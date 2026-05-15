import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bytes from "bytes";
import { prisma } from "../db.js";
import { getAlldebridApiKey } from "../db.js";
import { requireAuth } from "../auth.js";
import {
  uploadMagnets,
  uploadTorrentFile,
  unlockLink,
  AllDebridError,
  type MagnetUploadResult,
} from "../alldebrid.js";
import {
  isMagnetUri,
  isHttpUrl,
  newShareToken,
  splitLines,
  formatDate,
  relativeFromNow,
  safeFilename,
} from "../utils.js";
import { resolvePublicUrl } from "../publicUrl.js";
import { runMaintenance, runOnce } from "../worker.js";
import { applySingleUseInitialExpiry } from "../shareAccess.js";

type DownloadView = {
  id: number;
  name: string;
  status: string;
  kind: string;
  errorMessage: string | null;
  createdAt: string;
  createdAtRelative: string;
  readyAt: string;
  readyAtRelative: string;
  expirationMode: string;
  expiresAt: string | null;
  expiresAtRelative: string | null;
  expiresSoon: boolean;
  firstOpenedAt: string | null;
  scheduledDeleteAt: string | null;
  shareToken: string;
  sharePath: string;
  shareUrl: string | null;
  totalSize: string;
  files: Array<{
    id: number;
    filename: string;
    size: string;
    sizeBytes: number;
    directUrl: string | null;
    ready: boolean;
  }>;
};

function toView(
  d: {
    id: number;
    name: string | null;
    inputLabel: string;
    status: string;
    kind: string;
    errorMessage: string | null;
    expirationMode: string;
    expirationSeconds: number | null;
    firstOpenedAt: Date | null;
    scheduledDeleteAt: Date | null;
    shareToken: string;
    createdAt: Date;
    readyAt: Date | null;
    files: Array<{
      id: number;
      filename: string;
      size: bigint;
      directUrl: string | null;
    }>;
  },
  publicUrl: string,
): DownloadView {
  let totalBytes = 0;
  const files = d.files.map((f) => {
    const sb = Number(f.size);
    totalBytes += sb;
    return {
      id: f.id,
      filename: f.filename,
      size: bytes.format(sb) || "—",
      sizeBytes: sb,
      directUrl: f.directUrl,
      ready: !!f.directUrl,
    };
  });

  let expiresAt: Date | null = null;
  if (d.status === "ready" && d.readyAt) {
    if (d.expirationMode === "duration" && d.expirationSeconds) {
      expiresAt = new Date(d.readyAt.getTime() + d.expirationSeconds * 1000);
    } else if (d.expirationMode === "single_use" && d.scheduledDeleteAt) {
      expiresAt = d.scheduledDeleteAt;
    }
  }

  const expiresSoon =
    !!expiresAt && expiresAt.getTime() - Date.now() < 6 * 60 * 60 * 1000;

  return {
    id: d.id,
    name: d.name || d.inputLabel || `Téléchargement #${d.id}`,
    status: d.status,
    kind: d.kind,
    errorMessage: d.errorMessage,
    createdAt: formatDate(d.createdAt),
    createdAtRelative: relativeFromNow(d.createdAt),
    readyAt: formatDate(d.readyAt),
    readyAtRelative: relativeFromNow(d.readyAt),
    expirationMode: d.expirationMode,
    expiresAt: expiresAt ? formatDate(expiresAt) : null,
    expiresAtRelative: expiresAt ? relativeFromNow(expiresAt) : null,
    expiresSoon,
    firstOpenedAt: d.firstOpenedAt ? formatDate(d.firstOpenedAt) : null,
    scheduledDeleteAt: d.scheduledDeleteAt
      ? formatDate(d.scheduledDeleteAt)
      : null,
    shareToken: d.shareToken,
    /** Chemin relatif : toujours valide sur l’hôte actuel (évite localhost vs IP). */
    sharePath: `/d/${d.shareToken}`,
    shareUrl:
      d.status === "ready" ? `${publicUrl}/d/${d.shareToken}` : null,
    totalSize: bytes.format(totalBytes) || "—",
    files,
  };
}

