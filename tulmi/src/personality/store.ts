/**
 * Per-user personality storage. Saved in the Supabase `personalities` table
 * (one row per user, the profile kept as JSON). Reads/writes go through the
 * user's own JWT (RLS-scoped) or the service-role client — see dataClientFor.
 * When neither is available (DEV_SKIP_AUTH local testing) we fall back to an
 * in-memory map so the feature still works end-to-end without a database.
 */
import { dataClientFor, type AuthedUser } from "../auth/supabase.js";
import type { Personality } from "../../../shared/types/api.js";

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
