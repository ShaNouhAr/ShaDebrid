import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { config } from "./config.js";

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
  if (
    dl.expirationMode === "single_use" &&
    dl.scheduledDeleteAt &&
    Date.now() > dl.scheduledDeleteAt.getTime()
  ) {
    return {
      kind: "gone",
      reason: "Le délai de grâce après ouverture est dépassé.",
    };
  }

  return { kind: "ok", dl };
}

/** Usage unique : premier accès (page, fichier, ZIP ou liste de liens). */
export async function touchShareSingleUseIfNeeded(
  dl: ShareDownload,
): Promise<void> {
  if (dl.expirationMode !== "single_use" || dl.firstOpenedAt) return;
  const grace = config.singleUseGraceSeconds;
  await prisma.download.update({
    where: { id: dl.id },
    data: {
      firstOpenedAt: new Date(),
      scheduledDeleteAt: new Date(Date.now() + grace * 1000),
    },
  });
}
