/**
 * Flow — API contract (source of truth).
 *
 * This file defines the shape of every request/response between the clients
 * (Android keyboard, later iOS) and the backend. Keep it framework-free so it
 * can be imported by the backend directly and mirrored by the Android app.
 */

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/** Audio container the client is sending. */
export type AudioFormat = "wav" | "m4a" | "webm" | "mp3" | "ogg" | "flac";

/**
 * Language hint for transcription + cleanup. Tulmi targets most world
 * languages, so this is open-ended: any ISO-639-1 code (e.g. "es", "fr", "ar",
 * "ja") is accepted. The named values are conveniences:
 * - "auto"     : let the model detect (default; best for spontaneous speech)
 * - "hi"       : primarily Hindi
 * - "en"       : primarily English
 * - "hinglish" : explicit Hindi/English code-switching (the flagship case)
 *
 * For any code-switching (Spanglish, Arabic/English, etc.), prefer "auto".
 */
export type LanguageHint = "auto" | "hi" | "en" | "hinglish" | (string & {});

/**
 * What the user is typing into, used to adapt tone/format.
 * Free-form on the wire (any app name), but these are the ones we tune for.
 */
export type TargetAppHint =
  | "WhatsApp"
  | "Slack"
  | "Gmail"
  | "Email"
  | "Messages"
  | "Notes"
  | "Search"
  | "Code"
  | "Generic"
  | (string & {});

/** Usage we record per request for metering / free-tier enforcement. */
export interface UsageRecord {
  /** Length of audio processed, in seconds (the primary meter). */
  audioSeconds: number;
  /** Word count of the cleaned output (secondary meter). */
  words: number;
  /** Cleanup model that produced the output, e.g. "anthropic/claude-haiku-4.5". */
  model: string;
}

/** Aggregated usage for the stats screen (this month + all-time). */
export interface UsageSummary {
  month: { words: number; audioSeconds: number; requests: number };
  total: { words: number; audioSeconds: number; requests: number };
}

/**
 * Three continuous style dials (0–100). Continuous instead of enum so the
 * keyboard can offer a slider that Actually Feels Like a slider, and so we can
 * A/B different midpoints without a shape change.
 *
 *   formality: 0 = "yo" / 100 = "Dear Sir/Madam"
 *   length:    0 = terse / 100 = generous, spelled-out
 *   warmth:    0 = matter-of-fact / 100 = warm, personable
 */
export interface ToneDial {
  formality?: number;
  length?: number;
  warmth?: number;
}

/**
 * Per-target-app style override — the tone dial + emoji policy that should
 * apply when the user writes into this app specifically. Everything is optional;
 * unset fields inherit the top-level Personality. Sparse by design so an app
 * like "Slack" can override only formality without changing warmth.
 */
export interface AppStyle {
  dial?: ToneDial;
  formality?: "casual" | "neutral" | "formal";
  emoji?: "none" | "minimal" | "expressive";
  /** Free-form addendum for this app, e.g. "always thread-friendly". */
  note?: string;
}

/**
 * Per-recipient hint — a plain-language note the user writes about a specific
 * contact ("my mom", "boss@work"). Non-normative — the LLM uses it as advice,
 * not a rule. Kept as a small list so the prompt stays finite.
 */
export interface RecipientHint {
  /** Free-form identifier (name, handle, or address). Compared verbatim. */
  recipient: string;
  /** e.g. "very close friend, keep it low-effort and funny". */
  hint: string;
}

/**
 * The user's personality / style profile. Set once in the app, stored in the
 * backend, and applied to every output so the text sounds like *them*. The app
 * may also pass an inline override per request.
 *
 * Legacy fields (tone/formality/emoji) still work — new fields (dial/appStyles/
 * recipientHints/watermark/learnFromSent) are additive and layer on top.
 */
export interface Personality {
  /** Free-text description of voice, e.g. "warm, concise, a little witty". */
  tone?: string;
  /** How formal the output should lean. */
  formality?: "casual" | "neutral" | "formal";
  /** How much emoji to use (only when it fits the app/context). */
  emoji?: "none" | "minimal" | "expressive";
  /** Preferred languages/scripts, in priority order (e.g. ["hinglish", "en"]). */
  languages?: LanguageHint[];
  /** Optional sign-off the user likes (only used where a sign-off fits). */
  signature?: string;
  /** Free-form extra instructions ("avoid exclamation marks", "use British spelling"). */
  customInstructions?: string;
  /** Personal dictionary: names, brands, jargon to spell exactly (one per line
   * or comma-separated). Biases speech-to-text and cleanup so the right
   * spellings come out. */
  vocabulary?: string;
  /** Text-expansion shortcuts, one per line as "trigger = expansion". The
   * cleanup step expands each trigger into its full text. */
  snippets?: string;

