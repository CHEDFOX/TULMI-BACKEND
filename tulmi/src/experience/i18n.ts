/**
 * Server-side UI localization.
 *
 * The backend owns every visible string (SDUI), so we localize the *whole UI*
 * here: take a built bootstrap/screen response and return it with all
 * user-facing text rendered in the user's chosen language. Translations are
 * produced on demand by the LLM and cached per language (memory + best-effort
 * disk), so each phrase is translated exactly once.
 *
 * Pattern adapted from Plutto's onboarding_translator:
 *   - English is the source of truth; "en"/"auto" pass through untouched.
 *   - Non-English languages are produced by the model and cached.
 *   - Any phrase that can't be translated falls back to English, so a screen
 *     never breaks on a translation miss.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import OpenAI from "openai";
import { getConfig } from "../config.js";
import type {
  ActionRef,
  ActionSpec,
  BootstrapResponse,
  Node,
  ScreenResponse,
} from "../../../shared/types/sdui.js";

type AnyResponse = BootstrapResponse | ScreenResponse;

/** Tulmi language code → human name used in the translation prompt. */
const LANGUAGE_NAMES: Record<string, string> = {
  hi: "Hindi", es: "Spanish", fr: "French", ar: "Arabic", pt: "Portuguese",
  de: "German", it: "Italian", ru: "Russian", ja: "Japanese", ko: "Korean",
  zh: "Chinese (Simplified)", bn: "Bengali", ta: "Tamil", te: "Telugu",
  mr: "Marathi", gu: "Gujarati", pa: "Punjabi", ur: "Urdu", tr: "Turkish",
  id: "Indonesian", vi: "Vietnamese", th: "Thai", nl: "Dutch",
  hinglish:
    "Hinglish (Hindi written in Latin/Roman script — casual, modern Indian texting style)",
};

/** Right-to-left languages (the app reads the hint below to flip layout). */
const RTL = new Set(["ar", "he", "fa", "ur"]);

/** Exact strings we never translate (brand, etc.). */
const KEEP = new Set(["Tailzu"]);

const BRAND_NOTE = "Never translate the brand name 'Tailzu' — keep it exactly.";

function langInfo(language: string | undefined): { code: string; name: string } | null {
  const code = (language || "").trim().toLowerCase();
  if (!code || code === "en" || code === "auto") return null;
  return { code, name: LANGUAGE_NAMES[code] ?? code };
}

function isTranslatable(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (KEEP.has(t)) return false;
  if (t.startsWith("@") || t.startsWith("$")) return false; // label / state refs
  if (/^https?:\/\//i.test(t)) return false;
  return /\p{L}/u.test(t); // must contain a letter (skip pure emoji/symbols/numbers)
}

// ---------------------------------------------------------------------------
// Tree transforms — visit only the fields that hold user-facing copy.
// `fn` is applied in two passes: once to COLLECT strings, once to REPLACE them.
// ---------------------------------------------------------------------------

type StrFn = (s: string) => string;

function transformActionRef(ref: ActionRef, fn: StrFn): ActionRef {
  return typeof ref === "string" ? ref : transformActionSpec(ref, fn);
}

function transformActionSpec(a: ActionSpec, fn: StrFn): ActionSpec {
  switch (a.kind) {
    case "toast":
      return { ...a, message: fn(a.message) };
    case "speak":
      return { ...a, text: fn(a.text) };
    case "setState":
      // Only translate state values that clearly hold display text.
      return typeof a.value === "string" &&
        /(?:^|\.)(status|message|label|title|text|hint|caption|toast)$/i.test(a.path)
        ? { ...a, value: fn(a.value) }
        : a;
    case "sequence":
      return { ...a, actions: a.actions.map((r) => transformActionRef(r, fn)) };
    case "condition":
      return {
        ...a,
        then: transformActionRef(a.then, fn),
        else: a.else ? transformActionRef(a.else, fn) : a.else,
      };
    case "callEndpoint":
      return {
        ...a,
        onSuccess: a.onSuccess ? transformActionRef(a.onSuccess, fn) : a.onSuccess,
        onError: a.onError ? transformActionRef(a.onError, fn) : a.onError,
      };
    default:
      return a;
  }
}

function transformNode(node: Node, fn: StrFn): Node {
  const out: Node = { ...node };
  if (node.props) {
    const p: Record<string, unknown> = { ...node.props };
    for (const key of ["content", "label", "placeholder"]) {
      if (typeof p[key] === "string") p[key] = fn(p[key] as string);
    }
    out.props = p;
  }
  if (node.children) out.children = node.children.map((c) => transformNode(c, fn));
  if (node.on) {
    const on: Record<string, ActionRef> = {};
    for (const [event, ref] of Object.entries(node.on)) {
      on[event] = transformActionRef(ref as ActionRef, fn);
    }
    out.on = on as Node["on"];
  }
  return out;
}

function transformResponse<T extends AnyResponse>(resp: T, fn: StrFn): T {
  // We rebuild a shallow copy and only touch copy-bearing fields. Cast to a
  // loose shape because bootstrap and screen responses share no base type.
  const out = { ...(resp as unknown as Record<string, unknown>) };

  if (typeof out.title === "string") out.title = fn(out.title);

  const nav = out.navigation as { kind?: string; tabs?: Array<{ title: string }> } | undefined;
  if (nav?.kind === "tabs" && Array.isArray(nav.tabs)) {
    out.navigation = {
      ...nav,
      tabs: nav.tabs.map((t) => ({ ...t, title: fn(t.title) })),
    };
  }

  if (out.labels && typeof out.labels === "object") {
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.labels as Record<string, string>)) {
      labels[k] = typeof v === "string" ? fn(v) : v;
    }
    out.labels = labels;
  }

  if (out.update && typeof out.update === "object") {
    const u = { ...(out.update as Record<string, unknown>) };
    for (const k of ["title", "message", "cta"]) {
      if (typeof u[k] === "string") u[k] = fn(u[k] as string);
    }
    out.update = u;
  }

  if (out.root) out.root = transformNode(out.root as Node, fn);
  if (Array.isArray(out.blocks)) {
    out.blocks = (out.blocks as Node[]).map((n) => transformNode(n, fn));
  }
  if (out.actions && typeof out.actions === "object") {
    const actions: Record<string, ActionSpec> = {};
    for (const [k, v] of Object.entries(out.actions as Record<string, ActionSpec>)) {
      actions[k] = transformActionSpec(v, fn);
    }
    out.actions = actions;
  }

  return out as unknown as T;
}

