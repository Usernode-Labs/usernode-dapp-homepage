# Noder NFT

Mint unique on-chain **Noder** NFTs by paying the native coin of the Usernode
testnet. A public gallery shows every minted Noder; signed-in users mint their
own with a one-time on-chain payment to the project treasury, and the artwork
is revealed once the chain confirms the transfer.

This is a standalone Usernode Social Vibecoding app: Node.js / Express +
PostgreSQL, port 3000.

## How minting works (trustless)

1. The user taps **Mint Yours**. The server creates a `pending_mints` row and
   returns pay instructions: treasury address, amount (`MINT_PRICE`), and a memo
   `{"app":"noder-nft","type":"mint","mid":"<uuid>"}`.
2. The frontend asks the centrally-hosted Usernode bridge to send the payment
   (manual fallback if no wallet). The memo binds the payment to the pending
   mint.
3. A 30s background poller watches the treasury on the public block explorer.
   When a **confirmed** transfer carries `amount >= MINT_PRICE` and a memo whose
   `mid` matches a pending mint, the server mints the NFT (`token_id = MAX+1`,
   random artwork) and flips the pending record to `confirmed`. The server never
   trusts a client claim of payment.

`consumedTxIds` (seeded from minted rows on boot) guarantees one tx mints one
NFT, even across restarts.

## Configuration (`dapp.json` secrets)

| Key | Default | Notes |
|---|---|---|
| `TREASURY_ADDRESS` | — (required) | `ut1…` address that receives mint fees. |
| `MINT_PRICE` | `100` | Native coins per mint. |
| `MAX_SUPPLY` | `1000` | Hard cap on total mints. |
| `MINT_TTL_HOURS` | `24` | Unpaid pending mints expire after this; late payments still credit. |

Platform-injected: `DATABASE_URL`, `JWT_SECRET`, `PORT`, `USERNODE_ENV`.
Optional `EXPLORER_API_BASE` overrides the explorer upstream for localnet.

## Tables

- `nfts` — public. The minted gallery (token_id, owner, tx_hash, image_index).
- `pending_mints` — `staging:private`. Per-user unpaid mint intent. Copied
  schema-only to staging; the gallery (`nfts`) is what staging seeds.

## Run locally

```bash
npm install
DATABASE_URL=postgres://… JWT_SECRET=dev TREASURY_ADDRESS=ut1… node server.js
```

Open http://localhost:3000.
