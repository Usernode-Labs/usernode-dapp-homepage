#!/usr/bin/env node
/**
 * Noder NFT — mint unique on-chain "Noder" NFTs by paying the native coin of
 * the Usernode testnet.
 *
 * Express + PostgreSQL, port 3000, standard Usernode Social Vibecoding stack.
 *
 * Trust model (mirrors the dapp-homepage submit-a-dapp flow): the server never
 * trusts a client claim of payment. A background poller watches the treasury
 * address on the public block explorer; only a *confirmed* transfer whose memo
 * carries a matching pending-mint id (and amount >= MINT_PRICE) mints the NFT.
 */

const express = require("express");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const path = require("path");

const { ARTWORK_COUNT, svgForIndex } = require("./lib/artwork");

// ── Config ────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === "staging";

const TREASURY_ADDRESS = (process.env.TREASURY_ADDRESS || "").trim();
const MINT_PRICE = Number(process.env.MINT_PRICE) || 100;
const MAX_SUPPLY = Number(process.env.MAX_SUPPLY) || 1000;
const MINT_TTL_HOURS = Number(process.env.MINT_TTL_HOURS) || 24;

// Memo binding — the exact shape reconcileMintPayments() looks for on-chain.
const MEMO_APP = "noder-nft";
const MEMO_TYPE = "mint";

// Public block explorer. The frontend reaches it through this app's
// /explorer-api/* proxy (the bridge polls POST /<chain>/transactions with no
// platform token to forward); the server-side poller hits the same upstream
// directly. Overridable for localnet via EXPLORER_API_BASE.
const EXPLORER_API_BASE = (
  process.env.EXPLORER_API_BASE || "https://testnet-explorer.usernodelabs.org/api"
).replace(/\/+$/, "");

const STATS_POLL_INTERVAL_MS = 30000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Schema ──────────────────────────────────────────────────────────────────
// `nfts` is public: a stranger seeing every minted Noder is fine — it's a
// gallery / leaderboard. `pending_mints` is private: it holds per-user
// financial intent (an unpaid mint a specific user initiated), so it is copied
// schema-only into staging and seeded with fakes there.
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nfts (
      id             SERIAL PRIMARY KEY,
      token_id       INTEGER UNIQUE NOT NULL,
      owner_id       INTEGER NOT NULL,
      owner_username TEXT NOT NULL,
      tx_hash        TEXT UNIQUE NOT NULL,
      image_index    INTEGER NOT NULL,
      minted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_mints (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     INTEGER NOT NULL,
      username    TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL,
      tx_hash     TEXT,
      token_id    INTEGER
    );
  `);

  // Private: holds a single user's unpaid financial intent. Staging gets the
  // structure only — no prod rows — and we seed nothing into it (the gallery
  // is what testers look at; pending intents aren't needed there).
  await pool.query(`COMMENT ON TABLE pending_mints IS 'staging:private'`);

  // Helpful index for the per-user active-pending lookup.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS pending_mints_user_status_idx ON pending_mints (user_id, status)`
  );
}

// ── Staging seed ─────────────────────────────────────────────────────────────
// `nfts` is brand new (doesn't exist in prod yet), so staging boots with an
// empty gallery. Seed a believable spread so reviewers see a populated grid.
// Strictly a no-op outside staging.
async function seedStaging() {
  if (!IS_STAGING) return;

  const users = [
    { id: 101, username: "alice_staging" },
    { id: 102, username: "bob_staging" },
    { id: 103, username: "carol_staging" },
    { id: 104, username: "dave_staging" },
  ];

  for (let t = 1; t <= 15; t++) {
    const u = users[(t - 1) % users.length];
    const imageIndex = (t - 1) % ARTWORK_COUNT; // cycles 0–9 then 0–4
    // Deterministic, obviously-fake 64-char hex tx hash.
    const txHash =
      "stagingdemo" + String(t).padStart(2, "0") + "f".repeat(64 - 13);
    // Stagger minted_at across the past 7 days.
    const hoursAgo = Math.round((t / 15) * 7 * 24);
    await pool.query(
      `INSERT INTO nfts (token_id, owner_id, owner_username, tx_hash, image_index, minted_at)
       VALUES ($1, $2, $3, $4, $5, NOW() - ($6 || ' hours')::interval)
       ON CONFLICT (token_id) DO NOTHING`,
      [t, u.id, u.username, txHash, imageIndex, String(hoursAgo)]
    );
  }
  console.log("[seed] staging gallery seeded with 15 demo Noders");
}

