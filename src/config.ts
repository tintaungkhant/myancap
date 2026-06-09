/**
 * Single source of configuration. `loadConfig` is pure (inject `env` in tests);
 * `getConfig` memoizes a real load so importing this module has no side effects.
 */

export type Config = {
  telegramBotToken: string;
  telegramWebhookSecret?: string;
  openaiApiKey: string;
  geminiApiKey: string;
  azureSpeechKey: string;
  azureSpeechRegion: string;
  ttsVoice: string;
  maxTtsRate: number;
  ytdlpCookies?: string;
  ytdlpPlayerClient?: string;
  databasePath: string;
  workDir: string;
  maxConcurrentJobs: number;
  maxVideoSeconds: number;
  port: number;
};

type Env = Record<string, string | undefined>;

function req(env: Env, key: string, missing: string[]): string {
  const v = env[key];
  if (!v) {
    missing.push(key);
    return "";
  }
  return v;
}

function posInt(env: Env, key: string, def: number, errors: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${key} must be a positive integer (got "${raw}")`);
    return def;
  }
  return n;
}

function floatAtLeast(env: Env, key: string, min: number, def: number, errors: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    errors.push(`${key} must be a number >= ${min} (got "${raw}")`);
    return def;
  }
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  const missing: string[] = [];
  const errors: string[] = [];

  const cfg: Config = {
    telegramBotToken: req(env, "TELEGRAM_BOT_TOKEN", missing),
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    openaiApiKey: req(env, "OPENAI_API_KEY", missing),
    geminiApiKey: req(env, "GEMINI_API_KEY", missing),
    azureSpeechKey: req(env, "AZURE_SPEECH_KEY", missing),
    azureSpeechRegion: env.AZURE_SPEECH_REGION || "southeastasia",
    ttsVoice: env.TTS_VOICE || "my-MM-ThihaNeural",
    maxTtsRate: floatAtLeast(env, "TTS_MAX_RATE", 1, 1.5, errors),
    ytdlpCookies: env.YTDLP_COOKIES,
    ytdlpPlayerClient: env.YTDLP_PLAYER_CLIENT,
    databasePath: env.DATABASE_PATH || "/data/myancap.db",
    workDir: env.WORK_DIR || "/tmp/myancap",
    maxConcurrentJobs: posInt(env, "MAX_CONCURRENT_JOBS", 1, errors),
    maxVideoSeconds: posInt(env, "MAX_VIDEO_SECONDS", 900, errors),
    port: posInt(env, "PORT", 3000, errors),
  };

  if (missing.length) {
    errors.unshift(`Missing required env vars: ${missing.join(", ")}`);
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n  ${errors.join("\n  ")}`);
  }

  return Object.freeze(cfg);
}

let cached: Config | undefined;

/** Memoized real config. Throws on first call if env is invalid. */
export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
