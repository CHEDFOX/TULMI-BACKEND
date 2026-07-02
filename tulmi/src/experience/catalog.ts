/**
 * Experience service — the screen catalog.
 *
 * This is where the backend "owns the UI". Each screen is built as data (a tree
 * of SDUI Nodes) and handed to the generic renderer in the app. Change these
 * builders → the app changes, with no client rebuild.
 *
 * See ../../../shared/types/sdui.ts for the contract.
 */
import type {
  ActionRef,
  BootstrapResponse,
  KeyboardConfigResponse,
  NavigationShell,
  Node,
  ScreenResponse,
  ThemeTokens,
} from "../../../shared/types/sdui.js";
import { SDUI_SCHEMA_VERSION } from "../../../shared/types/sdui.js";
import type { HistoryEntry, Personality, StatsResponse, UsageSummary } from "../../../shared/types/api.js";

// --- Global theme -----------------------------------------------------------

export const THEME: ThemeTokens = {
  color: {
    bg: "#000000",
    surface: "#000000",
    card: "#0b0b0f",
    inputBg: "#0e0e12",
    border: "rgba(255,255,255,0.10)",
    // Was "#FFFFFF" — the app's readableOn() auto-contrast wasn't kicking in on
    // some builds, so selected chips and primary buttons rendered as white text
    // on white (invisible). Brand orange is punchy, on-theme, and lands high-
    // contrast against the black surface regardless of the client's readableOn
    // implementation. Buttons + selected chips now look like accent pills.
    primary: "#ff6b1f",
    text: "rgba(255,255,255,0.96)",
    body: "rgba(255,255,255,0.74)",
    muted: "rgba(255,255,255,0.55)",
    label: "rgba(255,255,255,0.42)",
    danger: "#e0556b",
    success: "#4caf50",
  },
  // Plutto-style scale: airy, editorial.
  space: { xs: 4, sm: 8, md: 12, lg: 18, xl: 26, content: 24, contentTop: 34 },
  radius: { sm: 8, md: 14, card: 18, pill: 999 },
  font: {
    // Headings render in a serif (set per-platform in the renderer); body is sans.
    sizes: { overline: 11, caption: 12, label: 13, body: 15, lg: 18, h1: 24, brand: 30 },
    weights: { light: "300", regular: "400", medium: "500", bold: "700", heavy: "800" },
  },
};

const NAV: NavigationShell = {
  kind: "tabs",
  tabs: [
    { id: "home", title: "Home", screenId: "home" },
    { id: "personality", title: "You", screenId: "personality" },
    { id: "settings", title: "Settings", screenId: "settings" },
  ],
};

// --- Small Node helpers (keep builders readable) ----------------------------

const text = (content: string, variant = "body", extra: Partial<Node> = {}): Node => ({
  type: "Text",
  props: { content, variant },
  ...extra,
});

const spacer = (height: number): Node => ({ type: "Spacer", style: { height } });

// --- Cache version ----------------------------------------------------------
//
// Opaque token that increments whenever the server catalog changes in a way
// clients should re-fetch. Sent in every bootstrap response as `cacheVersion`;
// clients compare against the value they've stored and drop any locally
// cached screens when it differs. Also bumped on process restart so a code
// deploy invalidates every client on their next bootstrap.

let CACHE_VERSION = `${Date.now().toString(36)}.${Math.floor(Math.random() * 0xffff).toString(36)}`;

/** The current cache-version token clients should compare against. */
export function currentCacheVersion(): string {
  return CACHE_VERSION;
}

/**
 * Bump the token — the next bootstrap every client fetches will carry the new
 * value and any cached screens on the client will be discarded. Called by the
 * admin endpoint (`POST /v1/admin/cache/bump`) and automatically at boot.
 */
export function bumpCacheVersion(): string {
  CACHE_VERSION = `${Date.now().toString(36)}.${Math.floor(Math.random() * 0xffff).toString(36)}`;
  return CACHE_VERSION;
}

// --- Bootstrap --------------------------------------------------------------

