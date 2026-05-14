# Relais

Application self‑hosted pour envoyer des **magnets, torrents ou liens** (1fichier, uptobox, etc.) vers un **service de débridage** (via sa clé API), puis partager un **lien unique** par téléchargement, avec :

- Comptes utilisateurs (**admin** / **user**)
- Expiration configurable : durée fixe, usage unique (avec délai de grâce), ou manuelle
- Worker qui suit les magnets et débloque les liens
- Redirection **302** vers l’URL directe du fichier côté débrideur (rien ne transite sur ton disque)

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
  - partagehub_db:/data
# volumes:
#   partagehub_db:
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
| `SINGLE_USE_GRACE_SECONDS` | `3600` | Grâce après 1er clic (mode single‑use). |

## Mises à jour

```bash
git pull
docker compose up -d --build
```

## Sécurité

- Mots de passe en bcrypt, sessions chiffrées, tokens de partage aléatoires.
- Exposer derrière HTTPS en production ; changer le mot de passe admin par défaut.

## Limites

- Liens « delayed » côté débrideur : non géré automatiquement.
- Pas d’API REST publique (UI HTML).