  // --- Style dials + per-context overrides (v2 additions) --------------------

  /** Continuous style dials — see ToneDial. Overrides `formality` when set. */
  dial?: ToneDial;
  /** Per-target-app overrides (e.g. { WhatsApp: { dial: { formality: 10 } } }). */
  appStyles?: Record<string, AppStyle>;
  /** Small list of per-contact hints applied when `recipient` matches. */
  recipientHints?: RecipientHint[];

  // --- Consent + trust flags -------------------------------------------------

  /**
   * If true, appends " · Tailzu" (or the localised equivalent) after outputs.
   * Opt-in growth mechanism — users get "sent with Tailzu" attribution.
   */
  watermark?: boolean;

  /**
   * Explicit consent for the backend to use recent outputs to improve the
   * user's saved style. If false, cleanup runs are single-shot and forgotten.
   * Default: unset → treat as false. Never inferred from anything else.
   */
  learnFromSent?: boolean;

  /**
   * Explicit consent for the backend to keep raw audio beyond the STT call.
   * Default: unset → treat as false. Today the backend deletes audio right
   * after the STT call regardless; this flag exists so a future feature (e.g.
   * "review my last dictation") can be opted into.
   */
  retainAudio?: boolean;

  /**
   * Explicit consent for the backend to keep a per-request history log
   * (input transcript/text + cleaned output) so the user can browse and
   * re-use their past cleanups. Default: unset → treat as false. Distinct
   * from `learnFromSent`: learning uses runs to improve the personality;
   * `retainHistory` just keeps the receipts. Either flag being true is
   * enough to enable history storage.
   */
  retainHistory?: boolean;
}

/**
 * "Command mode" — a trailing verbal (or typed) instruction the user tacks
 * on to alter the cleanup for this one run. E.g. "…MAKE IT SHORTER".
 *
 * See pipeline/commands.ts for the detector; the transcript minus the command
 * is what gets cleaned, and the command shapes the cleanup prompt as an
 * ephemeral, "for this run only" override that never touches saved personality.
 */
export type Command =
  | { kind: "shorter" }
  | { kind: "longer" }
  | { kind: "formal" }
  | { kind: "casual" }
  | { kind: "translate"; lang: string }
  | { kind: "bulletpoints" }
  | { kind: "emojiOff" }
  | { kind: "emojiOn" };

/** Options that shape a request (shared by voice, typing, and screen modes). */
export interface CleanupOptions {
  /** App the user is typing into; drives tone + formatting. Default "Generic". */
  targetApp?: TargetAppHint;
  /** Language hint. Default "auto". */
  language?: LanguageHint;
  /**
   * Personality override for this request. If omitted, the backend uses the
   * user's saved personality (resolved from their account).
   */
  personality?: Personality;
  /**
   * One-shot command override detected from the tail of the input
   * (e.g. "…make it shorter"). Applied as an addendum to the cleanup prompt
   * for THIS run only — never persisted, never merged into personality.
   */
  command?: Command;
  /**
   * Values the snippet expander can interpolate into user snippets — e.g.
   * `sig = — {name}` becomes `— Alex` when variables.name === "Alex". Every
   * field is optional; unset variables resolve to an empty string.
   */
  variables?: {
    name?: string;
    email?: string;
  };
}

// ---------------------------------------------------------------------------
// REST: one-shot transcribe + clean  (POST /v1/transcribe-clean)
// ---------------------------------------------------------------------------
//
// Sent as multipart/form-data:
//   - field "audio": the audio file
//   - field "targetApp" (optional)
//   - field "language"  (optional)
//
// This is the simplest path: upload a whole clip, get polished text back. It is
// what the test script and early Android builds use before live streaming.

export interface TranscribeCleanResponse {
  /** The polished, insert-ready text. */
  cleanedText: string;
  /** The raw STT output, before cleanup (useful for debugging/QA). */
  transcript: string;
  usage: UsageRecord;
}

// ---------------------------------------------------------------------------
// WebSocket: live streaming  (wss://host/v1/stream)
// ---------------------------------------------------------------------------
//
// Sequence:
//   1. client → { type: "start", ... }
//   2. client → binary audio frames (raw bytes of the chosen format)
//   3. client → { type: "end" }
//   4. server → "transcript" (once), then "cleaned_delta" (many), then "done"
//   Any time → server may send "error".

