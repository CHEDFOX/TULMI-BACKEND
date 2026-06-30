/**
 * Tulmi — Server-Driven UI (SDUI) contract.
 *
 * This is the SECOND source of truth, alongside ./api.ts. Where api.ts defines
 * the "brain" endpoints (transcribe, refine, draft, speak, personality), THIS
 * file defines how the backend drives the entire UI of the main app.
 *
 * Philosophy: the frontend is a GENERIC RENDERER. It knows how to draw a fixed
 * set of primitive components and how to obey a fixed set of declarative
 * actions. It has NO hardcoded screens. The backend sends a Screen document
 * (a tree of Nodes) and the renderer draws it. Change the JSON on the server →
 * the whole app changes, with no new build.
 *
 * Keep this file framework-free so both the backend and the RN renderer import
 * it directly.
 */

// ===========================================================================
// 0. Versioning & capability negotiation
// ===========================================================================
//
// The renderer ships once and lives for a long time; the server evolves daily.
// To stay safe, the client tells the server what it can render, and the server
// promises never to emit a node/action the client doesn't understand. Unknown
// nodes still degrade gracefully (see Node.fallback).

/** Bumped only on breaking changes to this contract. */
export const SDUI_SCHEMA_VERSION = 1;

export interface ClientCapabilities {
  /** SDUI_SCHEMA_VERSION the renderer was built against. */
  schemaVersion: number;
  /** Native app/renderer version, e.g. "1.4.0". */
  appVersion: string;
  platform: "ios" | "android";
  /** Component `type`s this build can render (the registry keys). */
  components: string[];
  /** Action `kind`s this build can execute. */
  actions: string[];
  /** Device hints the server may use for layout/theming decisions. */
  device?: {
    width: number;
    height: number;
    scale: number;
    colorScheme: "light" | "dark";
    locale: string;
    reduceMotion?: boolean;
  };
}

// ===========================================================================
// 1. Bootstrap — the app's entry point
// ===========================================================================
//
// On launch the client POSTs its capabilities to /v1/app/bootstrap and gets
// back the global theme, the navigation shell (e.g. tab bar), and the id of the
// first screen to load. Everything after that is screen fetches + actions.

export interface BootstrapRequest {
  capabilities: ClientCapabilities;
  /** Opaque session/auth token if the user is signed in. */
  authToken?: string;
}

export interface BootstrapResponse {
  schemaVersion: number;
  /** Global design tokens; individual screens may override pieces. */
  theme: ThemeTokens;
  /** The app-level navigation chrome (tabs / stack). */
  navigation: NavigationShell;
  /** Screen to render first. */
  initialScreenId: string;
  /** Optional remote feature flags the renderer can read in conditions. */
  flags?: Record<string, boolean | number | string>;
  /**
   * Central copy: every user-facing string the app can show. Nodes reference
   * a label with "@key" (e.g. props.content = "@home.title"), so ALL wording is
   * controlled from the backend and reusable across screens.
   */
  labels?: Record<string, string>;
  /** Version gating — force or suggest an app update from the server. */
  update?: UpdateGate;
  /** Languages for the native post-auth picker (code/name/greeting). */
  languages?: LanguageOption[];
  /** Seconds the client may cache bootstrap before refetching. */
  cacheTtlSeconds?: number;
}

export interface LanguageOption {
  code: string;
  name: string;
  greeting: string;
  regions?: string[];
}

/**
 * Lets the backend block or nudge old app versions without an app-store action.
 * The client sends its appVersion in capabilities; the server returns thresholds.
 */
export interface UpdateGate {
  /** Apps below this are hard-blocked with a non-dismissible screen. */
  minVersion?: string;
  /** Apps below this (but >= minVersion) see a dismissible prompt. */
  latestVersion?: string;
  title?: string;
  message?: string;
  cta?: string;
  /** Where the CTA sends the user (store links). */
  url?: { ios?: string; android?: string; default?: string };
}

/** The persistent navigation chrome. Either a tab bar or a plain stack. */
export type NavigationShell =
  | {
      kind: "tabs";
      tabs: Array<{
        id: string;
        title: string;
        icon?: string;
        screenId: string;
      }>;
    }
  | { kind: "stack"; rootScreenId: string };

// ===========================================================================
// 2. Screen documents
// ===========================================================================
//
// A Screen is fetched from /v1/app/screen and is a tree of Nodes plus the data,
// named actions, and theme overrides it needs. The renderer walks `root` and
// draws each Node via its component registry.

export interface ScreenRequest {
  screenId: string;
  capabilities: ClientCapabilities;
  authToken?: string;
  /** Params passed by a `navigate` action (e.g. an item id). */
  params?: Record<string, unknown>;
}

