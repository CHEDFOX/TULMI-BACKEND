/**
 * Per-user usage metering. Every successful request records audio seconds +
 * word count so we can enforce a free tier later.
 *
 * Writes to the Supabase `usage_events` table (see supabase/migrations). When
 * Supabase is disabled (DEV_SKIP_AUTH local testing) we log instead of writing,
 * so the pipeline still runs end-to-end without a database.
 */
import { dataClientFor, supabase, type AuthedUser } from "../auth/supabase.js";
import { getConfig } from "../config.js";
import type { UsageRecord, UsageSummary } from "../../../shared/types/api.js";

export interface MeterInput extends UsageRecord {
  user: AuthedUser;
  /** Which surface produced this: "rest" | "stream". */
  source: "rest" | "stream";
}

export async function recordUsage(input: MeterInput): Promise<void> {
  const sb = dataClientFor(input.user);

  if (!sb) {
    // Dev / no-Supabase mode: don't lose the signal, just log it.
    console.info(
      `[usage] user=${input.user.id} audio=${input.audioSeconds.toFixed(
        1,
      )}s words=${input.words} model=${input.model} source=${input.source}`,
    );
    return;
  }

  const { error } = await sb.from("usage_events").insert({
    user_id: input.user.id,
    audio_seconds: input.audioSeconds,
    word_count: input.words,
    model: input.model,
    source: input.source,
  });

  if (error) {
    // Never fail the user's request because metering failed; log loudly.
    console.error(`[usage] failed to record for ${input.user.id}:`, error.message);
  }
}

/** Aggregate a user's usage into this-month + all-time totals (for the stats screen). */
export async function usageSummary(user: AuthedUser): Promise<UsageSummary> {
  const empty = () => ({ words: 0, audioSeconds: 0, requests: 0 });
  const out: UsageSummary = { month: empty(), total: empty() };
  const sb = dataClientFor(user);
  if (!sb) return out;

  const { data, error } = await sb
    .from("usage_events")
    .select("audio_seconds, word_count, created_at")
    .eq("user_id", user.id);
  if (error || !data) return out;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  for (const r of data as Array<{ audio_seconds?: number; word_count?: number; created_at?: string }>) {
    const a = r.audio_seconds ?? 0;
    const w = r.word_count ?? 0;
    out.total.words += w; out.total.audioSeconds += a; out.total.requests += 1;
    if ((r.created_at ?? "") >= monthStart) {
      out.month.words += w; out.month.audioSeconds += a; out.month.requests += 1;
    }
  }
  return out;
}

/**
 * Windowed usage projection for the Privacy audit endpoint. Reads the same
 * usage_events rows and buckets them into fixed windows: 24h / 7d / 30d /
 * all-time. When Supabase is disabled all counts come back as zero (the caller
 * still gets a valid PrivacyAuditResponse shape).
 */
export async function usageWindows(
  user: AuthedUser,
): Promise<Array<{ window: string; requests: number; audioSeconds: number; words: number }>> {
  const buckets = [
    { window: "last24h", sinceMs: 24 * 60 * 60 * 1000 },
    { window: "last7d", sinceMs: 7 * 24 * 60 * 60 * 1000 },
    { window: "last30d", sinceMs: 30 * 24 * 60 * 60 * 1000 },
    { window: "allTime", sinceMs: Number.POSITIVE_INFINITY },
  ];
  const empty = () =>
    buckets.map((b) => ({ window: b.window, requests: 0, audioSeconds: 0, words: 0 }));

  const sb = dataClientFor(user);
  if (!sb) return empty();

  const { data, error } = await sb
    .from("usage_events")
    .select("audio_seconds, word_count, created_at")
    .eq("user_id", user.id);
  if (error || !data) return empty();

  const now = Date.now();
  const out = empty();
  for (const r of data as Array<{ audio_seconds?: number; word_count?: number; created_at?: string }>) {
    const ts = r.created_at ? Date.parse(r.created_at) : NaN;
    const age = Number.isFinite(ts) ? now - ts : Number.POSITIVE_INFINITY;
    const a = r.audio_seconds ?? 0;
    const w = r.word_count ?? 0;
    for (let i = 0; i < buckets.length; i++) {
      if (age <= buckets[i]!.sinceMs) {
        out[i]!.audioSeconds += a;
        out[i]!.words += w;
        out[i]!.requests += 1;
      }
    }
  }
  return out;
}

/**
 * Pre-flight free-tier check. Returns a human-readable reason string when the
 * user is over the configured monthly ceiling — the caller should refuse the
 * request BEFORE calling any paid upstream. Returns null when the user is
 * inside the limit (or no limit is configured).
 *
 * Cheap enough to call on every request path: one indexed query per user per
 * request, cached at Supabase.
 */
export async function enforceQuota(user: AuthedUser): Promise<string | null> {
  const cfg = getConfig();
  const capAudio = cfg.FREE_MONTHLY_AUDIO_SECONDS;
  const capWords = cfg.FREE_MONTHLY_WORDS;
  if (capAudio <= 0 && capWords <= 0) return null; // no limit configured

  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const used = await usageSince(user.id, monthStart);
  if (!used) return null; // Supabase unavailable → fail open, don't lock users out

  if (capAudio > 0 && used.audioSeconds >= capAudio) {
    return `Monthly voice cap reached (${Math.round(capAudio / 60)} min). Resets ${monthResetDate()}.`;
  }
  if (capWords > 0 && used.words >= capWords) {
    return `Monthly word cap reached (${capWords}). Resets ${monthResetDate()}.`;
  }
  return null;
}

function monthResetDate(): string {
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Sum a user's audio-seconds usage since a given ISO timestamp. This is the
 * read side free-tier enforcement uses (see enforceQuota).
 */
export async function usageSince(
  userId: string,
  sinceIso: string,
): Promise<{ audioSeconds: number; words: number } | null> {
  const sb = supabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from("usage_events")
    .select("audio_seconds, word_count")
    .eq("user_id", userId)
    .gte("created_at", sinceIso);

  if (error || !data) return null;

  return data.reduce(
    (acc, row) => ({
      audioSeconds: acc.audioSeconds + (row.audio_seconds ?? 0),
      words: acc.words + (row.word_count ?? 0),
    }),
    { audioSeconds: 0, words: 0 },
  );
}
