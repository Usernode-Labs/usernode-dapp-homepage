# Noder NFT — notes for Claude Code

A standalone Usernode Social Vibecoding app: mint unique on-chain **Noder**
NFTs by paying the native testnet coin. Express + PostgreSQL, port 3000.

Read the authoritative platform conventions before changing anything:
https://social-vibecoding.usernodelabs.org/claude.md
If a rule here conflicts with the hosted conventions, the hosted conventions
win.

## Architecture

- `server.js` — Express app. Schema init (`nfts`, `pending_mints`), the public
  + auth API routes, the explorer proxy (`/explorer-api/*`), and the 30s
  background poller (`reconcileMintPayments` + `expireStaleMints`).
- `lib/artwork.js` — 10 embedded SVG "Noder" illustrations as a string array.
  `image_index` on an `nfts` row maps into it. No file I/O, no image hosting.
- `index.html` — single-file UI (Tailwind CDN, dark). Gallery grid, mint modal
  with bridge `sendTransaction` + 5s confirmation polling, My Collection view.
  Contains the `usernode-dev-console@1` forwarder — do not remove it.
- `dapp.json` — secrets manifest (`TREASURY_ADDRESS`, `MINT_PRICE`,
  `MAX_SUPPLY`, `MINT_TTL_HOURS`).

## Trust model

The server never trusts a client claim of payment. Only a *confirmed* explorer
transfer to `TREASURY_ADDRESS` with `amount >= MINT_PRICE` and a memo
`{"app":"noder-nft","type":"mint","mid":"<uuid>"}` matching a pending mint
causes a mint. `consumedTxIds` (seeded from `nfts.tx_hash` on boot) makes it
one-tx-one-mint across restarts.

## Tables / privacy

- `nfts` — **public**: the minted gallery; a stranger seeing every row is fine.
- `pending_mints` — **`staging:private`**: per-user unpaid financial intent.
  Copied schema-only into staging. The boot seed populates `nfts` (15 demo
  Noders across alice/bob/carol/dave_staging) so the gallery isn't empty;
  `pending_mints` is intentionally left empty in staging.

A public table must never FK into a private one — `nfts` and `pending_mints`
have no FK between them; they're joined in app code by `token_id`.

## Conventions

- token_id is `MAX(token_id)+1` assigned at confirmation (1-based); image_index
  is random 0–(ARTWORK_COUNT-1) at confirmation.
- Explorer tx id fallback chain: `tx.tx_id || tx.id || tx.txid || tx.hash`.
- The homepage directory lists this app via its own `dapps.json` entry whose
  `pubkey` is this treasury address, so the homepage poller counts mints.