export function buildBootstrap(opts: { onboarded?: boolean } = {}): BootstrapResponse {
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    // Opaque cache token — clients invalidate any cached screens when this
    // changes. Bumps on every process restart plus any admin-triggered bump.
    cacheVersion: CACHE_VERSION,
    theme: THEME,
    navigation: NAV,
    // The server owns onboarding: first-run users land on the flow; everyone
    // else goes straight to the app.
    initialScreenId: opts.onboarded ? "home" : "onboarding",
    flags: {},
    // Central copy — every screen can reference these with "@key".
    labels: {
      "app.name": "Tailzu",
      "onboarding.title": "Welcome To Tailzu",
      "onboarding.subtitle": "Speak Or Type Rough — Tailzu Makes It Sound Like You.",
      "onboarding.cta": "Get Started",

      // Stats screen (see statsScreen). Kept as label refs so localisation
      // controls copy without redeploying the backend.
      "stats.title": "Your usage",
      "stats.hero.subtitle": "This month, in your voice",
      "stats.kv.weekWords": "Words this week",
      "stats.kv.audio": "Audio dictated",
      "stats.kv.saved": "Minutes saved",
      "stats.effort.template":
        "Your effort: you'd have spent {minutes} minutes typing what Tulmi cleaned up in seconds.",
      "stats.sparkline.label": "Requests, last 30 days",
      "stats.cta.history": "See history",

      // History screen (see historyScreen).
      "history.title": "History",
      "history.subtitle":
        "Every cleanup you've kept, newest first. Tap for details, long-press to remove.",
      "history.empty":
        "No history yet. Turn on 'Keep history' in your personality to start collecting your cleanups.",
      "history.detail.toast": "Detail view coming soon",
      "history.delete.error": "Couldn't reach history. Try again.",
    },
    languages: [
      { code: "en", name: "English", greeting: "Hello", regions: ["US","GB","CA","AU","IN"] },
      { code: "hi", name: "हिन्दी", greeting: "नमस्ते", regions: ["IN"] },
      { code: "es", name: "Español", greeting: "Hola", regions: ["ES","MX","AR"] },
      { code: "fr", name: "Français", greeting: "Bonjour", regions: ["FR","CA"] },
      { code: "ar", name: "العربية", greeting: "مرحبا", regions: ["AE","SA","EG"] },
      { code: "pt", name: "Português", greeting: "Olá", regions: ["PT","BR"] },
      { code: "de", name: "Deutsch", greeting: "Hallo", regions: ["DE"] },
      { code: "it", name: "Italiano", greeting: "Ciao", regions: ["IT"] },
      { code: "ru", name: "Русский", greeting: "Привет", regions: ["RU"] },
      { code: "ja", name: "日本語", greeting: "こんにちは", regions: ["JP"] },
      { code: "ko", name: "한국어", greeting: "안녕하세요", regions: ["KR"] },
      { code: "zh", name: "中文", greeting: "你好", regions: ["CN"] },
      { code: "bn", name: "বাংলা", greeting: "নমস্কার", regions: ["BD","IN"] },
      { code: "ta", name: "தமிழ்", greeting: "வணக்கம்", regions: ["IN","LK"] },
      { code: "te", name: "తెలుగు", greeting: "నమస్కారం", regions: ["IN"] },
      { code: "mr", name: "मराठी", greeting: "नमस्कार", regions: ["IN"] },
      { code: "gu", name: "ગુજરાતી", greeting: "નમસ્તે", regions: ["IN"] },
      { code: "pa", name: "ਪੰਜਾਬੀ", greeting: "ਸਤਿ ਸ੍ਰੀ ਅਕਾਲ", regions: ["IN"] },
      { code: "ur", name: "اردو", greeting: "السلام علیکم", regions: ["PK","IN"] },
      { code: "tr", name: "Türkçe", greeting: "Merhaba", regions: ["TR"] },
      { code: "id", name: "Indonesia", greeting: "Halo", regions: ["ID"] },
      { code: "vi", name: "Tiếng Việt", greeting: "Xin chào", regions: ["VN"] },
      { code: "th", name: "ไทย", greeting: "สวัสดี", regions: ["TH"] },
      { code: "nl", name: "Nederlands", greeting: "Hallo", regions: ["NL"] },
    ],
    // Version gate (dormant: thresholds are at/below the shipped app version, so
    // it won't fire — flip these to force/suggest an update from the server).
    update: {
      minVersion: "0.5.0",
      latestVersion: "1.0.0",
      title: "Update Tulmi",
      message: "A newer version of Tulmi is available with the latest improvements.",
      cta: "Update now",
      url: {
        android: "https://play.google.com/store/apps/details?id=com.tulmi.app",
        ios: "https://apps.apple.com/app/id000000000",
        default: "https://github.com/CHEDFOX/tulmi",
      },
    },
    cacheTtlSeconds: 300,
  };
}

// --- Screens ----------------------------------------------------------------

export interface ScreenContext {
  personality: Personality;
  language: string;
  email?: string;
  usage?: UsageSummary;
  /**
   * Optional per-user stats projection for the "stats" screen. Populated by
   * the screen route handler when it has been wired to fetch statsForUser();
   * when absent, the stats screen falls back to the numbers in `usage`.
   */
  stats?: StatsResponse;
  /** Pre-fetched history for the "history" screen (optional; the screen also
   * refetches via callEndpoint on mount for freshness). */
  history?: HistoryEntry[];
  name?: string;
  dictionary?: Array<{ word: string; replacement: string }>;
  frequentWords?: string[];
}

export function buildScreen(screenId: string, ctx: ScreenContext): ScreenResponse | null {
  switch (screenId) {
    case "home":
      return homeScreen(ctx);
    case "dictionary":
      return dictionaryScreen(ctx);
    case "language_select":
      return languageSelectScreen(ctx);
    case "delete_account":
      return deleteAccountScreen();
    case "reply":
      return replyScreen();
    case "personality":
      return personalityScreen(ctx.personality);
    case "settings":
      return settingsScreen(ctx);
    case "stats":
      return statsScreen(ctx);
    case "history":
      return historyScreen(ctx);
    case "onboarding":
      return onboardingWelcome();
    case "onboarding_language":
      return onboardingLanguage(ctx.language);
    case "onboarding_keyboard":
      return onboardingKeyboard();
    default:
      return null;
  }
}

/** Languages offered in onboarding + settings. */
const LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
  { value: "hinglish", label: "Hinglish" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "ar", label: "Arabic" },
  { value: "pt", label: "Portuguese" },
];