// ── On-chain payment poller ───────────────────────────────────────────────────
const consumedTxIds = new Set(); // tx ids already credited to a mint
let chainId = null;
let lastHeight = 0;

function txIdOf(tx) {
  // Same fallback chain the homepage poller uses for explorer field drift.
  return tx.tx_id || tx.id || tx.txid || tx.hash || null;
}

async function explorerJson(method, urlPath, body) {
  const url = `${EXPLORER_API_BASE}/${String(urlPath).replace(/^\/+/, "")}`;
  const resp = await fetch(url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`explorer ${method} ${urlPath} -> HTTP ${resp.status}`);
  return resp.json();
}

async function discoverChainId() {
  const data = await explorerJson("GET", "active_chain");
  const id =
    (data && (data.chain_id || data.active_chain || data.chain)) ||
    (typeof data === "string" ? data : null);
  if (!id) throw new Error("could not resolve chain_id from active_chain");
  return id;
}

// Seed the consumed-tx set from already-minted rows so a restart can never
// double-credit a payment.
async function loadConsumedTxIds() {
  const { rows } = await pool.query(`SELECT tx_hash FROM nfts`);
  for (const r of rows) if (r.tx_hash) consumedTxIds.add(r.tx_hash);
}

// Page the explorer for inbound transfers to the treasury and return the raw
// tx list for this pass. Incremental via from_height once we've seen blocks.
async function fetchTreasuryTxs() {
  if (!chainId) return [];
  const collected = [];
  let cursor = null;
  let maxHeight = lastHeight;

  for (let page = 0; page < 200; page++) {
    const body = { recipient: TREASURY_ADDRESS, limit: 50 };
    if (cursor) body.cursor = cursor;
    if (lastHeight > 0) body.from_height = lastHeight;

    let data;
    try {
      data = await explorerJson("POST", `${chainId}/transactions`, body);
    } catch (e) {
      console.warn(`[poll] tx fetch failed: ${e.message}`);
      break;
    }

    const items = data.transactions || data.items || data.txs || [];
    for (const tx of items) {
      collected.push(tx);
      const h = Number(tx.height || tx.block_height || 0);
      if (h > maxHeight) maxHeight = h;
    }

    cursor = data.next_cursor || data.cursor || null;
    if (!cursor || items.length === 0) break;
  }

  if (maxHeight > lastHeight) lastHeight = maxHeight;
  return collected;
}

// Credit confirmed payments → mint. Trusts only confirmed chain state.
async function reconcileMintPayments(txs) {
  for (const tx of txs) {
    const txId = txIdOf(tx);
    if (!txId || consumedTxIds.has(txId)) continue;

    const status = tx.status;
    if (status && status !== "confirmed") continue;

    const amount = typeof tx.amount === "number" ? tx.amount : Number(tx.amount);
    if (!(amount >= MINT_PRICE)) continue;

    let memo;
    try {
      memo = JSON.parse(tx.memo || "");
    } catch (_) {
      continue;
    }
    if (!memo || memo.app !== MEMO_APP || memo.type !== MEMO_TYPE) continue;
    if (typeof memo.mid !== "string" || !memo.mid) continue;

    // Look up the pending mint. Credit a real confirmed payment even if the
    // form already gave up (status expired) — the fee was burned regardless.
    const { rows } = await pool.query(
      `SELECT * FROM pending_mints WHERE id = $1`,
      [memo.mid]
    );
    const pend = rows[0];
    if (!pend) continue;
    if (pend.status !== "pending" && pend.status !== "expired") continue;

    // Mint inside a transaction: token_id = MAX+1, enforce the supply cap,
    // random artwork. The poller is single-threaded so the count→insert is safe.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const supplyRes = await client.query(`SELECT COUNT(*)::int AS c FROM nfts`);
      if (supplyRes.rows[0].c >= MAX_SUPPLY) {
        await client.query("ROLLBACK");
        console.warn(`[mint] supply cap reached — cannot mint for ${pend.id}`);
        continue;
      }
      const nextRes = await client.query(
        `SELECT COALESCE(MAX(token_id), 0) + 1 AS next FROM nfts`
      );
      const tokenId = nextRes.rows[0].next;
      const imageIndex = Math.floor(Math.random() * ARTWORK_COUNT);

      await client.query(
        `INSERT INTO nfts (token_id, owner_id, owner_username, tx_hash, image_index)
         VALUES ($1, $2, $3, $4, $5)`,
        [tokenId, pend.user_id, pend.username, txId, imageIndex]
      );
      await client.query(
        `UPDATE pending_mints SET status = 'confirmed', tx_hash = $2, token_id = $3 WHERE id = $1`,
        [pend.id, txId, tokenId]
      );
      await client.query("COMMIT");

      consumedTxIds.add(txId);
      console.log(
        `[mint] confirmed ${pend.id} -> Noder #${tokenId} for ${pend.username} (${amount} from ${tx.source || tx.from_pubkey || tx.from || "?"})`
      );
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // Unique violation on tx_hash → already minted by a prior pass; mark
      // consumed so we stop retrying.
      if (e.code === "23505") consumedTxIds.add(txId);
      else console.warn(`[mint] failed to mint for ${pend.id}: ${e.message}`);
    } finally {
      client.release();
    }
  }
}

