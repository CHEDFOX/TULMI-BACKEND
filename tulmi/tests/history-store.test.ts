import { describe, expect, it } from "vitest";
import type { AuthedUser } from "../src/auth/supabase.js";
import type { Personality } from "../../shared/types/api.js";

process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.STT_PROVIDER = "openai";
process.env.DEV_SKIP_AUTH = "true";

// eslint-disable-next-line import/first
import {
  appendHistoryEntry,
  deleteHistoryEntry,
  hasConsentedToHistory,
  listHistory,
  statsForUser,
  TYPING_WORDS_PER_MINUTE,
} from "../src/history/store.js";

function makeUser(id: string): AuthedUser {
  return { id, email: `${id}@test.local` };
}

const CONSENT_HISTORY: Personality = { retainHistory: true };

describe("hasConsentedToHistory", () => {
  it("returns false for undefined / empty personality", () => {
    expect(hasConsentedToHistory(undefined)).toBe(false);
    expect(hasConsentedToHistory({})).toBe(false);
  });

  it("returns true when learnFromSent is set", () => {
    expect(hasConsentedToHistory({ learnFromSent: true })).toBe(true);
  });

  it("returns true when retainHistory is set", () => {
    expect(hasConsentedToHistory({ retainHistory: true })).toBe(true);
  });
});

describe("appendHistoryEntry", () => {
  it("no-ops when the personality lacks consent", async () => {
    const user = makeUser("hs-noconsent");
    await appendHistoryEntry(
      user,
      {}, // no consent
      { kind: "typing", input: "hi", output: "hi." },
    );
    const { entries } = await listHistory(user);
    expect(entries).toEqual([]);
  });

  it("writes when consent is given and listHistory returns it", async () => {
    const user = makeUser("hs-write");
    await appendHistoryEntry(
      user,
      CONSENT_HISTORY,
      { kind: "typing", input: "raw", output: "clean" },
    );
    const { entries } = await listHistory(user);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.input).toBe("raw");
    expect(entries[0]?.output).toBe("clean");
    expect(entries[0]?.kind).toBe("typing");
    // The row should have a UUID id + createdAt.
    expect(entries[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof entries[0]?.createdAt).toBe("string");
  });
});

describe("listHistory", () => {
  it("respects the limit option", async () => {
    const user = makeUser("hs-limit");
    for (let i = 0; i < 5; i++) {
      await appendHistoryEntry(user, CONSENT_HISTORY, {
        kind: "typing",
        input: `in${i}`,
        output: `out${i}`,
      });
    }
    const { entries } = await listHistory(user, { limit: 2 });
    expect(entries).toHaveLength(2);
  });

  it("respects the kind filter", async () => {
    const user = makeUser("hs-kind");
    await appendHistoryEntry(user, CONSENT_HISTORY, {
      kind: "typing",
      input: "typed",
      output: "polished",
    });
    await appendHistoryEntry(user, CONSENT_HISTORY, {
      kind: "voice",
      input: "spoken",
      output: "spoken clean",
    });
    await appendHistoryEntry(user, CONSENT_HISTORY, {
      kind: "draft",
      input: "intent",
      output: "reply",
    });

    const typing = await listHistory(user, { kind: "typing" });
    expect(typing.entries.map((e) => e.kind)).toEqual(["typing"]);
    const voice = await listHistory(user, { kind: "voice" });
    expect(voice.entries.map((e) => e.kind)).toEqual(["voice"]);
  });

  it("returns a nextBefore cursor when more rows exist and paginates through all", async () => {
    const user = makeUser("hs-page");
    for (let i = 0; i < 5; i++) {
      await appendHistoryEntry(user, CONSENT_HISTORY, {
        kind: "typing",
        input: `in${i}`,
        output: `out${i}`,
      });
      // Ensure each entry gets a distinct createdAt so the cursor advances.
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await listHistory(user, { limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextBefore).toBeDefined();

    const page2 = await listHistory(user, {
      limit: 2,
      before: page1.nextBefore!,
    });
    expect(page2.entries).toHaveLength(2);

    const page3 = await listHistory(user, {
      limit: 2,
      before: page2.nextBefore!,
    });
    expect(page3.entries).toHaveLength(1);
    // Last page → no more cursor.
    expect(page3.nextBefore).toBeUndefined();
  });
});

describe("deleteHistoryEntry", () => {
  it("soft-deletes an entry so it disappears from listHistory", async () => {
    const user = makeUser("hs-del");
    await appendHistoryEntry(user, CONSENT_HISTORY, {
      kind: "typing",
      input: "in",
      output: "out",
    });
    const { entries } = await listHistory(user);
    expect(entries).toHaveLength(1);
    const id = entries[0]!.id;
    const ok = await deleteHistoryEntry(user, id);
    expect(ok).toBe(true);
    const after = await listHistory(user);
    expect(after.entries).toEqual([]);
  });

  it("returns false for a nonexistent id", async () => {
    const user = makeUser("hs-del-missing");
    const ok = await deleteHistoryEntry(user, "00000000-0000-0000-0000-000000000000");
    expect(ok).toBe(false);
  });
});

describe("statsForUser", () => {
  it("returns totals + a length-7 sparkline for the 'week' window", async () => {
    const user = makeUser("hs-stats");
    for (let i = 0; i < 3; i++) {
      await appendHistoryEntry(
        user,
        CONSENT_HISTORY,
        {
          kind: "voice",
          input: "hi",
          output: "cleaned output",
          wordsOut: 40,
        },
        // audioSeconds — internal audioSeconds param
        12,
      );
    }
    const stats = await statsForUser(user, "week");
    expect(stats.window).toBe("week");
    expect(stats.requests).toBe(3);
    expect(stats.wordsOut).toBe(120);
    expect(stats.audioSeconds).toBe(36);
    expect(stats.sparklinePerDay).toHaveLength(7);
    // All three requests happened "today" — the last bucket carries them.
    expect(stats.sparklinePerDay[6]).toBe(3);
  });

  it("computes minutesSaved as wordsOut / 40, rounded to one decimal", async () => {
    const user = makeUser("hs-minutes");
    // 40 wpm baseline; 100 words → 2.5 minutes.
    await appendHistoryEntry(
      user,
      CONSENT_HISTORY,
      { kind: "typing", input: "x", output: "y", wordsOut: 100 },
    );
    const stats = await statsForUser(user, "week");
    expect(stats.wordsOut).toBe(100);
    expect(stats.minutesSaved).toBe(2.5);
    // Sanity: matches the exported constant we're deriving from.
    expect(TYPING_WORDS_PER_MINUTE).toBe(40);
  });
});