/** The refine playground — proves the full SDUI loop incl. a brain call. */
function homeScreen(ctx: ScreenContext): ScreenResponse {
  const titleStyle = { fontSize: 30, fontWeight: "800" as const, color: "$color.text", marginBottom: 24 };

  const boxWithVoice = (bindKey: string): Node => ({
    type: "Stack", style: { position: "relative" }, children: [
      { type: "TextField", bind: { value: bindKey }, props: { placeholder: "Type here…", multiline: true }, style: { paddingRight: 56, minHeight: 96 } },
      { type: "Stack", style: { position: "absolute", right: 12, top: 0, bottom: 0, justify: "center" }, children: [
        {
          type: "VoiceToggle",
          bind: { value: bindKey },
          props: { targetApp: "WhatsApp", language: "auto", size: 38 },
          on: { onError: "err" },
          // Older bundles don't have VoiceToggle in their registry. VoiceButton
          // has shipped since the initial SDUI release, drives the same bind,
          // and reads state → mic → transcript → writes back. Same product
          // outcome, one-tap-record instead of press-and-hold.
          fallback: {
            type: "VoiceButton",
            bind: { value: bindKey },
            props: { targetApp: "WhatsApp", language: "auto" },
            on: { onError: "err" },
          },
        },
      ] },
    ],
  });

  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "home",
    title: "",
    state: {
      input: "", screenContent: "", intent: "", result: "", recording: false,
      dictionary: ctx.dictionary ?? [],
      frequentWords: ctx.frequentWords ?? [],
    },
    actions: {
      err: { kind: "toast", message: "Something went wrong. Check your connection.", tone: "error" },
      openDictionary: { kind: "navigate", screenId: "dictionary" },
    },
    root: {
      type: "Screen",
      children: [
        // 1) Refine ⇄ Reply swipe (fixed-height pager inside the vertical scroll)
        // Pager is a modern (post-v1) component. Old bundles get the same two
        // panes stacked vertically via fallback — no swipe, but every screen
        // element remains reachable.
        {
          type: "Pager",
          props: { hint: true, peek: 44, height: 360 },
          children: [
            { type: "Stack", style: { paddingHorizontal: 24, paddingTop: 16 }, children: [
              { type: "Heading", props: { content: "Make it sound like you" }, style: titleStyle },
              boxWithVoice("input"),
              { type: "Spacer", style: { height: 22 } },
              { type: "Stack", style: { align: "center" }, children: [
                {
                  type: "RefineButton",
                  bind: { value: "input" },
                  props: { targetApp: "WhatsApp", language: "auto", width: 160 },
                  on: { onError: "err" },
                  // Old-bundle fallback: plain Button that fires /v1/refine
                  // via the callEndpoint action (present since v1 CORE_ACTIONS).
                  // Result is written back into `input` so the user still sees
                  // the cleaned text where they typed.
                  fallback: {
                    type: "Button",
                    props: { label: "Refine", variant: "primary" },
                    on: { onPress: {
                      kind: "callEndpoint",
                      method: "POST",
                      path: "/v1/refine",
                      body: { text: "$state.input", targetApp: "WhatsApp", language: "auto" },
                      assignTo: "input",
                      onError: "err",
                    } },
                  },
                },
              ] },
            ] },
            { type: "Stack", style: { paddingHorizontal: 24, paddingTop: 16 }, children: [
              { type: "Heading", props: { content: "Reply in your voice" }, style: titleStyle },
              { type: "TextField", bind: { value: "screenContent" }, props: { placeholder: "Paste their message…", multiline: true }, style: { minHeight: 70 } },
              { type: "Spacer", style: { height: 14 } },
              boxWithVoice("intent"),
              { type: "Spacer", style: { height: 18 } },
              { type: "Stack", style: { align: "center" }, children: [
                {
                  type: "DraftButton",
                  bind: { value: "intent" },
                  props: { messageKey: "screenContent", resultKey: "result", width: 160 },
                  on: { onError: "err" },
                  // Old-bundle fallback: plain Button that fires /v1/draft.
                  fallback: {
                    type: "Button",
                    props: { label: "Draft reply", variant: "primary" },
                    on: { onPress: {
                      kind: "callEndpoint",
                      method: "POST",
                      path: "/v1/draft",
                      body: {
                        intent: "$state.intent",
                        screenContent: "$state.screenContent",
                        targetApp: "WhatsApp",
                        language: "auto",
                      },
                      assignTo: "result",
                      onError: "err",
                    } },
                  },
                },
              ] },
            ] },
          ],
          // Pager fallback: same two children in a vertical Stack. Old bundles
          // scroll through them instead of swiping. Product usable.
          fallback: {
            type: "Stack",
            style: { direction: "column" },
            children: [
              { type: "Stack", style: { paddingHorizontal: 24, paddingTop: 16 }, children: [
                { type: "Heading", props: { content: "Make it sound like you" }, style: titleStyle },
                boxWithVoice("input"),
                { type: "Spacer", style: { height: 22 } },
                { type: "Stack", style: { align: "center" }, children: [
                  {
                    type: "Button",
                    props: { label: "Refine", variant: "primary" },
                    on: { onPress: {
                      kind: "callEndpoint",
                      method: "POST",
                      path: "/v1/refine",
                      body: { text: "$state.input", targetApp: "WhatsApp", language: "auto" },
                      assignTo: "input",
                      onError: "err",
                    } },
                  },
                ] },
              ] },
              { type: "Spacer", style: { height: 32 } },
              { type: "Stack", style: { paddingHorizontal: 24 }, children: [
                { type: "Heading", props: { content: "Reply in your voice" }, style: titleStyle },
                { type: "TextField", bind: { value: "screenContent" }, props: { placeholder: "Paste their message…", multiline: true }, style: { minHeight: 70 } },
                { type: "Spacer", style: { height: 14 } },
                boxWithVoice("intent"),
                { type: "Spacer", style: { height: 18 } },
                { type: "Stack", style: { align: "center" }, children: [
                  {
                    type: "Button",
                    props: { label: "Draft reply", variant: "primary" },
                    on: { onPress: {
                      kind: "callEndpoint",
                      method: "POST",
                      path: "/v1/draft",
                      body: {
                        intent: "$state.intent",
                        screenContent: "$state.screenContent",
                        targetApp: "WhatsApp",
                        language: "auto",
                      },
                      assignTo: "result",
                      onError: "err",
                    } },
                  },
                ] },
              ] },
            ],
          },
        },

        { type: "Spacer", style: { height: 56 } }, // HIGH gap between sections

        // 2) Dictionary (tappable header → full page)
        {
          type: "Row",
          props: { label: "Dictionary" },
          on: { onPress: "openDictionary" },
          style: { borderBottomWidth: 0, paddingVertical: 4, marginBottom: 10 },
          // Fallback: a Button labelled Dictionary (visible + tappable on old
          // bundles). Same navigate action fires.
          fallback: {
            type: "Button",
            props: { label: "Dictionary", variant: "secondary" },
            on: { onPress: "openDictionary" },
            style: { marginBottom: 10 },
          },
        },
        {
          type: "DictionaryEditor",
          bind: { value: "dictionary" },
          props: { rows: 2 },
          on: { onError: "err" },
          // Old-bundle fallback: point them to the full-page editor via the
          // Dictionary row above. Cannot inline-edit without the component.
          fallback: {
            type: "Text",
            props: { content: "Tap Dictionary above to edit your saved words.", variant: "muted" },
            style: { paddingHorizontal: 24 },
          },
        },

        { type: "Spacer", style: { height: 56 } }, // HIGH gap

        // 3) The user's frequent words (computed by the backend)
        { type: "Heading", props: { content: ctx.name ? `${ctx.name}'s words` : "Your words" }, style: { fontSize: 22, fontWeight: "800", color: "$color.text", marginBottom: 4 } },
        { type: "Text", props: { content: "Words you use often", variant: "muted" }, style: { marginBottom: 16 } },
        {
          type: "WordChips",
          bind: { value: "frequentWords" },
          // Old-bundle fallback: pre-join the words server-side into a plain
          // Text — same info, no chip layout. Empty list falls through to
          // "You haven't dictated much yet." for a friendlier empty state.
          fallback: (ctx.frequentWords ?? []).length > 0
            ? {
                type: "Text",
                props: {
                  content: (ctx.frequentWords ?? []).join(" · "),
                  variant: "muted",
                },
                style: { paddingHorizontal: 4 },
              }
            : {
                type: "Text",
                props: {
                  content: "You haven't dictated much yet.",
                  variant: "muted",
                },
                style: { paddingHorizontal: 4 },
              },
        },
      ],
    },
    cacheTtlSeconds: 0,
  };
}

