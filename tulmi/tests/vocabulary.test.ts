import { describe, expect, it, beforeEach } from "vitest";
import type { AuthedUser } from "../src/auth/supabase.js";

// Vocabulary learning writes through the personality store, which lazily
// calls getConfig() when it reaches out to Supabase. In tests there is no
// .env and no Supabase — we prime the required keys so getConfig() passes
// validation, then DEV_SKIP_AUTH routes writes to the in-module memory map.
// This assignment runs before any test body (which is where getConfig is
// first hit), and vitest's isolate:true keeps it out of other files.
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.STT_PROVIDER = "openai";
process.env.DEV_SKIP_AUTH = "true";

// eslint-disable-next-line import/first
import {
  getPersonality,
  savePersonality,
  learnVocabularyCorrections,
  VOCAB_MAX_LINES,
} from "../src/personality/store.js";

// These tests exercise the memory-backed fallback in personality/store —
// under DEV_SKIP_AUTH there is no Supabase, so writes hit the in-module map.
// We use a fresh user per test to isolate state.

function makeUser(id: string): AuthedUser {
  return { id, email: `${id}@test.local` };
}

describe("learnVocabularyCorrections", () => {
  beforeEach(async () => {
    // Reset any prior state for the shared "vocab-*" ids by writing empty.
    await savePersonality(makeUser("vocab-a"), {});
    await savePersonality(makeUser("vocab-b"), {});
    await savePersonality(makeUser("vocab-c"), {});
    await savePersonality(makeUser("vocab-d"), {});
  });

  it("adds each corrected 'to' spelling, trimmed", async () => {
    const user = makeUser("vocab-a");
    const next = await learnVocabularyCorrections(user, [
      { from: "kubernetes", to: "  K8s  " },
      { from: "postgres", to: "PostgreSQL" },
    ]);
    const lines = (next.vocabulary ?? "").split("\n").filter(Boolean);
    expect(lines).toContain("K8s");
    expect(lines).toContain("PostgreSQL");
    // Persisted, not just returned:
    const stored = await getPersonality(user);
    expect(stored.vocabulary).toBe(next.vocabulary);
  });

  it("dedupes against existing lines (case-insensitive) and repeat corrections", async () => {
    const user = makeUser("vocab-b");
    await savePersonality(user, { vocabulary: "PostgreSQL\nRedis" });
    const next = await learnVocabularyCorrections(user, [
      { from: "postgres", to: "postgresql" }, // dup of existing "PostgreSQL"
      { from: "redis-server", to: "Redis" }, // dup of existing "Redis"
      { from: "kubernetes", to: "K8s" },
      { from: "kubernetes", to: "K8s" }, // dup within the same batch
    ]);
    const lines = (next.vocabulary ?? "").split("\n");
    // No dup of PostgreSQL / Redis
    const countPg = lines.filter((l) => l.toLowerCase() === "postgresql").length;
    const countRedis = lines.filter((l) => l.toLowerCase() === "redis").length;
    const countK8s = lines.filter((l) => l.toLowerCase() === "k8s").length;
    expect(countPg).toBe(1);
    expect(countRedis).toBe(1);
    expect(countK8s).toBe(1);
  });

  it("caps the total number of lines and drops the OLDEST entries first", async () => {
    const user = makeUser("vocab-c");
    // Fill the vocab right up to the ceiling with numeric tokens.
    const existing = Array.from({ length: VOCAB_MAX_LINES }, (_, i) => `oldterm${i}`);
    await savePersonality(user, { vocabulary: existing.join("\n") });

    const next = await learnVocabularyCorrections(user, [
      { from: "x", to: "brandnew1" },
      { from: "y", to: "brandnew2" },
    ]);
    const lines = (next.vocabulary ?? "").split("\n");
    expect(lines.length).toBe(VOCAB_MAX_LINES);
    // Newest entries survive
    expect(lines).toContain("brandnew1");
    expect(lines).toContain("brandnew2");
    // Oldest two dropped
    expect(lines).not.toContain("oldterm0");
    expect(lines).not.toContain("oldterm1");
    // Order preserved: older entries remain in their original order.
    expect(lines.indexOf("oldterm2")).toBeLessThan(lines.indexOf("brandnew1"));
  });

  it("skips corrections with an empty 'to'", async () => {
    const user = makeUser("vocab-d");
    const next = await learnVocabularyCorrections(user, [
      { from: "x", to: "   " },
      { from: "y", to: "RealTerm" },
    ]);
    const lines = (next.vocabulary ?? "").split("\n").filter(Boolean);
    expect(lines).toEqual(["RealTerm"]);
  });
});
