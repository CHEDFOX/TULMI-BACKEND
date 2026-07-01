import { describe, expect, it } from "vitest";
import { detectCommand } from "../src/pipeline/commands.js";

describe("detectCommand", () => {
  it("returns null and preserves text when no command trails the input", () => {
    const r = detectCommand("hey uh the meeting is at three thirty");
    expect(r.command).toBeNull();
    expect(r.transcript).toBe("hey uh the meeting is at three thirty");
  });

  it("detects trailing 'MAKE IT SHORTER' and strips the phrase", () => {
    const r = detectCommand("hey uh the meeting is at three, MAKE IT SHORTER");
    expect(r.command).toEqual({ kind: "shorter" });
    expect(r.transcript).toBe("hey uh the meeting is at three");
  });

  it("detects 'make it much longer' and is case-insensitive", () => {
    const r = detectCommand("send the deck by five make it much longer");
    expect(r.command).toEqual({ kind: "longer" });
    expect(r.transcript).toBe("send the deck by five");
  });

  it("detects 'make it more formal' / 'make it casual'", () => {
    expect(detectCommand("dear team meeting shortly, make it more formal").command).toEqual({
      kind: "formal",
    });
    expect(detectCommand("yo the plan works make it casual").command).toEqual({
      kind: "casual",
    });
  });

  it("detects bullet-points variants", () => {
    expect(detectCommand("here are the risks in bullet points").command).toEqual({
      kind: "bulletpoints",
    });
    expect(detectCommand("here are the risks as bullets").command).toEqual({
      kind: "bulletpoints",
    });
    expect(detectCommand("write these risks as a bulleted list").command).toEqual({
      kind: "bulletpoints",
    });
  });

  it("detects 'translate this to <lang>' and captures the language, lowercased", () => {
    const r = detectCommand("the meeting is at three, translate this to Spanish");
    expect(r.command).toEqual({ kind: "translate", lang: "spanish" });
    expect(r.transcript).toBe("the meeting is at three");
  });

  it("detects emoji on / off variants", () => {
    expect(detectCommand("thanks a lot no emojis").command).toEqual({ kind: "emojiOff" });
    expect(detectCommand("thanks a lot less emoji").command).toEqual({ kind: "emojiOff" });
    expect(detectCommand("congrats add emoji").command).toEqual({ kind: "emojiOn" });
    expect(detectCommand("congrats with emojis").command).toEqual({ kind: "emojiOn" });
  });

  it("does NOT match mid-sentence uses of the command words", () => {
    // "shorter" here is describing a noun, not a trailing command.
    const r = detectCommand("the article was shorter than the last one");
    expect(r.command).toBeNull();
    expect(r.transcript).toBe("the article was shorter than the last one");
  });

  it("does NOT match a lone 'shorter' at the end without the 'make it' preamble", () => {
    const r = detectCommand("the article was shorter");
    expect(r.command).toBeNull();
    // Unchanged (or trim-only)
    expect(r.transcript).toBe("the article was shorter");
  });

  it("with two chained commands, only the TAIL applies", () => {
    // The tail-most command is "longer"; the earlier "shorter" phrase is
    // absorbed into the strip via the leading connector part of the regex.
    const r = detectCommand("meeting is at three, MAKE IT SHORTER, MAKE IT LONGER");
    expect(r.command).toEqual({ kind: "longer" });
    expect(r.transcript).toBe("meeting is at three");
  });

  it("tolerates trailing punctuation ('.', '!', '…')", () => {
    expect(detectCommand("call mom, translate to french.").command).toEqual({
      kind: "translate",
      lang: "french",
    });
    expect(detectCommand("send the update, make it shorter!").command).toEqual({
      kind: "shorter",
    });
    expect(detectCommand("draft the reply, make it casual…").command).toEqual({
      kind: "casual",
    });
  });

  it("returns empty transcript when the whole input IS the command", () => {
    const r = detectCommand("make it shorter");
    expect(r.command).toEqual({ kind: "shorter" });
    expect(r.transcript).toBe("");
  });

  it("returns { transcript: raw, command: null } for empty input", () => {
    expect(detectCommand("")).toEqual({ transcript: "", command: null });
    expect(detectCommand("   ")).toEqual({ transcript: "   ", command: null });
  });
});