/** The personality form — server seeds it with the user's saved profile. */
function personalityScreen(p: Personality): ScreenResponse {
  const SECTION = 30; // consistent gap between sections
  const chip = (label: string, group: string, value: string): Node => ({
    type: "Chip",
    props: { label, group, value },
    on: { onPress: { kind: "haptic", style: "selection" } },
  });
  const label = (content: string): Node => ({ type: "Text", props: { content, variant: "label" }, style: { marginBottom: 8 } });
  const gap = (h: number): Node => ({ type: "Spacer", style: { height: h } });

  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "personality",
    title: "",
    state: {
      form: {
        tone: p.tone ?? "",
        formality: p.formality ?? "neutral",
        emoji: p.emoji ?? "minimal",
        vocabulary: p.vocabulary ?? "",
        // preserved across saves even though they're not shown here:
        customInstructions: p.customInstructions ?? "",
        signature: p.signature ?? "",
        snippets: p.snippets ?? "",
      },
      status: "",
      sample: "",
    },
    actions: {
      save: { kind: "sequence", actions: [
        { kind: "setState", path: "status", value: "Saving…" },
        { kind: "callEndpoint", method: "PUT", path: "/v1/personality", body: "$state.form", onSuccess: "saved", onError: "saveErr" },
      ] },
      saved: { kind: "sequence", actions: [
        { kind: "setState", path: "status", value: "Saved. Tailzu writes in this voice." },
        { kind: "haptic", style: "success" },
      ] },
      saveErr: { kind: "toast", message: "Couldn't save. Check your connection.", tone: "error" },
      learn: { kind: "sequence", actions: [
        { kind: "setState", path: "status", value: "Learning your voice…" },
        { kind: "callEndpoint", method: "POST", path: "/v1/personality/learn", body: { sample: "$state.sample" }, onSuccess: "learned", onError: "saveErr" },
      ] },
      learned: { kind: "sequence", actions: [
        { kind: "haptic", style: "success" },
        { kind: "toast", message: "Learned your voice — updating…", tone: "success" },
        { kind: "refresh" },
      ] },
    },
    root: {
      type: "Screen",
      children: [
        { type: "Heading", props: { content: "Your personality" }, style: { fontSize: 30, fontWeight: "800", color: "$color.text", marginBottom: 10 } },
        { type: "Paragraph", props: { content: "Set once — it shapes everything Tailzu writes for you." }, style: { marginBottom: SECTION } },

        label("Tone"),
        { type: "TextField", bind: { value: "form.tone" }, props: { placeholder: "warm and concise, a little witty" } },
        gap(SECTION),

        label("Formality"),
        { type: "Stack", style: { direction: "row", gap: 8 }, children: [
          chip("casual", "form.formality", "casual"), chip("neutral", "form.formality", "neutral"), chip("formal", "form.formality", "formal"),
        ] },
        gap(SECTION),

        label("Emoji"),
        { type: "Stack", style: { direction: "row", gap: 8 }, children: [
          chip("none", "form.emoji", "none"), chip("minimal", "form.emoji", "minimal"), chip("expressive", "form.emoji", "expressive"),
        ] },
        gap(SECTION),

        label("Words it should know"),
        { type: "TextField", bind: { value: "form.vocabulary" }, props: { placeholder: "Aarav\nNykaa\nKubernetes", multiline: true } },
        gap(SECTION + 2),

        { type: "Button", props: { label: "Save", variant: "primary" }, on: { onPress: "save" } },
        { type: "Text", bind: { content: "status" }, props: { variant: "muted" }, style: { marginTop: 10, textAlign: "center" } },

        gap(40),
        { type: "Divider" },
        gap(28),

        label("Or learn it from a sample"),
        { type: "TextField", bind: { value: "sample" }, props: { placeholder: "Paste a few messages you've written…", multiline: true } },
        gap(14),
        { type: "Button", props: { label: "Learn my voice", variant: "secondary" }, on: { onPress: "learn" } },
      ],
    },
    cacheTtlSeconds: 0,
  };
}

/** Reply helper — drafts a personalized reply via /v1/draft. */
function replyScreen(): ScreenResponse {
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "reply",
    title: "Reply helper",
    state: { screenContent: "", intent: "", busy: false, result: {} },
    actions: {
      draft: {
        kind: "sequence",
        actions: [
          { kind: "setState", path: "busy", value: true },
          {
            kind: "callEndpoint",
            method: "POST",
            path: "/v1/draft",
            body: {
              screenContent: "$state.screenContent",
              intent: "$state.intent",
              targetApp: "WhatsApp",
              language: "auto",
            },
            assignTo: "result",
            onSuccess: "draftDone",
            onError: "draftErr",
          },
        ],
      },
      draftDone: {
        kind: "sequence",
        actions: [
          { kind: "setState", path: "busy", value: false },
          { kind: "haptic", style: "success" },
        ],
      },
      draftErr: {
        kind: "sequence",
        actions: [
          { kind: "setState", path: "busy", value: false },
          { kind: "toast", message: "Couldn't draft. Check ⚙ Connection + your key.", tone: "error" },
        ],
      },
    },
    root: {
      type: "Screen",
      children: [
        { type: "Overline", props: { content: "Reply" } },
        text("Reply helper", "h1"),
        { type: "Paragraph", props: { content: "Paste what you got, say what you mean — get a reply in your voice." }, style: { marginBottom: 20 } },
        text("What they wrote", "label"),
        {
          type: "TextField",
          bind: { value: "screenContent" },
          props: { placeholder: "Paste the message you received…", multiline: true },
        },
        spacer(12),
        text("What you want to say", "label"),
        {
          type: "TextField",
          bind: { value: "intent" },
          props: { placeholder: "politely decline, suggest next week" },
        },
        spacer(12),
        { type: "Button", props: { label: "Draft reply", variant: "primary" }, on: { onPress: "draft" } },
        spacer(16),
        { type: "ProgressBar", visibleIf: { truthy: "busy" } },
        {
          type: "Card",
          visibleIf: { truthy: "result.draftText" },
          motion: { appear: "fadeInUp" },
          children: [text("", "body", { bind: { content: "result.draftText" } })],
        },
      ],
    },
    cacheTtlSeconds: 0,
  };
}

