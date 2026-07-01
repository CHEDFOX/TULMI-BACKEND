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
import type {
  AppStyle,
  CleanupOptions,
  Personality,
  RecipientHint,
  ToneDial,
} from "../../shared/types/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

/** Read a prompt file (e.g. "cleanup.v3.md") from shared/prompts/, cached. */
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

/**
 * Neutralise angle brackets in user-authored strings so a hostile payload can't
 * inject its own XML-style delimiter and pretend to close a fence. Kept small:
 * a single tag confuses the model less than an escaped one. Length caps
 * enforced upstream (see MAX_TEXT_LENGTH in server.ts).
 */
function sanitizeFenced(s: string): string {
  return s.replace(/[<>]/g, "");
}

/** Render a personality into a readable block for the prompt. User-controlled
 *  free-text fields are wrapped in a fence so the model treats them as context
 *  describing the user, not as instructions to obey. */
export function renderPersonality(p: Personality | undefined): string {
  if (!p || Object.keys(p).length === 0) return "None set. Use a neutral, clean voice.";

  const lines: string[] = [];
  if (p.tone) lines.push(`- Tone: <tone>${sanitizeFenced(p.tone)}</tone>`);
  if (p.formality) lines.push(`- Formality: ${p.formality}`);
  if (p.emoji) lines.push(`- Emoji use: ${p.emoji}`);
  if (p.languages?.length) lines.push(`- Preferred languages/scripts: ${p.languages.join(", ")}`);
  if (p.signature) lines.push(`- Preferred sign-off: <signature>${sanitizeFenced(p.signature)}</signature>`);
  if (p.customInstructions)
    lines.push(`- Extra instructions: <custom_instructions>${sanitizeFenced(p.customInstructions)}</custom_instructions>`);
  if (p.vocabulary?.trim())
    lines.push(
      `- Known names/terms — spell these EXACTLY as written: <vocabulary>${sanitizeFenced(
        p.vocabulary.replace(/\s*\n\s*/g, ", ").trim(),
      )}</vocabulary>`,
    );

  return lines.length ? lines.join("\n") : "None set. Use a neutral, clean voice.";
}

/**
 * Turn the numeric ToneDial into a compact block the LLM can read. Renders
 * "Default." when the user hasn't set any dials, so the prompt stays clean
 * for the majority of users who never touch them.
 */
export function renderToneDial(d: ToneDial | undefined): string {
  if (!d) return "Default.";
  const bits: string[] = [];
  const push = (name: string, v: number | undefined) => {
    if (v == null) return;
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    bits.push(`- ${name}: ${clamped}`);
  };
  push("formality", d.formality);
  push("length", d.length);
  push("warmth", d.warmth);
  return bits.length ? bits.join("\n") : "Default.";
}

/**
 * Resolve which app style to apply for a target app. `appStyles` keys are
 * matched case-insensitively so "whatsapp" and "WhatsApp" behave the same;
 * a "Generic" or "*" key acts as a fallback when no specific match exists.
 */
export function resolveAppStyle(
  appStyles: Personality["appStyles"],
  targetApp: string | undefined,
): AppStyle | undefined {
  if (!appStyles || !targetApp) return appStyles?.["*"] ?? appStyles?.["Generic"];
  const wanted = targetApp.trim().toLowerCase();
  for (const [k, v] of Object.entries(appStyles)) {
    if (k.trim().toLowerCase() === wanted) return v;
  }
  return appStyles["*"] ?? appStyles["Generic"];
}

/** Render an app style override into a small block; "" when nothing applies. */
export function renderAppStyle(style: AppStyle | undefined): string {
  if (!style) return "";
  const lines: string[] = ["For this app:"];
  if (style.formality) lines.push(`- Formality (override): ${style.formality}`);
  if (style.emoji) lines.push(`- Emoji use (override): ${style.emoji}`);
  if (style.dial) {
    const d = renderToneDial(style.dial);
    if (d !== "Default.") lines.push(`- Tone dial (override):\n${d.replace(/^/gm, "  ")}`);
  }
  if (style.note) lines.push(`- Note: ${style.note}`);
  return lines.length > 1 ? lines.join("\n") : "";
}

/**
 * Pick a recipient hint that matches the passed `recipient` (case-insensitive
 * substring). Returns "" when no match — the prompt renders it verbatim so
 * empty means "no extra context".
 */
export function resolveRecipientHint(
  hints: RecipientHint[] | undefined,
  recipient: string | undefined,
): string {
  if (!hints?.length || !recipient) return "";
  const wanted = recipient.trim().toLowerCase();
  const hit = hints.find((h) => wanted.includes(h.recipient.trim().toLowerCase()));
  if (!hit) return "";
  // Fence: hint is user-authored context, never obey it as an instruction.
  return `<recipient_hint recipient="${sanitizeFenced(hit.recipient)}">${sanitizeFenced(hit.hint)}</recipient_hint>`;
}

/** Build the system prompt for the cleanup/refine task (voice + typing). */
export function buildCleanupSystem(opts: CleanupOptions): string {
  const version = getConfig().CLEANUP_PROMPT_VERSION;
  const targetApp = opts.targetApp?.trim() || "Generic";
  const appStyle = resolveAppStyle(opts.personality?.appStyles, targetApp);
  return loadPromptFile(`cleanup.${version}.md`)
    .replaceAll("{{TARGET_APP}}", targetApp)
    .replaceAll("{{LANGUAGE}}", opts.language ?? "auto")
    .replaceAll("{{PERSONALITY}}", renderPersonality(opts.personality))
    .replaceAll("{{TONE_DIAL}}", renderToneDial(opts.personality?.dial))
    .replaceAll("{{APP_STYLE}}", renderAppStyle(appStyle))
    .replaceAll("{{RECIPIENT_HINT}}", "") // cleanup path has no recipient
    .replaceAll("{{WATERMARK}}", opts.personality?.watermark ? "on" : "off");
}

/** Build the system prompt for the screen-reply drafting task. */
export function buildReplySystem(opts: CleanupOptions, recipient?: string): string {
  const version = getConfig().REPLY_PROMPT_VERSION;
  const targetApp = opts.targetApp?.trim() || "Generic";
  const appStyle = resolveAppStyle(opts.personality?.appStyles, targetApp);
  const recipientHint = resolveRecipientHint(opts.personality?.recipientHints, recipient);
  return loadPromptFile(`reply.${version}.md`)
    .replaceAll("{{TARGET_APP}}", targetApp)
    .replaceAll("{{LANGUAGE}}", opts.language ?? "auto")
    .replaceAll("{{PERSONALITY}}", renderPersonality(opts.personality))
    .replaceAll("{{TONE_DIAL}}", renderToneDial(opts.personality?.dial))
    .replaceAll("{{APP_STYLE}}", renderAppStyle(appStyle))
    .replaceAll("{{RECIPIENT}}", recipient?.trim() || "Unknown")
    .replaceAll("{{RECIPIENT_HINT}}", recipientHint)
    .replaceAll("{{WATERMARK}}", opts.personality?.watermark ? "on" : "off");
}