export const WS_PATH = "/v1/stream";

/** Control messages the client sends (JSON). Audio itself is sent as binary frames. */
export type ClientMessage =
  | ({
      type: "start";
      format: AudioFormat;
      /** Sample rate of the audio being streamed, e.g. 16000. */
      sampleRate: number;
    } & CleanupOptions)
  | { type: "end" };

/** Messages the server sends back (JSON). */
export type ServerMessage =
  | { type: "ready" } // server accepted "start", client may begin sending audio
  | { type: "transcript"; text: string } // raw STT result
  | { type: "cleaned_delta"; text: string } // incremental cleaned tokens
  | { type: "done"; cleanedText: string; usage: UsageRecord }
  | { type: "error"; code: ErrorCode; message: string };

export type ErrorCode =
  | "unauthorized"
  | "quota_exceeded"
  | "bad_request"
  | "audio_too_long"
  | "stt_failed"
  | "cleanup_failed"
  | "internal";

// ---------------------------------------------------------------------------
// REST: typing-refine  (POST /v1/refine)
// ---------------------------------------------------------------------------
//
// The "smart autocorrect" mode: the user TYPED some rough text and wants it
// rewritten in the best way, in their personality + the target app's tone.
// No audio, no STT — just text in, polished text out.

export interface RefineRequest extends CleanupOptions {
  /** The raw text the user typed. */
  text: string;
}

export interface RefineResponse {
  refinedText: string;
  usage: UsageRecord; // audioSeconds is 0 here
}

// ---------------------------------------------------------------------------
// REST: screen-reply  (POST /v1/draft)
// ---------------------------------------------------------------------------
//
// The "screen bubble" / Share-sheet mode. The app captured what's on screen
// (e.g. an email/chat) and the user said/typed what they want to do. The
// backend drafts a personalized reply using their personality + who they're
// writing to.
//
//   Android: floating bubble reads the screen via an accessibility service.
//   iOS:     user shares the text / a screenshot into the app (Apple forbids
//            reading other apps' screens directly).

export interface DraftRequest extends CleanupOptions {
  /** Text captured from the screen (the email/message/etc. being responded to). */
  screenContent: string;
  /** What the user wants, in plain language ("politely decline, suggest next week"). */
  intent: string;
  /** Optional: who the reply is addressed to, to tune tone. */
  recipient?: string;
}

export interface DraftResponse {
  draftText: string;
  usage: UsageRecord;
}

// ---------------------------------------------------------------------------
// REST: text-to-speech  (POST /v1/speak)
// ---------------------------------------------------------------------------
//
// Voice output (the "mouth"): text in → spoken audio out. Used when the app
// needs to speak back — e.g. the screen bubble reading on-screen content aloud,
// or reading a generated draft to the user.
//
// The response is BINARY audio (Content-Type per `format`, default audio/mpeg),
// not JSON.

export type TtsFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

export interface SpeakRequest {
  /** The text to speak. */
  text: string;
  /** Voice name (e.g. "alloy", "nova"). Defaults to the server's TTS_VOICE. */
  voice?: string;
  /** Output container. Defaults to the server's TTS_FORMAT (mp3). */
  format?: TtsFormat;
  /** Optional style steer, e.g. "calm and friendly" (can come from personality). */
  instructions?: string;
}

// ---------------------------------------------------------------------------
// REST: voice preview  (POST /v1/voice/preview)
// ---------------------------------------------------------------------------
//
// Play a short sample so the user can hear what a voice sounds like BEFORE
// they pick it in Settings. Same shape/output as /v1/speak (binary audio) —
// text and instructions default sensibly when omitted so the caller can just
// pass { voice: "nova" } and get a preview.

export interface VoicePreviewRequest {
  /** Voice name to preview. Defaults to the server's TTS_VOICE. */
  voice?: string;
  /** Text to speak. Defaults to a short English sample. */
  text?: string;
  /** Style steer. Defaults to a derivation from the user's personality. */
  instructions?: string;
}

// ---------------------------------------------------------------------------
// REST: personality  (GET/PUT /v1/personality)
// ---------------------------------------------------------------------------
//
// GET  → the user's saved personality (or an empty object if none set).
// PUT  → save/replace it (body is a Personality).

export interface PersonalityResponse {
  personality: Personality;
}

