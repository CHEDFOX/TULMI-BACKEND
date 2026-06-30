/**
 * Tulmi backend HTTP/WS server.
 *
 *   GET  /healthz                 → liveness
 *   POST /v1/transcribe-clean     → voice: multipart audio → cleaned text
 *   WS   /v1/stream               → voice (live): audio frames up, text down
 *   POST /v1/refine               → typing: text → polished text (autocorrect)
 *   POST /v1/draft                → screen: screen content + intent → reply
 *   POST /v1/speak                → voice out: text → spoken audio (TTS)
 *   GET  /v1/personality          → read the user's saved style profile
 *   PUT  /v1/personality          → save the user's style profile
 *
 * Every output is shaped by the user's personality + the target-app context,
 * resolved here on the backend (the app just sends the inputs).
 */
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import transcribeStream from "./routes/transcribe-stream.js";
import { getConfig, VERSION } from "./config.js";
import { resolveUser, type AuthedUser } from "./auth/supabase.js";
import { recordUsage, usageSummary } from "./usage/metering.js";
import { getProfile, updateProfile } from "./profile/store.js";
import { runPipeline, runPipelineStream } from "./pipeline/index.js";
import { clean, draftReply, inferStyle } from "./pipeline/cleanup.js";
import { synthesize } from "./pipeline/tts.js";
import {
  getPersonality,
  savePersonality,
  resolvePersonality,
} from "./personality/store.js";
import { buildBootstrap, buildScreen, buildKeyboardConfig } from "./experience/catalog.js";
import { localize } from "./experience/i18n.js";
import type {
  AudioFormat,
  ClientMessage,
  DraftRequest,
  DraftResponse,
  HealthResponse,
  LanguageHint,
  Personality,
  PersonalityResponse,
  RefineRequest,
  RefineResponse,
  ServerMessage,
  SpeakRequest,
  TargetAppHint,
} from "../../shared/types/api.js";
import { WS_PATH } from "../../shared/types/api.js";

const cfg = getConfig();

const app = Fastify({
  logger: true,
  bodyLimit: 50 * 1024 * 1024, // 50 MB — generous ceiling for an audio clip
});

await app.register(multipart, {
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});
await app.register(websocket);

// Rate-limit /v1/* routes. The keyGenerator falls back to IP for anonymous
// callers (SDUI bootstrap/screen) and uses the bearer token for authed callers
// so one user can't blow another's budget. Health/readiness are excluded so
// load-balancer probes are never throttled.
await app.register(rateLimit, {
  global: false,
  max: cfg.RATE_LIMIT_MAX,
  timeWindow: cfg.RATE_LIMIT_WINDOW_MS,
  keyGenerator: (req) => {
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.length > 7) return auth;
    return req.ip;
  },
});

await app.register(transcribeStream);

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

// --- Health -----------------------------------------------------------------

// /healthz — liveness only. Cheap, no upstream calls. Used by Docker HEALTHCHECK.
app.get("/healthz", async (): Promise<HealthResponse> => {
  return { status: "ok", service: "tulmi-backend", version: VERSION };
});

// /readyz — readiness. Pings the upstreams the pipeline depends on so an
// orchestrator (or operator) can tell "process alive" from "actually serving".
// Cached for 5 s so a flood of probes can't push us into upstream rate limits.
type Readiness = { name: string; ok: boolean; detail?: string };
let readyCache: { at: number; status: number; body: unknown } | null = null;
const READY_CACHE_MS = 5_000;

async function pingHead(url: string, timeoutMs = 1500): Promise<Readiness> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", signal: ctl.signal });
    // 2xx-4xx all mean the host is reachable; 5xx means upstream is sick.
    return { name: url, ok: res.status < 500, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { name: url, ok: false, detail: (err as Error).message };
  } finally {
    clearTimeout(t);
  }
}

app.get("/readyz", async (_req, reply) => {
  const now = Date.now();
  if (readyCache && now - readyCache.at < READY_CACHE_MS) {
    return reply.code(readyCache.status).send(readyCache.body);
  }
  const checks: Readiness[] = [];
  checks.push(await pingHead("https://openrouter.ai/api/v1/models"));
  if (cfg.SUPABASE_URL) {
    checks.push(await pingHead(`${cfg.SUPABASE_URL}/auth/v1/health`));
  } else {
    checks.push({ name: "supabase", ok: cfg.DEV_SKIP_AUTH, detail: "not configured (DEV_SKIP_AUTH)" });
  }
  const allOk = checks.every((c) => c.ok);
  const status = allOk ? 200 : 503;
  const body = {
    status: allOk ? "ready" : "degraded",
    service: "tulmi-backend",
    version: VERSION,
    checks,
  };
  readyCache = { at: now, status, body };
  return reply.code(status).send(body);
});

