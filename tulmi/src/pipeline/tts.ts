/**
 * Text-to-speech (voice output). The "mouth": turns text into spoken audio for
 * features like the screen-bubble reading content aloud, or reading a draft
 * back to the user.
 *
 * Provider: OpenAI gpt-4o-mini-tts — multilingual, cheap, and *steerable*
 * (the `instructions` field lets the user's personality shape how it speaks).
 */
import OpenAI from "openai";
import { getConfig } from "../config.js";

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: getConfig().OPENAI_API_KEY });
  return client;
}

export type TtsFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

const FORMAT_MIME: Record<TtsFormat, string> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

export interface TtsInput {
  text: string;
  /** Voice name (e.g. "alloy", "nova", "marin"). Defaults to TTS_VOICE. */
  voice?: string;
  /** Output container. Defaults to TTS_FORMAT. */
  format?: TtsFormat;
  /** Optional style steer, e.g. "warm and upbeat" — derived from personality. */
  instructions?: string;
}

export interface TtsResult {
  audio: Buffer;
  contentType: string;
}

export async function synthesize(input: TtsInput): Promise<TtsResult> {
  const cfg = getConfig();
  if (!cfg.OPENAI_API_KEY) {
    throw new Error("TTS requires OPENAI_API_KEY.");
  }
  const format = (input.format ?? cfg.TTS_FORMAT) as TtsFormat;

  const params = {
    model: cfg.OPENAI_TTS_MODEL,
    voice: input.voice ?? cfg.TTS_VOICE,
    input: input.text,
    response_format: format,
    ...(input.instructions ? { instructions: input.instructions } : {}),
  } as unknown as OpenAI.Audio.Speech.SpeechCreateParams;

  const res = await openai().audio.speech.create(params);
  const audio = Buffer.from(await res.arrayBuffer());
  return { audio, contentType: FORMAT_MIME[format] };
}
