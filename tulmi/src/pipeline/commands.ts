/**
 * Command mode — trailing "…MAKE IT SHORTER" style overrides.
 *
 * The user speaks (or types) a natural-language override at the TAIL of their
 * dictation to steer the cleanup for one run. This module detects that trailer
 * with regex, strips it out of the transcript, and returns a discriminated
 * Command the cleanup pipeline can apply as a per-run prompt addendum.
 *
 *   "hey uh the meeting is at three, MAKE IT SHORTER"
 *     → transcript = "hey uh the meeting is at three"
 *     → command    = { kind: "shorter" }
 *
 * Design constraints:
 *  - Trailing-only: the command must be the LAST utterance. Mid-sentence uses
 *    like "the article is shorter" must NOT match.
 *  - Multi-command: if the user chained "MAKE IT SHORTER, MAKE IT LONGER",
 *    only the tail (the last one) applies.
 *  - Case-insensitive; tolerant of trailing punctuation (".", "!", "…").
 */
import type { Command } from "../../../shared/types/api.js";

// Common "please make it" / "now make it" preamble. Kept non-capturing so
// the whole match can be sliced off the transcript in one go.
const MAKE_IT =
  "(?:please\\s+)?(?:now\\s+)?(?:make\\s+it|make\\s+this|make\\s+that)";

// Trailing bag: punctuation + whitespace we allow after the command word.
const TAIL = "[\\s.!?…,\"'\\)\\]]*";

/**
 * Ordered list of (regex, factory) pairs. Every regex is anchored to $ so it
 * only matches at the tail. We accept a small optional leading connector
 * (",", "and", "then", "…", filler space) so the stripped transcript comes
 * back clean without a dangling comma.
 */
const PATTERNS: Array<{ re: RegExp; make: (m: RegExpMatchArray) => Command }> = [
  // shorter / longer
  {
    re: new RegExp(
      `[,;\\-—…]?\\s*(?:and\\s+|then\\s+)?${MAKE_IT}\\s+(?:a\\s+bit\\s+|much\\s+|way\\s+|more\\s+)?shorter${TAIL}$`,
      "i",
    ),
    make: () => ({ kind: "shorter" }),
  },
  {
    re: new RegExp(
      `[,;\\-—…]?\\s*(?:and\\s+|then\\s+)?${MAKE_IT}\\s+(?:a\\s+bit\\s+|much\\s+|way\\s+|more\\s+)?longer${TAIL}$`,
      "i",
    ),
    make: () => ({ kind: "longer" }),
  },

  // formal / casual — "make it formal" or "make it more formal"
  {
    re: new RegExp(
      `[,;\\-—…]?\\s*(?:and\\s+|then\\s+)?${MAKE_IT}\\s+(?:more\\s+)?formal${TAIL}$`,
      "i",
    ),
    make: () => ({ kind: "formal" }),
  },
  {
    re: new RegExp(
      `[,;\\-—…]?\\s*(?:and\\s+|then\\s+)?${MAKE_IT}\\s+(?:more\\s+)?casual${TAIL}$`,
      "i",
    ),
    make: () => ({ kind: "casual" }),
  },

  // bullet points — "in bullet points", "as bullets", "as a bulleted list"
  {
    re: new RegExp(
      `[,;\\-—…]?\\s*(?:and\\s+|then\\s+)?(?:in|as|to)\\s+(?:a\\s+)?bullet(?:ed)?\\s?points?${TAIL}$`,
      "i",
    ),
    make: () => ({ kind: "bulletpoints" }),
  },
  {
    re: new RegExp(
      `[,;\\-—…]?\\s*(?:and\\s+|then\\s+)?(?:in|as|to)\\s+(?:a\\s+)?bullet(?:ed)?\\s+list${TAIL}$`,
      "i",
    ),
    make: () => ({ kind: "bulletpoints" }),
  },
  {
    // Standalone "as bullets" / "as bullet" — no explicit "points"/"list".
    re: new RegExp(
      `[,;\\-—…]?\\s*(?:and\\s+|then\\s+)?(?:in|as)\\s+bullets${TAIL}$`,
      "i",
    ),
    make: () => ({ kind: "bulletpoints" }),
  },

  // translate — captures the target language. Accept 1-2 word language names
  // ("english", "brazilian portuguese", "simplified chinese"). We keep the
  // captured span loose; the LLM does the actual language mapping.
  {
    re: new RegExp(
      `[,;\\-—…]?\\s*(?:and\\s+|then\\s+)?translate\\s+(?:this|it|that)?\\s*(?:to|into|in)\\s+([A-Za-z][A-Za-z\\-]*(?:\\s+[A-Za-z][A-Za-z\\-]*)?)${TAIL}$`,
      "i",
    ),
    make: (m) => ({ kind: "translate", lang: (m[1] ?? "").trim().toLowerCase() }),
  },

  // emoji off — "no emoji", "no emojis", "without emojis", "less emoji"
  {
    re: new RegExp(
      `[,;\\-—…]?\\s*(?:and\\s+|then\\s+)?(?:no|without|less|fewer)\\s+emojis?${TAIL}$`,
      "i",
    ),
    make: () => ({ kind: "emojiOff" }),
  },

  // emoji on — "add emoji", "with emoji", "more emojis"
  {
    re: new RegExp(
      `[,;\\-—…]?\\s*(?:and\\s+|then\\s+)?(?:add|with|more|use)\\s+emojis?${TAIL}$`,
      "i",
    ),
    make: () => ({ kind: "emojiOn" }),
  },
];

/** Match every pattern once, return the earliest tail match (or null). */
function matchTail(text: string): { start: number; command: Command } | null {
  let best: { start: number; command: Command } | null = null;
  for (const { re, make } of PATTERNS) {
    const m = text.match(re);
    if (!m || m.index == null) continue;
    // Earliest tail-anchored match wins — every regex ends at text.length,
    // so the one starting earliest ate the most trailing text (including
    // its own leading connector).
    if (!best || m.index < best.start) {
      best = { start: m.index, command: make(m) };
    }
  }
  return best;
}

/**
 * Detect a command at the tail of the raw transcript.
 *
 * Only the TAIL command applies — but chained commands
 * ("…MAKE IT SHORTER, MAKE IT LONGER") are peeled off iteratively so the
 * remaining transcript is clean text with no leftover command phrases.
 * The FIRST detected command (the true tail) is the one returned; earlier
 * chained commands are discarded along with their phrase.
 */
export function detectCommand(rawTranscript: string): {
  transcript: string;
  command: Command | null;
} {
  const raw = rawTranscript ?? "";
  if (!raw.trim()) return { transcript: raw, command: null };

  let text = raw;
  let head: Command | null = null;
  // Bounded loop: each peel strictly shortens `text`. Guard with a hard cap
  // so a pathological regex can never spin forever.
  for (let i = 0; i < 8; i++) {
    const hit = matchTail(text);
    if (!hit) break;
    if (head === null) head = hit.command;
    text = text.slice(0, hit.start).replace(/[\s,;:.\-—…]+$/g, "").trim();
    if (!text) break;
  }

  return { transcript: text, command: head };
}
