/**
 * Tulmi live dictation — backend streaming endpoint (DROP-IN for the backend repo).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ This file does NOT belong to the app repo — it's a handoff artifact.      │
 * │ Copy it into your Fastify backend repo (the one on the VPS) and register  │
 * │ it. See STREAMING-BACKEND.md (next to this file) for the 5-step setup.    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Implements the WebSocket side of STREAMING.md:
 *   GET /v1/transcribe-stream
 *   client → { type:"start", ... } then raw 16 kHz mono PCM frames, then { type:"stop" }
 *   server → { type:"ready" | "partial" | "final" | "done" | "error", text? }
 *
 * Speech engine: Deepgram (streaming). Swap `openEngine` for AssemblyAI / OpenAI
 * Realtime / self-hosted Whisper later — the wire protocol to the phone is the
 * same, so no app changes are needed.
 *
 * Requires:  npm i @fastify/websocket @deepgram/sdk
 * Env:       DEEPGRAM_API_KEY=...     (and your existing DEV_SKIP_AUTH / Supabase)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import websocket from "@fastify/websocket";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";

interface StartMessage {
  type: "start";
  token?: string;
  targetApp?: string;
  language?: string; // "auto" | "hi" | "en" | "multi" | ...
  sampleRate?: number;
  encoding?: string;
  channels?: number;
}

async function transcribeStream(fastify: FastifyInstance): Promise<void> {
  // Safe to register more than once; guard if your app already adds it.
  if (!fastify.hasDecorator("websocketServer")) {
    await fastify.register(websocket);
  }

  const deepgram = createClient(process.env.DEEPGRAM_API_KEY ?? "");

  fastify.get(
    "/v1/transcribe-stream",
    { websocket: true },
    (socket: any, _req: FastifyRequest) => {
      let dg: any = null;
      let closed = false;

      const send = (obj: unknown) => {
        // ws readyState OPEN === 1
        if (!closed && socket.readyState === 1) socket.send(JSON.stringify(obj));
      };

      const closeEngine = () => {
        try {
          // @deepgram/sdk v3 renamed finish() → requestClose(); support both.
          if (typeof dg?.requestClose === "function") dg.requestClose();
          else if (typeof dg?.finish === "function") dg.finish();
        } catch {
          /* ignore */
        }
      };

      const openEngine = (start: StartMessage) => {
        if (!process.env.DEEPGRAM_API_KEY) {
          send({ type: "error", message: "DEEPGRAM_API_KEY not set on the server" });
          return;
        }
        // "auto" → Deepgram's multilingual model. Pass a specific code (e.g. "hi")
        // to lock a language. Tune model/options to taste.
        const language =
          !start.language || start.language === "auto" ? "multi" : start.language;

        dg = deepgram.listen.live({
          model: "nova-2",
          language,
          encoding: "linear16", // matches the app's pcm_s16le
          sample_rate: start.sampleRate ?? 16000,
          channels: start.channels ?? 1,
          interim_results: true, // gives us live "partial" text
          smart_format: true,
          punctuate: true,
        });

        dg.on(LiveTranscriptionEvents.Open, () => send({ type: "ready" }));
        dg.on(LiveTranscriptionEvents.Transcript, (data: any) => {
          const text = data?.channel?.alternatives?.[0]?.transcript ?? "";
          if (!text) return;
          // is_final marks the end of a segment → commit it; interim → replace.
          send({ type: data.is_final ? "final" : "partial", text });
        });
        dg.on(LiveTranscriptionEvents.Error, (e: any) =>
          send({ type: "error", message: String(e?.message ?? e) }),
        );
      };

      socket.on("message", (raw: Buffer, isBinary: boolean) => {
        // Binary frames are audio → forward straight to the engine.
        if (isBinary) {
          if (dg) {
            try {
              dg.send(raw);
            } catch {
              /* engine not ready yet */
            }
          }
          return;
        }

        // Text frames are JSON control messages.
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (msg.type === "start") {
          // TODO (auth): unless process.env.DEV_SKIP_AUTH === "true", verify
          // msg.token as a Supabase JWT here (reuse your existing verifier) and
          // close with { type:"error" } if invalid. Left open so it works
          // against DEV_SKIP_AUTH first, like the rest of the backend.
          openEngine(msg as StartMessage);
        } else if (msg.type === "stop") {
          closeEngine();
          // Flush, tell the client we're done, then close the socket.
          setTimeout(() => {
            send({ type: "done" });
            try {
              socket.close();
            } catch {
              /* ignore */
            }
          }, 300);
        }
      });

      socket.on("close", () => {
        closed = true;
        closeEngine();
      });
      socket.on("error", () => {
        closed = true;
        closeEngine();
      });
    },
  );
}

export default fp(transcribeStream, { name: "tulmi-transcribe-stream" });
