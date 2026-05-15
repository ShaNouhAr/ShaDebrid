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
  /** Filet de sécurité après le 1er CLIC sur un fichier en mode single_use.
   *  Permet de re-télécharger en cas de coupure. Réduit l'expiration à now + grace. */
  singleUseGraceSeconds: parseInt(
    required("SINGLE_USE_GRACE_SECONDS", "300"),
    10,
  ),
  /** Durée de vie MAXIMALE d'un lien single_use SANS aucun clic : à partir de readyAt,
   *  le lien expire automatiquement après ce délai (par défaut 1 h). */
  singleUseMaxLifetimeSeconds: parseInt(
    required("SINGLE_USE_MAX_LIFETIME_SECONDS", "3600"),
    10,
  ),
  userAgent: "ShaDebrid/0.1",
} as const;

export function isStrongEnoughSecret(secret: string): boolean {
  return secret.length >= 32;
}
