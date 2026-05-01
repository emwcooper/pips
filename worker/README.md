# pips-stats Worker

Tiny Cloudflare Worker that records anonymous solve times and serves the global histogram for https://emwcooper.github.io/pips/.

## Endpoints

- `POST /solve` — body `{ difficulty: "easy"|"medium"|"hard", elapsedMs, clientId? }`. Rejects solves under 5s or over 60min.
- `GET /histogram?difficulty=easy` — returns `{ difficulty, labels, counts, total }` matching the client's histogram bins.

## First-time deploy

```sh
# 1. Install wrangler (one-time)
brew install node            # if Node isn't installed
npm i -g wrangler

# 2. Auth
wrangler login

# 3. Create the D1 database (records the database_id you need to paste back)
cd worker
wrangler d1 create pips-stats
# -> copy the printed database_id into wrangler.toml

# 4. Apply schema
wrangler d1 execute pips-stats --remote --file=./schema.sql

# 5. Deploy
wrangler deploy
# -> note the URL it prints (e.g. https://pips-stats.<account>.workers.dev)
```

After deploy, set that URL as `STATS_API_URL` in `src/stats/global.js` of the main app.

## Subsequent deploys

```sh
cd worker
wrangler deploy
```
