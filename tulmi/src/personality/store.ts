/**
 * Per-user personality storage. Saved in the Supabase `personalities` table
 * (one row per user, the profile kept as JSON). Reads/writes go through the
 * user's own JWT (RLS-scoped) or the service-role client — see dataClientFor.
 * When neither is available (DEV_SKIP_AUTH local testing) we fall back to an
 * in-memory map so the feature still works end-to-end without a database.
 */
import { dataClientFor, type AuthedUser } from "../auth/supabase.js";
import type {
  Personality,
  VocabularyCorrection,
} from "../../../shared/types/api.js";

/** Vocabulary size ceiling — keep the STT bias prompt short and cheap. */
export const VOCAB_MAX_LINES = 200;

const memory = new Map<string, Personality>();

export async function getPersonality(user: AuthedUser): Promise<Personality> {
  const sb = dataClientFor(user);
  if (!sb) return memory.get(user.id) ?? {};

  const { data, error } = await sb
    .from("personalities")
    .select("data")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error(`[personality] load failed for ${user.id}:`, error.message);
    return {};
  }
  return (data?.data as Personality) ?? {};
}

export async function savePersonality(
  user: AuthedUser,
  personality: Personality,
): Promise<void> {
  const sb = dataClientFor(user);
  if (!sb) {
    memory.set(user.id, personality);
    return;
  }

  const { error } = await sb
    .from("personalities")
    .upsert(
      { user_id: user.id, data: personality, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );

  if (error) {
    throw new Error(`Failed to save personality: ${error.message}`);
  }
}

/**
 * Resolve the personality to use for a request: an inline override from the app
 * wins; otherwise fall back to the user's saved profile.
 */
export async function resolvePersonality(
  user: AuthedUser,
  override: Personality | undefined,
): Promise<Personality> {
  if (override && Object.keys(override).length > 0) return override;
  return getPersonality(user);
}

/**
 * Merge auto-learned corrections into the user's `vocabulary`. Only the
 * corrected ("to") spellings are added — the buggy "from" spelling is
 * incidental context, and adding both would just confuse the STT bias
 * prompt. Existing lines are preserved, duplicates (case-insensitive) are
 * skipped, and the total is capped at VOCAB_MAX_LINES (drop-oldest FIFO)
 * so a chatty client can't blow up the personality doc.
 *
 * Returns the updated personality so the caller can respond with a receipt.
 */
export async function learnVocabularyCorrections(
  user: AuthedUser,
  corrections: VocabularyCorrection[],
): Promise<Personality> {
  const current = await getPersonality(user);

  const existing = (current.vocabulary ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Case-insensitive dedupe set primed with what the user already has, so
  // repeated corrections of the same term don't stack duplicates.
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const additions: string[] = [];
  for (const { to } of corrections) {
    const term = (to ?? "").trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(term);
  }

  // FIFO cap: keep the tail (newest entries), drop the oldest.
  const combined = [...existing, ...additions];
  const capped =
    combined.length > VOCAB_MAX_LINES
      ? combined.slice(combined.length - VOCAB_MAX_LINES)
      : combined;

  const next: Personality = { ...current, vocabulary: capped.join("\n") };
  await savePersonality(user, next);
  return next;
}
