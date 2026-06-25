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
 * The user's personality / style profile. Set once in the app, stored in the
 * backend, and applied to every output so the text sounds like *them*. The app
 * may also pass an inline override per request.
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
}

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
// REST: personality  (GET/PUT /v1/personality)
// ---------------------------------------------------------------------------
//
// GET  → the user's saved personality (or an empty object if none set).
// PUT  → save/replace it (body is a Personality).

export interface PersonalityResponse {
  personality: Personality;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: "ok";
  service: "tulmi-backend";
  version: string;
}
