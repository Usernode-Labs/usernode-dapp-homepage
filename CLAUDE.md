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
 poller that exposes `GET /api/stats`,
 `GET /api/transactions?pubkey=…`, and `GET /user_activity` (per-wallet
 rollup across all tracked dapps + global usernames). No
 `package.json`, no auth middleware (the homepage is fully public).
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
shell, `/dapps.json`, `/api/stats`, `/api/transactions`,
`/user_activity`, and `/explorer-api/*` are all reachable without
auth — that's intentional. The only "user action" the page exposes
is clicking out to a hosted dapp.

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

`GET /user_activity` re-rolls the same caches into a per-wallet view:

```json
{
  "<wallet ut1...>": {
    "wallet_address": "ut1...",
    "wallet_public_key": "ut1...",
    "has_set_username": true,
    "username": "alice_abc123",
    "total_dapp_transactions": 17,
    "transactions_by_dapp": {
      "<dapp pubkey>": { "dapp_name": "Opinion Market", "transactions": 9 }
    }
  }
}
```

`wallet_address` and `wallet_public_key` are intentionally the same
value — the explorer only surfaces the bech32 address (`ut1...`) per
tx, and on Usernode the address *is* the bech32 of the public key
hash. Both fields are kept in the response for forward-compat.

Wallets are included if they've ever sent a tx to a tracked dapp **or**
ever set a username on the global usernames address. The poller polls
that address (`USERNAMES_PUBKEY`, overridable via env) the same way it
polls dapp pubkeys, then `deriveUsernamesByWallet` resolves "latest
`set_username` per sender wins". Self-sends (sender == dapp pubkey,
e.g. lastwin's UTXO consolidation) are excluded from the rollup.

## Explorer API proxy

`/explorer-api/*` proxies to the upstream block explorer
(`testnet-explorer.usernodelabs.org/api` in production,
`localhost:4173/api` in `--local-dev`). The proxy switches between
`http` and `https` automatically based on whether the upstream looks
like a private IP. Same convention as every other dapp in the fleet.

## App-specific conventions

- **Adding a new dapp**: append an object to `dapps.json` and bounce
  the server. The poller picks up new pubkeys on its next 30s tick.
- **Operator status (maintenance/deprecated)**: an entry may carry an
  optional `"status"` string — `"operational"` (default when omitted),
  `"maintenance"`, or `"deprecated"`. It feeds the health status dot +
  `/api/health` Status panel and overrides the auto-detected
  reachability/activity status. Absence means `operational`; no
  migration needed.
- **`/api/health` is intentionally public**: a background reachability
  prober HEADs each dapp's `url` (HEAD→GET fallback, 5s timeout) and
  the route joins that with on-chain activity recency, the poller's
  sync state, and the operator `status` into a per-dapp status map.
  Same public posture as `/api/stats`. Staging seeds a synthetic
  spread (`seedStagingHealth`) since live probes/`txCache` are empty
  in a preview.
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

## Submit-a-dapp flow (on-chain fee + auto-publish)

Anyone can publish a new dapp via the **Submit** button in the header.
The flow burns a one-time on-chain fee (`SUBMISSION_FEE`, default
1000 tokens) to the **Community Fund Reserve**
(`COMMUNITY_FUND_RESERVE_ADDRESS`, may be a burn address). Once the
poller confirms the payment on-chain, the dapp is **auto-published** to
`dapps.json` and appears on the homepage on the next tick — **there is
no validator review and no pending state; confirmation is publication.**
Fees are **non-refundable**. There are **no authenticated surfaces** —
every endpoint is public, matching the app's original posture.

- **Storage is file-backed, not Postgres.** Submissions live in
  `submissions.json` (gitignored), written atomically (temp file +
  `rename`) and loaded into memory on boot — same zero-dependency,
  file-as-source-of-truth approach as `dapps.json`. The app still
  ignores `DATABASE_URL`. Override the path with `SUBMISSIONS_JSON_PATH`.
- **Status flow is two terminal states:** `awaiting_payment` →
  `published` (plus `expired` for unpaid submissions swept after
  `SUBMISSION_TTL_HOURS`).
- **Payment verification + publish is server-side and trustless.** The
  poller adds `COMMUNITY_FUND_RESERVE_ADDRESS` to its tracked set;
  `reconcileSubmissionPayments()` (run each 30s tick) publishes a
  submission only when a **confirmed** transfer to the Reserve carries
  `amount >= SUBMISSION_FEE` and a memo
  `{"app":"dapp-homepage","type":"submit","sid":"<id>"}` whose `sid`
  matches an awaiting/expired submission. On a match it appends the
  entry to `dapps.json` (atomic write; idempotent via the `listingHas`
  guard) and flips the record to `published`. If the `dapps.json` write
  fails it leaves the record unpublished and the tx unconsumed so the
  next tick retries — the fee is already burned regardless.
  `consumedTxIds` (re-seeded from `payment_tx_hash` on boot) ensures one
  tx publishes one submission. Never trusts a client claim of payment.
- **`dapps.json` must be writable** by the `node` user — publication is
  unattended, so a non-writable file silently blocks new rows (logged,
  retried each tick).
- **Public submit endpoints** (no auth): `POST /api/submissions` (create
  + get pay instructions), `GET /api/submissions/:id` (status poll),
  `GET /api/submit-config`. These accept writes but expose only a
  global, per-submission view — no user data.
- Secrets declared in `dapp.json` (all non-`private`, public values):
  `COMMUNITY_FUND_RESERVE_ADDRESS`, `SUBMISSION_FEE`,
  `SUBMISSION_TTL_HOURS`. When `COMMUNITY_FUND_RESERVE_ADDRESS` is unset
  the submit flow is disabled (the form returns 503).
