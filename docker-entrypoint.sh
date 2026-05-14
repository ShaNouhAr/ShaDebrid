#!/bin/sh
set -e

# When /data is a bind mount from the host, it is often root-owned: user `node` cannot
# create SQLite there. First hop as root fixes ownership, then gosu drops privileges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data
  exec gosu node "$0" "$@"
fi

cd /app
npx prisma migrate deploy
exec node dist/server.js
