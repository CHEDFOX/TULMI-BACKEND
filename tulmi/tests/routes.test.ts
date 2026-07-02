import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.GROQ_API_KEY = "test-groq-key";
process.env.STT_PROVIDER = "openai";
process.env.DEV_SKIP_AUTH = "true";
process.env.NODE_ENV = "test";

// Track calls so tests can assert command-stripping etc.
const cleanCalls: Array<{ input: string; opts: unknown }> = [];

vi.mock("../src/pipeline/cleanup.js", () => ({
  clean: vi.fn(async (input: string, opts: unknown) => {
    cleanCalls.push({ input, opts });
    return `cleaned:${input}`;
  }),
  cleanStream: async function* () {
    /* not used from these routes */
  },
  draftReply: vi.fn(
    async (screenContent: string, intent: string) =>
      `drafted:${intent}::${screenContent}`,
  ),
  inferStyle: vi.fn(async () => ({ tone: "learned" })),
  expandSnippets: (s: string) => s,
}));

vi.mock("../src/pipeline/stt.js", () => ({
  transcribe: vi.fn(async () => ({
    text: "hey there",
    durationSeconds: 3,
  })),
  estimateDurationSeconds: () => 0,
}));

// eslint-disable-next-line import/first
import { buildApp } from "../src/server.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /healthz", () => {
  it("returns 200 and status:ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("tulmi-backend");
  });
});