// ---------------------------------------------------------------------------
// Translation memory: per-language { english → translated }, memory + disk.
// ---------------------------------------------------------------------------

const memory = new Map<string, Map<string, string>>();
const locks = new Map<string, Promise<unknown>>();

function cacheDir(): string {
  return join(process.cwd(), "data", "i18n");
}

async function loadDisk(code: string): Promise<Map<string, string>> {
  try {
    const buf = await readFile(join(cacheDir(), `${code}.json`), "utf8");
    return new Map(Object.entries(JSON.parse(buf) as Record<string, string>));
  } catch {
    return new Map();
  }
}

async function saveDisk(code: string, cache: Map<string, string>): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(
      join(cacheDir(), `${code}.json`),
      JSON.stringify(Object.fromEntries(cache), null, 2),
      "utf8",
    );
  } catch {
    /* best-effort: cache is an optimization, not a requirement */
  }
}

/** Serialize work per language so concurrent requests don't double-translate. */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  locks.set(key, prev.then(() => gate));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    const cfg = getConfig();
    _client = new OpenAI({
      apiKey: cfg.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": cfg.OPENROUTER_APP_URL,
        "X-Title": cfg.OPENROUTER_APP_NAME,
      },
    });
  }
  return _client;
}

function buildPrompt(languageName: string, items: string[]): string {
  return [
    `Translate each UI string below into ${languageName}.`,
    "Rules:",
    "- Natural, concise, in a clean and friendly product tone.",
    "- Preserve emoji, leading/trailing spaces, and line breaks exactly where they are.",
    "- Keep short labels short; keep ALL-CAPS words emphatic if the script supports caps.",
    `- ${BRAND_NOTE}`,
    "- No quotes, numbering, or commentary.",
    'Return ONLY a JSON object {"items": ["...", ...]} whose array has EXACTLY the same length and order as the input.',
    "",
    "Input JSON:",
    JSON.stringify(items),
  ].join("\n");
}

async function translateViaLLM(languageName: string, items: string[]): Promise<string[]> {
  const cfg = getConfig();
  if (!cfg.OPENROUTER_API_KEY || items.length === 0) return [];
  try {
    const res = await client().chat.completions.create({
      model: cfg.CLEANUP_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a professional UI localizer for a mobile app. Output ONLY valid JSON. No prose, no markdown.",
        },
        { role: "user", content: buildPrompt(languageName, items) },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed as { items?: unknown }).items;
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => (typeof x === "string" ? x : ""));
  } catch (err) {
    console.error("[i18n] translation failed:", (err as Error).message);
    return [];
  }
}

async function ensureTranslations(
  code: string,
  name: string,
  strings: string[],
): Promise<Map<string, string>> {
  return withLock(code, async () => {
    let cache = memory.get(code);
    if (!cache) {
      cache = await loadDisk(code);
      memory.set(code, cache);
    }
    const missing = strings.filter((s) => !cache!.has(s));
    if (missing.length > 0) {
      const translated = await translateViaLLM(name, missing);
      let changed = false;
      for (let i = 0; i < missing.length; i++) {
        const t = translated[i];
        if (typeof t === "string" && t.trim()) {
          cache!.set(missing[i], t);
          changed = true;
        }
      }
      if (changed) await saveDisk(code, cache!);
    }
    return cache!;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return `resp` with every user-facing string translated into `language`.
 * "en"/"auto"/unknown-empty pass through unchanged. Safe on any bootstrap or
 * screen response; never throws (falls back to English per missing phrase).
 */
export async function localize<T extends AnyResponse>(
  resp: T,
  language: string | undefined,
): Promise<T> {
  const info = langInfo(language);
  if (!info) return resp;

  // Pass 1 — collect translatable strings.
  const found = new Set<string>();
  transformResponse(resp, (s) => {
    if (isTranslatable(s)) found.add(s);
    return s;
  });
  if (found.size === 0) return resp;

  // Translate (cached) then Pass 2 — substitute.
  const map = await ensureTranslations(info.code, info.name, [...found]);
  const localized = transformResponse(resp, (s) => map.get(s) ?? s);

  // RTL languages: tell the app to flip layout (bootstrap only).
  if (RTL.has(info.code) && "navigation" in (localized as unknown as Record<string, unknown>)) {
    const b = localized as BootstrapResponse;
    b.flags = { ...(b.flags ?? {}), textDirection: "rtl" };
  }
  return localized;
}
