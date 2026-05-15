/* ShaDebrid Service Worker
 *
 * Strategy:
 *  - Static assets (CSS, fonts, icons): cache-first.
 *  - HTML navigations: network-first, fallback to cached shell on offline.
 *  - Auth/data POST + share streams + download routes: NEVER cached, pass through.
 *
 * Bump CACHE_VERSION whenever static asset bundle changes (build:css output).
 */
const CACHE_VERSION = "shadebrid-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const STATIC_ASSETS = [
  "/static/styles/app.css",
  "/static/favicon.svg",
  "/static/icon-192.png",
  "/static/icon-512.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(CACHE_VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Paths that must always go to network (auth, downloads, share streams, API). */
function isPassthrough(url) {
  const p = url.pathname;
  if (p.startsWith("/d/")) return true; // public share page + file routes
  if (p.startsWith("/downloads/")) return true;
  if (p === "/login" || p === "/logout") return true;
  if (p.startsWith("/admin/")) return true;
  if (p.startsWith("/account")) return true;
  if (p.startsWith("/new")) return true;
  if (p === "/health") return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET — POST/PUT/DELETE always go straight to network.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Ignore cross-origin requests (Google Fonts CDN etc.) — let the browser handle.
  if (url.origin !== self.location.origin) return;

  // Never intercept passthrough routes (live data, streams, auth)
  if (isPassthrough(url)) return;

  // Static assets : cache-first
  if (url.pathname.startsWith("/static/") || url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, clone));
          }
          return res;
        });
      }),
    );
    return;
  }

  // HTML navigations : network-first with cached fallback
  if (req.mode === "navigate" || (req.headers.get("Accept") || "").includes("text/html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match("/")),
        ),
    );
  }
});
