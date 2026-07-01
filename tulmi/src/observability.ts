/**
 * Observability wire-up.
 *
 * - Structured logs: uses Fastify's own pino logger with a redaction list that
 *   strips Authorization headers, api keys, and Supabase JWTs out of every log
 *   line — so a leaked log file doesn't leak user tokens.
 * - Sentry: opt-in via SENTRY_DSN. When the env var is unset (dev / a fresh
 *   VPS) this module no-ops and exports a shim `captureException` that logs
 *   locally instead of sending. Adds zero runtime cost when disabled.
 *
 * Import order matters: this module reads getConfig(), which reads env; so
 * server.ts imports it AFTER dotenv has been loaded (which happens inside
 * getConfig).
 */
import { getConfig } from "./config.js";

let sentryReady = false;

// Loaded lazily so the require survives the runtime image never installing
// @sentry/node (e.g. when SENTRY_DSN is unset — Sentry stays a dev-only dep).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sentry: any = null;

/**
 * Fastify logger options with redactions applied. Pass this straight to
 * Fastify({ logger }) so every log line the server emits is JSON with
 * secrets scrubbed.
 */
export function fastifyLoggerOptions() {
  return {
    level: process.env.LOG_LEVEL ?? "info",
    // Pino's built-in redact — cheap, guaranteed to run before serialization.
    redact: {
      paths: [
        // Common carriers of user tokens.
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers["x-supabase-auth"]',
        'headers.authorization',
        'headers.cookie',
        // Fastify's own request/reply serializer paths.
        '*.authorization',
        '*.token',
        '*.access_token',
        '*.refresh_token',
        '*.api_key',
        '*.apiKey',
        '*.password',
      ],
      censor: "[redacted]",
      remove: false,
    },
    // Trim request logs to safe fields (Fastify's default includes the whole
    // req/res which can accidentally serialize a huge JSON body).
    serializers: {
      req(req: { method: string; url: string; ip?: string; id?: string }) {
        return { id: req.id, method: req.method, url: req.url, ip: req.ip };
      },
    },
  };
}

/**
 * Initialise Sentry if SENTRY_DSN is set. Safe to call more than once; the
 * second call is a no-op.
 */
export async function initSentry(): Promise<void> {
  if (sentryReady) return;
  const cfg = getConfig();
  const dsn = cfg.SENTRY_DSN;
  if (!dsn) return;

  try {
    // Dynamic import so `@sentry/node` is only touched when a DSN is present.
    // The dependency is declared optional in package.json.
    sentry = await import("@sentry/node");
    sentry.init({
      dsn,
      environment: cfg.SENTRY_ENVIRONMENT,
      tracesSampleRate: cfg.SENTRY_TRACES_SAMPLE_RATE,
      // Don't ship the JWT-carrying Authorization header up to Sentry either.
      beforeSend(event: unknown) {
        try {
          const e = event as { request?: { headers?: Record<string, string> } };
          if (e.request?.headers) {
            for (const k of Object.keys(e.request.headers)) {
              if (k.toLowerCase() === "authorization" || k.toLowerCase() === "cookie") {
                e.request.headers[k] = "[redacted]";
              }
            }
          }
        } catch {
          /* best-effort */
        }
        return event;
      },
    });
    sentryReady = true;
  } catch (err) {
    // A missing @sentry/node in prod is a config bug, not a crash — log and
    // continue. captureException below will silently fall back to console.
    // eslint-disable-next-line no-console
    console.error("[sentry] init failed — running without error reporting:", err);
  }
}

/**
 * Capture an exception. Sends to Sentry when configured, otherwise logs
 * locally so the error is never silently swallowed.
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (sentryReady && sentry) {
    try {
      sentry.captureException(err, { extra: context });
      return;
    } catch {
      /* fall through */
    }
  }
  // eslint-disable-next-line no-console
  console.error("[error]", err, context ?? {});
}
