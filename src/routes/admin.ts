import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db.js";
import { getAlldebridApiKey, setAlldebridApiKey, getPublicBaseUrlSetting, setPublicBaseUrl } from "../db.js";
import { hashPassword, requireAdmin } from "../auth.js";
import { ping, AllDebridError } from "../alldebrid.js";
import { formatDate } from "../utils.js";
import { getFlash, setFlash } from "./downloads.js";
import { resolvePublicUrl } from "../publicUrl.js";

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ---------------- Users ----------------
  app.get("/admin/users", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const users = await prisma.user.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        username: true,
        role: true,
        createdAt: true,
        _count: { select: { downloads: true } },
      },
    });
    return await reply.renderPage("admin-users.ejs", {
      title: "Utilisateurs",
      user,
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        createdAt: formatDate(u.createdAt),
        downloadCount: u._count.downloads,
      })),
      flash: getFlash(req),
    });
  });

  app.post<{
    Body: {
      username?: string;
      password?: string;
      role?: string;
    };
  }>("/admin/users", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const username = (req.body.username || "").trim();
    const password = req.body.password || "";
    const role = req.body.role === "admin" ? "admin" : "user";
    if (!username || password.length < 6) {
      setFlash(req, {
        type: "error",
        text:
          "Identifiant requis et mot de passe d'au moins 6 caractères.",
      });
      return reply.redirect("/admin/users");
    }
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      setFlash(req, { type: "error", text: "Cet identifiant existe déjà." });
      return reply.redirect("/admin/users");
    }
    await prisma.user.create({
      data: {
        username,
        passwordHash: await hashPassword(password),
        role,
      },
    });
    setFlash(req, {
      type: "success",
      text: `Utilisateur "${username}" créé.`,
    });
    return reply.redirect("/admin/users");
  });

  app.post<{ Params: { id: string }; Body: { password?: string } }>(
    "/admin/users/:id/password",
    async (req, reply) => {
      const user = await requireAdmin(req, reply);
      if (!user) return;
      const id = parseInt(req.params.id, 10);
      const password = req.body.password || "";
      if (password.length < 6) {
        setFlash(req, {
          type: "error",
          text: "Mot de passe d'au moins 6 caractères requis.",
        });
        return reply.redirect("/admin/users");
      }
      await prisma.user.update({
        where: { id },
        data: { passwordHash: await hashPassword(password) },
      });
      setFlash(req, { type: "success", text: "Mot de passe mis à jour." });
      return reply.redirect("/admin/users");
    },
  );

  app.post<{ Params: { id: string }; Body: { role?: string } }>(
    "/admin/users/:id/role",
    async (req, reply) => {
      const user = await requireAdmin(req, reply);
      if (!user) return;
      const id = parseInt(req.params.id, 10);
      const role = req.body.role === "admin" ? "admin" : "user";
      if (id === user.id && role !== "admin") {
        setFlash(req, {
          type: "error",
          text: "Vous ne pouvez pas vous retirer le rôle admin.",
        });
        return reply.redirect("/admin/users");
      }
      await prisma.user.update({ where: { id }, data: { role } });
      setFlash(req, { type: "success", text: "Rôle mis à jour." });
      return reply.redirect("/admin/users");
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/users/:id/delete",
    async (req, reply) => {
      const user = await requireAdmin(req, reply);
      if (!user) return;
      const id = parseInt(req.params.id, 10);
      if (id === user.id) {
        setFlash(req, {
          type: "error",
          text: "Vous ne pouvez pas vous supprimer.",
        });
        return reply.redirect("/admin/users");
      }
      await prisma.user.delete({ where: { id } });
      setFlash(req, { type: "success", text: "Utilisateur supprimé." });
      return reply.redirect("/admin/users");
    },
  );

  // ---------------- Settings ----------------
  app.get("/admin/settings", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    const apiKey = await getAlldebridApiKey();
    let alldebridStatus: {
      ok: boolean;
      username?: string;
      premium?: boolean;
      premiumUntil?: string;
      error?: string;
    } | null = null;
    if (apiKey) {
      try {
        const info = await ping(apiKey);
        alldebridStatus = {
          ok: true,
          username: info.user.username,
          premium: info.user.isPremium,
          premiumUntil: info.user.premiumUntil
            ? formatDate(new Date(info.user.premiumUntil * 1000))
            : undefined,
        };
      } catch (err) {
        const e = err as Error;
        alldebridStatus = {
          ok: false,
          error:
            e instanceof AllDebridError ? `${e.code}: ${e.message}` : e.message,
        };
      }
    }
    const publicBaseUrlSetting = await getPublicBaseUrlSetting();
    const effectivePublicUrl = await resolvePublicUrl(req);
    return await reply.renderPage("admin-settings.ejs", {
      title: "Paramètres",
      user,
      hasApiKey: !!apiKey,
      apiKeyMasked: apiKey
        ? apiKey.slice(0, 4) + "•".repeat(8) + apiKey.slice(-4)
        : null,
      alldebridStatus,
      publicBaseUrlSetting: publicBaseUrlSetting || "",
      effectivePublicUrl,
      flash: getFlash(req),
    });
  });

  app.get("/admin/settings/public", async (_req, reply) =>
    reply.redirect("/admin/settings", 302),
  );
  app.get("/admin/settings/public-url", async (_req, reply) =>
    reply.redirect("/admin/settings", 302),
  );

  type PublicSettingsBody = {
    settingsAction?: string;
    baseUrl?: string;
    clearPublicUrl?: string;
  };

  async function postAdminPublicSettings(
    req: FastifyRequest<{ Body: PublicSettingsBody }>,
    reply: FastifyReply,
  ): Promise<void> {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    let action = req.body.settingsAction;
    if (!action && req.body.clearPublicUrl) action = "clearPublicUrl";
    if (!action) action = "savePublicUrl";
    if (action === "clearPublicUrl") {
      await setPublicBaseUrl("");
      setFlash(req, {
        type: "success",
        text: "URL publique réinitialisée (détection automatique ou PUBLIC_URL).",
      });
      return reply.redirect("/admin/settings");
    }
    if (action === "savePublicUrl") {
      const raw = (req.body.baseUrl || "").trim();
      if (!raw) {
        setFlash(req, {
          type: "error",
          text: "URL vide : saisissez une URL complète ou utilisez « Réinitialiser ».",
        });
        return reply.redirect("/admin/settings");
      }
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        setFlash(req, {
          type: "error",
          text: "URL invalide (ex. https://partage.example.com).",
        });
        return reply.redirect("/admin/settings");
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        setFlash(req, {
          type: "error",
          text: "Utilisez http:// ou https://.",
        });
        return reply.redirect("/admin/settings");
      }
      await setPublicBaseUrl(u.origin);
      setFlash(req, {
        type: "success",
        text: `URL publique enregistrée : ${u.origin}`,
      });
      return reply.redirect("/admin/settings");
    }
    setFlash(req, { type: "error", text: "Requête non reconnue." });
    return reply.redirect("/admin/settings");
  }

  app.post<{ Body: PublicSettingsBody }>(
    "/admin/settings",
    postAdminPublicSettings,
  );

  /** Anciens formulaires (HTML en cache) : même traitement que POST /admin/settings */
  app.post<{ Body: { baseUrl?: string; clearPublicUrl?: string } }>(
    "/admin/settings/public",
    async (req, reply) => {
      const b = req.body;
      (req as FastifyRequest<{ Body: PublicSettingsBody }>).body = {
        settingsAction: b.clearPublicUrl ? "clearPublicUrl" : "savePublicUrl",
        baseUrl: b.baseUrl,
      };
      return postAdminPublicSettings(
        req as FastifyRequest<{ Body: PublicSettingsBody }>,
        reply,
      );
    },
  );
  app.post<{ Body: { baseUrl?: string; clearPublicUrl?: string } }>(
    "/admin/settings/public-url",
    async (req, reply) => {
      const b = req.body;
      (req as FastifyRequest<{ Body: PublicSettingsBody }>).body = {
        settingsAction: b.clearPublicUrl ? "clearPublicUrl" : "savePublicUrl",
        baseUrl: b.baseUrl,
      };
      return postAdminPublicSettings(
        req as FastifyRequest<{ Body: PublicSettingsBody }>,
        reply,
      );
    },
  );

  app.post<{ Body: { apiKey?: string; clear?: string } }>(
    "/admin/settings/apikey",
    async (req, reply) => {
      const user = await requireAdmin(req, reply);
      if (!user) return;
      if (req.body.clear) {
        await prisma.setting.deleteMany({ where: { key: "alldebrid.apikey" } });
        setFlash(req, { type: "success", text: "Clé API supprimée." });
        return reply.redirect("/admin/settings");
      }
      const apiKey = (req.body.apiKey || "").trim();
      if (!apiKey) {
        setFlash(req, { type: "error", text: "Clé API vide." });
        return reply.redirect("/admin/settings");
      }
      try {
        await ping(apiKey);
      } catch (err) {
        const e = err as Error;
        setFlash(req, {
          type: "error",
          text: `Validation échouée : ${e.message}`,
        });
        return reply.redirect("/admin/settings");
      }
      await setAlldebridApiKey(apiKey);
      setFlash(req, { type: "success", text: "Clé API enregistrée." });
      return reply.redirect("/admin/settings");
    },
  );
}
