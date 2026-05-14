import type { FastifyInstance } from "fastify";
import archiver from "archiver";
import { Readable } from "node:stream";
import bytes from "bytes";
import { config } from "../config.js";
import { safeFilename } from "../utils.js";
import {
  accessShareByToken,
  touchShareSingleUseIfNeeded,
} from "../shareAccess.js";

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  // --- Export : liens directs (JDownloader, aria2c, IDM, etc.) ---
  app.get<{ Params: { token: string } }>(
    "/d/:token/liens.txt",
    async (req, reply) => {
      const r = await accessShareByToken(req.params.token);
      if (r.kind === "not_found") return reply.code(404).send("Not found\n");
      if (r.kind === "not_ready")
        return reply
          .code(409)
          .type("text/plain; charset=utf-8")
          .send(`Pas encore prêt.\n${r.reason}\n`);
      if (r.kind === "gone")
        return reply.code(410).type("text/plain; charset=utf-8").send(`${r.reason}\n`);
      const { dl } = r;
      await touchShareSingleUseIfNeeded(dl);
      const lines: string[] = [
        "# Export Relais — coller dans JDownloader / IDM / aria2c -i",
        `# ${(dl.name || dl.inputLabel || "release").replace(/\r?\n/g, " ")}`,
        "",
      ];
      for (const f of dl.files) {
        if (!f.directUrl) continue;
        lines.push(`# ${f.filename}`);
        lines.push(f.directUrl);
        lines.push("");
      }
      const body = lines.join("\n").trimEnd() + "\n";
      const base = safeFilename(dl.name || dl.inputLabel || "release").slice(0, 80);
      return reply
        .header("Content-Disposition", `attachment; filename="${base}-liens.txt"`)
        .type("text/plain; charset=utf-8")
        .send(body);
    },
  );

  // --- Archive ZIP (téléchargement « toute la release » en un fichier) ---
  app.get<{ Params: { token: string } }>(
    "/d/:token/archive.zip",
    async (req, reply) => {
      const r = await accessShareByToken(req.params.token);
      if (r.kind === "not_found") return reply.code(404).send({ error: "Not found" });
      if (r.kind === "not_ready")
        return reply.code(409).send({ error: "Not ready", detail: r.reason });
      if (r.kind === "gone") return reply.code(410).send({ error: r.reason });
      const { dl } = r;
      await touchShareSingleUseIfNeeded(dl);

      const readyFiles = dl.files.filter((f) => !!f.directUrl);
      if (readyFiles.length === 0) {
        return reply.code(404).send({ error: "No files" });
      }

      const base = safeFilename(dl.name || dl.inputLabel || "release").slice(0, 80);
      const archive = archiver("zip", { zlib: { level: 0 } });

      archive.on("error", (err) => {
        req.log.error({ err }, "archive zip error");
      });

      reply
        .header("Content-Type", "application/zip")
        .header(
          "Content-Disposition",
          `attachment; filename="${base}.zip"`,
        );

      for (const f of readyFiles) {
        if (!f.directUrl) continue;
        try {
          const res = await fetch(f.directUrl, {
            redirect: "follow",
            headers: { "User-Agent": config.userAgent },
            signal: AbortSignal.timeout(600_000),
          });
          if (!res.ok || !res.body) {
            archive.append(
              Buffer.from(
                `Échec HTTP ${res.status} pour le fichier.\nURL : ${f.directUrl.slice(0, 120)}…`,
                "utf-8",
              ),
              { name: `_erreur_${safeFilename(f.filename)}.txt` },
            );
            continue;
          }
          const web = res.body as import("stream/web").ReadableStream<Uint8Array>;
          const nodeStream = Readable.fromWeb(web);
          archive.append(nodeStream, { name: safeFilename(f.filename) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          archive.append(
            Buffer.from(`Erreur réseau : ${msg}`, "utf-8"),
            { name: `_erreur_${safeFilename(f.filename)}.txt` },
          );
        }
      }

      void archive.finalize();
      return reply.send(archive);
    },
  );

  // Page publique de partage
  app.get<{ Params: { token: string } }>("/d/:token", async (req, reply) => {
    const r = await accessShareByToken(req.params.token);
    if (r.kind === "not_found") {
      return await reply.code(404).renderPage(
        "share-not-found.ejs",
        { title: "Lien introuvable", reason: "Ce lien n'existe pas ou a expiré." },
        { layout: "layouts/public.ejs" },
      );
    }
    if (r.kind === "not_ready") {
      return await reply.code(409).renderPage(
        "share-not-found.ejs",
        {
          title: "Lien non prêt",
          reason: r.reason,
          autoRefresh: r.pending,
        },
        { layout: "layouts/public.ejs" },
      );
    }
    if (r.kind === "gone") {
      return await reply.code(410).renderPage(
        "share-not-found.ejs",
        { title: "Lien expiré", reason: r.reason },
        { layout: "layouts/public.ejs" },
      );
    }

    const { dl } = r;
    await touchShareSingleUseIfNeeded(dl);

    const files = dl.files.map((f) => ({
      id: f.id,
      filename: f.filename,
      size: bytes.format(Number(f.size)) || "—",
      directUrl: f.directUrl,
    }));
    const ready = files.filter((f) => !!f.directUrl);

    const zipSizeHintBytes = dl.files.reduce(
      (acc, f) => acc + Number(f.size),
      0,
    );
    const zipBaseName = safeFilename(
      dl.name || dl.inputLabel || "release",
    ).slice(0, 80);

    return await reply.renderPage(
      "share.ejs",
      {
        title: dl.name || "Téléchargement",
        name: dl.name || dl.inputLabel || `Téléchargement #${dl.id}`,
        token: dl.shareToken,
        files: ready,
        totalSize:
          bytes.format(
            dl.files.reduce((acc, f) => acc + Number(f.size), 0),
          ) || "—",
        zipSizeHintBytes,
        zipBaseName,
        singleFile: ready.length === 1 ? ready[0] : null,
        expirationMode: dl.expirationMode,
      },
      { layout: "layouts/public.ejs" },
    );
  });

  // 302 vers l’URL CDN du fichier débridé
  app.get<{ Params: { token: string; fileId: string } }>(
    "/d/:token/f/:fileId",
    async (req, reply) => {
      const r = await accessShareByToken(req.params.token);
      if (r.kind !== "ok") {
        return reply.code(404).send({ error: "Not found" });
      }
      const { dl } = r;
      const fileId = parseInt(req.params.fileId, 10);
      const f = dl.files.find((x) => x.id === fileId);
      if (!f || !f.directUrl) {
        return reply.code(404).send({ error: "Not ready" });
      }
      await touchShareSingleUseIfNeeded(dl);
      return reply.redirect(f.directUrl, 302);
    },
  );
}
