import { describe, expect, it } from "vitest";
import { expandSnippets } from "../src/pipeline/cleanup.js";

describe("expandSnippets", () => {
  it("returns input unchanged when no snippets are configured", () => {
    expect(expandSnippets("hello", undefined)).toBe("hello");
    expect(expandSnippets("hello", "")).toBe("hello");
  });

  it("expands whole-word triggers, case-insensitively", () => {
    const snippets = "brb = be right back\nomw = on my way";
    expect(expandSnippets("brb 5 min", snippets)).toBe("be right back 5 min");
    expect(expandSnippets("BRB!", snippets)).toBe("be right back!");
    expect(expandSnippets("brbing", snippets)).toBe("brbing");
  });

  it("treats regex-special chars in the trigger literally", () => {
    // The trigger's dot must NOT act like `.` in regex — replacing 'a.b'
    // should not also replace 'axb'. Both triggers use `\b` for boundaries,
    // so we surround with spaces to keep the tests unambiguous.
    const snippets = "a.b = matched";
    expect(expandSnippets("axb", snippets)).toBe("axb");
    expect(expandSnippets("a.b", snippets)).toBe("matched");
  });

  it("ignores malformed lines (no '=')", () => {
    const snippets = "brb be right back";
    expect(expandSnippets("brb", snippets)).toBe("brb");
  });

  it("interpolates {name}, {email}, {targetApp}, {recipient} from ctx", () => {
    const snippets = "sig = — {name} <{email}>\nheading = To {recipient} in {targetApp}:";
    const out = expandSnippets("heading sig", snippets, {
      name: "Alex",
      email: "alex@example.com",
      targetApp: "Gmail",
      recipient: "Boss",
    });
    expect(out).toBe("To Boss in Gmail: — Alex <alex@example.com>");
  });

  it("resolves known-but-missing variables to empty strings, not the literal token", () => {
    const snippets = "sig = — {name}";
    // No name provided → empties, so the trigger becomes "— " (trailing space).
    expect(expandSnippets("sig", snippets, {})).toBe("— ");
  });

  it("leaves unknown {var} tokens literal so a stray brace survives", () => {
    const snippets = "note = keep {stray} intact";
    expect(expandSnippets("note", snippets, {})).toBe("keep {stray} intact");
  });

  it("interpolates {date}, {time}, {day} from a fixed 'now'", () => {
    // Deterministic clock: Wednesday, 2025-03-05 14:07 UTC.
    const now = new Date(Date.UTC(2025, 2, 5, 14, 7, 0));
    const snippets = "stamp = {date} {time} {day}";
    expect(expandSnippets("stamp", snippets, { now })).toBe("2025-03-05 14:07 Wednesday");
  });

  it("still works when ctx is omitted (time vars use real clock, string vars empty)", () => {
    const snippets = "hello = hi {name}";
    // No ctx → name is empty; result is just "hi " (with trailing space).
    expect(expandSnippets("hello", snippets)).toBe("hi ");
  });
});
