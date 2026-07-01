/**
 * The cleanup "brain": OpenRouter chat calls that
 *  - clean()/cleanStream()  : polish raw transcript OR typed text (voice + typing)
 *  - draftReply()           : draft a personalized reply from screen content + intent
 *
 * Default model: anthropic/claude-haiku-4.5, swappable via CLEANUP_MODEL.
 * System prompts are built in ../prompts.ts from the versioned shared/prompts/.
 */
import OpenAI from "openai";
import { getConfig } from "../config.js";
import { buildCleanupSystem, buildReplySystem } from "../prompts.js";
import type { CleanupOptions, Personality } from "../../../shared/types/api.js";

let client: OpenAI | null = null;
function openrouter(): OpenAI {
  if (!client) {
    const cfg = getConfig();
    client = new OpenAI({
      apiKey: cfg.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": cfg.OPENROUTER_APP_URL,
        "X-Title": cfg.OPENROUTER_APP_NAME,
      },
    });
  }
  return client;
}

const TEMPERATURE = 0.2; // low: faithful cleanup, not creativity
const REPLY_TEMPERATURE = 0.4; // a touch more latitude for natural drafting

// Output ceilings. Set explicitly so OpenRouter's per-request credit
// reservation matches what we actually produce (~200 tokens for cleanup,
// ~500 for a reply). Without this, OpenRouter reserves the model's full
// context ceiling (64k+ tokens) upfront and rejects small-balance accounts
// even though the real cost is a fraction of a cent.
//
// Real outputs are almost always shorter than the input — cleanup collapses
// filler, reply drafts hit medium length. These caps leave generous headroom.
const MAX_TOKENS_CLEANUP = 1024;   // ≈ 750 words of cleaned text
const MAX_TOKENS_REPLY = 2048;     // ≈ 1500 words — email-length drafts
const MAX_TOKENS_STYLE = 512;      // small JSON blob

// --- Snippets (text expansion) ---------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse "trigger = expansion" lines into pairs (first '=' splits the line). */
function parseSnippets(text: string): Array<{ trigger: string; expansion: string }> {
  const out: Array<{ trigger: string; expansion: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const trigger = line.slice(0, i).trim();
    if (trigger) out.push({ trigger, expansion: line.slice(i + 1).trim() });
  }
  return out;
}

/** Expand the user's snippet triggers (whole-word, case-insensitive). */
export function expandSnippets(text: string, snippets?: string): string {
  if (!snippets?.trim() || !text) return text;
  let out = text;
  for (const { trigger, expansion } of parseSnippets(snippets)) {
    const re = new RegExp(`\\b${escapeRegExp(trigger)}\\b`, "gi");
    out = out.replace(re, () => expansion);
  }
  return out;
}

// --- Cleanup / refine (voice + typing) -------------------------------------

/** Non-streaming cleanup of a transcript or typed text. */
export async function clean(
  input: string,
  opts: CleanupOptions = {},
): Promise<string> {
  if (!input.trim()) return "";
  const res = await openrouter().chat.completions.create({
    model: getConfig().CLEANUP_MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS_CLEANUP,
    messages: [
      { role: "system", content: buildCleanupSystem(opts) },
      { role: "user", content: input },
    ],
  });
  return expandSnippets((res.choices[0]?.message?.content ?? "").trim(), opts.personality?.snippets);
}

/** Streaming cleanup — yields cleaned text deltas as they arrive. */
export async function* cleanStream(
  input: string,
  opts: CleanupOptions = {},
): AsyncGenerator<string, void, unknown> {
  if (!input.trim()) return;
  const stream = await openrouter().chat.completions.create({
    model: getConfig().CLEANUP_MODEL,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS_CLEANUP,
    stream: true,
    messages: [
      { role: "system", content: buildCleanupSystem(opts) },
      { role: "user", content: input },
    ],
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

// --- Screen-reply drafting --------------------------------------------------

/** Draft a personalized reply from on-screen content + the user's intent. */
export async function draftReply(
  screenContent: string,
  intent: string,
  opts: CleanupOptions = {},
  recipient?: string,
): Promise<string> {
  if (!intent.trim()) return "";
  const userMsg =
    `SCREEN CONTENT (what I'm replying to):\n${screenContent.trim() || "(none)"}\n\n` +
    `MY INTENT (what I want to say back):\n${intent.trim()}`;

  const res = await openrouter().chat.completions.create({
    model: getConfig().CLEANUP_MODEL,
    temperature: REPLY_TEMPERATURE,
    max_tokens: MAX_TOKENS_REPLY,
    messages: [
      { role: "system", content: buildReplySystem(opts, recipient) },
      { role: "user", content: userMsg },
    ],
  });
  return expandSnippets((res.choices[0]?.message?.content ?? "").trim(), opts.personality?.snippets);
}

// --- Learn style from a writing sample -------------------------------------

const LEARN_TEMPERATURE = 0.3;

/** Infer a style profile from a sample of the user's own writing. */
export async function inferStyle(sample: string): Promise<Partial<Personality>> {
  if (!sample.trim()) return {};
  const system =
    "You analyze a person's writing and infer their texting/writing style. " +
    "Return ONLY a JSON object with these optional keys: " +
    "tone (short phrase like 'warm and concise, a little witty'), " +
    "formality ('casual' | 'neutral' | 'formal'), " +
    "emoji ('none' | 'minimal' | 'expressive'), " +
    "signature (a sign-off they use, or omit it), " +
    "customInstructions (concrete style rules you observed, e.g. 'lowercase, few commas, no exclamation marks'), " +
    "dial (an object { formality: 0-100, length: 0-100, warmth: 0-100 } — omit any dial you can't confidently read from the sample). " +
    "No prose, no markdown, no extra keys.";
  const res = await openrouter().chat.completions.create({
    model: getConfig().CLEANUP_MODEL,
    temperature: LEARN_TEMPERATURE,
    max_tokens: MAX_TOKENS_STYLE,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: "Here is a sample of my writing:\n\n" + sample.trim() },
    ],
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  } catch {
    return {};
  }
  return sanitizeStyle(parsed);
}

function sanitizeStyle(o: Record<string, unknown>): Partial<Personality> {
  const out: Partial<Personality> = {};
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
  const tone = str(o.tone, 200);
  if (tone) out.tone = tone;
  if (o.formality === "casual" || o.formality === "neutral" || o.formality === "formal") out.formality = o.formality;
  if (o.emoji === "none" || o.emoji === "minimal" || o.emoji === "expressive") out.emoji = o.emoji;
  const sig = str(o.signature, 100);
  if (sig) out.signature = sig;
  const ci = str(o.customInstructions, 500);
  if (ci) out.customInstructions = ci;
  // Tone dial (v3): each dial is optional; only include ones the model gave
  // us as a number, and clamp to 0-100.
  if (o.dial && typeof o.dial === "object") {
    const d = o.dial as Record<string, unknown>;
    const clamp01 = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : undefined;
    const dial: NonNullable<Personality["dial"]> = {};
    const f = clamp01(d.formality);
    const l = clamp01(d.length);
    const w = clamp01(d.warmth);
    if (f != null) dial.formality = f;
    if (l != null) dial.length = l;
    if (w != null) dial.warmth = w;
    if (Object.keys(dial).length) out.dial = dial;
  }
  return out;
}
