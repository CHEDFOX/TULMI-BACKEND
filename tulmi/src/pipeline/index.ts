/**
 * Pipeline orchestration: audio → transcript → cleaned text, plus usage.
 *
 * Two entry points:
 *  - runPipeline()        : one-shot (REST + test script)
 *  - runPipelineStream()  : streaming (WebSocket) — emits events as they happen
 */
import { transcribe } from "./stt.js";
import { clean, cleanStream } from "./cleanup.js";
import type {
  AudioFormat,
  CleanupOptions,
  UsageRecord,
} from "../../../shared/types/api.js";
import { getConfig } from "../config.js";

export interface PipelineInput extends CleanupOptions {
  audio: Buffer;
  format: AudioFormat;
}

export interface PipelineResult {
  transcript: string;
  cleanedText: string;
  usage: UsageRecord;
}

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** One-shot: transcribe then clean. */
export async function runPipeline(
  input: PipelineInput,
): Promise<PipelineResult> {
  const { audio, format, ...opts } = input;

  const stt = await transcribe({ audio, format, language: opts.language, vocabulary: opts.personality?.vocabulary });
  const cleanedText = await clean(stt.text, opts);

  return {
    transcript: stt.text,
    cleanedText,
    usage: {
      audioSeconds: stt.durationSeconds,
      words: countWords(cleanedText),
      model: getConfig().CLEANUP_MODEL,
    },
  };
}

/** Events emitted by the streaming pipeline. */
export type PipelineEvent =
  | { type: "transcript"; text: string }
  | { type: "cleaned_delta"; text: string }
  | { type: "done"; cleanedText: string; usage: UsageRecord };

/**
 * Streaming: emit the transcript once, then cleaned deltas, then a final done
 * event with usage. Note: STT itself isn't incremental here — we transcribe the
 * full clip, then stream the *cleanup*, which is where most of the latency and
 * the visible "typing" effect lives.
 */
export async function* runPipelineStream(
  input: PipelineInput,
): AsyncGenerator<PipelineEvent, void, unknown> {
  const { audio, format, ...opts } = input;

  const stt = await transcribe({ audio, format, language: opts.language, vocabulary: opts.personality?.vocabulary });
  yield { type: "transcript", text: stt.text };

  let cleanedText = "";
  for await (const delta of cleanStream(stt.text, opts)) {
    cleanedText += delta;
    yield { type: "cleaned_delta", text: delta };
  }
  cleanedText = cleanedText.trim();

  yield {
    type: "done",
    cleanedText,
    usage: {
      audioSeconds: stt.durationSeconds,
      words: countWords(cleanedText),
      model: getConfig().CLEANUP_MODEL,
    },
  };
}
