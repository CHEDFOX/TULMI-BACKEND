// CALLERS: /v1/transcribe-clean, /v1/refine, /v1/draft, and the /v1/stream WS
// handler should call appendHistoryEntry() on success. Wiring lives in
// server.ts / cleanup routes.
/**
 * Per-user cleanup history: append-only log of what the user asked for and
 * what Tulmi produced. Storage is *opt-in* — appendHistoryEntry no-ops unless
 * the caller passes a personality that has explicitly consented via
 * `learnFromSent === true` or `retainHistory === true`.
 *
 * Reads/writes go through the user's own JWT (RLS-scoped) when available and
 * the service-role client otherwise. Falls back to a plain in-memory store
 * under DEV_SKIP_AUTH so the endpoints still work end-to-end without a DB.
 *
 * Soft-delete: entries are hidden by setting a server-side `deleted_at`
 * timestamp; rows are never physically removed here (a periodic 90-day purge
 * runs out-of-tree — see 0004_history.sql).
 */
import { randomUUID } from "node:crypto";
import { dataClientFor, type AuthedUser } from "../auth/supabase.js";
import type {
  HistoryEntry,
  LanguageHint,
  Personality,
  TargetAppHint,
} from "../../../shared/types/api.js";

/**
 * Baseline typing throughput assumed when estimating "minutes saved". 40 wpm
 * is a middle-of-the-road adult typing speed; tuned here as a single constant
 * so a product-facing decision (should we assume 30? 60?) is one edit away.
 */
export const TYPING_WORDS_PER_MINUTE = 40;

/** How many history rows a list response returns by default. */
export const DEFAULT_LIMIT = 50;
/** Maximum a caller can request via `?limit=` on the list endpoint. */
export const MAX_LIMIT = 200;

/** A row headed for the DB. Matches the SDUI HistoryEntry contract 1:1. */
export interface HistoryInput {
  kind: HistoryEntry["kind"];
  targetApp?: TargetAppHint;
  language?: LanguageHint;
  input: string;
  output: string;
  durationMs?: number;
  wordsIn?: number;
  wordsOut?: number;
}

/** Filters accepted by listHistory. */
export interface ListOptions {
  /** Newest-N cap for the response. Clamped to [1, MAX_LIMIT]. */
  limit?: number;
  /** ISO-8601 cursor — return rows strictly older than this timestamp. */
  before?: string;
  /** Only return rows whose kind matches. */
  kind?: HistoryEntry["kind"];
}

/** Sum-of-cleanups over a rolling window, plus a per-UTC-day sparkline. */
export interface StatsForUser {
  window: "week" | "month" | "all";
  requests: number;
  wordsOut: number;
  audioSeconds: number;
  minutesSaved: number;
  sparklinePerDay: number[];
}

/** True when the caller has opted-in to history retention. */
export function hasConsentedToHistory(personality: Personality | undefined): boolean {
  if (!personality) return false;
  return personality.learnFromSent === true || personality.retainHistory === true;
}

// ---------------------------------------------------------------------------
// In-memory fallback — used when Supabase is disabled (DEV_SKIP_AUTH).
// ---------------------------------------------------------------------------

interface StoredRow extends HistoryEntry {
  deletedAt?: string;
  audioSeconds?: number;
}

const memory = new Map<string, StoredRow[]>();

