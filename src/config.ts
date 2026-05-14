import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

const publicUrlEnv = required("PUBLIC_URL", "http://localhost:3000").replace(
  /\/$/,
  "",
);

/** Secure session cookie: SESSION_COOKIE_SECURE=true|false overrides PUBLIC_URL scheme. */
function sessionCookieSecure(): boolean {
  const o = optional("SESSION_COOKIE_SECURE");
  if (o === "true" || o === "1") return true;
  if (o === "false" || o === "0") return false;
  return publicUrlEnv.startsWith("https://");
}

export const config = {
  appName: "ShaDebrid",
  publicUrl: publicUrlEnv,
  sessionCookieSecure: sessionCookieSecure(),
  host: required("HOST", "0.0.0.0"),
  port: parseInt(required("PORT", "3000"), 10),
  sessionSecret: required("SESSION_SECRET"),
  databaseUrl: required("DATABASE_URL", "file:./data/app.db"),
  bootstrapAdmin: {
    username: required("BOOTSTRAP_ADMIN_USERNAME", "admin"),
    password: required("BOOTSTRAP_ADMIN_PASSWORD", "changeme"),
  },
  workerIntervalMs: parseInt(required("WORKER_INTERVAL_MS", "15000"), 10),
  singleUseGraceSeconds: parseInt(
    required("SINGLE_USE_GRACE_SECONDS", "3600"),
    10,
  ),
  userAgent: "Relais/0.1",
} as const;

export function isStrongEnoughSecret(secret: string): boolean {
  return secret.length >= 32;
}
