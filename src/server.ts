import path from "node:path";
import { statSync, createReadStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import secureSession from "@fastify/secure-session";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import view from "@fastify/view";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import ejs from "ejs";

import { config } from "./config.js";
import { resolvePublicUrl } from "./publicUrl.js";
import { bootstrapAdminIfNeeded, getSessionUser } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { downloadsRoutes } from "./routes/downloads.js";
import { adminRoutes } from "./routes/admin.js";
import { publicRoutes } from "./routes/public.js";
import { startWorker, stopWorker } from "./worker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Heure de dernière modification du fichier serveur en cours (utile pour vérifier qu’on exécute bien le dernier build). */
let bundleMtime: string | undefined;
try {
  bundleMtime = statSync(__filename).mtime.toISOString();
} catch {
  bundleMtime = undefined;
}

// In dev (tsx), __dirname is /…/src ; in prod it's /…/dist. Views & public live next to src/.
const projectRoot = path.resolve(__dirname, "..");
const viewsDir = path.join(projectRoot, "views");
const publicDir = path.join(projectRoot, "public");

/** Empreinte des assets statiques. On l'injecte en query-string (?v=...) sur les
 *  URLs CSS/SW dans les templates pour invalider tout cache intermédiaire (reverse
 *  proxy, CDN, navigateur) à chaque rebuild — sinon un openresty/nginx peut servir
 *  un vieux 404 ou un vieux CSS et casser le rendu après déploiement. */
function computeAssetsVersion(): string {
  const candidates = [
    path.join(publicDir, "styles", "app.css"),
    path.join(publicDir, "sw.js"),
    path.join(publicDir, "manifest.webmanifest"),
  ];
  let max = 0;
  for (const p of candidates) {
    try {
      const m = statSync(p).mtimeMs;
      if (m > max) max = m;
    } catch {
      // missing file: ignore (will fall back to other candidates)
    }
  }
  return max ? Math.floor(max).toString(36) : "dev";
}
const assetsVersion = computeAssetsVersion();

/** TRUST_PROXY accepte :
 *  - true / 1 : tout X-Forwarded-* est accepté (utile derrière un reverse proxy local)
 *  - false / 0 : aucun (si l'app est exposée directement)
 *  - une liste d'IP/CIDR séparés par virgules : seules ces sources sont fiables */
function parseTrustProxy(): boolean | string[] {
  const raw = (process.env.TRUST_PROXY ?? "true").trim();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0" || raw === "") return false;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const app = Fastify({
    routerOptions: { ignoreTrailingSlash: true },
    logger: {
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty" },
    },
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: parseTrustProxy(),
  });

  // ---- Security headers (Helmet) ----
  // CSP désactive l'inline-script par défaut. On a quelques <script> inline
  // dans les vues (layout, share.ejs, etc.) — on autorise 'self' + 'unsafe-inline'
  // sur scriptSrc faute de pouvoir hasher chaque inline (les vues sont rendues
  // dynamiquement). styleSrc idem (styles inline + Google Fonts).
  await app.register(helmet, {
    contentSecurityPolicy: {
      // Helmet ajoute `upgrade-insecure-requests` par défaut, ce qui casse les
      // déploiements accédés en HTTP direct (LAN, env de test) en forçant le
      // navigateur à demander toutes les ressources en https — qu'il ne sait
      // pas servir. On supprime cette directive : toutes nos sources externes
      // (Google Fonts) sont déjà en https, et la prod passe par un reverse
      // proxy TLS qui fait son propre redirect http→https si besoin.
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // permet aux navigateurs de download les fichiers externes (CDN AllDebrid)
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    // HSTS activé si on est derrière HTTPS (cookie secure = signal qu'on est en TLS)
    strictTransportSecurity: config.sessionCookieSecure
      ? { maxAge: 31536000, includeSubDomains: true, preload: false }
      : false,
  });

  // ---- Rate limiting global doux + strict sur /login ----
  await app.register(rateLimit, {
    global: false, // appliqué seulement où on le décide
    max: 60,
    timeWindow: "1 minute",
  });

  // ---- Session ----
  // Derive a stable 32-byte key from SESSION_SECRET (sha256)
  const sessionKey = createHash("sha256")
    .update(config.sessionSecret)
    .digest();

  await app.register(cookie);
  await app.register(secureSession, {
    key: sessionKey,
    cookieName: "session",
    cookie: {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.sessionCookieSecure,
      maxAge: 60 * 60 * 24 * 30, // 30 days
    },
  });

  // Anti-BFCache : on empêche le navigateur de re-servir une page authentifiée
  // depuis son cache après un logout (sinon la touche « back » montre encore le
  // dashboard malgré la session expirée). On exclut les assets statiques, la
  // PWA (manifest + sw), les routes publiques de partage et l'export liens.txt
  // pour ne pas casser leur cache CDN/navigateur.
  const NO_STORE_BYPASS = [
    "/static/",
    "/manifest.webmanifest",
    "/sw.js",
    "/health",
    "/d/", // pages publiques /d/:token et /d/:token/archive.zip, etc.
    "/favicon",
  ];
  app.addHook("onSend", async (req, reply, payload) => {
    const url = req.url || "";
    if (NO_STORE_BYPASS.some((p) => url === p || url.startsWith(p))) {
      return payload;
    }
    if (!reply.getHeader("Cache-Control")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  // ---- Body parsers ----
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024, // 20 MB max for .torrent
      files: 5,
    },
  });

  // ---- Views ----
  await app.register(view, {
    engine: { ejs },
    root: viewsDir,
    defaultContext: {
      appName: config.appName,
      publicUrl: config.publicUrl,
      assetsVersion,
    },
  });

  // Decorate reply with renderPage(template, data, opts?). Auto-injects currentUser + path
  // and applies a default layout (layouts/app.ejs) unless opts.layout overrides it.
  app.decorateReply(
    "renderPage",
    async function (
      this: import("fastify").FastifyReply,
      template: string,
      data: Record<string, unknown> = {},
      opts?: { layout?: string | false },
    ) {
      const currentUser = getSessionUser(this.request);
      const publicUrl = await resolvePublicUrl(this.request);
      const merged = {
        appName: config.appName,
        publicUrl,
        currentUser,
        path: this.request.url,
        assetsVersion,
        ...data,
      };
      Object.assign(this.locals, merged);
      const layout =
        opts && "layout" in opts ? opts.layout : "layouts/app.ejs";
      return this.view(template, merged, layout ? { layout } : undefined);
    },
  );

  // ---- Static ----
  await app.register(staticPlugin, {
    root: publicDir,
    prefix: "/static/",
    decorateReply: false,
  });

  // ---- PWA : manifest + service worker servis à la racine ----
  // SW doit être à la racine pour avoir scope="/" sans header spécial.
  app.get("/manifest.webmanifest", async (_req, reply) => {
    return reply
      .header("Content-Type", "application/manifest+json; charset=utf-8")
      .header("Cache-Control", "public, max-age=300")
      .send(createReadStream(path.join(publicDir, "manifest.webmanifest")));
  });
  // Le SW est servi avec son CACHE_VERSION réécrit pour matcher assetsVersion :
  // ainsi chaque déploiement invalide aussi le cache navigateur installé par le SW
  // (sinon le SW peut servir un vieux 404 mis en cache lors d'un précédent boot).
  // De même, les URLs précachées dans STATIC_ASSETS reçoivent le ?v=... pour
  // pointer vers la même URL que les <link> dans les pages HTML.
  const swRawTemplate = readFileSync(path.join(publicDir, "sw.js"), "utf-8");
  const swPatched = swRawTemplate
    .replace(
      /const\s+CACHE_VERSION\s*=\s*"[^"]*"\s*;/,
      `const CACHE_VERSION = "shadebrid-${assetsVersion}";`,
    )
    .replace(
      /"\/static\/styles\/app\.css"/g,
      `"/static/styles/app.css?v=${assetsVersion}"`,
    );
  app.get("/sw.js", async (_req, reply) => {
    return reply
      .header("Content-Type", "application/javascript; charset=utf-8")
      .header("Service-Worker-Allowed", "/")
      .header("Cache-Control", "no-cache")
      .send(swPatched);
  });

  // ---- Routes ----
  await app.register(authRoutes);
  await app.register(downloadsRoutes);
  await app.register(adminRoutes);
  await app.register(publicRoutes);

  app.get("/health", async () => ({
    ok: true,
    bundleMtime,
  }));

  // ---- Bootstrap admin user ----
  await bootstrapAdminIfNeeded(config.bootstrapAdmin);

  // ---- Start ----
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { bundleMtime },
    "ShaDebrid démarré (POST /admin/settings doit exister sur ce build ; si 404, reconstruire l’image ou dist/)",
  );
  startWorker();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    stopWorker();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