export interface ScreenResponse {
  schemaVersion: number;
  screenId: string;
  /** Shown in the nav bar; omit for a custom header inside `root`. */
  title?: string;
  /** Per-screen theme overrides merged over the global theme. */
  theme?: Partial<ThemeTokens>;
  /**
   * Two ways to describe a screen:
   *  1. `root` — a full, hand-built Node tree (max flexibility).
   *  2. `template` + `blocks` — name a layout the app already knows ("feature",
   *     "list", "scroll"…) and hand it content blocks; the app composes the
   *     chrome. Same idea as Plutto's templates. Provide one or the other.
   */
  template?: string;
  /** Content blocks for the named template (when `template` is set). */
  blocks?: Node[];
  /** The component tree (when not using a template). */
  root?: Node;
  /**
   * Initial client-side state for this screen. Nodes bind to it via `bind`,
   * and actions mutate it via `setState`. Keys are dot-paths.
   */
  state?: Record<string, unknown>;
  /** Named actions referenced by Nodes via ActionRef. Keeps the tree small. */
  actions?: Record<string, ActionSpec>;
  /** Seconds the client may cache this screen. 0 = always refetch. */
  cacheTtlSeconds?: number;
}

// ===========================================================================
// 3. Nodes — the component tree
// ===========================================================================
//
// `type` is a registry key the renderer maps to a native/RN component. The
// renderer ships a fixed set (below); the server may only use types the client
// advertised in capabilities.components. Everything visual — text, layout,
// inputs, lists, images, motion — is expressed as Nodes.

export interface Node {
  /** Registry key, e.g. "Stack" | "Text" | "Button" | "TextField" | "Image". */
  type: string;
  /** Stable id (for state binding, lists, and analytics). */
  id?: string;
  /** Type-specific properties (e.g. Text.content, Image.source). */
  props?: Record<string, unknown>;
  /** Visual style; values may be raw or theme-token refs ("$color.primary"). */
  style?: StyleProps;
  /** Child nodes (for containers like Stack/Card/List). */
  children?: Node[];
  /**
   * Bind a prop to live state/data by dot-path, e.g. { value: "form.email" }.
   * Re-renders when that state changes.
   */
  bind?: Record<string, string>;
  /** Event handlers → action references. e.g. { onPress: "submit" }. */
  on?: Partial<Record<NodeEvent, ActionRef>>;
  /** Entry/exit animation for this node. */
  motion?: MotionSpec;
  /** Render only when this condition is truthy (flag/state driven). */
  visibleIf?: Condition;
  /** Rendered if the client can't draw `type` (forward-compat safety net). */
  fallback?: Node;
}

export type NodeEvent =
  | "onPress"
  | "onLongPress"
  | "onChange"
  | "onSubmit"
  | "onAppear"
  | "onDisappear"
  | "onRefresh"
  | "onEndReached"
  | "onResult" // async component produced a value (e.g. VoiceButton transcript)
  | "onError"; // async component failed

/**
 * The component registry the v1 renderer ships. The server discovers the real
 * set from capabilities.components, but this is the baseline contract.
 */
export const CORE_COMPONENTS = [
  "Screen", // scroll/safe-area root
  "Stack", // flex container (props.direction: "row" | "column")
  "Spacer", // flexible/empty space
  "Text", // props.content, props.variant ("h1"|"body"|"caption"…)
  "Image", // props.source (url), props.aspectRatio
  "Icon", // props.name
  "Button", // props.label, props.variant; on.onPress
  "TextField", // props.placeholder, bind.value; on.onChange
  "Chip", // selectable pill; props.label, props.selected
  "Card", // elevated container
  "List", // props.items (data path) + props.itemTemplate (Node)
  "Divider",
  "ProgressBar",
  "VoiceButton", // records mic → /v1/transcribe-clean → bind.value
  // SDUI v2 content blocks:
  "Heading", // props.content
  "Paragraph", // props.content
  "Badge", // props.label, props.tone ("accent")
  "KeyValue", // props.label, props.value
  "Hero", // props.title, props.subtitle, props.image
] as const;

/** Named layouts for `template` + `blocks` screens. */
export const CORE_TEMPLATES = ["scroll", "feature", "list", "centered"] as const;

// ===========================================================================
// 4. Actions — declarative behavior
// ===========================================================================
//
// Nodes reference actions by name (ActionRef) and the renderer interprets them.
// This is how the backend controls flow, navigation, network calls, haptics,
// media, and motion without shipping code.

/** A reference to a named action in ScreenResponse.actions, or an inline spec. */
export type ActionRef = string | ActionSpec;

