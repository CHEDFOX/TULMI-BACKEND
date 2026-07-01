/**
 * Centralised, validated configuration. Everything secret comes from env vars
 * (see ../../.env.example). Nothing is hardcoded.
 *
 * We load .env from the tulmi/ folder first, then fall back to the repo root,
 * so either location works.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendEnv = resolve(__dirname, "..", ".env");
const rootEnv = resolve(__dirname, "..", "..", ".env");

if (existsSync(backendEnv)) loadEnv({ path: backendEnv });
else if (existsSync(rootEnv)) loadEnv({ path: rootEnv });
else loadEnv(); // fall back to process env / default lookup

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null ? def : v.toLowerCase() === "true"));

const EnvSchema = z.object({
  // --- Speech-to-text provider ---
  // "openai" (default) covers ~100 languages — best for a global product.
  // "groq" is a fast/cheap Whisper alternative.
  STT_PROVIDER: z.enum(["openai", "groq"]).default("openai"),

  // OpenAI STT (used when STT_PROVIDER=openai). gpt-4o-transcribe is the
  // current best; gpt-4o-mini-transcribe is cheaper; whisper-1 is the legacy.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_STT_MODEL: z.string().default("gpt-4o-transcribe"),

  // Groq STT (used when STT_PROVIDER=groq).
  GROQ_API_KEY: z.string().optional(),
  GROQ_STT_MODEL: z.string().default("whisper-large-v3-turbo"),

  // Deepgram (used by the WS /v1/transcribe-stream route for live dictation —
  // not the one-shot /v1/transcribe-clean path, which uses STT_PROVIDER above).
  // Optional: without it the live route returns a "not configured" error and
  // the app's fallback REST transcribe still works.
  DEEPGRAM_API_KEY: z.string().optional(),

  // OpenRouter (cleanup) — required to run the pipeline.
  // Model slug follows OpenRouter's naming: "<vendor>/<model>". Swap this via
  // env (CLEANUP_MODEL=...) without a code change. Current default is picked
  // for a good speed × quality × price balance for short cleanup / drafting.
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  CLEANUP_MODEL: z.string().default("openai/gpt-5.4-mini"),
  OPENROUTER_APP_URL: z.string().default("https://tulmi.local"),
  OPENROUTER_APP_NAME: z.string().default("Tulmi"),

  // --- Text-to-speech (voice output: read-aloud / screen-clarify) ---
  // Uses OPENAI_API_KEY. gpt-4o-mini-tts is cheap, multilingual, and steerable.
  TTS_PROVIDER: z.enum(["openai"]).default("openai"),
  OPENAI_TTS_MODEL: z.string().default("gpt-4o-mini-tts"),
  TTS_VOICE: z.string().default("alloy"),
  TTS_FORMAT: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).default("mp3"),

  // Supabase — optional when DEV_SKIP_AUTH is true.
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),

  // Server
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.string().optional(),

  // When true, auth + metering are skipped (local pipeline testing).
  DEV_SKIP_AUTH: bool(false),
  // Explicit escape hatch for running with auth off in production-shaped envs
  // (load tests, smoke checks). Off by default — see the boot-time refusal.
  DEV_SKIP_AUTH_ALLOW_PROD: bool(false),

  // Prompt versions to load from shared/prompts/. v3 (cleanup) / v2 (reply)
  // add the tone dial + per-app overrides + watermark. Roll back by exporting
  // CLEANUP_PROMPT_VERSION=v2 / REPLY_PROMPT_VERSION=v1 without a code change.
  CLEANUP_PROMPT_VERSION: z.string().default("v3"),
  REPLY_PROMPT_VERSION: z.string().default("v2"),

  // Sentry (backend). Optional — the observability layer no-ops when unset,
  // so the value can safely stay empty in dev.
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default("production"),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().default(0.05),

  // Rate limiting (per IP / per Authorization header).
  RATE_LIMIT_MAX: z.coerce.number().default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_UNAUTH_MAX: z.coerce.number().default(20),

  // Input length caps — refuse any request whose text field exceeds this many
  // characters, so a runaway client can't burn LLM budget on huge inputs. 10k
  // chars ≈ 2500 tokens ≈ a healthy 2-minute dictation.
  MAX_TEXT_LENGTH: z.coerce.number().default(10_000),

  // Free-tier ceiling per calendar month. When set (positive number), any
  // signed-in user who exceeds it is refused with `quota_exceeded` BEFORE the
  // paid upstream call is made. Unset / 0 = no ceiling.
  FREE_MONTHLY_AUDIO_SECONDS: z.coerce.number().default(0),
  FREE_MONTHLY_WORDS: z.coerce.number().default(0),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  /** True if Supabase is fully configured for metering (needs the service key). */
  supabaseEnabled: boolean;
  /**
   * True if we can verify user JWTs — needs the URL plus EITHER the service key
   * OR the public anon key (verifying a token only calls /auth/v1/user, which
   * the anon key is allowed to do). So real auth works without the secret key.
   */
  authEnabled: boolean;
};

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid/missing environment variables:\n${issues}\n\n` +
        `Copy .env.example to .env and fill in your keys.`,
    );
  }

  const env = parsed.data;

  // The selected STT provider must have its key.
  if (env.STT_PROVIDER === "openai" && !env.OPENAI_API_KEY) {
    throw new Error(
      "STT_PROVIDER=openai but OPENAI_API_KEY is missing. Add OPENAI_API_KEY, " +
        "or set STT_PROVIDER=groq and add GROQ_API_KEY.",
    );
  }
  if (env.STT_PROVIDER === "groq" && !env.GROQ_API_KEY) {
    throw new Error(
      "STT_PROVIDER=groq but GROQ_API_KEY is missing. Add GROQ_API_KEY, " +
        "or set STT_PROVIDER=openai and add OPENAI_API_KEY.",
    );
  }

  const supabaseEnabled = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
  const authEnabled = Boolean(
    env.SUPABASE_URL && (env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY),
  );

  if (!authEnabled && !env.DEV_SKIP_AUTH) {
    throw new Error(
      "Supabase auth is not configured but DEV_SKIP_AUTH is false. " +
        "Set SUPABASE_URL + SUPABASE_ANON_KEY (or SUPABASE_SERVICE_KEY), " +
        "or set DEV_SKIP_AUTH=true for local testing.",
    );
  }

  // Hard refuse to boot in a production-shaped environment with auth disabled —
  // a forgotten DEV_SKIP_AUTH=true is the single largest cost-amplification
  // footgun (unauthenticated requests spend OpenAI/OpenRouter budget).
  const isProd = env.NODE_ENV === "production";
  if (env.DEV_SKIP_AUTH && isProd && !env.DEV_SKIP_AUTH_ALLOW_PROD) {
    throw new Error(
      "DEV_SKIP_AUTH=true is not allowed when NODE_ENV=production. " +
        "Configure Supabase (SUPABASE_URL + SUPABASE_ANON_KEY) and remove " +
        "DEV_SKIP_AUTH before deploying. To override for a controlled load " +
        "test, set DEV_SKIP_AUTH_ALLOW_PROD=true (NOT recommended).",
    );
  }

  cached = { ...env, supabaseEnabled, authEnabled };
  return cached;
}

export const VERSION = "0.1.0";
