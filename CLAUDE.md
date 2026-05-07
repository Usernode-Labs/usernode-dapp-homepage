# Dapp Homepage — notes for Claude Code

A directory listing of dapps built on the Usernode chain, sorted by
popularity / users / transactions / alphabetical. Each entry links out
to a hosted dapp (Opinion Market, Falling Sands, Last One Wins, Echo,
…). The homepage itself sends no transactions; it just renders
`dapps.json` and decorates each row with on-chain stats (unique senders
+ total tx count) derived from the explorer.

This app runs as a child app inside Usernode Social Vibecoding. Read
the authoritative platform conventions before making changes:

**Platform conventions (always current):**
https://usernode.evanshapiro.dev/claude.md

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win.

## Architecture

- `server.js` — Zero-dependency Node.js HTTP server. Serves
  `index.html` and `dapps.json`, proxies `/explorer-api/*` to the
  upstream block explorer, and runs a background per-pubkey stats
  poller that exposes `GET /api/stats` and
  `GET /api/transactions?pubkey=…`. No `package.json`, no auth
  middleware (the homepage is fully public).
- `index.html` — Single-file UI. CSS variables for light/dark theme,
  rubber-band scroll, sort menu (popular / users / txns / alpha).
  Contains the `// usernode-dev-console@1` forwarder block that
  surfaces client logs to the Usernode platform's dev console panel —
  do not remove it.
- `dapps.json` — Source of truth for the list. Each entry has
  `name`, `description`, `author`, `url`, `pubkey`. The poller reads
  this file every 30s to discover which addresses to track.
- `dapps.local.json` — Localnet variant, used when `--local-dev`.
- `Dockerfile` — `node:20-alpine`, copies the three files, runs
  `node server.js`. No build step.

## Running locally

```bash
node server.js              # production dapps.json
node server.js --local-dev  # uses dapps.local.json + localnet explorer
```

Then open `http://localhost:8000`. Override the listen port with
`PORT=…`.

## Auth model

The homepage is **public**. There is no JWT, no platform login
required, no `req.user` consulted anywhere. SV injects `JWT_SECRET`
and `DATABASE_URL` into the container; both are ignored. The HTML
shell, `/dapps.json`, `/api/stats`, `/api/transactions`, and
`/explorer-api/*` are all reachable without auth — that's intentional.
The only "user action" the page exposes is clicking out to a hosted
dapp.

## Stats poller

`server.js` runs a background poll loop:

- Discovers `chain_id` once at startup via
  `GET /active_chain` on the explorer.
- For each `pubkey` in `dapps.json`, pages
  `POST /<chain_id>/transactions` filtered by `recipient: pubkey`,
  with `from_height` for incremental fetches.
- Caches raw txs in memory (per pubkey, unbounded but bounded
  `seenTxIds` at 5000 to prevent unbounded memory growth on long-lived
  pubkeys).
- Re-derives `{ users, txns }` per pubkey from the cache on each pass.
- Polls every 30s. On `chain_id` change (chain reset / different
  network), all caches are cleared.

`GET /api/stats` returns `{ [pubkey]: { users, txns } }` for the UI's
sort+display. `GET /api/transactions?pubkey=…` returns the full raw-tx
cache for that pubkey, in case anything else wants to consume it
without re-paginating the explorer.

## Explorer API proxy

`/explorer-api/*` proxies to the upstream block explorer
(`testnet-explorer.usernodelabs.org/api` in production,
`localhost:4173/api` in `--local-dev`). The proxy switches between
`http` and `https` automatically based on whether the upstream looks
like a private IP. Same convention as every other dapp in the fleet.

## App-specific conventions

- **Adding a new dapp**: append an object to `dapps.json` and bounce
  the server. The poller picks up new pubkeys on its next 30s tick.
- **Stats are recipient-only**: the poller queries `recipient: pubkey`
  so amounts shown reflect what each dapp actually received (excludes
  sender change). See the explorer `amount` caveat in the platform
  conventions.
- **Links open in new tabs** (`target="_blank"`). When the homepage
  itself runs inside SV, the new tab lands on each dapp's "Open in
  Usernode" page if that dapp gates its HTML shell. That's a known UX
  edge — fix at the link-strategy layer when it matters, not here.
- **No package.json**: the server is intentionally zero-dependency
  Node stdlib only. Don't add dependencies without a strong reason —
  the cold-boot story (Dockerfile is `COPY` + `node server.js`) is
  part of why this app is robust.
- **`/api/stats` and `/api/transactions` are intentionally public**.
  They expose a global summary identical for every viewer.
