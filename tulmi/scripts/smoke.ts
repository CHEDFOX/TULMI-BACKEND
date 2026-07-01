/**
 * End-to-end smoke test — no external audio file needed.
 *
 *   npm run smoke                       # default phrase, WhatsApp
 *   npm run smoke -- --app Slack
 *   npm run smoke -- --text "hey uh so the meeting is at three"
 *
 * What it does, in order:
 *   1. Uses OpenAI TTS to *generate* a messy-sounding voice sample. This is
 *      the same OpenAI key you already use for STT; a single TTS run is
 *      roughly a tenth of a cent.
 *   2. Feeds that audio into the same pipeline the app uses:
 *      STT (OpenAI gpt-4o-transcribe or Groq Whisper, per STT_PROVIDER)
 *      → cleanup (OpenRouter LLM).
 *   3. Prints the raw transcript and the cleaned text so you can eyeball
 *      whether the whole chain is healthy.
 *
 * Also saves the generated audio to test-assets/generated.mp3 so you can
 * re-run the classic `npm run test:pipeline -- test-assets/generated.mp3`
 * next time without re-billing TTS.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/pipeline/index.js";
import { synthesize } from "../src/pipeline/tts.js";
import type { TargetAppHint, LanguageHint } from "../../shared/types/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// A deliberately messy phrase — filler words, run-on, no punctuation. Cleanup
// should turn this into a short, well-formed message. If the output still
// contains "uh"/"like"/"basically" the LLM step is misconfigured.
const DEFAULT_TEXT =
  "hey uh so like the meeting tomorrow is at three thirty please bring the deck thanks bye";

function parseArgs(argv: string[]) {
  let app: TargetAppHint = "WhatsApp";
  let lang: LanguageHint = "auto";
  let text = DEFAULT_TEXT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--app") app = argv[++i] as TargetAppHint;
    else if (a === "--lang") lang = argv[++i] as LanguageHint;
    else if (a === "--text") text = argv[++i];
  }
  return { app, lang, text };
}

async function main() {
  const { app, lang, text } = parseArgs(process.argv.slice(2));

  console.log("\n▶ Smoke test — no external audio file needed");
  console.log(`  targetApp=${app}  language=${lang}`);
  console.log(`  input text (spoken by TTS):`);
  console.log(`    "${text}"\n`);

  // ------------ Step 1: generate the audio via TTS -------------------------
  const t0 = Date.now();
  console.log("1/2  generating voice sample via OpenAI TTS…");
  const { audio } = await synthesize({
    text,
    format: "mp3",
    // A little on-purpose vocal fry so the STT has real filler to remove.
    instructions: "casual, slightly rushed, natural pauses",
  });
  const ttsMs = Date.now() - t0;

  const outDir = resolve(__dirname, "..", "test-assets");
  const outPath = resolve(outDir, "generated.mp3");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, audio);
  console.log(
    `     ok — ${(audio.length / 1024).toFixed(0)} KB in ${(ttsMs / 1000).toFixed(2)}s`,
  );
  console.log(`     saved to ${outPath}\n`);

  // ------------ Step 2: run the full pipeline on it ------------------------
  console.log("2/2  running STT + cleanup pipeline…");
  const t1 = Date.now();
  const result = await runPipeline({
    audio,
    format: "mp3",
    targetApp: app,
    language: lang,
  });
  const pipelineMs = Date.now() - t1;
  console.log(`     ok — ${(pipelineMs / 1000).toFixed(2)}s\n`);

  // ------------ Report -----------------------------------------------------
  const bar = "─".repeat(64);
  console.log(bar);
  console.log("RAW TRANSCRIPT (STT):");
  console.log(result.transcript || "(empty)");
  console.log(bar);
  console.log("CLEANED TEXT (LLM):");
  console.log(result.cleanedText || "(empty)");
  console.log(bar);
  console.log(
    `usage: audio=${result.usage.audioSeconds.toFixed(1)}s  ` +
      `words=${result.usage.words}  model=${result.usage.model}`,
  );
  console.log(`total: ${((ttsMs + pipelineMs) / 1000).toFixed(2)}s ` +
    `(TTS ${(ttsMs / 1000).toFixed(2)}s + pipeline ${(pipelineMs / 1000).toFixed(2)}s)\n`);

  // Quick pass/fail heuristic — this is a smoke test, not a strict eval.
  const cleaned = result.cleanedText.toLowerCase();
  const stillMessy = /\b(uh|um|like\b|basically)\b/.test(cleaned);
  const empty = cleaned.trim().length === 0;
  if (empty) {
    console.error("✗ FAIL — cleaned text is empty. Check OPENROUTER_API_KEY.");
    process.exit(2);
  }
  if (stillMessy) {
    console.error("⚠  WARNING — filler words survived cleanup. Model or prompt may be off.");
    process.exit(3);
  }
  console.log("✓ PASS — pipeline produced clean text.\n");
}

main().catch((err) => {
  console.error("\n✗ Smoke test failed:", err?.message ?? err);
  process.exit(1);
});