// --- Voice (REST): one-shot transcribe + clean ------------------------------

const ALLOWED_FORMATS: AudioFormat[] = [
  "wav",
  "m4a",
  "webm",
  "mp3",
  "ogg",
  "flac",
];

function formatFromFilename(name: string | undefined): AudioFormat | null {
  const ext = name?.split(".").pop()?.toLowerCase() as AudioFormat | undefined;
  return ext && ALLOWED_FORMATS.includes(ext) ? ext : null;
}

const AUTHED_RL = {
  rateLimit: { max: cfg.RATE_LIMIT_MAX, timeWindow: cfg.RATE_LIMIT_WINDOW_MS },
};
const UNAUTH_RL = {
  rateLimit: {
    max: cfg.RATE_LIMIT_UNAUTH_MAX,
    timeWindow: cfg.RATE_LIMIT_WINDOW_MS,
  },
};

app.post("/v1/transcribe-clean", { config: AUTHED_RL }, async (req, reply) => {
  const user = await resolveUser(req.headers["authorization"]);
  if (!user) {
    return reply.code(401).send({ code: "unauthorized", message: "Missing or invalid token" });
  }

  let audio: Buffer | null = null;
  let format: AudioFormat | null = null;
  let targetApp: TargetAppHint | undefined;
  let language: LanguageHint | undefined;
  let personalityOverride: Personality | undefined;

  // Iterate multipart parts: one file ("audio") + optional text fields.
  for await (const part of req.parts()) {
    if (part.type === "file") {
      format = formatFromFilename(part.filename) ?? "m4a";
      audio = await part.toBuffer();
    } else if (part.fieldname === "targetApp") {
      targetApp = String(part.value);
    } else if (part.fieldname === "language") {
      language = String(part.value) as LanguageHint;
    } else if (part.fieldname === "personality") {
      try {
        personalityOverride = JSON.parse(String(part.value)) as Personality;
      } catch {
        /* ignore malformed personality field */
      }
    }
  }

  if (!audio || !format) {
    return reply.code(400).send({ code: "bad_request", message: "Missing 'audio' file" });
  }

  try {
    const personality = await resolvePersonality(user, personalityOverride);
    const result = await runPipeline({ audio, format, targetApp, language, personality });
    await recordUsage({ user, source: "rest", ...result.usage });
    return reply.send(result);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ code: "internal", message: "Pipeline failed" });
  }
});

// --- Typing (REST): refine typed text ---------------------------------------

app.post("/v1/refine", { config: AUTHED_RL }, async (req, reply) => {
  const user = await resolveUser(req.headers["authorization"]);
  if (!user) {
    return reply.code(401).send({ code: "unauthorized", message: "Missing or invalid token" });
  }

  const body = (req.body ?? {}) as RefineRequest;
  if (!body.text || !body.text.trim()) {
    return reply.code(400).send({ code: "bad_request", message: "Missing 'text'" });
  }

  try {
    const personality = await resolvePersonality(user, body.personality);
    const refinedText = await clean(body.text, {
      targetApp: body.targetApp,
      language: body.language,
      personality,
    });
    const usage = {
      audioSeconds: 0,
      words: countWords(refinedText),
      model: cfg.CLEANUP_MODEL,
    };
    await recordUsage({ user, source: "rest", ...usage });
    const res: RefineResponse = { refinedText, usage };
    return reply.send(res);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ code: "cleanup_failed", message: "Refine failed" });
  }
});

// --- Screen (REST): draft a personalized reply ------------------------------

