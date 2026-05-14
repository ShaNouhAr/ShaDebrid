import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import {
  clearSession,
  getSessionUser,
  setSessionUser,
  verifyPassword,
  type SessionUser,
} from "../auth.js";

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
}
