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
import { createHash } from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import transcribeStream from "./routes/transcribe-stream.js";
import { getConfig, VERSION } from "./config.js";
import { resolveUser, supabase, type AuthedUser } from "./auth/supabase.js";
import { enforceQuota, recordUsage, usageSummary, usageWindows } from "./usage/metering.js";
import { captureException, fastifyLoggerOptions, initSentry } from "./observability.js";
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
  PrivacyAuditResponse,
  RefineRequest,
  RefineResponse,
  ServerMessage,
  SpeakRequest,
  TargetAppHint,
} from "../../shared/types/api.js";
import { WS_PATH } from "../../shared/types/api.js";

const cfg = getConfig();

// Sentry — opt-in via SENTRY_DSN. Awaited so error hooks are registered
// before Fastify starts accepting traffic.
await initSentry();

const app = Fastify({
  // Redact Authorization/api-key headers out of every log line + trim the
  // request serializer so large multipart bodies never enter the log. See
  // observability.fastifyLoggerOptions() for the redaction list.
  logger: fastifyLoggerOptions(),
  bodyLimit: 50 * 1024 * 1024, // 50 MB — generous ceiling for an audio clip
});

// Route unhandled errors through the observability layer (Sentry when
// configured, console otherwise) — Fastify's default error handler still runs
// after and formats the JSON response, this only tees the event.
app.addHook("onError", async (req, _reply, err) => {
  captureException(err, { route: req.routeOptions?.url, method: req.method });
});

await app.register(multipart, {
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});
await app.register(websocket);

// Rate-limit /v1/* routes. The key is the SHA-256 of the bearer token (so an
// attacker rotating fake tokens can't sidestep their per-user budget), or the
// client IP for anonymous callers. Health/readiness are excluded so
// load-balancer probes are never throttled.
await app.register(rateLimit, {
  global: false,
  max: cfg.RATE_LIMIT_MAX,
  timeWindow: cfg.RATE_LIMIT_WINDOW_MS,
  keyGenerator: (req) => {
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.length > 7) {
      // Hash the bearer so log lines / error reports never carry raw JWTs, and
      // so an attacker rotating a fake token can't "look" like a fresh user
      // per request. Truncated to 24 hex = 96 bits, plenty for a rate-limit key.
      const tok = auth.replace(/^Bearer\s+/i, "").trim();
      return "u:" + createHash("sha256").update(tok).digest("hex").slice(0, 24);
    }
    return "ip:" + req.ip;
  },
});

await app.register(transcribeStream);

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Refuse strings whose length exceeds the config-defined MAX_TEXT_LENGTH.
 *  Returns an error message when over-cap; null when ok. */
