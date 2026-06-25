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

  // OpenRouter (cleanup) — required to run the pipeline.
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  CLEANUP_MODEL: z.string().default("anthropic/claude-haiku-4.5"),
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

  // When true, auth + metering are skipped (local pipeline testing).
  DEV_SKIP_AUTH: bool(false),

  // Prompt versions to load from shared/prompts/.
  CLEANUP_PROMPT_VERSION: z.string().default("v2"),
  REPLY_PROMPT_VERSION: z.string().default("v1"),
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

  cached = { ...env, supabaseEnabled, authEnabled };
  return cached;
}

export const VERSION = "0.1.0";
