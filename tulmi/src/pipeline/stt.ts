/**
 * Speech-to-text. Provider-pluggable so we can serve a global audience:
 *  - "openai" (default): gpt-4o-transcribe — ~100 languages, strong multilingual.
 *  - "groq": whisper-large-v3-turbo — fast + cheap fallback.
 *
 * Hindi/Hinglish remains the flagship, but language is open-ended: any
 * ISO-639-1 code is passed through; "auto"/"hinglish" let the model detect (best
 * for spontaneous code-switching).
 */
import OpenAI, { toFile as toOpenAIFile } from "openai";
import Groq, { toFile as toGroqFile } from "groq-sdk";
import { getConfig } from "../config.js";
import type { AudioFormat, LanguageHint } from "../../../shared/types/api.js";

let openaiClient: OpenAI | null = null;
function openai(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: getConfig().OPENAI_API_KEY });
  return openaiClient;
}

let groqClient: Groq | null = null;
function groq(): Groq {
  if (!groqClient) groqClient = new Groq({ apiKey: getConfig().GROQ_API_KEY });
  return groqClient;
}

/**
 * Map our language hint to an ISO-639-1 code, or undefined for auto-detect.
 * "auto" and "hinglish" → undefined (let the model detect; it handles
 * code-switching better than being pinned to one language). Anything else is
 * assumed to be a valid language code and passed through.
 */
function sttLanguage(hint: LanguageHint | undefined): string | undefined {
  if (!hint || hint === "auto" || hint === "hinglish") return undefined;
  return hint;
}

export interface SttResult {
  text: string;
  /** Audio length in seconds (0 when the provider doesn't report it). */
  durationSeconds: number;
}

export interface SttInput {
  audio: Buffer;
  format: AudioFormat;
  language?: LanguageHint;
  /** Personal dictionary (names/jargon) to bias recognition toward. */
  vocabulary?: string;
}

const CODE_SWITCH_HINT = "The speaker may mix multiple languages in one sentence.";

/** Whisper's prompt biases spelling/vocabulary — fold the user's dictionary in. */
function sttPrompt(vocabulary?: string): string {
  const terms = vocabulary?.replace(/\s*\n\s*/g, ", ").trim();
  return terms ? `${CODE_SWITCH_HINT} Likely names/terms: ${terms}.` : CODE_SWITCH_HINT;
}

export async function transcribe(input: SttInput): Promise<SttResult> {
  const cfg = getConfig();
  const raw = await (cfg.STT_PROVIDER === "groq"
    ? transcribeGroq(input)
    : transcribeOpenAI(input));

  // Provider didn't report a duration (OpenAI gpt-4o-transcribe never does)
  // — fall back to a header/CBR probe of the buffer so metering isn't zeroed
  // out for every voice request.
  if (raw.durationSeconds > 0) return raw;
  const estimated = estimateDurationSeconds(input.audio, input.format);
  return { ...raw, durationSeconds: estimated };
}

/**
 * Probe an audio buffer for its length in seconds when the STT provider
 * didn't hand us one. Accurate for well-formed WAV; a rough CBR-128kbps
 * estimate for MP3; zero (with a once-per-boot warning) for containers we
 * don't parse yet (m4a/ogg/webm/flac). Never throws — a bad header just
 * returns 0 and lets metering under-count instead of failing the request.
 */
export function estimateDurationSeconds(
  audio: Buffer,
  format: AudioFormat,
): number {
  try {
    switch (format) {
      case "wav":
        return probeWavDuration(audio);
      case "mp3":
        // Approximate at CBR 128 kbps: bytes / 16_000 = seconds.
        // 128000 bits/s ÷ 8 = 16000 bytes/s. Real files vary (VBR, ID3v2 tag,
        // other bitrates) — the goal is "non-zero and vaguely honest", not
        // sample-accurate. Truth-in-metering: this can be off by ±25%.
        return audio.length / 16_000;
      case "m4a":
      case "ogg":
      case "webm":
      case "flac":
        warnUnsupportedFormatOnce(format);
        return 0;
    }
  } catch {
    // Fall through — a corrupt header shouldn't reject the whole request.
  }
  return 0;
}

// One-per-boot warning per format we can't yet probe, so ops sees a clear
// signal (rather than silence + zeroed metering) when a client starts sending
// a container we haven't wired up.
const warnedFormats = new Set<AudioFormat>();
function warnUnsupportedFormatOnce(format: AudioFormat): void {
  if (warnedFormats.has(format)) return;
  warnedFormats.add(format);
  console.warn(
    `[stt] provider returned no duration for ${format}; no header probe wired up ` +
      `→ audioSeconds will be 0 for ${format} until parser is added.`,
  );
}

/**
 * Parse a canonical PCM WAV header (RIFF/WAVE) and return the audio length in
 * seconds. We walk the chunk table so files with a "LIST"/"bext" chunk before
 * "data" (broadcast-WAV variants) still work. Returns 0 on any parse mismatch.
 */
function probeWavDuration(buf: Buffer): number {
  if (buf.length < 44) return 0;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return 0;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return 0;

  let offset = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;

    if (id === "fmt ") {
      if (bodyStart + 16 > buf.length) return 0;
      numChannels = buf.readUInt16LE(bodyStart + 2);
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      bitsPerSample = buf.readUInt16LE(bodyStart + 14);
    } else if (id === "data") {
      dataSize = size;
      break; // stop at data — later chunks are metadata
    }

    // WAV chunks are word-aligned; odd sizes get a pad byte.
    offset = bodyStart + size + (size % 2);
  }

  if (sampleRate <= 0 || numChannels <= 0 || bitsPerSample <= 0 || dataSize <= 0) {
    return 0;
  }
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  return byteRate > 0 ? dataSize / byteRate : 0;
}

async function transcribeOpenAI(input: SttInput): Promise<SttResult> {
  const cfg = getConfig();
  const file = await toOpenAIFile(input.audio, `audio.${input.format}`);

  // gpt-4o-transcribe returns { text } (no duration). Audio-seconds for metering
  // is reported by the client recorder; words are the reliable meter here.
  const res = await openai().audio.transcriptions.create({
    file,
    model: cfg.OPENAI_STT_MODEL,
    language: sttLanguage(input.language),
    prompt: sttPrompt(input.vocabulary),
    response_format: "json",
  });

  return {
    text: (res.text ?? "").trim(),
    durationSeconds: 0,
  };
}

async function transcribeGroq(input: SttInput): Promise<SttResult> {
  const cfg = getConfig();
  const file = await toGroqFile(input.audio, `audio.${input.format}`);

  // verbose_json gives us the audio duration for metering.
  const res = (await groq().audio.transcriptions.create({
    file,
    model: cfg.GROQ_STT_MODEL,
    language: sttLanguage(input.language),
    response_format: "verbose_json",
    prompt: sttPrompt(input.vocabulary),
  })) as { text: string; duration?: number };

  return {
    text: (res.text ?? "").trim(),
    durationSeconds: typeof res.duration === "number" ? res.duration : 0,
  };
}