function tooLong(text: string | undefined): string | null {
  if (text == null) return null;
  if (text.length > cfg.MAX_TEXT_LENGTH) {
    return `text exceeds ${cfg.MAX_TEXT_LENGTH} chars (got ${text.length})`;
  }
  return null;
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

  const quota = await enforceQuota(user);
  if (quota) return reply.code(429).send({ code: "quota_exceeded", message: quota });

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
  const over = tooLong(body.text);
  if (over) return reply.code(413).send({ code: "bad_request", message: over });

  const quota = await enforceQuota(user);
  if (quota) return reply.code(429).send({ code: "quota_exceeded", message: quota });

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
  const tooBig = tooLong(body.intent) ?? tooLong(body.screenContent) ?? tooLong(body.recipient);
  if (tooBig) return reply.code(413).send({ code: "bad_request", message: tooBig });

  const quota = await enforceQuota(user);
  if (quota) return reply.code(429).send({ code: "quota_exceeded", message: quota });

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
  const over = tooLong(body.text) ?? tooLong(body.instructions);
  if (over) return reply.code(413).send({ code: "bad_request", message: over });

  const quota = await enforceQuota(user);
  if (quota) return reply.code(429).send({ code: "quota_exceeded", message: quota });

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
  const over =
    tooLong(personality.tone) ??
    tooLong(personality.signature) ??
    tooLong(personality.customInstructions) ??
    tooLong(personality.vocabulary) ??
    tooLong(personality.snippets);
  if (over) return reply.code(413).send({ code: "bad_request", message: over });
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
  const over = tooLong(body.sample);
  if (over) return reply.code(413).send({ code: "bad_request", message: over });

  const quota = await enforceQuota(user);
  if (quota) return reply.code(429).send({ code: "quota_exceeded", message: quota });

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

// --- Privacy audit (receipts screen) ----------------------------------------
//
// Feeds the in-app "Data & Privacy" screen. Nothing new is stored — this is
// just a projection of usage_events + the user's stated consent flags.
// Purpose: give users a concrete, honest answer to "what have you done with
// my stuff". Auditability, not marketing copy.

app.get("/v1/privacy/audit", { config: AUTHED_RL }, async (req, reply) => {
  const user = await resolveUser(req.headers["authorization"]);
  if (!user) {
    return reply.code(401).send({ code: "unauthorized", message: "Missing or invalid token" });
  }
  const [windows, personality] = await Promise.all([
    usageWindows(user),
    getPersonality(user),
  ]);
  const res: PrivacyAuditResponse = {
    windows,
    // Backend today deletes audio after the STT call regardless of the flag,
    // so this reports the flag's *stated intent* honestly (false unless the
    // user has opted in). Do not toggle to true until server-side retention
    // is actually implemented — a mislabelled "false" is safer than a false "true".
    audioRetained: personality.retainAudio === true,
    learningFromRuns: personality.learnFromSent === true,
    upstreamProviders: computeUpstreamProviders(),
    links: [
      { label: "Read policy", url: "https://tailzu.space/privacy" },
      { label: "Contact support", url: "mailto:support@tailzu.space" },
      { label: "Delete my data", url: "mailto:privacy@tailzu.space?subject=Delete%20my%20data" },
    ],
  };
  return reply.send(res);
});

/**
 * Which SaaS providers your text/audio may have gone to under the current
 * server configuration. Derived from env — the "delete provider X" toggle
 * (env change) automatically drops it from this list, so the audit stays
 * honest without a code push.
 */
function computeUpstreamProviders(): string[] {
  const out = new Set<string>();
  if (cfg.STT_PROVIDER === "openai" || cfg.OPENAI_API_KEY) out.add("OpenAI");
  if (cfg.STT_PROVIDER === "groq" || cfg.GROQ_API_KEY) out.add("Groq");
  if (cfg.DEEPGRAM_API_KEY) out.add("Deepgram");
  if (cfg.OPENROUTER_API_KEY) out.add("OpenRouter (cleanup LLM)");
  if (cfg.SUPABASE_URL) out.add("Supabase (auth + metering only)");
  return [...out];
}

// --- Account: delete everything we hold about a user ------------------------
//
// The Settings screen's "Delete account" button fires this. We remove the
// user's saved personality, profile, and usage_events, then ask Supabase Auth
// to delete the account itself (requires the service-role key; falls back to a
// "please email us" message when only the anon key is configured).
//
// This is intentionally destructive and irreversible — we don't hold a
// tombstone. The endpoint returns a small JSON summary of what was deleted so
// the client can show a receipt.

app.delete("/v1/account", { config: AUTHED_RL }, async (req, reply) => {
  const user = await resolveUser(req.headers["authorization"]);
  if (!user) {
    return reply.code(401).send({ code: "unauthorized", message: "Missing or invalid token" });
  }

  const admin = supabase();
  const summary = { personality: false, profile: false, usageEvents: 0, authAccount: false };

  if (admin) {
    // Delete usage rows and application-level tables. Errors are logged but
    // don't abort the sequence — the user still gets a partial receipt.
    try {
      const { count } = await admin
        .from("usage_events")
        .delete({ count: "exact" })
        .eq("user_id", user.id);
      summary.usageEvents = count ?? 0;
    } catch (err) { req.log.error({ err }, "delete usage_events"); }

    try {
      const { error } = await admin.from("personalities").delete().eq("user_id", user.id);
      summary.personality = !error;
    } catch (err) { req.log.error({ err }, "delete personalities"); }

    try {
      const { error } = await admin.from("profiles").delete().eq("user_id", user.id);
      summary.profile = !error;
    } catch (err) { req.log.error({ err }, "delete profiles"); }

    // Auth deletion requires the service-role key. When it fails we return a
    // partial-success message rather than pretending the account is gone.
    try {
      const { error } = await admin.auth.admin.deleteUser(user.id);
      summary.authAccount = !error;
    } catch (err) {
      req.log.error({ err }, "delete auth user");
    }
  }

  return reply.send({
    status: summary.authAccount ? "deleted" : "partial",
    ...summary,
    message: summary.authAccount
      ? "Your account and all associated data have been deleted."
      : "Data removed. To finalize account deletion, email privacy@tailzu.space.",
  });
});

// --- Keyboard config (server-driven keyboard; cached by the native shell) ----

app.get("/v1/keyboard/config", { config: UNAUTH_RL }, async (_req, reply) => {
  return reply.send(buildKeyboardConfig());
});

// --- Voice (WebSocket): live streaming --------------------------------------

app.register(async (instance) => {
  // Same audio ceiling as /v1/transcribe-stream, in bytes. This WS collects
  // the whole clip in memory before running the batched pipeline, so an
  // unbounded chunks[] is a real OOM risk.
  const MAX_STREAM_BYTES = 30 * 1024 * 1024;
  const IDLE_TIMEOUT_MS = 60_000;

  instance.get(WS_PATH, { websocket: true }, (socket, req) => {
    const send = (msg: ServerMessage) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(msg));
    };

    let started = false;
    let format: AudioFormat = "webm";
    let targetApp: TargetAppHint | undefined;
    let language: LanguageHint | undefined;
    let personalityOverride: Personality | undefined;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let authedUser: AuthedUser | null = null;
    let authReady = false;
    let closed = false;
    let idleTimer: NodeJS.Timeout | null = null;

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        send({ type: "error", code: "bad_request", message: "idle timeout" });
        safeClose();
      }, IDLE_TIMEOUT_MS);
    };

    const safeClose = () => {
      closed = true;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      try { socket.close(); } catch { /* ignore */ }
    };

    // Verify auth on connect (header carried through the upgrade request).
    // We DO NOT accept any binary frame until authReady = true — silent-drop
    // is safer than buffering unbounded audio for an unauthenticated caller.
    resolveUser(req.headers["authorization"]).then(async (user) => {
      if (!user) {
        send({ type: "error", code: "unauthorized", message: "Missing or invalid token" });
        safeClose();
        return;
      }
      const over = await enforceQuota(user);
      if (over) {
        send({ type: "error", code: "quota_exceeded", message: over });
        safeClose();
        return;
      }
      authedUser = user;
      authReady = true;
    });

    socket.on("message", async (data: Buffer, isBinary: boolean) => {
      if (closed) return;

      // Binary frame → audio chunk. Refuse until auth resolved AND client
      // sent "start"; cap total bytes; reset idle window.
      if (isBinary) {
        if (!authReady || !started) return; // silent drop
        totalBytes += data.length;
        if (totalBytes > MAX_STREAM_BYTES) {
          send({ type: "error", code: "audio_too_long", message: "stream size cap reached" });
          safeClose();
          return;
        }
        chunks.push(data);
        armIdle();
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
        armIdle();
        return;
      }

      if (msg.type === "end") {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        const user = authedUser;
        if (!user) {
          send({ type: "error", code: "unauthorized", message: "Not authenticated" });
          safeClose();
          return;
        }
        if (chunks.length === 0) {
          send({ type: "error", code: "bad_request", message: "No audio received" });
          safeClose();
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
          safeClose();
        }
      }
    });

    socket.on("close", () => { closed = true; if (idleTimer) clearTimeout(idleTimer); });
    socket.on("error", () => { closed = true; if (idleTimer) clearTimeout(idleTimer); });
  });
});

// --- Boot -------------------------------------------------------------------

try {
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
