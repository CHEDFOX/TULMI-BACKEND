import { describe, expect, it } from "vitest";
import {
  renderPersonality,
  renderToneDial,
  renderAppStyle,
  resolveAppStyle,
  resolveRecipientHint,
} from "../src/prompts.js";
import type { Personality } from "../../shared/types/api.js";

describe("renderPersonality", () => {
  it("returns the neutral fallback for an empty personality", () => {
    expect(renderPersonality(undefined)).toContain("None set");
    expect(renderPersonality({})).toContain("None set");
  });

  it("emits one bullet per configured field", () => {
    const p: Personality = {
      tone: "warm, concise",
      formality: "casual",
      emoji: "minimal",
      signature: "— T",
      customInstructions: "no exclamation marks",
    };
    const out = renderPersonality(p);
    expect(out).toMatch(/Tone: warm, concise/);
    expect(out).toMatch(/Formality: casual/);
    expect(out).toMatch(/Emoji use: minimal/);
    expect(out).toMatch(/Preferred sign-off: — T/);
    expect(out).toMatch(/Extra instructions: no exclamation marks/);
  });
});

describe("renderToneDial", () => {
  it("returns 'Default.' when no dial is set", () => {
    expect(renderToneDial(undefined)).toBe("Default.");
    expect(renderToneDial({})).toBe("Default.");
  });

  it("clamps values into [0,100] and rounds", () => {
    const out = renderToneDial({ formality: -12, length: 132.6, warmth: 50.4 });
    expect(out).toMatch(/formality: 0/);
    expect(out).toMatch(/length: 100/);
    expect(out).toMatch(/warmth: 50/);
  });

  it("omits dials the user didn't set", () => {
    const out = renderToneDial({ warmth: 80 });
    expect(out).toBe("- warmth: 80");
  });
});

describe("resolveAppStyle", () => {
  const styles: NonNullable<Personality["appStyles"]> = {
    WhatsApp: { formality: "casual" },
    Slack: { emoji: "minimal" },
    "*": { note: "wildcard" },
  };

  it("matches the target app case-insensitively", () => {
    expect(resolveAppStyle(styles, "whatsapp")).toEqual({ formality: "casual" });
    expect(resolveAppStyle(styles, "SLACK")).toEqual({ emoji: "minimal" });
  });

  it("falls back to the wildcard when no specific entry exists", () => {
    expect(resolveAppStyle(styles, "Unknown")).toEqual({ note: "wildcard" });
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveAppStyle(undefined, "WhatsApp")).toBeUndefined();
  });
});

describe("renderAppStyle", () => {
  it("emits an empty string when no fields are set", () => {
    expect(renderAppStyle(undefined)).toBe("");
    expect(renderAppStyle({})).toBe("");
  });

  it("emits every configured override", () => {
    const out = renderAppStyle({
      formality: "formal",
      emoji: "none",
      dial: { formality: 70 },
      note: "always thread-friendly",
    });
    expect(out).toMatch(/For this app:/);
    expect(out).toMatch(/Formality \(override\): formal/);
    expect(out).toMatch(/Emoji use \(override\): none/);
    expect(out).toMatch(/Tone dial \(override\):/);
    expect(out).toMatch(/Note: always thread-friendly/);
  });
});

describe("resolveRecipientHint", () => {
  const hints: NonNullable<Personality["recipientHints"]> = [
    { recipient: "mom", hint: "warm, low effort" },
    { recipient: "boss@work", hint: "polite, tight" },
  ];

  it("returns the matching hint (case-insensitive substring)", () => {
    expect(resolveRecipientHint(hints, "Mom")).toBe("mom: warm, low effort");
    expect(resolveRecipientHint(hints, "james — boss@work")).toBe("boss@work: polite, tight");
  });

  it("returns '' when nothing matches", () => {
    expect(resolveRecipientHint(hints, "someone new")).toBe("");
    expect(resolveRecipientHint(undefined, "mom")).toBe("");
    expect(resolveRecipientHint(hints, undefined)).toBe("");
  });
});
