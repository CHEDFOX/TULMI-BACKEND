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
  BootstrapResponse,
  KeyboardConfigResponse,
  NavigationShell,
  Node,
  ScreenResponse,
  ThemeTokens,
} from "../../../shared/types/sdui.js";
import { SDUI_SCHEMA_VERSION } from "../../../shared/types/sdui.js";
import type { Personality, UsageSummary } from "../../../shared/types/api.js";

// --- Global theme -----------------------------------------------------------

export const THEME: ThemeTokens = {
  color: {
    bg: "#0a0a0d", // near-black
    surface: "#101015",
    card: "#121219",
    inputBg: "#16161d",
    border: "rgba(255,255,255,0.10)",
    primary: "#5b4bff", // Tulmi accent (swap from the backend anytime)
    text: "rgba(255,255,255,0.94)", // headings / primary text
    body: "rgba(255,255,255,0.72)", // body prose
    muted: "rgba(255,255,255,0.55)", // secondary
    label: "rgba(255,255,255,0.38)", // overlines / faint labels
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
    { id: "reply", title: "Reply", screenId: "reply" },
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

// --- Bootstrap --------------------------------------------------------------

export function buildBootstrap(opts: { onboarded?: boolean } = {}): BootstrapResponse {
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    theme: THEME,
    navigation: NAV,
    // The server owns onboarding: first-run users land on the flow; everyone
    // else goes straight to the app.
    initialScreenId: opts.onboarded ? "home" : "onboarding",
    flags: {},
    // Central copy — every screen can reference these with "@key".
    labels: {
      "app.name": "Tulmi",
      "onboarding.title": "Welcome to Tulmi",
      "onboarding.subtitle": "Speak or type rough — Tulmi makes it sound like you.",
      "onboarding.cta": "Get started",
      "home.refine": "✨ Refine",
      "common.save": "Save",
    },
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
}

export function buildScreen(screenId: string, ctx: ScreenContext): ScreenResponse | null {
  switch (screenId) {
    case "home":
      return homeScreen(ctx);
    case "reply":
      return replyScreen();
    case "personality":
      return personalityScreen(ctx.personality);
    case "settings":
      return settingsScreen(ctx);
    case "stats":
      return statsScreen(ctx.usage);
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
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "home",
    title: "Tulmi",
    state: {
      input: "hey can we meet kal at 5 i think um",
      busy: false,
      result: {},
    },
    actions: {
      refine: {
        kind: "sequence",
        actions: [
          { kind: "setState", path: "busy", value: true },
          {
            kind: "callEndpoint",
            method: "POST",
            path: "/v1/refine",
            body: { text: "$state.input", targetApp: "WhatsApp", language: "auto" },
            assignTo: "result",
            onSuccess: "refineDone",
            onError: "refineErr",
          },
        ],
      },
      refineDone: {
        kind: "sequence",
        actions: [
          { kind: "setState", path: "busy", value: false },
          { kind: "haptic", style: "success" },
        ],
      },
      refineErr: {
        kind: "sequence",
        actions: [
          { kind: "setState", path: "busy", value: false },
          { kind: "toast", message: "Couldn't reach the backend. Check ⚙ Connection.", tone: "error" },
        ],
      },
      voiceErr: { kind: "toast", message: "Voice failed. Allow mic + check your key.", tone: "error" },
    },
    root: {
      type: "Screen",
      children: [
        { type: "Overline", props: { content: "Playground" } },
        { type: "Heading", props: { content: "Make it sound like you" } },
        { type: "Paragraph", props: { content: "Type something rough, then ✨ Refine — or just speak it." }, style: { marginBottom: 22 } },
        { type: "Text", props: { content: "Your text", variant: "label" } },
        {
          type: "TextField",
          bind: { value: "input" },
          props: { placeholder: "Type here…", multiline: true },
        },
        spacer(10),
        {
          type: "Button",
          props: { label: "✨ Refine", variant: "primary" },
          on: { onPress: "refine" },
        },
        spacer(10),
        text("Or speak — it fills the box above:", "label"),
        {
          type: "VoiceButton",
          bind: { value: "input" },
          props: { targetApp: "WhatsApp", language: ctx.language ?? "auto", live: true },
          on: { onError: "voiceErr" },
        },
        spacer(16),
        { type: "ProgressBar", visibleIf: { truthy: "busy" } },
        {
          type: "Card",
          visibleIf: { truthy: "result.refinedText" },
          motion: { appear: "fadeInUp" },
          children: [text("", "body", { bind: { content: "result.refinedText" } })],
        },
      ],
    },
    cacheTtlSeconds: 0,
  };
}

/** The personality form — server seeds it with the user's saved profile. */
function personalityScreen(p: Personality): ScreenResponse {
  const chip = (label: string, group: string, value: string): Node => ({
    type: "Chip",
    props: { label, group, value },
    on: { onPress: { kind: "haptic", style: "selection" } },
  });

  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "personality",
    title: "Your personality",
    state: {
      form: {
        tone: p.tone ?? "",
        formality: p.formality ?? "neutral",
        emoji: p.emoji ?? "minimal",
        customInstructions: p.customInstructions ?? "",
        signature: p.signature ?? "",
        vocabulary: p.vocabulary ?? "",
        snippets: p.snippets ?? "",
      },
      status: "",
      sample: "",
    },
    actions: {
      save: {
        kind: "sequence",
        actions: [
          { kind: "setState", path: "status", value: "Saving…" },
          {
            kind: "callEndpoint",
            method: "PUT",
            path: "/v1/personality",
            body: "$state.form",
            onSuccess: "saved",
            onError: "saveErr",
          },
        ],
      },
      saved: {
        kind: "sequence",
        actions: [
          { kind: "setState", path: "status", value: "Saved. Tulmi will write in this voice." },
          { kind: "haptic", style: "success" },
        ],
      },
      saveErr: { kind: "toast", message: "Couldn't save. Check ⚙ Connection.", tone: "error" },
      learn: {
        kind: "sequence",
        actions: [
          { kind: "setState", path: "status", value: "Learning your voice…" },
          { kind: "callEndpoint", method: "POST", path: "/v1/personality/learn", body: { sample: "$state.sample" }, onSuccess: "learned", onError: "saveErr" },
        ],
      },
      learned: {
        kind: "sequence",
        actions: [
          { kind: "haptic", style: "success" },
          { kind: "toast", message: "Learned your voice — updating…", tone: "success" },
          { kind: "refresh" },
        ],
      },
    },
    root: {
      type: "Screen",
      children: [
        { type: "Overline", props: { content: "Your voice" } },
        text("Your personality", "h1"),
        { type: "Paragraph", props: { content: "Set once — applied to everything Tulmi writes for you." }, style: { marginBottom: 20 } },

        text("Tone", "label"),
        { type: "TextField", bind: { value: "form.tone" }, props: { placeholder: "warm and concise, a little witty" } },

        spacer(12),
        text("Formality", "label"),
        {
          type: "Stack",
          style: { direction: "row", gap: 8 },
          children: [
            chip("casual", "form.formality", "casual"),
            chip("neutral", "form.formality", "neutral"),
            chip("formal", "form.formality", "formal"),
          ],
        },

        spacer(12),
        text("Emoji", "label"),
        {
          type: "Stack",
          style: { direction: "row", gap: 8 },
          children: [
            chip("none", "form.emoji", "none"),
            chip("minimal", "form.emoji", "minimal"),
            chip("expressive", "form.emoji", "expressive"),
          ],
        },

        spacer(12),
        text("Extra instructions", "label"),
        {
          type: "TextField",
          bind: { value: "form.customInstructions" },
          props: { placeholder: "avoid exclamation marks; British spelling", multiline: true },
        },

        spacer(12),
        text("Words Tulmi should know", "label"),
        { type: "Paragraph", props: { content: "Names, brands, or jargon to spell right — one per line." }, style: { marginBottom: 6 } },
        {
          type: "TextField",
          bind: { value: "form.vocabulary" },
          props: { placeholder: "Aarav\nNykaa\nKubernetes", multiline: true },
        },

        spacer(12),
        text("Snippets", "label"),
        { type: "Paragraph", props: { content: "Shortcuts that expand. One per line: trigger = full text." }, style: { marginBottom: 6 } },
        {
          type: "TextField",
          bind: { value: "form.snippets" },
          props: { placeholder: "eod = I'll have this done by end of day, thanks!", multiline: true },
        },

        spacer(16),
        { type: "Button", props: { label: "Save personality", variant: "primary" }, on: { onPress: "save" } },
        spacer(8),
        text("", "muted", { bind: { content: "status" } }),

        spacer(24),
        { type: "Divider" },
        spacer(20),
        { type: "Overline", props: { content: "Or learn it automatically" } },
        text("Learn my voice from a sample", "label"),
        { type: "Paragraph", props: { content: "Paste a few of your real messages — Tulmi fills in your style above." }, style: { marginBottom: 8 } },
        {
          type: "TextField",
          bind: { value: "sample" },
          props: { placeholder: "Paste a few messages you've written…", multiline: true },
        },
        spacer(10),
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
  const langChip = (l: { value: string; label: string }): Node => ({
    type: "Chip",
    props: { label: l.label, group: "language", value: l.value },
    on: {
      onPress: {
        kind: "sequence",
        actions: [
          { kind: "haptic", style: "selection" },
          { kind: "callEndpoint", method: "PUT", path: "/v1/profile", body: { language: l.value } },
          { kind: "toast", message: `Language set to ${l.label}`, tone: "success" },
        ],
      },
    },
  });

  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "settings",
    title: "Settings",
    state: { language: ctx.language },
    actions: {
      openDocs: { kind: "openUrl", url: "https://github.com/CHEDFOX/tulmi", external: true },
      reloadApp: { kind: "refresh" },
      signOut: { kind: "signOut" },
    },
    root: {
      type: "Screen",
      children: [
        { type: "Overline", props: { content: "Tulmi" } },
        text("Settings", "h1"),
        spacer(8),
        {
          type: "Card",
          children: [
            text("Signed in", "label"),
            text(ctx.email ?? "Your account", "body"),
          ],
        },

        spacer(20),
        text("Language", "label"),
        { type: "Paragraph", props: { content: "What you mostly speak and type. Tulmi adapts to this." }, style: { marginBottom: 10 } },
        {
          type: "Stack",
          style: { direction: "row", gap: 8, wrap: "wrap" },
          children: LANGUAGES.map(langChip),
        },

        spacer(20),
        { type: "Divider" },
        spacer(20),
        text("App", "label"),
        spacer(8),
        text("Backend connection is set via the ⚙ button (top-right).", "muted"),
        spacer(12),
        { type: "Button", props: { label: "Open project on GitHub", variant: "secondary" }, on: { onPress: "openDocs" } },
        spacer(8),
        { type: "Button", props: { label: "Reload from server", variant: "secondary" }, on: { onPress: "reloadApp" } },
        spacer(8),
        { type: "Button", props: { label: "Your usage", variant: "secondary" }, on: { onPress: { kind: "navigate", screenId: "stats" } } },
        spacer(8),
        { type: "Button", props: { label: "See the intro again", variant: "secondary" }, on: { onPress: { kind: "navigate", screenId: "onboarding" } } },

        spacer(20),
        { type: "Divider" },
        spacer(20),
        text("Account", "label"),
        spacer(8),
        { type: "Button", props: { label: "Sign out", variant: "secondary" }, on: { onPress: "signOut" } },
      ],
    },
    cacheTtlSeconds: 0,
  };
}

/** Server-rendered usage stats (numbers fetched in the screen route). */
function statsScreen(usage?: UsageSummary): ScreenResponse {
  const u = usage ?? { month: { words: 0, audioSeconds: 0, requests: 0 }, total: { words: 0, audioSeconds: 0, requests: 0 } };
  const mins = (s: number) => Math.round(s / 60);
  const saved = Math.max(0, Math.round(u.total.words / 40 - u.total.audioSeconds / 60));
  const card = (value: string, caption: string): Node => ({
    type: "Card",
    style: { flex: 1, alignItems: "center" },
    children: [
      { type: "Heading", props: { content: value }, style: { fontSize: 26, marginBottom: 2 } },
      { type: "Text", props: { content: caption, variant: "label" }, style: { textAlign: "center" } },
    ],
  });
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "stats",
    title: "Your usage",
    state: {},
    root: {
      type: "Screen",
      children: [
        { type: "Overline", props: { content: "Your usage" } },
        text("This month", "h1"),
        spacer(12),
        {
          type: "Stack",
          style: { direction: "row", gap: 8 },
          children: [
            card(u.month.words.toLocaleString(), "Words"),
            card(String(mins(u.month.audioSeconds)), "Minutes dictated"),
            card(u.month.requests.toLocaleString(), "Requests"),
          ],
        },
        spacer(16),
        {
          type: "Card",
          children: [
            text("≈ " + saved.toLocaleString() + " min", "h1"),
            text("Estimated typing time saved, all-time", "label"),
          ],
        },
        spacer(20),
        { type: "Divider" },
        spacer(20),
        text("All time", "label"),
        spacer(8),
        {
          type: "Stack",
          style: { direction: "row", gap: 8 },
          children: [
            card(u.total.words.toLocaleString(), "Words"),
            card(String(mins(u.total.audioSeconds)), "Minutes"),
            card(u.total.requests.toLocaleString(), "Requests"),
          ],
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
  const row = (n: string, body: string): Node => ({
    type: "Stack",
    style: { direction: "row", gap: 12 },
    children: [
      { type: "Text", props: { content: n }, style: { color: "$color.primary", fontSize: 16, fontWeight: "700" } },
      { type: "Paragraph", props: { content: body }, style: { marginBottom: 0, flex: 1 } },
    ],
  });
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    screenId: "onboarding_keyboard",
    title: "Enable keyboard",
    template: "scroll",
    state: {},
    actions: {
      finish: {
        kind: "sequence",
        actions: [
          { kind: "callEndpoint", method: "PUT", path: "/v1/profile", body: { onboarded: true } },
          { kind: "haptic", style: "success" },
          { kind: "switchTab", tabId: "home" },
        ],
      },
    },
    blocks: [
      ...stepHeader(3, 3, "Keyboard"),
      { type: "Heading", props: { content: "Turn on the Tulmi keyboard" }, style: { textAlign: "center", fontSize: 26, lineHeight: 32, marginBottom: 10 } },
      { type: "Paragraph", props: { content: "The Tulmi keyboard adds voice + ✨ Refine inside every app — WhatsApp, email, anywhere you type." }, style: { textAlign: "center", marginBottom: 28 } },
      {
        type: "Card",
        children: [
          row("1", "Open your phone's Settings → System → Languages & input → On-screen keyboard."),
          { type: "Spacer", style: { height: 12 } },
          row("2", "Enable “Tulmi”, then set it as your keyboard (tap the 🌐 globe key to switch)."),
          { type: "Spacer", style: { height: 12 } },
          row("3", "Allow Full Access so voice + Refine can reach the server."),
        ],
      },
      { type: "Paragraph", props: { content: "You can do this later too — it’s in Settings whenever you’re ready." }, style: { textAlign: "center", marginTop: 20 } },
      { type: "Spacer", style: { height: 32 } },
      { type: "Button", props: { label: "Finish — start using Tulmi", variant: "primary" }, on: { onPress: "finish" } },
    ],
    cacheTtlSeconds: 0,
  };
}

// --- Keyboard config (server-driven keyboard; cached by the native shell) ----

export function buildKeyboardConfig(): KeyboardConfigResponse {
  return {
    schemaVersion: SDUI_SCHEMA_VERSION,
    theme: {
      background: THEME.color.bg,
      key: THEME.color.inputBg,
      keyText: THEME.color.text,
      accent: THEME.color.primary,
      keyPressed: THEME.color.surface,
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
    features: { voice: true, refine: true, liveVoice: true },
    labels: {
      refine: "✨ Refine",
      listening: "Listening… tap to stop",
      transcribing: "Transcribing…",
      refining: "Refining…",
      space: "space",
      return: "return",
      needFullAccess: "Enable Full Access to use voice + Refine.",
    },
    cacheTtlSeconds: 600,
  };
}