/** Settings — server-driven app info, account, language, and links. */
function settingsScreen(ctx: ScreenContext): ScreenResponse {
  const current = LANGUAGES.find((l) => l.value === ctx.language)?.label ?? "Auto";
  // Row helper attaches a Button fallback so old TestFlight bundles (which
  // don't know the "Row" node type) still render each Settings item as a
  // tappable button. Without the fallback the entire Settings body renders
  // as null on old bundles — that was the "empty Settings" bug in the field.
  const row = (label: string, action: ActionRef, extra: Partial<Node> = {}): Node => {
    const extraProps = (extra.props as Record<string, unknown> | undefined) ?? {};
    const danger = extraProps.danger === true;
    return {
      type: "Row",
      props: { label },
      on: { onPress: action },
      ...extra,
      fallback: {
        type: "Button",
        props: {
          label,
          variant: danger ? "danger" : "secondary",
        },
        on: { onPress: action },
        style: { marginBottom: 8 },
      },
    };
  };

  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "settings",
    title: "",
    state: { language: ctx.language },
    actions: {
      signOut: { kind: "signOut" },
      privacy: { kind: "openUrl", url: "https://tailzu.space/privacy", external: true },
      terms: { kind: "openUrl", url: "https://tailzu.space/terms", external: true },
      openPersonality: { kind: "switchTab", tabId: "personality" },
      openDictionary: { kind: "navigate", screenId: "dictionary" },
      openHistory: { kind: "navigate", screenId: "history" },
      openStats: { kind: "navigate", screenId: "stats" },
    },
    root: {
      type: "Screen",
      children: [
        // Left-aligned title, tighter gap. The prior right-aligned title with a
        // 64 px gap made the list appear to be missing when the first rows fell
        // just below the fold.
        { type: "Heading", props: { content: "Settings" }, style: { fontSize: 30, fontWeight: "800", color: "$color.text", marginBottom: 20 } },

        // Personalisation
        row("Personality", "openPersonality", { props: { label: "Personality", value: "You" } }),
        row("Dictionary", "openDictionary", { props: { label: "Dictionary" } }),
        row("History", "openHistory", { props: { label: "History" } }),
        row("Stats", "openStats", { props: { label: "Stats" } }),

        // Preferences
        row("Language", { kind: "navigate", screenId: "language_select" }, { props: { label: "Language", value: current } }),

        // Legal + account
        row("Privacy Policy", "privacy", { props: { label: "Privacy Policy" } }),
        row("Terms of Use", "terms", { props: { label: "Terms of Use" } }),
        row("Sign out", "signOut", { props: { label: "Sign out", chevron: false } }),
        row("Delete account", { kind: "navigate", screenId: "delete_account" }, { props: { label: "Delete account", danger: true, chevron: false } }),
      ],
    },
    cacheTtlSeconds: 0,
  };
}

/**
 * Server-rendered usage stats screen. Prefers a fresh StatsResponse
 * (`ctx.stats`) when the screen route provides one, otherwise degrades to
 * the aggregate UsageSummary that /v1/app/screen already knows how to fetch.
 * The screen itself does no client-side fetching — see the "history" screen
 * below for the opposite pattern.
 */
function statsScreen(ctx: ScreenContext): ScreenResponse {
  const usage = ctx.usage ?? {
    month: { words: 0, audioSeconds: 0, requests: 0 },
    total: { words: 0, audioSeconds: 0, requests: 0 },
  };
  const stats = ctx.stats;
  const mins = (s: number) => Math.round(s / 60);

  // Weekly words: prefer the explicit stats projection; else derive from the
  // monthly aggregate as a rough seven-day proxy. Not perfect, but the number
  // still reads as "your recent activity" rather than a phantom placeholder.
  const wordsWeek = stats?.window === "week"
    ? stats.wordsOut
    : Math.round(usage.month.words / 4);
  const wordsMonth = usage.month.words;
  const audioSecondsMonth = usage.month.audioSeconds;
  // Same 40 wpm baseline the /v1/stats endpoint uses (see history/store.ts).
  const minutesSaved = stats?.minutesSaved ?? Math.max(0, Math.round(usage.total.words / 40));
  const typingMinutes = Math.max(1, Math.round(usage.total.words / 40));

  // NOTE: we render the sparkline as a small Unicode bar chart in a plain
  // Text node because the client renderer doesn't ship a Chart component yet.
  // Replace this with a real ChartLine node once the app registry gains one.
  const sparklineText = renderSparkline(stats?.sparklinePerDay);

  const kv = (label: string, value: string): Node => ({
    type: "KeyValue",
    props: { label, value },
    style: { flex: 1 },
  });

  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "stats",
    title: "Your usage",
    state: {},
    actions: {
      openHistory: { kind: "navigate", screenId: "history" },
    },
    root: {
      type: "Screen",
      children: [
        {
          type: "Hero",
          props: {
            title: wordsMonth.toLocaleString() + " words",
            subtitle: "This month, in your voice",
          },
        },
        spacer(20),
        {
          type: "Stack",
          style: { direction: "row", gap: 8 },
          children: [
            kv("Words this week", wordsWeek.toLocaleString()),
            kv("Audio dictated", `${mins(audioSecondsMonth)} min`),
            kv("Minutes saved", `${minutesSaved.toLocaleString()}`),
          ],
        },
        spacer(20),
        {
          type: "Paragraph",
          props: {
            content:
              `Your effort: you'd have spent ${typingMinutes.toLocaleString()} minutes typing ` +
              `what Tulmi cleaned up in seconds.`,
          },
        },
        spacer(24),
        // Sparkline block — Text-only until the renderer ships a chart node.
        text("Requests, last 30 days", "label"),
        spacer(6),
        {
          type: "Card",
          children: [
            text(sparklineText, "body", { style: { fontSize: 22, letterSpacing: 2 } }),
          ],
        },
        spacer(24),
        {
          type: "Button",
          props: { label: "See history", variant: "secondary" },
          on: { onPress: "openHistory" },
        },
      ],
    },
    cacheTtlSeconds: 0,
  };
}

