import { prisma, getAlldebridApiKey } from "./db.js";
import {
  magnetStatus,
  magnetFiles,
  unlockLink,
  deleteMagnet,
  flattenFiles,
  STATUS_READY,
  isErrorStatus,
  AllDebridError,
} from "./alldebrid.js";
import { config } from "./config.js";
import { applySingleUseInitialExpiry } from "./shareAccess.js";

let running = false;
let timer: NodeJS.Timeout | null = null;

export function startWorker(): void {
  if (timer) return;
  const tick = async () => {
    try {
      await runOnce();
      await runMaintenance();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[worker] tick failed", e);
    } finally {
      timer = setTimeout(tick, config.workerIntervalMs);
    }
  };
  timer = setTimeout(tick, 1000);
}

export function stopWorker(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Poll AllDebrid for pending magnets and unlock links when ready. */
export async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const apiKey = await getAlldebridApiKey();
    if (!apiKey) return;

    const pending = await prisma.download.findMany({
      where: {
        kind: "magnet",
        status: "pending",
        alldebridMagnetId: { not: null },
      },
      take: 20,
    });

    for (const dl of pending) {
      const adId = parseInt(dl.alldebridMagnetId!, 10);
      try {
        const st = await magnetStatus(apiKey, adId);
        if (!st) continue;

        // Update name when available
        if (st.filename && st.filename !== dl.name) {
          await prisma.download.update({
            where: { id: dl.id },
            data: { name: st.filename },
          });
        }

        if (isErrorStatus(st.statusCode)) {
          await prisma.download.update({
            where: { id: dl.id },
            data: {
              status: "failed",
              errorMessage: `${st.status} (code ${st.statusCode})`,
            },
          });
          continue;
        }

        if (st.statusCode === STATUS_READY) {
          // Fetch the file tree
          const filesResp = await magnetFiles(apiKey, [adId]);
          const entry = filesResp.find((m) => String(m.id) === String(adId));
          if (!entry || entry.error) {
            await prisma.download.update({
              where: { id: dl.id },
              data: {
                status: "failed",
                errorMessage:
                  entry?.error?.message ||
                  "Aucun fichier trouvé pour ce magnet.",
              },
            });
            continue;
          }
          const flat = flattenFiles(entry.files).filter((f) => !!f.link);
          if (flat.length === 0) {
            await prisma.download.update({
              where: { id: dl.id },
              data: {
                status: "failed",
                errorMessage: "Magnet prêt mais aucun lien à débloquer.",
              },
            });
            continue;
          }
          // Unlock each link to get the direct CDN URL
          const fileRows: Array<{
            position: number;
            filename: string;
            size: bigint;
            sourceUrl: string;
            directUrl: string | null;
          }> = [];
          let anyError: string | null = null;
          for (let i = 0; i < flat.length; i++) {
            const f = flat[i]!;
            try {
              const u = await unlockLink(apiKey, f.link);
              fileRows.push({
                position: i + 1,
                filename: u.filename || f.path,
                size: BigInt(u.filesize || f.size || 0),
                sourceUrl: f.link,
                directUrl: u.link,
              });
            } catch (err) {
              const e = err as Error;
              const msg =
                e instanceof AllDebridError
                  ? `${e.code}: ${e.message}`
                  : e.message;
              anyError = msg;
              fileRows.push({
                position: i + 1,
                filename: f.path,
                size: BigInt(f.size || 0),
                sourceUrl: f.link,
                directUrl: null,
              });
            }
          }
          // Persist files + mark ready (or failed if all errored)
          const readyCount = fileRows.filter((r) => r.directUrl).length;
          await prisma.$transaction(async (tx) => {
            await tx.downloadFile.deleteMany({
              where: { downloadId: dl.id },
            });
            await tx.downloadFile.createMany({
              data: fileRows.map((r) => ({
                downloadId: dl.id,
                position: r.position,
                filename: r.filename,
                size: r.size,
                sourceUrl: r.sourceUrl,
                directUrl: r.directUrl,
              })),
            });
            await tx.download.update({
              where: { id: dl.id },
              data: {
                status: readyCount > 0 ? "ready" : "failed",
                readyAt: readyCount > 0 ? new Date() : null,
                errorMessage:
                  readyCount === 0
                    ? anyError || "Aucun lien débloqué"
                    : null,
              },
            });
          });
          if (readyCount > 0) {
            // Pose le timer initial (1 h par d\u00e9faut) pour les liens single_use.
            await applySingleUseInitialExpiry(dl.id);
          }
        }
        // else: still processing, leave as pending
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[worker] magnet update failed", dl.id, err);
      }
    }
  } finally {
    running = false;
  }
}

/** Apply expiration policies: delete from AllDebrid + mark as expired. */
export async function runMaintenance(): Promise<void> {
  const apiKey = await getAlldebridApiKey();
  const now = new Date();
  // 1. duration mode -> readyAt + expirationSeconds < now
  const durationExpired = await prisma.download.findMany({
    where: {
      status: "ready",
      expirationMode: "duration",
      expirationSeconds: { not: null },
      readyAt: { not: null },
    },
    take: 100,
  });
  for (const d of durationExpired) {
    if (!d.readyAt || !d.expirationSeconds) continue;
    const exp = d.readyAt.getTime() + d.expirationSeconds * 1000;
    if (now.getTime() < exp) continue;
    await expireDownload(d, apiKey);
  }
  // 2. single_use mode :
  //    - scheduledDeleteAt < now (timer initial OU raccourci apr\u00e8s clic)
  //    - OU donn\u00e9es legacy sans scheduledDeleteAt mais readyAt > maxLifetime
  const maxLifetimeCutoff = new Date(
    now.getTime() - config.singleUseMaxLifetimeSeconds * 1000,
  );
  const singleUseExpired = await prisma.download.findMany({
    where: {
      status: "ready",
      expirationMode: "single_use",
      OR: [
        { scheduledDeleteAt: { lt: now } },
        {
          AND: [
            { scheduledDeleteAt: null },
            { readyAt: { lt: maxLifetimeCutoff } },
          ],
        },
      ],
    },
    take: 100,
  });
  for (const d of singleUseExpired) {
    await expireDownload(d, apiKey);
  }
}

async function expireDownload(
  d: { id: number; kind: string; alldebridMagnetId: string | null },
  apiKey: string | null,
): Promise<void> {
  if (apiKey && d.kind === "magnet" && d.alldebridMagnetId) {
    try {
      await deleteMagnet(apiKey, parseInt(d.alldebridMagnetId, 10));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[worker] AllDebrid delete failed for download",
        d.id,
        (err as Error).message,
      );
    }
  }
  await prisma.download.update({
    where: { id: d.id },
    data: {
      status: "expired",
      deletedAt: new Date(),
    },
  });
}
