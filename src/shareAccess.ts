import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { getAlldebridApiKey } from "./db.js";
import { deleteMagnet } from "./alldebrid.js";

export type ShareDownload = Prisma.DownloadGetPayload<{
  include: { files: true };
}>;

export type ShareAccessResult =
  | { kind: "ok"; dl: ShareDownload }
  | { kind: "not_found" }
  | { kind: "not_ready"; pending: boolean; reason: string }
  | { kind: "gone"; reason: string };

export async function accessShareByToken(
  token: string,
): Promise<ShareAccessResult> {
  const dl = await prisma.download.findUnique({
    where: { shareToken: token },
    include: { files: { orderBy: { position: "asc" } } },
  });
  if (!dl) return { kind: "not_found" };

  if (dl.status !== "ready") {
    const pending = dl.status === "pending";
    return {
      kind: "not_ready",
      pending,
      reason: pending
        ? "Le téléchargement est encore en cours sur le service."
        : dl.status === "failed"
          ? "Le téléchargement a échoué."
          : "Ce lien n'est plus disponible.",
    };
  }

  if (
    dl.expirationMode === "duration" &&
    dl.expirationSeconds &&
    dl.readyAt
  ) {
    const exp = dl.readyAt.getTime() + dl.expirationSeconds * 1000;
    if (Date.now() > exp) {
      return { kind: "gone", reason: "La durée de ce lien est dépassée." };
    }
  }
  if (dl.expirationMode === "single_use") {
    // Filet : si readyAt est ancien (donn\u00e9es legacy sans scheduledDeleteAt fix\u00e9
    // \u00e0 ready), on calcule l'expiration \u00e0 la vol\u00e9e.
    const fallbackExpireAt =
      dl.readyAt
        ? dl.readyAt.getTime() + config.singleUseMaxLifetimeSeconds * 1000
        : null;
    const expireAt = dl.scheduledDeleteAt
      ? dl.scheduledDeleteAt.getTime()
      : fallbackExpireAt;
    if (expireAt != null && Date.now() > expireAt) {
      return { kind: "gone", reason: "Le lien a expiré." };
    }
  }

  return { kind: "ok", dl };
}

/** Marque le premier accès (informationnel) à un partage single_use. */
export async function touchShareSingleUseIfNeeded(
  dl: ShareDownload,
): Promise<void> {
  if (dl.expirationMode !== "single_use" || dl.firstOpenedAt) return;
  await prisma.download.update({
    where: { id: dl.id },
    data: { firstOpenedAt: new Date() },
  });
}

/** Pose le timer initial (max lifetime, 1 h par défaut) dès que le partage est ready.
 *  Idempotent : ne fait rien si déjà posé ou si mode != single_use. */
export async function applySingleUseInitialExpiry(
  downloadId: number,
): Promise<void> {
  const dl = await prisma.download.findUnique({
    where: { id: downloadId },
    select: {
      id: true,
      expirationMode: true,
      scheduledDeleteAt: true,
      readyAt: true,
    },
  });
  if (!dl) return;
  if (dl.expirationMode !== "single_use") return;
  if (dl.scheduledDeleteAt) return; // déjà posé
  const base = dl.readyAt ?? new Date();
  const target = new Date(
    base.getTime() + config.singleUseMaxLifetimeSeconds * 1000,
  );
  await prisma.download.update({
    where: { id: dl.id },
    data: { scheduledDeleteAt: target },
  });
}

/** Marque un fichier comme intégralement transféré au visiteur via le proxy.
 *  Si single_use et que TOUS les fichiers ont été stream, expire immédiatement le partage. */
export async function markFileStreamed(
  dl: ShareDownload,
  fileId: number,
): Promise<{ expired: boolean }> {
  await prisma.downloadFile.update({
    where: { id: fileId },
    data: { streamedAt: new Date() },
  });
  if (dl.expirationMode !== "single_use") return { expired: false };

  const remaining = await prisma.downloadFile.count({
    where: { downloadId: dl.id, streamedAt: null },
  });
  if (remaining > 0) return { expired: false };

  await expireDownloadNow(dl.id);
  return { expired: true };
}

/** Marque un clic « consommé » sur un fichier (redirection 302 vers le CDN).
 *  Raccourcit `scheduledDeleteAt` à `min(actuel, now + grace)` pour passer en mode retry
 *  rapide après le premier vrai clic. N'expire jamais immédiatement (laisse 5 min de retry). */
export async function markFileClicked(
  downloadId: number,
  fileId: number,
): Promise<void> {
  await prisma.downloadFile.updateMany({
    where: { id: fileId, streamedAt: null },
    data: { streamedAt: new Date() },
  });
  const dl = await prisma.download.findUnique({
    where: { id: downloadId },
    select: { expirationMode: true, scheduledDeleteAt: true },
  });
  if (!dl || dl.expirationMode !== "single_use") return;
  const target = new Date(Date.now() + config.singleUseGraceSeconds * 1000);
  if (!dl.scheduledDeleteAt || target < dl.scheduledDeleteAt) {
    await prisma.download.update({
      where: { id: downloadId },
      data: { scheduledDeleteAt: target },
    });
  }
}

/** Marque l’ensemble du partage comme consommé (ex. après un ZIP complet). */
export async function markZipDownloaded(dl: ShareDownload): Promise<{ expired: boolean }> {
  if (dl.expirationMode !== "single_use") return { expired: false };
  await prisma.downloadFile.updateMany({
    where: { downloadId: dl.id, streamedAt: null },
    data: { streamedAt: new Date() },
  });
  await expireDownloadNow(dl.id);
  return { expired: true };
}

/** Expiration immédiate : delete côté AllDebrid (best-effort) + status = expired. */
export async function expireDownloadNow(downloadId: number): Promise<void> {
  const dl = await prisma.download.findUnique({
    where: { id: downloadId },
    select: {
      id: true,
      kind: true,
      alldebridMagnetId: true,
      status: true,
    },
  });
  if (!dl || dl.status === "expired") return;

  const apiKey = await getAlldebridApiKey();
  if (apiKey && dl.kind === "magnet" && dl.alldebridMagnetId) {
    try {
      await deleteMagnet(apiKey, parseInt(dl.alldebridMagnetId, 10));
    } catch {
      // best-effort : on continue même si AllDebrid répond une erreur
    }
  }
  await prisma.download.update({
    where: { id: dl.id },
    data: {
      status: "expired",
      deletedAt: new Date(),
      scheduledDeleteAt: new Date(),
    },
  });
}
