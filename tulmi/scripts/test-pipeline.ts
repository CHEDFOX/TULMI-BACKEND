/**
 * Prove the pipeline end-to-end WITHOUT the server:
 *
 *   npm run test:pipeline -- ./test-assets/sample.m4a --app WhatsApp --lang auto
 *
 * Feeds an audio file → Groq Whisper (STT) → OpenRouter (cleanup) → prints the
 * raw transcript and the cleaned text, plus timing and usage.
 *
 * Requires GROQ_API_KEY + OPENROUTER_API_KEY in your .env. Supabase is NOT
 * needed (DEV_SKIP_AUTH=true by default in .env.example).
 */
import { readFileSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";
import { runPipeline } from "../src/pipeline/index.js";
import type {
  AudioFormat,
  LanguageHint,
  TargetAppHint,
} from "../../shared/types/api.js";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let app: TargetAppHint | undefined;
  let lang: LanguageHint | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--app") app = argv[++i] as TargetAppHint;
    else if (a === "--lang") lang = argv[++i] as LanguageHint;
    else positional.push(a);
  }
  return { file: positional[0], app, lang };
}

const ALLOWED: AudioFormat[] = ["wav", "m4a", "webm", "mp3", "ogg", "flac"];

async function main() {
  const { file, app, lang } = parseArgs(process.argv.slice(2));

  if (!file) {
    console.error(
      "Usage: npm run test:pipeline -- <audio-file> [--app WhatsApp] [--lang auto|hi|en|hinglish|<iso-code>]",
    );
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const ext = extname(file).slice(1).toLowerCase() as AudioFormat;
  if (!ALLOWED.includes(ext)) {
    console.error(`Unsupported format ".${ext}". Use one of: ${ALLOWED.join(", ")}`);
    process.exit(1);
  }

  const audio = readFileSync(file);
  console.log(`\n▶ Input: ${basename(file)} (${(audio.length / 1024).toFixed(0)} KB)`);
  console.log(`  targetApp=${app ?? "Generic"}  language=${lang ?? "auto"}\n`);

  const t0 = Date.now();
  const result = await runPipeline({
    audio,
    format: ext,
    targetApp: app,
    language: lang,
  });
  const ms = Date.now() - t0;

  console.log("─".repeat(60));
  console.log("RAW TRANSCRIPT:\n" + (result.transcript || "(empty)"));
  console.log("─".repeat(60));
  console.log("CLEANED TEXT:\n" + (result.cleanedText || "(empty)"));
  console.log("─".repeat(60));
  console.log(
    `usage: audio=${result.usage.audioSeconds.toFixed(1)}s  ` +
      `words=${result.usage.words}  model=${result.usage.model}`,
  );
  console.log(`end-to-end: ${(ms / 1000).toFixed(2)}s\n`);
}

main().catch((err) => {
  console.error("\nPipeline failed:", err?.message ?? err);
  process.exit(1);
});
