import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import {
  clearSession,
  getSessionUser,
  setSessionUser,
  requireAuth,
  verifyPassword,
  hashPassword,
  type SessionUser,
} from "../auth.js";
import { getFlash, setFlash } from "./downloads.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { next?: string; error?: string } }>(
    "/login",
    async (req, reply) => {
      if (getSessionUser(req)) {
        return reply.redirect("/");
      }
      return await reply.renderPage(
        "login.ejs",
        {
          title: "Connexion",
          next: req.query.next || "/",
          error: req.query.error,
          flash: null,
        },
        { layout: "layouts/public.ejs" },
      );
    },
  );

  app.post<{
    Body: { username?: string; password?: string; next?: string };
  }>("/login", async (req, reply) => {
    const username = (req.body.username || "").trim();
    const password = req.body.password || "";
    const next = req.body.next || "/";
    if (!username || !password) {
      return reply.redirect(
        `/login?error=missing&next=${encodeURIComponent(next)}`,
      );
    }
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return reply.redirect(
        `/login?error=invalid&next=${encodeURIComponent(next)}`,
      );
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return reply.redirect(
        `/login?error=invalid&next=${encodeURIComponent(next)}`,
      );
    }
    const sessionUser: SessionUser = {
      id: user.id,
      username: user.username,
      role: user.role === "admin" ? "admin" : "user",
    };
    setSessionUser(req, sessionUser);
    return reply.redirect(next);
  });

  app.post("/logout", async (req, reply) => {
    clearSession(req);
    return reply.redirect("/login");
  });

  // ---------------- Account ----------------
  app.get("/account", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    return await reply.renderPage("account.ejs", {
      title: "Mon compte",
      flash: getFlash(req),
    });
  });

  app.post<{
    Body: {
      currentPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    };
  }>("/account/password", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const currentPassword = req.body.currentPassword || "";
    const newPassword = req.body.newPassword || "";
    const confirmPassword = req.body.confirmPassword || "";

    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    if (!dbUser) return reply.redirect("/account");

    if (!(await verifyPassword(currentPassword, dbUser.passwordHash))) {
      setFlash(req, { type: "error", text: "Mot de passe actuel incorrect." });
      return reply.redirect("/account");
    }
    if (newPassword.length < 6) {
      setFlash(req, {
        type: "error",
        text: "Le nouveau mot de passe doit faire au moins 6 caractères.",
      });
      return reply.redirect("/account");
    }
    if (newPassword !== confirmPassword) {
      setFlash(req, {
        type: "error",
        text: "Les deux nouveaux mots de passe ne correspondent pas.",
      });
      return reply.redirect("/account");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword) },
    });
    setFlash(req, { type: "success", text: "Mot de passe mis à jour." });
    return reply.redirect("/account");
  });
}
