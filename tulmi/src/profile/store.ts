/**
 * Per-user profile: language preference + onboarding state. Persisted in the
 * Supabase `profiles` table via the user's JWT (RLS-scoped) or the service-role
 * client. Falls back to an in-memory map under DEV_SKIP_AUTH so the flow still
 * works without a database.
 */
import { dataClientFor, type AuthedUser } from "../auth/supabase.js";

export interface Profile {
  language: string; // 'auto' | 'en' | 'hi' | 'hinglish' | ...
  onboarded: boolean;
}

const DEFAULT_PROFILE: Profile = { language: "auto", onboarded: false };
const memory = new Map<string, Profile>();

export async function getProfile(user: AuthedUser): Promise<Profile> {
  const sb = dataClientFor(user);
  if (!sb) return memory.get(user.id) ?? { ...DEFAULT_PROFILE };

  const { data, error } = await sb
    .from("profiles")
    .select("language, onboarded")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error(`[profile] load failed for ${user.id}:`, error.message);
    return { ...DEFAULT_PROFILE };
  }
  return {
    language: data?.language ?? DEFAULT_PROFILE.language,
    onboarded: data?.onboarded ?? DEFAULT_PROFILE.onboarded,
  };
}

/** Patch a profile (language and/or onboarding). Returns the merged result. */
export async function updateProfile(
  user: AuthedUser,
  patch: Partial<Profile>,
): Promise<Profile> {
  const sb = dataClientFor(user);
  if (!sb) {
    const next = { ...(memory.get(user.id) ?? DEFAULT_PROFILE), ...patch };
    memory.set(user.id, next);
    return next;
  }

  const row: Record<string, unknown> = {
    user_id: user.id,
    updated_at: new Date().toISOString(),
  };
  if (patch.language !== undefined) row.language = patch.language;
  if (patch.onboarded !== undefined) {
    row.onboarded = patch.onboarded;
    if (patch.onboarded) row.onboarded_at = new Date().toISOString();
  }

  const { data, error } = await sb
    .from("profiles")
    .upsert(row, { onConflict: "user_id" })
    .select("language, onboarded")
    .maybeSingle();

  if (error) throw new Error(`Failed to save profile: ${error.message}`);
  return {
    language: data?.language ?? DEFAULT_PROFILE.language,
    onboarded: data?.onboarded ?? DEFAULT_PROFILE.onboarded,
  };
}