app.post("/v1/draft", { config: AUTHED_RL }, async (req, reply) => {
  const user = await resolveUser(req.headers["authorization"]);
  if (!user) {
    return reply.code(401).send({ code: "unauthorized", message: "Missing or invalid token" });
  }

  const body = (req.body ?? {}) as DraftRequest;
  if (!body.intent || !body.intent.trim()) {
    return reply.code(400).send({ code: "bad_request", message: "Missing 'intent'" });
  }

  try {
    const personality = await resolvePersonality(user, body.personality);
    const draftText = await draftReply(
      body.screenContent ?? "",
      body.intent,
      { targetApp: body.targetApp, language: body.language, personality },
      body.recipient,
    );
    const usage = {
      audioSeconds: 0,
      words: countWords(draftText),
      model: cfg.CLEANUP_MODEL,
    };
    await recordUsage({ user, source: "rest", ...usage });
    const res: DraftResponse = { draftText, usage };
    return reply.send(res);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ code: "cleanup_failed", message: "Draft failed" });
  }
});

// --- Text-to-speech (REST): text → spoken audio -----------------------------

app.post("/v1/speak", { config: AUTHED_RL }, async (req, reply) => {
  const user = await resolveUser(req.headers["authorization"]);
  if (!user) {
    return reply.code(401).send({ code: "unauthorized", message: "Missing or invalid token" });
  }

  const body = (req.body ?? {}) as SpeakRequest;
  if (!body.text || !body.text.trim()) {
    return reply.code(400).send({ code: "bad_request", message: "Missing 'text'" });
  }

  try {
    const { audio, contentType } = await synthesize({
      text: body.text,
      voice: body.voice,
      format: body.format,
      instructions: body.instructions,
    });
    await recordUsage({
      user,
      source: "rest",
      audioSeconds: 0,
      words: countWords(body.text),
      model: cfg.OPENAI_TTS_MODEL,
    });
    return reply.header("content-type", contentType).send(audio);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ code: "internal", message: "TTS failed" });
  }
});

// --- Personality (REST): read / save the user's style profile ---------------

app.get("/v1/personality", { config: AUTHED_RL }, async (req, reply) => {
  const user = await resolveUser(req.headers["authorization"]);
  if (!user) {
    return reply.code(401).send({ code: "unauthorized", message: "Missing or invalid token" });
  }
  const personality = await getPersonality(user);
  const res: PersonalityResponse = { personality };
  return reply.send(res);
});

app.put("/v1/personality", { config: AUTHED_RL }, async (req, reply) => {
  const user = await resolveUser(req.headers["authorization"]);
  if (!user) {
    return reply.code(401).send({ code: "unauthorized", message: "Missing or invalid token" });
  }
  const personality = (req.body ?? {}) as Personality;
  try {
    await savePersonality(user, personality);
    const res: PersonalityResponse = { personality };
    return reply.send(res);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ code: "internal", message: "Failed to save personality" });
  }
});

// Learn a style profile from a sample of the user's own writing, merge it into
// their saved personality, and return the result.
app.post("/v1/personality/learn", { config: AUTHED_RL }, async (req, reply) => {
  const user = await resolveUser(req.headers["authorization"]);
  if (!user) {
    return reply.code(401).send({ code: "unauthorized", message: "Missing or invalid token" });
  }
  const body = (req.body ?? {}) as { sample?: string };
  if (!body.sample || !body.sample.trim()) {
    return reply.code(400).send({ code: "bad_request", message: "Missing 'sample'" });
  }
  try {
    const inferred = await inferStyle(body.sample);
    const merged = { ...(await getPersonality(user)), ...inferred };
    await savePersonality(user, merged);
    const res: PersonalityResponse = { personality: merged };
    return reply.send(res);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ code: "internal", message: "Failed to learn style" });
  }
});

// --- Experience (SDUI): the backend drives the app's UI ---------------------
//
// The app is a generic renderer; these endpoints decide what it draws. Auth is
// optional here so the shell can boot pre-login (personality is empty for guests).

app.post("/v1/app/bootstrap", { config: UNAUTH_RL }, async (req, reply) => {
  // Auth is optional here so the shell can boot; when present, the user's
  // profile decides whether onboarding still needs to run.
  const user = await resolveUser(req.headers["authorization"]);
  const profile = user ? await getProfile(user) : null;
  const bootstrap = buildBootstrap({ onboarded: profile?.onboarded ?? false });
  return reply.send(await localize(bootstrap, profile?.language ?? "en"));
});