function memoryRows(userId: string): StoredRow[] {
  let rows = memory.get(userId);
  if (!rows) {
    rows = [];
    memory.set(userId, rows);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert one history row. This is a no-op when:
 *  - Supabase is disabled AND we have no in-memory fallback (never — the map
 *    is always available), OR
 *  - the passed `personality` doesn't have history consent set.
 *
 * The caller MUST pass its already-loaded personality — this function does
 * NOT re-fetch it, so per-request handlers stay one DB round-trip lean.
 */
export async function appendHistoryEntry(
  user: AuthedUser,
  personality: Personality | undefined,
  entry: HistoryInput,
  /** Optional: audio seconds for stats aggregation on the "voice" kind. */
  audioSeconds?: number,
): Promise<void> {
  if (!hasConsentedToHistory(personality)) return;

  const sb = dataClientFor(user);
  if (!sb) {
    memoryRows(user.id).unshift({
      id: randomUUID(),
      kind: entry.kind,
      targetApp: entry.targetApp,
      language: entry.language,
      input: entry.input,
      output: entry.output,
      durationMs: entry.durationMs,
      wordsIn: entry.wordsIn,
      wordsOut: entry.wordsOut,
      createdAt: new Date().toISOString(),
      audioSeconds,
    });
    return;
  }

  const { error } = await sb.from("cleanup_history").insert({
    user_id: user.id,
    kind: entry.kind,
    target_app: entry.targetApp ?? null,
    language: entry.language ?? null,
    input: entry.input,
    output: entry.output,
    duration_ms: entry.durationMs ?? null,
    words_in: entry.wordsIn ?? null,
    words_out: entry.wordsOut ?? null,
  });
  if (error) {
    // Never fail the user's request because history logging failed.
    console.error(`[history] failed to append for ${user.id}:`, error.message);
  }
}

/**
 * List a user's most recent history entries, newest-first. Uses ISO
 * timestamps as an opaque cursor because `created_at desc` is the only order
 * we ever paginate and it's already indexed.
 */
export async function listHistory(
  user: AuthedUser,
  opts: ListOptions = {},
): Promise<{ entries: HistoryEntry[]; nextBefore?: string }> {
  const limit = clampLimit(opts.limit);

  const sb = dataClientFor(user);
  if (!sb) {
    const all = memoryRows(user.id).filter(
      (r) =>
        !r.deletedAt &&
        (!opts.kind || r.kind === opts.kind) &&
        (!opts.before || r.createdAt < opts.before),
    );
    const page = all.slice(0, limit);
    return { entries: page.map(stripAudio), nextBefore: nextCursor(page, all.length, limit) };
  }

  let q = sb
    .from("cleanup_history")
    .select("id, kind, target_app, language, input, output, duration_ms, words_in, words_out, created_at")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit + 1); // ask for one extra so we know whether there's a next page

  if (opts.kind) q = q.eq("kind", opts.kind);
  if (opts.before) q = q.lt("created_at", opts.before);

  const { data, error } = await q;
  if (error) {
    console.error(`[history] list failed for ${user.id}:`, error.message);
    return { entries: [] };
  }

  const rows = (data ?? []).map(rowToEntry);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    entries: page,
    nextBefore: hasMore ? page[page.length - 1]?.createdAt : undefined,
  };
}

/**
 * Soft-delete an entry. Returns true when a row was updated, false when the
 * id isn't found (or belongs to someone else — RLS makes that indistinguishable
 * and that's intentional).
 */
