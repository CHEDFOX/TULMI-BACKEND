import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.GROQ_API_KEY = "test-groq-key";
process.env.STT_PROVIDER = "openai";
process.env.DEV_SKIP_AUTH = "true";
process.env.NODE_ENV = "test";

// Mock the pipeline so we don't touch OpenAI / OpenRouter over the wire. The
// stream returns a transcript event + cleaned deltas + done.
vi.mock("../src/pipeline/cleanup.js", () => ({
  clean: vi.fn(async (input: string) => `cleaned:${input}`),
  cleanStream: async function* (input: string) {
    yield input;
  },
  draftReply: vi.fn(async () => "drafted"),
  inferStyle: vi.fn(async () => ({})),
  expandSnippets: (s: string) => s,
}));

vi.mock("../src/pipeline/stt.js", () => ({
  transcribe: vi.fn(async () => ({
    text: "hey there",
    durationSeconds: 2,
  })),
  estimateDurationSeconds: () => 0,
}));

// eslint-disable-next-line import/first
import { buildApp } from "../src/server.js";

let app: FastifyInstance;
let port: number;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  port = addr.port;
});

afterAll(async () => {
  await app.close();
});

/** Open a WS to /v1/stream and wait until it's open. */
async function openStream(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

/** Await the next JSON server message from the socket. */
async function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const onMsg = (data: unknown) => {
      ws.off("error", onErr);
      try {
        resolve(JSON.parse(String(data)));
      } catch (err) {
        reject(err);
      }
    };
    const onErr = (err: Error) => {
      ws.off("message", onMsg);
      reject(err);
    };
    ws.once("message", onMsg);
    ws.once("error", onErr);
  });
}

describe("WebSocket /v1/stream", () => {
  it("responds to 'start' with 'ready'", async () => {
    const ws = await openStream();
    ws.send(
      JSON.stringify({
        type: "start",
        format: "webm",
        sampleRate: 16000,
      }),
    );
    const msg = await nextJson(ws);
    expect(msg.type).toBe("ready");
    ws.close();
  });

  it("returns an error when 'end' arrives with no audio", async () => {
    const ws = await openStream();
    ws.send(
      JSON.stringify({ type: "start", format: "webm", sampleRate: 16000 }),
    );
    await nextJson(ws); // 'ready'
    ws.send(JSON.stringify({ type: "end" }));
    const err = await nextJson(ws);
    expect(err.type).toBe("error");
    expect(err.code).toBe("bad_request");
    ws.close();
  });

  it("full lifecycle: start → binary → end → transcript/cleaned_delta/done", async () => {
    const ws = await openStream();
    const events: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => {
      try {
        events.push(JSON.parse(String(data)));
      } catch {
        /* ignore */
      }
    });

    ws.send(
      JSON.stringify({ type: "start", format: "webm", sampleRate: 16000 }),
    );
    // Give the server a beat to register the 'start', arm the idle timer, and
    // for the mocked auth Promise to resolve.
    await new Promise((r) => setTimeout(r, 60));
    // Send a small binary chunk so the "no audio" branch doesn't fire.
    ws.send(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await new Promise((r) => setTimeout(r, 20));
    ws.send(JSON.stringify({ type: "end" }));

    // Wait for the socket to close (server calls safeClose() after 'done').
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
    });

    const types = events.map((e) => e.type);
    expect(types).toContain("ready");
    expect(types).toContain("transcript");
    expect(types).toContain("cleaned_delta");
    expect(types).toContain("done");
    // Ordering: transcript comes before cleaned_delta, which comes before done.
    const iT = types.indexOf("transcript");
    const iC = types.indexOf("cleaned_delta");
    const iD = types.indexOf("done");
    expect(iT).toBeLessThan(iC);
    expect(iC).toBeLessThan(iD);
  });

  it("DEV_SKIP_AUTH accepts the connection with no Authorization header", async () => {
    // Same as the 'ready' test, but this documents the auth-off behavior as
    // an explicit contract the test suite relies on.
    const ws = await openStream();
    ws.send(
      JSON.stringify({ type: "start", format: "webm", sampleRate: 16000 }),
    );
    const msg = await nextJson(ws);
    expect(msg.type).toBe("ready");
    ws.close();
  });

  // Note: idle-timeout is 60s in code; not exercised here to keep the suite
  // fast. Would need env-configurable timeout for a fast test.
});