app.post("/v1/app/screen", { config: UNAUTH_RL }, async (req, reply) => {
  const body = (req.body ?? {}) as { screenId?: string };
  const screenId = body.screenId;
  if (!screenId) {
    return reply.code(400).send({ code: "bad_request", message: "Missing 'screenId'" });
  }

  const user = await resolveUser(req.headers["authorization"]);
  const [personality, profile] = user
    ? await Promise.all([getPersonality(user), getProfile(user)])
    : [{}, null];

  const usage = user && screenId === "stats" ? await usageSummary(user) : undefined;
  const screen = buildScreen(screenId, {
    personality,
    language: profile?.language ?? "auto",
    email: user?.email,
    usage,
  });
  if (!screen) {
    return reply.code(404).send({ code: "bad_request", message: `Unknown screen '${screenId}'` });
  }
  return reply.send(await localize(screen, profile?.language ?? "auto"));
});

// --- Profile (REST): language + onboarding state ----------------------------

app.get("/v1/profile", { config: AUTHED_RL }, async (req, reply) => {
  const user = await resolveUser(req.headers["authorization"]);
  if (!user) {
    return reply.code(401).send({ code: "unauthorized", message: "Missing or invalid token" });
  }
  return reply.send(await getProfile(user));
});

app.put("/v1/profile", { config: AUTHED_RL }, async (req, reply) => {
  const user = await resolveUser(req.headers["authorization"]);
  if (!user) {
    return reply.code(401).send({ code: "unauthorized", message: "Missing or invalid token" });
  }
  const body = (req.body ?? {}) as { language?: string; onboarded?: boolean };
  const patch: { language?: string; onboarded?: boolean } = {};
  if (typeof body.language === "string") patch.language = body.language;
  if (typeof body.onboarded === "boolean") patch.onboarded = body.onboarded;
  try {
    return reply.send(await updateProfile(user, patch));
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ code: "internal", message: "Failed to save profile" });
  }
});

// --- Keyboard config (server-driven keyboard; cached by the native shell) ----

app.get("/v1/keyboard/config", { config: UNAUTH_RL }, async (_req, reply) => {
  return reply.send(buildKeyboardConfig());
});

// --- Voice (WebSocket): live streaming --------------------------------------

app.register(async (instance) => {
  instance.get(WS_PATH, { websocket: true }, (socket, req) => {
    const send = (msg: ServerMessage) => socket.send(JSON.stringify(msg));

    let started = false;
    let format: AudioFormat = "webm";
    let targetApp: TargetAppHint | undefined;
    let language: LanguageHint | undefined;
    let personalityOverride: Personality | undefined;
    const chunks: Buffer[] = [];
    let authedUser: AuthedUser | null = null;

    // Verify auth on connect (header carried through the upgrade request).
    resolveUser(req.headers["authorization"]).then((user) => {
      if (!user) {
        send({ type: "error", code: "unauthorized", message: "Missing or invalid token" });
        socket.close();
        return;
      }
      authedUser = user;
    });

    socket.on("message", async (data: Buffer, isBinary: boolean) => {
      // Binary frame → audio chunk.
      if (isBinary) {
        if (started) chunks.push(data);
        return;
      }

      // Text frame → control message.
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        send({ type: "error", code: "bad_request", message: "Invalid JSON control frame" });
        return;
      }

      if (msg.type === "start") {
        started = true;
        format = msg.format;
        targetApp = msg.targetApp;
        language = msg.language;
        personalityOverride = msg.personality;
        send({ type: "ready" });
        return;
      }

      if (msg.type === "end") {
        const user = authedUser;
        if (!user) {
          send({ type: "error", code: "unauthorized", message: "Not authenticated" });
          return;
        }
        if (chunks.length === 0) {
          send({ type: "error", code: "bad_request", message: "No audio received" });
          return;
        }
        const audio = Buffer.concat(chunks);
        try {
          const personality = await resolvePersonality(user, personalityOverride);
          for await (const ev of runPipelineStream({
            audio,
            format,
            targetApp,
            language,
            personality,
          })) {
            send(ev);
            if (ev.type === "done") {
              await recordUsage({ user, source: "stream", ...ev.usage });
            }
          }
        } catch (err) {
          req.log.error(err);
          send({ type: "error", code: "internal", message: "Pipeline failed" });
        } finally {
          socket.close();
        }
      }
    });
  });
});

// --- Boot -------------------------------------------------------------------

try {
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