export type ActionSpec =
  // --- navigation & flow ---
  | { kind: "navigate"; screenId: string; params?: Record<string, unknown> }
  | { kind: "navigateBack" }
  | { kind: "switchTab"; tabId: string }
  | { kind: "openUrl"; url: string; external?: boolean }
  | { kind: "openSettings"; target?: "app" | "keyboard" }
  | { kind: "dismiss" }
  // --- data & network ---
  | {
      kind: "callEndpoint";
      method: "GET" | "POST" | "PUT" | "DELETE";
      /** Path on the backend, e.g. "/v1/personality". */
      path: string;
      /**
       * Request body. Either an object whose values may be placeholders
       * ("$state.x"), or a single placeholder string that resolves to a whole
       * subtree (e.g. "$state.form" → send the form object as the body).
       */
      body?: Record<string, unknown> | string;
      /** Store the JSON response at this state path. */
      assignTo?: string;
      onSuccess?: ActionRef;
      onError?: ActionRef;
    }
  | { kind: "refresh" } // re-fetch the current screen
  // --- local state ---
  | { kind: "setState"; path: string; value: unknown }
  | { kind: "toggleState"; path: string }
  // --- feedback & sensory ---
  | { kind: "haptic"; style: HapticStyle }
  | { kind: "toast"; message: string; tone?: "info" | "success" | "error" }
  | { kind: "playMedia"; url: string }
  | { kind: "speak"; text: string } // uses /v1/speak under the hood
  | { kind: "signOut" } // clears the Supabase session; app returns to the auth gate
  // --- composition ---
  | { kind: "sequence"; actions: ActionRef[] }
  | { kind: "condition"; if: Condition; then: ActionRef; else?: ActionRef };

export type HapticStyle =
  | "light"
  | "medium"
  | "heavy"
  | "selection"
  | "success"
  | "warning"
  | "error";

/** A small expression evaluated against state + flags for visibleIf/condition. */
export type Condition =
  | { eq: [string, unknown] } // state path == value
  | { neq: [string, unknown] }
  | { truthy: string } // state/flag path is truthy
  | { not: Condition }
  | { all: Condition[] }
  | { any: Condition[] };

// ===========================================================================
// 5. Theme & style tokens
// ===========================================================================
//
// The backend owns the look. Nodes reference tokens ("$color.primary") so the
// server can re-theme the whole app by changing the token map alone.

export interface ThemeTokens {
  color: Record<string, string>; // primary, bg, surface, text, muted, danger…
  space: Record<string, number>; // xs, sm, md, lg, xl
  radius: Record<string, number>;
  font: {
    family?: string;
    sizes: Record<string, number>; // body, h1, caption…
    weights: Record<string, string>; // regular, bold…
  };
}

/** Style values: raw (number/string) or a token ref string starting with "$". */
export type StyleValue = string | number;

export interface StyleProps {
  // layout
  flex?: number;
  direction?: "row" | "column";
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between" | "around";
  gap?: StyleValue;
  padding?: StyleValue;
  margin?: StyleValue;
  width?: StyleValue;
  height?: StyleValue;
  // visual
  background?: StyleValue;
  color?: StyleValue;
  radius?: StyleValue;
  borderWidth?: number;
  borderColor?: StyleValue;
  opacity?: number;
  fontSize?: StyleValue;
  fontWeight?: StyleValue;
  textAlign?: "left" | "center" | "right";
  [key: string]: unknown; // forward-compat; unknown keys ignored by renderer
}

// ===========================================================================
// 6. Motion
// ===========================================================================

export interface MotionSpec {
  appear?: MotionPreset;
  exit?: MotionPreset;
  durationMs?: number;
  delayMs?: number;
  /** Loops (e.g. a pulsing record button). */
  loop?: boolean;
}

export type MotionPreset =
  | "fade"
  | "fadeInUp"
  | "fadeInDown"
  | "scaleIn"
  | "slideInLeft"
  | "slideInRight"
  | "pulse";

// ===========================================================================
// 7. Keyboard config (the OS-legal "SDUI" for the keyboard)
// ===========================================================================
//
// The keyboard is a sandboxed native extension that must draw instantly and
// work offline, so it cannot live-render from the server per keystroke. Instead
// it fetches this config (GET /v1/keyboard/config), CACHES it, and refreshes in
// the background. This server-controls theme, layout, languages, copy, and which
// features are on — while the "brain" (refine/transcribe/tone) stays live API.

export interface KeyboardConfigResponse {
  schemaVersion: number;
  theme: {
    background: string;
    key: string;
    keyText: string;
    accent: string; // the ✨ Refine / active color
    keyPressed: string;
  };
  /** Enabled key layouts, one per language; first is default. */
  layouts: KeyboardLayout[];
  /** Feature switches the native shell honors. */
  features: {
    voice: boolean;
    refine: boolean;
    /** Show a live-streaming dictation UI vs. one-shot. */
    streaming: boolean;
  };
  /** All user-facing strings, so copy is server-controlled. */
  labels: Record<string, string>; // e.g. { refine: "✨ Refine", listening: "Listening…" }
  /** Seconds before the shell refetches config. */
  cacheTtlSeconds: number;
}

export interface KeyboardLayout {
  /** ISO code or name, e.g. "en", "hi", "hinglish". */
  language: string;
  /** Rows of key captions; specials use tokens like "{shift}" "{space}". */
  rows: string[][];
}
