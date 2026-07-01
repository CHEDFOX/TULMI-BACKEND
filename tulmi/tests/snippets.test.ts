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
});