/**
 * Render a request-per-day series as a compact Unicode block-chart. The input
 * is normalised to the eight-glyph ramp below; missing/empty input renders as
 * a neutral flat baseline so the screen never looks broken.
 */
function renderSparkline(series: number[] | undefined): string {
  const glyphs = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const s = series && series.length > 0 ? series : [0, 0, 0, 0, 0, 0, 0];
  const max = Math.max(1, ...s);
  return s
    .map((v) => {
      const idx = Math.max(0, Math.min(glyphs.length - 1, Math.round((v / max) * (glyphs.length - 1))));
      return glyphs[idx];
    })
    .join("");
}

/**
 * History browser. Loads the caller's opt-in cleanup history via /v1/history
 * and renders each row as a Card. Rows tap into a placeholder toast until we
 * ship a full-fat detail screen; long-press soft-deletes via /v1/history/:id.
 */
function historyScreen(ctx: ScreenContext): ScreenResponse {
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "history",
    title: "History",
    state: {
      entries: ctx.history ?? [],
      loading: false,
    },
    actions: {
      // Called on mount + after a delete succeeds — a single source of truth
      // for "get the freshest list" keeps the UI honest.
      refresh: {
        kind: "sequence",
        actions: [
          { kind: "setState", path: "loading", value: true },
          {
            kind: "callEndpoint",
            method: "GET",
            path: "/v1/history",
            assignTo: "entries",
            onSuccess: "refreshDone",
            onError: "err",
          },
        ],
      },
      refreshDone: { kind: "setState", path: "loading", value: false },
      // Tap on a card — detail view is intentionally deferred until we know
      // what belongs there beyond input/output/timestamp.
      openDetail: { kind: "toast", message: "Detail view coming soon", tone: "info" },
      // Long-press on a card — the row template resolves the entry id via a
      // "$item.id" placeholder that the renderer expands per row.
      deleteEntry: {
        kind: "sequence",
        actions: [
          {
            kind: "callEndpoint",
            method: "DELETE",
            path: "/v1/history/$item.id",
            onSuccess: "refresh",
            onError: "err",
          },
          { kind: "haptic", style: "success" },
        ],
      },
      err: { kind: "toast", message: "Couldn't reach history. Try again.", tone: "error" },
    },
    root: {
      type: "Screen",
      children: [
        {
          type: "Heading",
          props: { content: "History" },
          style: { fontSize: 30, fontWeight: "800", color: "$color.text", marginBottom: 6 },
        },
        {
          type: "Paragraph",
          props: {
            content:
              "Every cleanup you've kept, newest first. Tap for details, long-press to remove.",
          },
          style: { marginBottom: 20 },
        },
        { type: "ProgressBar", visibleIf: { truthy: "loading" } },
        {
          type: "List",
          bind: { items: "entries" },
          on: {
            onAppear: "refresh",
            onRefresh: "refresh",
          },
          props: {
            emptyLabel:
              "No history yet. Turn on 'Keep history' in your personality to start collecting your cleanups.",
            itemTemplate: {
              type: "Card",
              style: { marginBottom: 10 },
              on: {
                onPress: "openDetail",
                onLongPress: "deleteEntry",
              },
              children: [
                {
                  type: "Stack",
                  style: { direction: "row", justify: "between", align: "center" },
                  children: [
                    {
                      type: "Text",
                      bind: { content: "$item.createdAt" },
                      props: { variant: "label" },
                    },
                    {
                      type: "Badge",
                      bind: { label: "$item.targetApp" },
                      props: { tone: "accent" },
                      visibleIf: { truthy: "$item.targetApp" },
                    },
                  ],
                },
                { type: "Spacer", style: { height: 6 } },
                {
                  type: "Text",
                  bind: { content: "$item.input" },
                  props: { variant: "muted", numberOfLines: 2 },
                },
                { type: "Spacer", style: { height: 6 } },
                {
                  type: "Text",
                  bind: { content: "$item.output" },
                  props: { variant: "body", numberOfLines: 3 },
                  style: { fontWeight: "700", color: "$color.text" },
                },
              ],
            },
          },
        },
      ],
    },
    cacheTtlSeconds: 0,
  };
}

/**
 * Onboarding is a server-driven, multi-step flow:
 *   onboarding (welcome) → onboarding_language → onboarding_keyboard → home
 * Each step is its own screen; the server saves choices to the user's profile,
 * so completion is remembered server-side (not just on the device).
 */

/** A small step header used across the onboarding flow. */
function stepHeader(step: number, total: number, overline: string): Node[] {
  return [
    { type: "Spacer", style: { height: 20 } },
    { type: "Overline", props: { content: `${overline} · Step ${step} of ${total}` }, style: { textAlign: "center" } },
  ];
}

/** Step 1 — welcome + what Tulmi does. */
function onboardingWelcome(): ScreenResponse {
  const feature = (title: string, body: string): Node => ({
    type: "Stack",
    style: { direction: "column", gap: 4 },
    motion: { appear: "fadeInUp" },
    children: [
      { type: "Text", props: { content: title }, style: { color: "$color.text", fontSize: 16, fontWeight: "500", letterSpacing: 0.3 } },
      { type: "Paragraph", props: { content: body }, style: { marginBottom: 0 } },
    ],
  });
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "onboarding",
    title: "Welcome",
    template: "scroll",
    state: {},
    actions: { next: { kind: "navigate", screenId: "onboarding_language" } },
    blocks: [
      ...stepHeader(1, 3, "Welcome"),
      { type: "Heading", props: { content: "@onboarding.title" }, style: { textAlign: "center", fontSize: 30, lineHeight: 38, marginBottom: 12 } },
      { type: "Paragraph", props: { content: "@onboarding.subtitle" }, style: { textAlign: "center", marginBottom: 36 } },
      {
        type: "Stack",
        style: { direction: "column", gap: 22 },
        children: [
          feature("🎙️  Talk, don't type", "Tap the mic on the Tulmi keyboard and just speak."),
          feature("✨  One-tap polish", "Refine turns messy text into clean, clear writing."),
          feature("💬  Replies in your voice", "Paste a message, say your intent, get a perfect reply."),
          feature("🎚️  Always you", "Set your tone once — every word matches your style."),
        ],
      },
      { type: "Spacer", style: { height: 40 } },
      { type: "Button", props: { label: "Continue", variant: "primary" }, on: { onPress: "next" } },
    ],
    cacheTtlSeconds: 0,
  };
}

