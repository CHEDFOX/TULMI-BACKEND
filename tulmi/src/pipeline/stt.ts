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
  return cfg.STT_PROVIDER === "groq"
    ? transcribeGroq(input)
    : transcribeOpenAI(input);
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
