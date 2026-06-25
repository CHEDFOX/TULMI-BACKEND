/**
 * Loads the versioned prompt files from shared/prompts/ and renders them with
 * per-request values (target app, language, personality, recipient).
 *
 * Prompts are the product's core asset, kept as versioned markdown so we can
 * A/B and roll back without code changes.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getConfig } from "./config.js";
import type { CleanupOptions, Personality } from "../../shared/types/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

/** Read a prompt file (e.g. "cleanup.v2.md") from shared/prompts/, cached. */
function loadPromptFile(filename: string): string {
  const cached = cache.get(filename);
  if (cached) return cached;

  // Resolve across layouts: dev (src/) vs built (dist/), an explicit override,
  // and cwd-relative fallbacks. First existing wins.
  const candidates = [
    process.env.TULMI_SHARED_DIR &&
      resolve(process.env.TULMI_SHARED_DIR, "prompts", filename),
    resolve(__dirname, "..", "..", "shared", "prompts", filename), // tulmi/src → repo/shared
    resolve(__dirname, "..", "..", "..", "shared", "prompts", filename), // dist/tulmi/src → repo/shared
    resolve(process.cwd(), "..", "shared", "prompts", filename), // run from tulmi/
    resolve(process.cwd(), "shared", "prompts", filename), // run from repo root
  ].filter(Boolean) as string[];

  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      `Could not find prompt "${filename}". Looked in:\n` +
        candidates.map((p) => `  - ${p}`).join("\n") +
        `\nSet TULMI_SHARED_DIR to the shared/ directory if it lives elsewhere.`,
    );
  }

  const raw = readFileSync(path, "utf8");
  cache.set(filename, raw);
  return raw;
}

/** Render a personality into a readable block for the prompt. */
export function renderPersonality(p: Personality | undefined): string {
  if (!p || Object.keys(p).length === 0) return "None set. Use a neutral, clean voice.";

  const lines: string[] = [];
  if (p.tone) lines.push(`- Tone: ${p.tone}`);
  if (p.formality) lines.push(`- Formality: ${p.formality}`);
  if (p.emoji) lines.push(`- Emoji use: ${p.emoji}`);
  if (p.languages?.length) lines.push(`- Preferred languages/scripts: ${p.languages.join(", ")}`);
  if (p.signature) lines.push(`- Preferred sign-off: ${p.signature}`);
  if (p.customInstructions) lines.push(`- Extra instructions: ${p.customInstructions}`);
  if (p.vocabulary?.trim())
    lines.push(
      `- Known names/terms — spell these EXACTLY as written: ${p.vocabulary
        .replace(/\s*\n\s*/g, ", ")
        .trim()}`,
    );

  return lines.length ? lines.join("\n") : "None set. Use a neutral, clean voice.";
}

/** Build the system prompt for the cleanup/refine task (voice + typing). */
export function buildCleanupSystem(opts: CleanupOptions): string {
  const version = getConfig().CLEANUP_PROMPT_VERSION;
  return loadPromptFile(`cleanup.${version}.md`)
    .replaceAll("{{TARGET_APP}}", opts.targetApp?.trim() || "Generic")
    .replaceAll("{{LANGUAGE}}", opts.language ?? "auto")
    .replaceAll("{{PERSONALITY}}", renderPersonality(opts.personality));
}

/** Build the system prompt for the screen-reply drafting task. */
export function buildReplySystem(opts: CleanupOptions, recipient?: string): string {
  const version = getConfig().REPLY_PROMPT_VERSION;
  return loadPromptFile(`reply.${version}.md`)
    .replaceAll("{{TARGET_APP}}", opts.targetApp?.trim() || "Generic")
    .replaceAll("{{LANGUAGE}}", opts.language ?? "auto")
    .replaceAll("{{PERSONALITY}}", renderPersonality(opts.personality))
    .replaceAll("{{RECIPIENT}}", recipient?.trim() || "Unknown");
}