/** Step 2 — pick the main language; saved to the profile on Continue. */
function onboardingLanguage(current: string): ScreenResponse {
  const chip = (l: { value: string; label: string }): Node => ({
    type: "Chip",
    props: { label: l.label, group: "language", value: l.value },
    on: { onPress: { kind: "haptic", style: "selection" } },
  });
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "onboarding_language",
    title: "Language",
    template: "scroll",
    state: { language: current || "auto" },
    actions: {
      next: {
        kind: "sequence",
        actions: [
          { kind: "callEndpoint", method: "PUT", path: "/v1/profile", body: { language: "$state.language" } },
          { kind: "navigate", screenId: "onboarding_keyboard" },
        ],
      },
    },
    blocks: [
      ...stepHeader(2, 3, "Your language"),
      { type: "Heading", props: { content: "What do you mostly speak?" }, style: { textAlign: "center", fontSize: 26, lineHeight: 32, marginBottom: 10 } },
      { type: "Paragraph", props: { content: "Tulmi works in many languages. Pick your main one — you can change it anytime in Settings." }, style: { textAlign: "center", marginBottom: 28 } },
      {
        type: "Stack",
        style: { direction: "row", gap: 8, wrap: "wrap", justify: "center" },
        children: LANGUAGES.map(chip),
      },
      { type: "Spacer", style: { height: 40 } },
      { type: "Button", props: { label: "Continue", variant: "primary" }, on: { onPress: "next" } },
    ],
    cacheTtlSeconds: 0,
  };
}

/** Step 3 — enable the Tulmi keyboard, then finish (marks onboarded). */
function onboardingKeyboard(): ScreenResponse {
  const step = (n: string, body: string): Node => ({
    type: "Stack", style: { direction: "row", gap: 12 }, children: [
      { type: "Text", props: { content: n }, style: { color: "$color.text", fontSize: 16, fontWeight: "700" } },
      { type: "Paragraph", props: { content: body }, style: { marginBottom: 0, flex: 1 } },
    ],
  });
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "onboarding_keyboard",
    title: "",
    template: "scroll",
    state: { keyboardReady: false, dictationSample: "" }, // the app overwrites keyboardReady live
    actions: {
      err: {
        kind: "toast",
        tone: "error",
        message: "Voice failed. Check your connection.",
      },
      // Prefer openUrl("app-settings:") over openSettings — same underlying
      // iOS mechanism but a different Linking code path. Critically, this
      // action only reliably opens iOS Settings AFTER at least one permission
      // has been requested (mic/notif/etc.) — before that, iOS has no
      // per-app Settings surface and the URL resolves silently. The
      // "Try dictating" step above intentionally fires the mic permission
      // prompt, so by the time the user reaches this button Tulmi has a
      // Settings page to route to.
      openSettings: {
        kind: "sequence",
        actions: [
          { kind: "openUrl", url: "app-settings:", external: true },
          { kind: "toast", tone: "info", message: "In Settings: General → Keyboard → Keyboards → Add New → Tailzu" },
        ],
      },
      // Split the finish flow so `switchTab` only runs after the PUT succeeds.
      // Previously the write was fire-and-forget: any network blip / 401 / 5xx
      // was swallowed and the user still visually "completed" onboarding,
      // producing the "home tab + onboarding content" loop on next launch.
      finish: {
        kind: "callEndpoint",
        method: "PUT",
        path: "/v1/profile",
        body: { onboarded: true },
        onSuccess: "finishOk",
        onError: "finishErr",
      },
      finishOk: {
        kind: "sequence",
        actions: [
          { kind: "haptic", style: "success" },
          { kind: "switchTab", tabId: "home" },
        ],
      },
      finishErr: {
        kind: "toast",
        tone: "error",
        message: "Couldn't finish setup. Check your connection and try again.",
      },
      // Escape hatch — user can skip onboarding even if `keyboardReady` never
      // flips true (e.g. the iOS keyboard extension isn't installed on this
      // build, or Full Access can't be detected). Same server confirmation as
      // finish, so the flag actually persists.
      skip: {
        kind: "callEndpoint",
        method: "PUT",
        path: "/v1/profile",
        body: { onboarded: true },
        onSuccess: "finishOk",
        onError: "finishErr",
      },
    },
    blocks: [
      // STEP 1: Try dictating — this is genuinely a nice preview of the
      // product AND has a critical side-effect: tapping the mic triggers
      // iOS's mic-permission prompt. That prompt is what gives Tulmi a
      // per-app Settings page. Without it, tapping "Open Settings" below
      // resolves silently on iOS (nothing to route to). So the two-step
      // "Try voice → then Settings" ordering isn't just onboarding UX —
      // it's what makes the Settings button actually work.
      { type: "Card", children: [
        { type: "Heading", props: { content: "Try Tulmi's voice first" }, style: { fontSize: 20, fontWeight: "800", color: "$color.text", marginBottom: 6 } },
        { type: "Paragraph", props: { content: "Tap the mic and say anything. We'll clean it up in your voice." }, style: { marginBottom: 14 } },
        {
          type: "Stack", style: { position: "relative" }, children: [
            { type: "TextField", bind: { value: "dictationSample" }, props: { placeholder: "Your dictation appears here…", multiline: true }, style: { paddingRight: 56, minHeight: 84 } },
            { type: "Stack", style: { position: "absolute", right: 12, top: 0, bottom: 0, justify: "center" }, children: [
              {
                type: "VoiceToggle",
                bind: { value: "dictationSample" },
                props: { targetApp: "Notes", language: "auto", size: 34 },
                on: { onError: "err" },
                fallback: {
                  type: "VoiceButton",
                  bind: { value: "dictationSample" },
                  props: { targetApp: "Notes", language: "auto" },
                  on: { onError: "err" },
                },
              },
            ] },
          ],
        },
      ] },

      { type: "Spacer", style: { height: 20 } },

      // STEP 2: The keyboard-enable card. Apple does NOT allow deep-linking
      // into Settings > Keyboards, so the button below only lands on Tulmi's
      // own Settings page (which now exists because mic was requested
      // above). Show every navigation step so the user knows the path.
      { type: "Card", children: [
        { type: "Heading", props: { content: "Now enable the Tulmi keyboard" }, style: { fontSize: 20, fontWeight: "800", color: "$color.text", marginBottom: 10 } },
        step("1", "Open Settings, then tap General."),
        { type: "Spacer", style: { height: 12 } },
        step("2", "Tap Keyboard → Keyboards → Add New Keyboard."),
        { type: "Spacer", style: { height: 12 } },
        step("3", "Choose Tailzu from the list."),
        { type: "Spacer", style: { height: 12 } },
        step("4", "Tap Tailzu again and turn on “Allow Full Access”."),
        { type: "Spacer", style: { height: 12 } },
        step("5", "Return to Tailzu — the 🌐 globe key switches between keyboards."),
      ] },
      { type: "Spacer", style: { height: 22 } },
      // "Open Settings" (not "Open Keyboard Settings") — iOS can't deliver
      // what the old label promised; be honest about where the button lands.
      { type: "Button", visibleIf: { not: { truthy: "keyboardReady" } },
        props: { label: "Open Settings", variant: "primary" }, on: { onPress: "openSettings" } },
      { type: "Button", visibleIf: { truthy: "keyboardReady" },
        props: { label: "Start Using Tailzu", variant: "primary" }, on: { onPress: "finish" } },
      { type: "Spacer", style: { height: 14 } },
      // Ghost / text-only "Skip" so users aren't trapped if they can't or
      // won't add the keyboard right now.
      { type: "Button", visibleIf: { not: { truthy: "keyboardReady" } },
        props: { label: "Skip for now", variant: "secondary" }, on: { onPress: "skip" } },
    ],
    cacheTtlSeconds: 0,
  };
}