// Sweep unpaid pending mints past their TTL to 'expired' so the form stops
// polling. A genuine late payment still re-credits an expired record.
async function expireStaleMints() {
  await pool
    .query(
      `UPDATE pending_mints SET status = 'expired'
       WHERE status = 'pending' AND expires_at < NOW()`
    )
    .catch((e) => console.warn(`[expire] sweep failed: ${e.message}`));
}

async function pollTick() {
  try {
    if (!TREASURY_ADDRESS) return; // no treasury configured → nothing to poll
    if (!chainId) {
      try {
        chainId = await discoverChainId();
        console.log(`[poll] chain_id = ${chainId}`);
      } catch (e) {
        console.warn(`[poll] chain_id discovery failed: ${e.message}`);
        return;
      }
    }
    const txs = await fetchTreasuryTxs();
    if (txs.length) await reconcileMintPayments(txs);
    await expireStaleMints();
  } catch (e) {
    console.warn(`[poll] tick error: ${e.message}`);
  }
}

function startPoller() {
  pollTick();
  setInterval(pollTick, STATS_POLL_INTERVAL_MS);
}

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Auth — iframe token injection (platform scaffold). Deny-by-default for all
// non-GET and /api/* requests; explicit public allow-list below.
const PUBLIC_API_PATHS = new Set(["/health", "/api/mint-config"]);
const PUBLIC_PREFIXES = ["/explorer-api/", "/api/gallery"];

app.use((req, res, next) => {
  const token = req.query.token || req.headers["x-usernode-token"];
  if (token && JWT_SECRET) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (_) {}
  }
  if (req.method !== "GET" || req.path.startsWith("/api/")) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Explorer proxy — transparent passthrough so the bridge can poll for inclusion
// from inside the iframe (it has no platform token to forward).
app.all("/explorer-api/*", async (req, res) => {
  const subPath = req.path.slice("/explorer-api/".length);
  const url = `${EXPLORER_API_BASE}/${subPath}`;
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body || {}),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.set("content-type", upstream.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: "explorer proxy failed", detail: e.message });
  }
});

function nftView(row) {
  return {
    token_id: row.token_id,
    name: `Noder #${row.token_id}`,
    owner_username: row.owner_username,
    image_index: row.image_index,
    image_svg: svgForIndex(row.image_index),
    minted_at: row.minted_at,
    tx_hash: row.tx_hash,
  };
}

