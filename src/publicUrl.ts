import type { FastifyRequest } from "fastify";
import { config } from "./config.js";
import { getPublicBaseUrlSetting } from "./db.js";

/** Build origin from the incoming HTTP request (reverse-proxy friendly). */
export function requestOrigin(req: FastifyRequest): string {
  const xfProto = req.headers["x-forwarded-proto"];
  const proto =
    (typeof xfProto === "string" ? xfProto.split(",")[0]?.trim() : undefined) ||
    (Array.isArray(xfProto) ? xfProto[0]?.trim() : undefined) ||
    req.protocol ||
    "http";

  const xfHost = req.headers["x-forwarded-host"];
  const host =
    (typeof xfHost === "string" ? xfHost.split(",")[0]?.trim() : undefined) ||
    (Array.isArray(xfHost) ? xfHost[0]?.trim() : undefined) ||
    req.headers.host ||
    "";

  if (!host) {
    return config.publicUrl;
  }
  return `${proto}://${host}`.replace(/\/$/, "");
}

/**
 * Public base URL for absolute links (share URLs, copy buttons).
 * 1) Admin setting `public.baseUrl` if set
 * 2) Else Host / X-Forwarded-* from the current request
 * 3) Else `PUBLIC_URL` from env
 */
export async function resolvePublicUrl(req: FastifyRequest): Promise<string> {
  const fromDb = await getPublicBaseUrlSetting();
  if (fromDb) {
    return fromDb.replace(/\/$/, "");
  }
  return requestOrigin(req);
}
