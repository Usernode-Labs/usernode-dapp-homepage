# Usernode Hold'em — slice 1

On-chain 6-max No-Limit Texas Hold'em as a Usernode child app (Express +
Postgres + JWT iframe auth, port 3000). Separate from the dapp homepage.

## What's in slice 1

- One 6-max NL cash table: lobby, create/join, on-chain buy-in.
- Ledger-backed pooled-bank chips (1 chip = 1 token). The chain is touched
  only on **deposit** (read-verified) and **cash-out** (treasury-signed).
- Full betting (check/call/bet/raise/fold), all-in with main/side pots and
  odd-chip splits, automatic showdown with named made-hands.
- Provably-fair commit/reveal deal: per-hand secret seed + player entropy
  nonces, sha256 commitment written on-chain before dealing, seed revealed
  on-chain at hand end. Per-hand **Verify** panel + history.
- SSE live table state with **server-side redaction** of other players' hole
  cards.
- Action timer that **pauses while an action transaction is pending/
  confirming** and auto-checks-or-folds on timeout.

## Layout

```
engine/   pure, unit-tested poker logic (cards, evaluator, pots, holdem, fairness, timer)
chain/    explorer (read) + treasury (custodial signer/payout) + audit anchoring
view.js   per-viewer redacted SSE snapshot
db/       idempotent schema (with staging:private markers)
server.js Express app, REST + SSE + chain poller + game loop
public/   single-file responsive UI
```

## Running locally

```bash
npm install
DATABASE_URL=postgres://… JWT_SECRET=dev USERNODE_ENV=staging node server.js
```

## Tests

```bash
npm test   # node --test over engine/ (no DB or network needed)
```

## Deferred (later phases)

Mental-poker card encryption, ZK proofs, AI bots, leaderboards, stats,
achievements, chat, anti-collusion, replay, spectator mode, and full
table-creator controls. See the session spec.