export async function downloadsRoutes(app: FastifyInstance): Promise<void> {
  async function getAllowedModes(userId: number, role: string): Promise<string[]> {
    if (role === "admin") return ["single_use", "duration", "none"];
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { allowedExpirationModes: true },
    });
    return (dbUser?.allowedExpirationModes || "single_use").split(",").filter(Boolean);
  }

  async function renderNewDownloadForm(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const apiKey = await getAlldebridApiKey();
    const allowedExpirationModes = await getAllowedModes(user.id, user.role);
    return await reply.renderPage("new.ejs", {
      title: "Téléchargement",
      user,
      hasApiKey: !!apiKey,
      allowedExpirationModes,
      flash: getFlash(req),
    });
  }

  // Accueil connecté : formulaire liens / torrent
  app.get("/", async (req, reply) => {
    await renderNewDownloadForm(req, reply);
  });

  app.get("/new", async (req, reply) => {
    await renderNewDownloadForm(req, reply);
  });

  // Liste des téléchargements et liens de partage. Les téléchargements expirés sont
  // masqués de la liste (filtre c\u00f4t\u00e9 requ\u00eate) ; les donn\u00e9es restent en base pour audit.
  app.get<{ Querystring: { suite?: string } }>(
    "/gestion-liens",
    async (req, reply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;
      const rawSuite =
        typeof req.query.suite === "string" && req.query.suite.length > 0
          ? req.query.suite
          : null;

      // Le bandeau « Préparation du partage en cours » ne doit s'afficher que
      // tant que le download en question est `pending`. S'il est déjà prêt
      // (le worker a terminé entre la création et le rendu, ou après un reload
      // du polling), on redirige directement vers sa page de partage. Si le
      // download est en `failed` ou inconnu, on laisse simplement tomber le
      // paramètre `suite` et on affiche la liste normalement.
      let suiteToken: string | null = null;
      if (rawSuite) {
        const suiteDl = await prisma.download.findUnique({
          where: { shareToken: rawSuite },
          select: { status: true, userId: true },
        });
        if (
          suiteDl &&
          (user.role === "admin" || suiteDl.userId === user.id)
        ) {
          if (suiteDl.status === "ready") {
            return reply.redirect(`/d/${rawSuite}`, 302);
          }
          if (suiteDl.status === "pending") {
            suiteToken = rawSuite;
          }
          // failed / expired / autre : on n'affiche pas le bandeau
        }
      }

      const baseWhere = user.role === "admin" ? {} : { userId: user.id };
      const downloads = await prisma.download.findMany({
        where: { ...baseWhere, status: { not: "expired" } },
        include: { files: { orderBy: { position: "asc" } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      const publicUrl = await resolvePublicUrl(req);
      const view = downloads.map((d) => toView(d, publicUrl));
      return await reply.renderPage("dashboard.ejs", {
        title: "Gestion des liens",
        user,
        downloads: view,
        flash: getFlash(req),
        suiteToken,
      });
    },
  );

  /** JSON pour rafraîchir l’état sans F5 (comparaison id + status). Inclut un flag
   *  `expired` pour que l'UI puisse retirer une ligne d\u00e8s qu'elle disparait. */
  app.get("/downloads/poll", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const baseWhere = user.role === "admin" ? {} : { userId: user.id };
    const downloads = await prisma.download.findMany({
      where: { ...baseWhere, status: { not: "expired" } },
      select: { id: true, status: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return reply.send({
      items: downloads.map((d) => ({ id: d.id, status: d.status })),
    });
  });

  // Submit new download
  app.post<{
    Body: {
      links?: string;
      expirationMode?: string;
      expirationDuration?: string;
      password?: string;
    };
  }>("/new", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const apiKey = await getAlldebridApiKey();
    if (!apiKey) {
      setFlash(req, {
        type: "error",
        text: "La clé API du service de débridage n'est pas configurée. Contactez un administrateur.",
      });
      return reply.redirect("/new");
    }

    // Collect fields from either urlencoded body or multipart form data.
    const fields: Record<string, string> = {};
    let torrentFile: { filename: string; data: Buffer } | null = null;

    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (part.fieldname === "torrent" && part.filename) {
            const data = await part.toBuffer();
            if (data.length > 0) {
              torrentFile = {
                filename: safeFilename(part.filename),
                data,
              };
            }
          } else {
            // Drain any other file fields
            await part.toBuffer();
          }
        } else {
          fields[part.fieldname] = String(part.value ?? "");
        }
      }
    } else if (req.body) {
      fields.links = req.body.links || "";
      fields.expirationMode = req.body.expirationMode || "";
      fields.expirationDuration = req.body.expirationDuration || "";
      fields.password = req.body.password || "";
    }

    const allowedModes = await getAllowedModes(user.id, user.role);
    const requestedMode = fields.expirationMode || "";
    const fallbackMode = allowedModes[0] || "single_use";
    const expirationMode = allowedModes.includes(requestedMode)
      ? requestedMode
      : fallbackMode;
    const expirationHours = Math.max(
      0,
      parseInt(fields.expirationDuration || "24", 10) || 24,
    );
    const expirationSeconds =
      expirationMode === "duration" ? expirationHours * 3600 : null;
    const password = fields.password || undefined;

    const linkLines = splitLines(fields.links || "");

    if (linkLines.length === 0 && !torrentFile) {
      setFlash(req, {
        type: "error",
        text: "Aucun lien ni fichier .torrent fourni.",
      });
      return reply.redirect("/new");
    }

    const created: number[] = [];
    const errors: string[] = [];

    // Group magnets together (single API call), and handle direct links one by one.
    const magnets: string[] = [];
    const directLinks: string[] = [];
    for (const line of linkLines) {
      if (isMagnetUri(line) || /^[0-9a-f]{40}$/i.test(line)) {
        magnets.push(line);
      } else if (isHttpUrl(line)) {
        directLinks.push(line);
      } else {
        errors.push(`Ligne ignorée (format inconnu) : ${line.slice(0, 60)}`);
      }
    }

    // Magnets
    if (magnets.length > 0) {
      try {
        const res: MagnetUploadResult = await uploadMagnets(apiKey, magnets);
        for (const m of res.magnets) {
          if (m.error || !m.id) {
            errors.push(
              `Magnet refusé : ${m.error?.message || "raison inconnue"}`,
            );
            continue;
          }
          const dl = await prisma.download.create({
            data: {
              userId: user.id,
              kind: "magnet",
              inputLabel: m.name || m.hash || "magnet",
              name: m.name || null,
              alldebridMagnetId: String(m.id),
              status: m.ready ? "pending" : "pending",
              expirationMode,
              expirationSeconds,
              shareToken: newShareToken(),
            },
          });
          created.push(dl.id);
        }
      } catch (err) {
        const e = err as Error;
        errors.push(`Magnets : ${e.message}`);
      }
    }

    // Torrent file
    if (torrentFile) {
      try {
        const res = await uploadTorrentFile(
          apiKey,
          torrentFile.filename,
          torrentFile.data,
        );
        for (const m of res.files) {
          if (m.error || !m.id) {
            errors.push(
              `Fichier torrent refusé : ${m.error?.message || "raison inconnue"}`,
            );
            continue;
          }
          const dl = await prisma.download.create({
            data: {
              userId: user.id,
              kind: "magnet",
              inputLabel: m.name || torrentFile.filename,
              name: m.name || null,
              alldebridMagnetId: String(m.id),
              status: "pending",
              expirationMode,
              expirationSeconds,
              shareToken: newShareToken(),
            },
          });
          created.push(dl.id);
        }
      } catch (err) {
        const e = err as Error;
        errors.push(`Torrent : ${e.message}`);
      }
    }

    // Direct links
    for (const link of directLinks) {
      try {
        const res = await unlockLink(apiKey, link, password);
        const dl = await prisma.download.create({
          data: {
            userId: user.id,
            kind: "link",
            inputLabel: link,
            name: res.filename || null,
            status: "ready",
            expirationMode,
            expirationSeconds,
            shareToken: newShareToken(),
            readyAt: new Date(),
            files: {
              create: [
                {
                  position: 1,
                  filename: res.filename || "file",
                  size: BigInt(res.filesize || 0),
                  directUrl: res.link,
                  sourceUrl: link,
                },
              ],
            },
          },
        });
        // Lien direct = ready imm\u00e9diatement \u2192 pose le timer 1 h pour single_use.
        await applySingleUseInitialExpiry(dl.id);
        created.push(dl.id);
      } catch (err) {
        const e = err as Error;
        if (e instanceof AllDebridError) {
          errors.push(`${link} : ${e.code} — ${e.message}`);
        } else {
          errors.push(`${link} : ${e.message}`);
        }
      }
    }

    // Kick the worker for new magnets
    if (created.length > 0) {
      runOnce().catch(() => undefined);
    }

    if (created.length === 0) {
      setFlash(req, {
        type: "error",
        text:
          "Aucun téléchargement créé. " +
          (errors.length ? errors.join(" | ") : ""),
      });
      return reply.redirect("/new");
    }
    setFlash(req, {
      type: "success",
      text:
        `${created.length} téléchargement(s) créé(s). ` +
        (errors.length ? `Erreurs : ${errors.join(" | ")}` : ""),
    });
    if (created.length === 1) {
      const row = await prisma.download.findUnique({
        where: { id: created[0] },
        select: { shareToken: true, status: true },
      });
      if (row) {
        if (row.status === "ready") {
          return reply.redirect(`/d/${row.shareToken}`, 302);
        }
        return reply.redirect(
          `/gestion-liens?suite=${encodeURIComponent(row.shareToken)}`,
          302,
        );
      }
    }
    return reply.redirect("/gestion-liens");
  });

  // Manual delete (also deletes on AllDebrid for magnets)
  app.post<{ Params: { id: string } }>(
    "/downloads/:id/delete",
    async (req, reply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;
      const id = parseInt(req.params.id, 10);
      const dl = await prisma.download.findUnique({ where: { id } });
      if (!dl || (dl.userId !== user.id && user.role !== "admin")) {
        return reply.code(404).send({ error: "Not found" });
      }
      const apiKey = await getAlldebridApiKey();
      if (apiKey && dl.kind === "magnet" && dl.alldebridMagnetId) {
        try {
          const { deleteMagnet } = await import("../alldebrid.js");
          await deleteMagnet(apiKey, parseInt(dl.alldebridMagnetId, 10));
        } catch {
          // ignore
        }
      }
      await prisma.download.delete({ where: { id } });
      setFlash(req, { type: "success", text: "Téléchargement supprimé." });
      return reply.redirect("/gestion-liens");
    },
  );

  // Refresh / kick worker
  app.post("/downloads/refresh", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    runOnce().catch(() => undefined);
    runMaintenance().catch(() => undefined);
    setFlash(req, { type: "success", text: "Rafraîchissement lancé." });
    return reply.redirect("/gestion-liens");
  });
}

// ---------------- Flash messages stored in the session ----------------

export type Flash = { type: "success" | "error" | "info"; text: string };

export function setFlash(req: FastifyRequest, flash: Flash): void {
  req.session.set("flash", flash);
}

export function getFlash(req: FastifyRequest): Flash | null {
  const f = req.session.get("flash") as Flash | undefined;
  if (f) req.session.set("flash", undefined);
  return f ?? null;
}
