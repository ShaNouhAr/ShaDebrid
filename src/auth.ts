import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "./db.js";
import { WEAK_BOOTSTRAP_PASSWORDS } from "./config.js";

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

/** Hash bidon « pré-cuit » servant de cible à bcrypt.compare quand le nom
 *  d'utilisateur n'existe pas, afin d'éviter qu'un attaquant ne puisse mesurer
 *  un écart de temps de réponse entre « user inconnu » et « mot de passe faux »
 *  (énumération de comptes par timing). Aucun mot de passe réel ne peut le matcher. */
const DUMMY_BCRYPT_HASH =
  "$2b$12$9j1bB7/7gkcTgSxysr8hROWrvxzdrpmfjtKT1SHUrjjW5ZrV.FAI.";

/** Effectue un compare bcrypt en temps constant même si l'utilisateur n'existe pas.
 *  Renvoie toujours `false` quand `hash` est nul/vide, après avoir exécuté un
 *  compare bidon de coût équivalent. */
export async function verifyPasswordConstantTime(
  password: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(password || "x", DUMMY_BCRYPT_HASH).catch(() => false);
    return false;
  }
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
  // Si la base contient déjà au moins un user, on ignore complètement les
  // variables BOOTSTRAP_* : elles ne servent qu'au tout premier démarrage.
  if (count > 0) return;
  // À l'inverse, si on est sur le point de créer le premier admin avec un
  // mot de passe par défaut faible (changeme, admin, etc.) on refuse en
  // production : créer une instance fraiche avec un compte trivialement
  // devinable serait critique. En dev on warn seulement.
  if (WEAK_BOOTSTRAP_PASSWORDS.has(opts.password)) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `BOOTSTRAP_ADMIN_PASSWORD='${opts.password}' est une valeur par défaut faible. ` +
          "Définis BOOTSTRAP_ADMIN_PASSWORD à un vrai mot de passe dans .env avant le premier démarrage.",
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[bootstrap] BOOTSTRAP_ADMIN_PASSWORD='${opts.password}' est une valeur faible — change-la après le 1er login.`,
    );
  }
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