// ---------------------------------------------------------------------------
// REST: auto-learn vocabulary  (POST /v1/personality/vocabulary/learn)
// ---------------------------------------------------------------------------
//
// The keyboard/app calls this when it detects the user has corrected an
// output (deleted a produced word/phrase and typed a different spelling for
// the same term). The server appends the corrected "to" spelling to the
// personal vocabulary so future STT + cleanup runs bias toward it.
//
// Body is a small array of corrections. Anything over a per-request cap is
// rejected — this is a helper, not an import path.

export interface VocabularyCorrection {
  /** What the cleaner produced (or the wrong spelling to REPLACE from). */
  from: string;
  /** What the user meant (the CORRECT spelling to LEARN). */
  to: string;
}

export interface LearnVocabularyRequest {
  corrections: VocabularyCorrection[];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: "ok";
  service: "tulmi-backend";
  version: string;
}

// ---------------------------------------------------------------------------
// REST: privacy audit  (GET /v1/privacy/audit)
// ---------------------------------------------------------------------------
//
// The "receipts" endpoint — feeds the in-app Privacy screen so a user can see
// exactly what happened with their data over a window. Nothing new is stored;
// this is a projection of the existing metering.

export interface PrivacyAuditWindow {
  /** ISO window label ("last24h", "last7d", "last30d", "allTime"). */
  window: string;
  /** Total number of requests we processed for this user in this window. */
  requests: number;
  /** Seconds of audio processed. Deleted after transcription (retentionSeconds=0). */
  audioSeconds: number;
  /** Word count of cleaned output shown to the user. */
  words: number;
}

export interface PrivacyAuditResponse {
  /** Per-window usage counts. */
  windows: PrivacyAuditWindow[];
  /** True if long-term audio retention is on for this account. Default false. */
  audioRetained: boolean;
  /** True if the backend uses the user's runs to improve their style. */
  learningFromRuns: boolean;
  /** SaaS providers your text/audio has been sent to in this window. */
  upstreamProviders: string[];
  /**
   * Freeform links the app renders as chips ("Read policy", "Delete my data").
   */
  links: Array<{ label: string; url: string }>;
}

// ---------------------------------------------------------------------------
// REST: cleanup history  (GET/DELETE /v1/history)
// ---------------------------------------------------------------------------
//
// Opt-in per-user log of past cleanups. Storage is only performed when the
// user has consented via personality.learnFromSent === true OR
// personality.retainHistory === true. Reads and writes are always scoped to
// the caller. Rows are soft-deleted via a server-side deleted_at column and
// hidden from list/read responses.

/** One row in a user's cleanup history. */
export interface HistoryEntry {
  /** Server-generated UUID for the row. */
  id: string;
  /** Which surface produced this entry. */
  kind: "voice" | "typing" | "draft";
  /** Target app the cleanup was tuned for, when known. */
  targetApp?: TargetAppHint;
  /** Language hint that was in effect. */
  language?: LanguageHint;
  /** Raw input: transcript (for voice) or typed text (for typing/draft). */
  input: string;
  /** Cleaned / drafted output shown to the user. */
  output: string;
  /** Total pipeline time for this cleanup, in milliseconds. */
  durationMs?: number;
  /** Word count of the input. */
  wordsIn?: number;
  /** Word count of the output. */
  wordsOut?: number;
  /** ISO-8601 timestamp of when the row was created. */
  createdAt: string;
}

/** GET /v1/history response. */
export interface HistoryListResponse {
  entries: HistoryEntry[];
  /**
   * ISO-8601 cursor for the next page — pass back as `?before=` on the next
   * request to fetch older entries. Absent when there are no more rows.
   */
  nextBefore?: string;
}

/** GET /v1/stats response. */
export interface StatsResponse {
  /** Which rolling window this response covers. */
  window: "week" | "month" | "all";
  /** Total request count in the window. */
  requests: number;
  /** Total cleaned-output word count in the window. */
  wordsOut: number;
  /** Total audio seconds processed in the window. */
  audioSeconds: number;
  /**
   * Rough "minutes saved" estimate, computed on the server as
   * (wordsOut * TYPING_TIME_PER_WORD) / 60. See history/store.ts for the
   * constant.
   */
  minutesSaved: number;
  /**
   * Per-day counts (requests) for a sparkline. The array is ordered oldest→
   * newest, has length = window's day count (7/30/…, capped for "all"), and
   * is bucketed by UTC calendar day.
   */
  sparklinePerDay: number[];
}