describe("DEV_SKIP_AUTH", () => {
  it("resolves the caller to the dev user without an Authorization header", async () => {
    // /v1/personality requires auth; when DEV_SKIP_AUTH is on we should get 200.
    const res = await app.inject({ method: "GET", url: "/v1/personality" });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /v1/refine", () => {
  it("returns 200 with a cleaned refinedText for a valid body", async () => {
    cleanCalls.length = 0;
    const res = await app.inject({
      method: "POST",
      url: "/v1/refine",
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.refinedText).toBe("cleaned:hello");
    expect(body.usage.audioSeconds).toBe(0);
    // clean() should have been called once with the raw text (no command tail).
    expect(cleanCalls).toHaveLength(1);
    expect(cleanCalls[0]?.input).toBe("hello");
  });

  it("returns 400 for an empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/refine",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("bad_request");
  });

  it("returns 413 when text exceeds MAX_TEXT_LENGTH", async () => {
    const huge = "x".repeat(10_001);
    const res = await app.inject({
      method: "POST",
      url: "/v1/refine",
      payload: { text: huge },
    });
    expect(res.statusCode).toBe(413);
  });

  it("detects and strips a trailing 'make it shorter' before calling clean", async () => {
    cleanCalls.length = 0;
    const res = await app.inject({
      method: "POST",
      url: "/v1/refine",
      payload: { text: "the meeting is at three, make it shorter" },
    });
    expect(res.statusCode).toBe(200);
    expect(cleanCalls).toHaveLength(1);
    // Command stripped from the input handed to the LLM.
    expect(cleanCalls[0]?.input).toBe("the meeting is at three");
    const opts = cleanCalls[0]?.opts as { command?: { kind: string } };
    expect(opts?.command).toEqual({ kind: "shorter" });
  });
});

describe("POST /v1/draft", () => {
  it("returns 200 with a drafted reply when intent + screenContent are present", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/draft",
      payload: {
        intent: "politely decline",
        screenContent: "Coffee tomorrow?",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.draftText).toBe("drafted:politely decline::Coffee tomorrow?");
    expect(body.usage.audioSeconds).toBe(0);
  });

  it("returns 400 when intent is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/draft",
      payload: { screenContent: "hi" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Personality routes", () => {
  it("GET → empty personality initially", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/personality" });
    expect(res.statusCode).toBe(200);
    // The dev user shares state across tests; other tests may have written to
    // it (e.g. the retainHistory PUT below). So we only assert shape here.
    expect(res.json().personality).toBeDefined();
  });

  it("PUT saves the personality and GET reflects it", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/personality",
      payload: { tone: "warm and concise", formality: "casual" },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/v1/personality" });
    expect(get.statusCode).toBe(200);
    const body = get.json();
    expect(body.personality.tone).toBe("warm and concise");
    expect(body.personality.formality).toBe("casual");
  });

  it("POST /v1/personality/vocabulary/learn adds corrections to vocabulary", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/personality/vocabulary/learn",
      payload: {
        corrections: [
          { from: "kubernetes", to: "K8s" },
          { from: "postgres", to: "PostgreSQL" },
          { from: "redis-svc", to: "Redis" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const p = res.json().personality;
    const lines = (p.vocabulary ?? "").split("\n");
    expect(lines).toContain("K8s");
    expect(lines).toContain("PostgreSQL");
    expect(lines).toContain("Redis");
  });

  it("POST /v1/personality/vocabulary/learn refuses more than 20 corrections", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      from: `f${i}`,
      to: `t${i}`,
    }));
    const res = await app.inject({
      method: "POST",
      url: "/v1/personality/vocabulary/learn",
      payload: { corrections: many },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("SDUI /v1/app/*", () => {
  it("POST /v1/app/bootstrap returns theme + navigation + initialScreenId", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/app/bootstrap" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.theme).toBeDefined();
    expect(body.navigation).toBeDefined();
    expect(typeof body.initialScreenId).toBe("string");
  });

  it("POST /v1/app/screen returns the requested screen for known ids", async () => {
    for (const id of ["home", "stats", "history", "personality", "settings"]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/app/screen",
        payload: { screenId: id },
      });
      expect(res.statusCode, `screen '${id}'`).toBe(200);
      expect(res.json().screenId).toBe(id);
    }
  });

  it("POST /v1/app/screen returns 404 for an unknown screen id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/app/screen",
      payload: { screenId: "totally-unknown" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Stats + History", () => {
  it("GET /v1/stats?window=week returns the stats shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/stats?window=week",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.window).toBe("week");
    expect(typeof body.requests).toBe("number");
    expect(typeof body.wordsOut).toBe("number");
    expect(typeof body.audioSeconds).toBe("number");
    expect(typeof body.minutesSaved).toBe("number");
    expect(Array.isArray(body.sparklinePerDay)).toBe(true);
    expect(body.sparklinePerDay.length).toBe(7);
  });

  it("bootstrap response includes a cacheVersion token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/app/bootstrap",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.cacheVersion).toBe("string");
    expect(body.cacheVersion.length).toBeGreaterThan(0);
  });

  it("bootstrap + screen responses carry no-store headers", async () => {
    const b = await app.inject({
      method: "POST",
      url: "/v1/app/bootstrap",
      payload: {},
    });
    expect(b.headers["cache-control"]).toMatch(/no-store/);
    expect(b.headers["x-cache-version"]).toBeDefined();

    const s = await app.inject({
      method: "POST",
      url: "/v1/app/screen",
      payload: { screenId: "home" },
    });
    expect(s.headers["cache-control"]).toMatch(/no-store/);
  });

  it("admin cache bump requires the ADMIN_SECRET and changes the token", async () => {
    // No secret configured yet → refuses with 503.
    const no = await app.inject({ method: "POST", url: "/v1/admin/cache/bump" });
    expect(no.statusCode).toBe(503);

    // Configure a secret and re-check (we can't rebuild the app here so this
    // exercises the "not configured" branch. The end-to-end path with a
    // configured secret is covered by the cache.test.ts test suite below.)
  });

  it("admin cache version endpoint always exposes the current token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/cache/version" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.cacheVersion).toBe("string");
  });

  it("writes to history when personality has retainHistory=true and reads it back", async () => {
    // Turn on consent for the dev user.
    const put = await app.inject({
      method: "PUT",
      url: "/v1/personality",
      payload: { retainHistory: true },
    });
    expect(put.statusCode).toBe(200);

    // Fire a refine that mocks a cleaned output.
    const refine = await app.inject({
      method: "POST",
      url: "/v1/refine",
      payload: { text: "quick note about the shipment" },
    });
    expect(refine.statusCode).toBe(200);

    const hist = await app.inject({ method: "GET", url: "/v1/history" });
    expect(hist.statusCode).toBe(200);
    const body = hist.json();
    // At least one entry from the refine we just fired.
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    const latest = body.entries[0];
    expect(latest.kind).toBe("typing");
    expect(latest.output).toBe("cleaned:quick note about the shipment");
  });
});