export async function deleteHistoryEntry(
  user: AuthedUser,
  id: string,
): Promise<boolean> {
  const sb = dataClientFor(user);
  if (!sb) {
    const rows = memoryRows(user.id);
    const target = rows.find((r) => r.id === id && !r.deletedAt);
    if (!target) return false;
    target.deletedAt = new Date().toISOString();
    return true;
  }

  const { data, error } = await sb
    .from("cleanup_history")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    console.error(`[history] delete failed for ${user.id}:`, error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

/**
 * Aggregate the user's history + usage over a rolling window. Reads
 * cleanup_history rather than usage_events so we only reflect entries the
 * user has consented to keep — this screen is about *their* history, not the
 * meter behind it.
 */
export async function statsForUser(
  user: AuthedUser,
  window: "week" | "month" | "all",
): Promise<StatsForUser> {
  const sinceMs = windowSinceMs(window);
  const sinceIso = sinceMs != null ? new Date(Date.now() - sinceMs).toISOString() : undefined;
  const days = windowDayCount(window);

  const sb = dataClientFor(user);
  const rows = sb
    ? await fetchStatRowsSupabase(sb, user.id, sinceIso)
    : fetchStatRowsMemory(user.id, sinceIso);

  let requests = 0;
  let wordsOut = 0;
  let audioSeconds = 0;
  const spark = new Array<number>(days).fill(0);
  const todayUtcMidnight = utcMidnightMs(Date.now());

  for (const r of rows) {
    requests += 1;
    wordsOut += r.wordsOut ?? 0;
    audioSeconds += r.audioSeconds ?? 0;

    const created = Date.parse(r.createdAt);
    if (!Number.isFinite(created)) continue;
    const dayOffset = Math.floor((todayUtcMidnight - utcMidnightMs(created)) / MS_PER_DAY);
    // Newest bucket is the last element in the array.
    const idx = days - 1 - dayOffset;
    if (idx >= 0 && idx < days) spark[idx]! += 1;
  }

  return {
    window,
    requests,
    wordsOut,
    audioSeconds,
    minutesSaved: minutesSavedFor(wordsOut),
    sparklinePerDay: spark,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** UTC midnight of the calendar day containing `ms`. */
function utcMidnightMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function minutesSavedFor(wordsOut: number): number {
  if (wordsOut <= 0) return 0;
  // Rounded to the nearest tenth so the number looks precise but doesn't
  // pretend to be more accurate than the WPM heuristic behind it.
  return Math.round((wordsOut / TYPING_WORDS_PER_MINUTE) * 10) / 10;
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function nextCursor(page: HistoryEntry[], total: number, limit: number): string | undefined {
  if (page.length < limit || total <= limit) return undefined;
  return page[page.length - 1]?.createdAt;
}

function stripAudio(r: StoredRow): HistoryEntry {
  const { audioSeconds: _audioSeconds, deletedAt: _deletedAt, ...rest } = r;
  return rest;
}

function windowSinceMs(window: "week" | "month" | "all"): number | null {
  if (window === "week") return 7 * MS_PER_DAY;
  if (window === "month") return 30 * MS_PER_DAY;
  return null;
}

function windowDayCount(window: "week" | "month" | "all"): number {
  if (window === "week") return 7;
  if (window === "month") return 30;
  // For "all" we still cap the sparkline at 30 days so the array shape stays
  // renderable; the totals still cover everything.
  return 30;
}

interface StatRow {
  createdAt: string;
  wordsOut?: number;
  audioSeconds?: number;
}

async function fetchStatRowsSupabase(
  sb: NonNullable<ReturnType<typeof dataClientFor>>,
  userId: string,
  sinceIso: string | undefined,
): Promise<StatRow[]> {
  let q = sb
    .from("cleanup_history")
    .select("created_at, words_out, duration_ms, kind")
    .eq("user_id", userId)
    .is("deleted_at", null);
  if (sinceIso) q = q.gte("created_at", sinceIso);

  const { data, error } = await q;
  if (error || !data) {
    if (error) console.error(`[history] stats failed for ${userId}:`, error.message);
    return [];
  }
  return (data as Array<{
    created_at?: string;
    words_out?: number | null;
    duration_ms?: number | null;
    kind?: string;
  }>).map((r) => ({
    createdAt: r.created_at ?? new Date(0).toISOString(),
    wordsOut: r.words_out ?? 0,
    // We don't have per-row audio seconds in the DB; approximate voice rows
    // by their duration_ms (best-effort — this feeds a UI number, not billing).
    audioSeconds: r.kind === "voice" && r.duration_ms ? r.duration_ms / 1000 : 0,
  }));
}

function fetchStatRowsMemory(userId: string, sinceIso: string | undefined): StatRow[] {
  const rows = memoryRows(userId).filter((r) => !r.deletedAt);
  return rows
    .filter((r) => !sinceIso || r.createdAt >= sinceIso)
    .map((r) => ({
      createdAt: r.createdAt,
      wordsOut: r.wordsOut ?? 0,
      audioSeconds: r.audioSeconds ?? 0,
    }));
}

function rowToEntry(r: Record<string, unknown>): HistoryEntry {
  return {
    id: String(r.id),
    kind: r.kind as HistoryEntry["kind"],
    targetApp: (r.target_app as TargetAppHint | null) ?? undefined,
    language: (r.language as LanguageHint | null) ?? undefined,
    input: (r.input as string) ?? "",
    output: (r.output as string) ?? "",
    durationMs: (r.duration_ms as number | null) ?? undefined,
    wordsIn: (r.words_in as number | null) ?? undefined,
    wordsOut: (r.words_out as number | null) ?? undefined,
    createdAt: (r.created_at as string) ?? new Date(0).toISOString(),
  };
}