function dictionaryScreen(ctx: ScreenContext): ScreenResponse {
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "dictionary",
    title: "Dictionary",
    state: { dictionary: ctx.dictionary ?? [] },
    actions: { err: { kind: "toast", message: "Couldn't save.", tone: "error" } },
    root: { type: "Screen", children: [
      { type: "Heading", props: { content: "Dictionary" }, style: { fontSize: 28, fontWeight: "800", color: "$color.text", marginBottom: 8 } },
      { type: "Paragraph", props: { content: "Type the word, get the replacement — anywhere you use the Tailzu keyboard." }, style: { marginBottom: 28 } },
      { type: "DictionaryEditor", bind: { value: "dictionary" }, props: { full: true }, on: { onError: "err" } },
    ] },
    cacheTtlSeconds: 0,
  };
}

function languageSelectScreen(ctx: ScreenContext): ScreenResponse {
  const row = (l: { value: string; label: string }): Node => ({
    type: "Row",
    props: { label: l.label, value: l.value === ctx.language ? "✓" : "", chevron: false },
    on: { onPress: { kind: "sequence", actions: [
      { kind: "haptic", style: "selection" },
      { kind: "callEndpoint", method: "PUT", path: "/v1/profile", body: { language: l.value } },
      { kind: "navigateBack" },
    ] } },
  });
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "language_select",
    title: "Language",
    state: { language: ctx.language },
    actions: {},
    root: { type: "Screen", children: LANGUAGES.map(row) },
    cacheTtlSeconds: 0,
  };
}

function deleteAccountScreen(): ScreenResponse {
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "delete_account",
    title: "",
    state: {},
    actions: {
      confirm: { kind: "sequence", actions: [
        { kind: "callEndpoint", method: "DELETE", path: "/v1/account", onError: "err" },
        { kind: "signOut" },
      ] },
      err: { kind: "toast", message: "Couldn't delete the account. Try again.", tone: "error" },
    },
    root: { type: "Screen", children: [
      { type: "Heading", props: { content: "Delete account" }, style: { fontSize: 28, fontWeight: "800", color: "$color.text", marginBottom: 14 } },
      { type: "Paragraph", props: { content: "This permanently deletes your account, your personality, and your usage. This cannot be undone." }, style: { marginBottom: 32 } },
      { type: "Button", props: { label: "Delete my account", variant: "danger" }, on: { onPress: "confirm" } },
      { type: "Spacer", style: { height: 10 } },
      { type: "Button", props: { label: "Cancel", variant: "secondary" }, on: { onPress: { kind: "navigateBack" } } },
    ] },
    cacheTtlSeconds: 0,
  };
}

// --- Keyboard config (server-driven keyboard; cached by the native shell) ----

export function buildKeyboardConfig(): KeyboardConfigResponse {
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    theme: {
      // Match Apple's iOS 17 dark-mode system keyboard as closely as the
      // extension can render — same silhouette, same contrast, same tap
      // feedback — so the Tulmi keyboard reads as "a normal iOS keyboard"
      // before we layer any brand accents on top. Brand-orange call-to-action
      // is intentionally NOT set on accent right now; the return / refine
      // buttons render neutral. Add the accent back in a follow-up commit
      // once the base UX is proven identical to system.
      //
      // Colors are HEX ONLY — the native Swift + Kotlin extensions parse
      // "#RRGGBB" and fall through to a dim default on rgba() / hsl().
      background: "#000000",
      key: "#48484a",           // Apple letter-key grey, dark mode
      keyText: "#FFFFFF",       // solid hex — no rgba, no fallback
      accent: "#48484a",        // neutral (matches keys) — brand touch added later
      keyPressed: "#6c6c70",    // Apple-like brighter tap-highlight
    },
    layouts: [
      {
        language: "en",
        rows: [
          ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
          ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
          ["{shift}", "z", "x", "c", "v", "b", "n", "m", "{backspace}"],
          ["{globe}", "{mic}", "{refine}", "{space}", "{return}"],
        ],
      },
    ],
    features: { voice: true, refine: true, streaming: false },
    labels: {
      refine: "✨ Refine",
      listening: "Listening… tap to stop",
      transcribing: "Transcribing…",
      refining: "Refining…",
      space: "space",
      return: "return",
      needFullAccess: "Enable Full Access to use voice + Refine.",
    },
    // Was 600 (10 min). A live theme fix couldn't reach users mid-session.
    // 60 s keeps cost negligible and lets themed rollouts hit within a minute.
    cacheTtlSeconds: 60,
  };
}
