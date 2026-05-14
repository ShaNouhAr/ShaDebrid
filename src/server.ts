import path from "node:path";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import secureSession from "@fastify/secure-session";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import view from "@fastify/view";
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
    trustProxy: true,
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