// Public: total minted derived live — no counter to drift.
async function totalMinted() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM nfts`);
  return rows[0].c;
}

// GET /api/mint-config (public) — what the UI needs to render the mint banner.
app.get("/api/mint-config", async (_req, res) => {
  try {
    const minted = await totalMinted();
    res.json({
      mintPrice: MINT_PRICE,
      treasuryAddress: TREASURY_ADDRESS || null,
      maxSupply: MAX_SUPPLY,
      totalMinted: minted,
      soldOut: minted >= MAX_SUPPLY,
      mintEnabled: !!TREASURY_ADDRESS,
      env: IS_STAGING ? "staging" : "production",
      artworkCount: ARTWORK_COUNT,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gallery (public) — newest-first, 50/page, cursor = last token_id.
app.get("/api/gallery", async (req, res) => {
  try {
    const limit = 50;
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;
    const params = [];
    let where = "";
    if (cursor && Number.isFinite(cursor)) {
      params.push(cursor);
      where = `WHERE token_id < $1`;
    }
    params.push(limit + 1);
    const { rows } = await pool.query(
      `SELECT * FROM nfts ${where} ORDER BY token_id DESC LIMIT $${params.length}`,
      params
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({
      items: page.map(nftView),
      nextCursor: hasMore ? page[page.length - 1].token_id : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gallery/:tokenId (public) — single NFT detail.
app.get("/api/gallery/:tokenId", async (req, res) => {
  try {
    const tokenId = Number(req.params.tokenId);
    if (!Number.isInteger(tokenId)) return res.status(400).json({ error: "bad token id" });
    const { rows } = await pool.query(`SELECT * FROM nfts WHERE token_id = $1`, [tokenId]);
    if (!rows[0]) return res.status(404).json({ error: "not found" });
    res.json({ item: nftView(rows[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/my-nfts (auth) — the current user's collection, newest-first.
app.get("/api/my-nfts", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM nfts WHERE owner_id = $1 ORDER BY token_id DESC`,
      [req.user.id]
    );
    res.json({ items: rows.map(nftView) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mint (auth) — create a pending mint, return pay instructions.
// Reuses an existing non-expired pending mint so a double-tap can't strand fees.
app.post("/api/mint", async (req, res) => {
  try {
    if (!TREASURY_ADDRESS) {
      return res.status(503).json({ error: "Minting is not configured" });
    }
    if ((await totalMinted()) >= MAX_SUPPLY) {
      return res.status(409).json({ error: "Sold out", code: "sold_out" });
    }

    // Reuse a live pending mint rather than minting a duplicate intent.
    const existing = await pool.query(
      `SELECT * FROM pending_mints
       WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    let pend = existing.rows[0];

    if (!pend) {
      const ins = await pool.query(
        `INSERT INTO pending_mints (user_id, username, expires_at)
         VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)
         RETURNING *`,
        [req.user.id, req.user.username || "anon", String(MINT_TTL_HOURS)]
      );
      pend = ins.rows[0];
    }

    const memo = JSON.stringify({ app: MEMO_APP, type: MEMO_TYPE, mid: pend.id });
    res.json({
      mid: pend.id,
      treasuryAddress: TREASURY_ADDRESS,
      amount: MINT_PRICE,
      memo,
      expiresAt: pend.expires_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mint/:mid (auth) — poll a pending mint's status. Scoped to owner.
app.get("/api/mint/:mid", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM pending_mints WHERE id = $1`, [
      req.params.mid,
    ]);
    const pend = rows[0];
    if (!pend || pend.user_id !== req.user.id) {
      return res.status(404).json({ error: "not found" });
    }
    const out = { status: pend.status };
    if (pend.status === "confirmed" && pend.token_id != null) {
      const nftRes = await pool.query(`SELECT * FROM nfts WHERE token_id = $1`, [
        pend.token_id,
      ]);
      const nft = nftRes.rows[0];
      out.tokenId = pend.token_id;
      out.txHash = pend.tx_hash;
      if (nft) {
        out.imageIndex = nft.image_index;
        out.nft = nftView(nft);
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Static shell.
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await initSchema();
    await seedStaging();
    await loadConsumedTxIds();
  } catch (e) {
    console.error(`[boot] schema/seed failed: ${e.message}`);
  }
  startPoller();
  app.listen(PORT, () => {
    console.log(`Noder NFT listening on :${PORT} (${IS_STAGING ? "staging" : "production"})`);
    if (!TREASURY_ADDRESS) console.warn("[boot] TREASURY_ADDRESS unset — minting disabled");
  });
})();
