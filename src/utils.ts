import { randomBytes } from "node:crypto";

export function newShareToken(): string {
  // URL-safe base64, ~22 chars from 16 bytes
  return randomBytes(16)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function isMagnetUri(s: string): boolean {
  return /^magnet:\?/i.test(s.trim());
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);
}

export function relativeFromNow(d: Date | null | undefined): string {
  if (!d) return "—";
  const now = Date.now();
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < hour) return rtf.format(Math.round(diff / minute), "minute");
  if (abs < day) return rtf.format(Math.round(diff / hour), "hour");
  return rtf.format(Math.round(diff / day), "day");
}

export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "file";
}

/** Valide une URL « next » de redirection post-login : doit être un chemin local
 *  commençant par "/" mais pas par "//" (qui serait interprété comme une URL
 *  protocol-relative et permettrait un open-redirect). */
export function safeNextPath(raw: string | undefined | null, fallback = "/"): string {
  if (!raw || typeof raw !== "string") return fallback;
  const v = raw.trim();
  if (!v.startsWith("/")) return fallback;
  if (v.startsWith("//") || v.startsWith("/\\")) return fallback;
  if (v.includes("\n") || v.includes("\r")) return fallback;
  return v;
}

/** Échappe un JSON destiné à être injecté dans un <script>...</script>.
 *  JSON.stringify ne neutralise pas `</script>`, `<!--`, `U+2028` ni `U+2029`,
 *  qui peuvent casser le contexte d'un script HTML. */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Détecte un hostname pointant vers la machine elle-même ou vers un réseau privé
 *  (RFC1918, link-local, loopback, ULA IPv6). Sert de garde-fou anti-SSRF : on
 *  refuse que le serveur fetch des URLs renvoyant vers son propre réseau interne. */
function isPrivateOrLocalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "ip6-localhost" || h === "ip6-loopback") {
    return true;
  }
  // IPv4
  const m4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) {
    const o = m4.slice(1).map((x) => parseInt(x, 10));
    if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    if (o[0] === 10) return true;
    if (o[0] === 127) return true;
    if (o[0] === 0) return true;
    if (o[0] === 169 && o[1] === 254) return true; // link-local
    if (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0]! >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6 grossier : ::1, fc00::/7 (ULA), fe80::/10 (link-local)
  if (h === "::1" || h === "::") return true;
  if (/^fc[0-9a-f]{2}:/i.test(h) || /^fd[0-9a-f]{2}:/i.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;
  return false;
}

/** Valide une URL avant qu'on la fetch côté serveur (zip relais).
 *  Refuse tout schéma autre que http/https et tout hostname pointant vers le
 *  réseau privé/local. Défense en profondeur : `directUrl` vient de la réponse
 *  AllDebrid (donc déjà fiable en théorie), mais on évite qu'une donnée corrompue
 *  en base puisse transformer le serveur en sonde réseau interne (SSRF). */
export function isSafeExternalFetchUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!u.hostname) return false;
  if (isPrivateOrLocalHostname(u.hostname)) return false;
  return true;
}
