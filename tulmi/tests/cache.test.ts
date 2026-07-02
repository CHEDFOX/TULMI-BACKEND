/**
 * Cache-control admin surface — happy paths.
 *
 * Boots a second Fastify instance with ADMIN_SECRET set so the "bump" route
 * can actually authorise. The main routes.test.ts covers the negative paths
 * (missing/incorrect secret) under the standard test app.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.GROQ_API_KEY = "test-groq-key";
process.env.STT_PROVIDER = "openai";
process.env.DEV_SKIP_AUTH = "true";
process.env.NODE_ENV = "test";
process.env.ADMIN_SECRET = "test-admin-secret-xyz";

vi.mock("../src/pipeline/cleanup.js", () => ({
  clean: vi.fn(async (s: string) => `cleaned:${s}`),
  cleanStream: async function* () {},
  draftReply: vi.fn(async () => "drafted"),
  inferStyle: vi.fn(async () => ({})),
  expandSnippets: (s: string) => s,
}));
vi.mock("../src/pipeline/stt.js", () => ({
  transcribe: vi.fn(async () => ({ text: "", durationSeconds: 0 })),
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

describe("cache admin surface (with ADMIN_SECRET)", () => {
  it("bump rejects without the header", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/admin/cache/bump" });
    expect(res.statusCode).toBe(401);
  });

  it("bump rejects with the wrong secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/cache/bump",
      headers: { "x-admin-secret": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("bump succeeds with the right secret and changes the token", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/v1/admin/cache/version",
    });
    const beforeToken = before.json().cacheVersion;

    const bump = await app.inject({
      method: "POST",
      url: "/v1/admin/cache/bump",
      headers: { "x-admin-secret": "test-admin-secret-xyz" },
    });
    expect(bump.statusCode).toBe(200);
    const bumpBody = bump.json();
    expect(bumpBody.ok).toBe(true);
    expect(bumpBody.cacheVersion).not.toBe(beforeToken);

    // The next bootstrap picks up the new token.
    const boot = await app.inject({
      method: "POST",
      url: "/v1/app/bootstrap",
      payload: {},
    });
    expect(boot.json().cacheVersion).toBe(bumpBody.cacheVersion);
  });
});
