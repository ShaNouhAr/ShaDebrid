import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "./db.js";

export type SessionUser = {
  id: number;
  username: string;
  role: "admin" | "user";
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function getSessionUser(req: FastifyRequest): SessionUser | null {
  const u = req.session.get("user") as SessionUser | undefined;
  return u ?? null;
}

export function setSessionUser(req: FastifyRequest, user: SessionUser): void {
  req.session.set("user", user);
}

export function clearSession(req: FastifyRequest): void {
  req.session.delete();
}

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionUser | undefined> {
  const u = getSessionUser(req);
  if (!u) {
    const next = encodeURIComponent(req.url);
    void reply.redirect(`/login?next=${next}`);
    return undefined;
  }
  return u;
}

export async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionUser | undefined> {
  const u = await requireAuth(req, reply);
  if (!u) return undefined;
  if (u.role !== "admin") {
    void reply.code(403).send({ error: "Forbidden" });
    return undefined;
  }
  return u;
}

export async function bootstrapAdminIfNeeded(opts: {
  username: string;
  password: string;
}): Promise<void> {
  const count = await prisma.user.count();
  if (count > 0) return;
  const passwordHash = await hashPassword(opts.password);
  await prisma.user.create({
    data: {
      username: opts.username,
      passwordHash,
      role: "admin",
    },
  });
  // eslint-disable-next-line no-console
  console.log(
    `[bootstrap] Created admin user "${opts.username}" (change the password!)`,
  );
}
