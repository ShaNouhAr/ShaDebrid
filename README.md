# ShaDebrid

Application self‑hosted pour envoyer des **magnets, torrents ou liens** (1fichier, uptobox, etc.) vers un **service de débridage** (via sa clé API), puis partager un **lien unique** par téléchargement, avec :

- Comptes utilisateurs (**admin** / **user**)
- Expiration configurable : durée fixe, usage unique (avec délai de grâce), ou manuelle
- Worker qui suit les magnets et débloque les liens
- Téléchargement **streamé via le serveur** (anti-leech : l'URL CDN du débrideur n'est jamais exposée au visiteur ; rien ne touche le disque, tout passe en RAM)
- Expiration **immédiate** des liens *usage unique* à la fin du téléchargement (et filet de sécurité court en cas d'interruption)

## URL publique des liens de partage

Ordre de priorité pour construire les URLs absolues (`https://…/d/<token>`) :

1. **Paramètre admin** : Paramètres → « URL publique du site » (stocké en base).
2. **Sinon** : déduction à partir de la requête (`Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`) — utile derrière un reverse proxy sans toucher à `.env`.
3. **Sinon** : variable d’environnement **`PUBLIC_URL`**.

Cookie de session **`Secure`** : par défaut si `PUBLIC_URL` commence par `https://`. Derrière un proxy TLS vers le conteneur en HTTP, utilisez **`SESSION_COOKIE_SECURE=true`** (voir tableau ci‑dessous).

## Stack

- Node 22 + TypeScript + Fastify
- Prisma + SQLite
- EJS + Tailwind (CDN)

## Démarrage rapide (Docker)

1. Configuration :

   ```bash
   cp .env.example .env
   sed -i "s/SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
   $EDITOR .env
   ```

2. Lancer :

   ```bash
   docker compose up -d --build
   ```

3. Ouvrir <http://localhost:3000>, se connecter avec l’admin défini dans `.env`, puis **Paramètres** pour la clé API du débrideur et éventuellement l’**URL publique** si les liens copiés doivent pointer vers un domaine précis.

La base est dans `./data/app.db` (`mkdir -p data` si besoin).

### Erreur Prisma « unable to open database file »

Voir le script d’entrée Docker qui ajuste les droits sur `/data`. Sinon utilisez un volume nommé :

```yaml
volumes:
  - shadebrid_db:/data
# volumes:
#   shadebrid_db:
```

### Reverse proxy (HTTPS)

Exemple Caddy :

```caddyfile
partage.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Pensez à renseigner l’URL publique (admin ou `PUBLIC_URL=https://partage.example.com`) et, si besoin, `SESSION_COOKIE_SECURE=true`.

## Développement local

```bash
cp .env.example .env
npm install
npx prisma migrate dev
npm run dev
```

- **`npm run build`** : bundle avec **esbuild** (évite des segfault de `tsc` dans certains builds Docker).
- **`npm run typecheck`** : `tsc --noEmit`.

## Variables d’environnement

| Variable | Défaut | Description |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3000` | Repli si pas d’URL admin et pas d’en‑têtes utilisables. |
| `SESSION_COOKIE_SECURE` | *(auto)* | `true` / `false` pour forcer le flag `Secure` du cookie (proxy HTTPS → app en HTTP). |
| `HOST` | `0.0.0.0` | Écoute. |
| `PORT` | `3000` | Port. |
| `SESSION_SECRET` | — | **Obligatoire.** `openssl rand -hex 32`. |
| `DATABASE_URL` | `file:./data/app.db` | SQLite (Prisma). |
| `BOOTSTRAP_ADMIN_USERNAME` | `admin` | Premier admin si base vide. |
| `BOOTSTRAP_ADMIN_PASSWORD` | `changeme` | À changer. |
| `WORKER_INTERVAL_MS` | `15000` | Polling magnets (ms). |
| `SINGLE_USE_GRACE_SECONDS` | `300` | Fenêtre de retry après le 1er clic sur un fichier d'un lien single_use. |
| `SINGLE_USE_MAX_LIFETIME_SECONDS` | `3600` | Durée de vie max d'un lien single_use **sans aucun clic** (timer à partir de readyAt). |

## Sécurité

- **Mots de passe** : bcrypt(12) (~250 ms/hash). Le compare bcrypt est exécuté **même quand l'utilisateur n'existe pas** (anti-énumération par timing).
- **Sessions** : `@fastify/secure-session` (signature + chiffrement libsodium). Cookies `httpOnly`, `sameSite=lax`, `secure` automatique en HTTPS.
- **Brute-force login** : rate limit 10 tentatives / minute / IP sur `POST /login`.
- **Headers** : Helmet → CSP stricte, `X-Frame-Options: DENY`, HSTS (1 an) si TLS détecté, Referrer-Policy `strict-origin-when-cross-origin`.
- **BFCache** : `Cache-Control: no-store` sur toutes les pages applicatives (sauf assets statiques, partages publics et PWA) pour éviter qu'un « back » après logout réaffiche le dashboard.
- **Tokens de partage** : 128 bits aléatoires (base64url ~22 caractères), inexploitables par force brute.
- **Pas d'open-redirect** : `?next=…` validé (chemin local uniquement).
- **XSS** : EJS échappe `<%= %>` par défaut ; les JSON injectés en `<script>` passent par `safeJsonForScript` (échappe `</script>`, `U+2028/9`).
- **Anti-SSRF** : avant tout fetch ou redirect 302 d'une URL stockée en base (CDN AllDebrid), on refuse explicitement les schémas non `http(s)` et les hôtes privés / loopback (RFC1918, link-local, ULA IPv6, etc.).
- **`TRUST_PROXY`** : `true` derrière un reverse proxy local (Caddy/Nginx/Traefik), `false` si exposé direct, ou liste d'IP/CIDR de confiance.
- **Refus de démarrer en `NODE_ENV=production` si** :
  - `SESSION_SECRET` fait moins de 32 caractères ;
  - `BOOTSTRAP_ADMIN_PASSWORD` est une valeur par défaut faible (`changeme`, `admin`, `password`, etc.).
- En dev, un simple warning est émis pour ces deux cas — change-les avant de passer en prod.

## PWA (Progressive Web App)

L'application est installable comme app standalone (Android/iOS/Desktop) :
- Manifest : `/manifest.webmanifest` (servi à la racine).
- Service worker : `/sw.js` (cache statique + offline minimal, ne touche **jamais** aux routes `/d/...`, `/downloads/...`, `/admin/...`, auth ou téléchargements).
- Icônes (PNG 192/512 + maskable + apple-touch) générées depuis `public/favicon.svg` :
  ```bash
  npm run build:icons
  ```
- Lorsque le CSS change (`build:css`), bump `CACHE_VERSION` dans `public/sw.js` pour forcer l'invalidation côté clients installés.

## Mises à jour

```bash
git pull
docker compose up -d --build
```

## Limites

- Liens « delayed » côté débrideur : non géré automatiquement.
- Pas d’API REST publique (UI HTML).
