#!/usr/bin/env node
/**
 * Node.js server: dapps homepage + NFT terminal with server-tracked points.
 *
 * Refactored from bare HTTP to Express + PostgreSQL + JWT auth.
 * Keeps all existing routes (proxy, stats, submissions) and adds:
 * - /api/nft-config: returns authenticated user's current points balance
 * - POST /api/mint: deducts points on successful mint, returns new balance + NFT IDs
 *
 * Run:
 *   node server.js              # production dapps.json
 *   node server.js --local-dev  # uses dapps.local.json (localnet URLs)
 */

const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

// ── .env loader ──────────────────────────────────────────────────────────────
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] == null) process.env[key] = val;
  }
})();

const LOCAL_DEV = process.argv.includes("--local-dev");
const PORT = Number(process.env.PORT) || 8000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-insecure";
const INDEX_PATH = path.join(__dirname, "index.html");
const NFT_TERMINAL_PATH = path.join(__dirname, "nft-terminal.html");
const PUBLIC_DIR = path.join(__dirname, "public");
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots");

// PostgreSQL connection for user_points table.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://localhost/usernode_nft_test",
});

// Static content-type lookup for screenshot assets served from public/.
const STATIC_CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

const DAPPS_PATH = (() => {
  if (process.env.DAPPS_JSON_PATH) return path.resolve(process.env.DAPPS_JSON_PATH);
  if (LOCAL_DEV) {
    const localPath = path.join(__dirname, "dapps.local.json");
    if (fs.existsSync(localPath)) return localPath;
  }
  return path.join(__dirname, "dapps.json");
})();

// ── Submit-a-dapp config ──────────────────────────────────────────────────────
const SUBMISSIONS_PATH = process.env.SUBMISSIONS_JSON_PATH
  ? path.resolve(process.env.SUBMISSIONS_JSON_PATH)
  : path.join(__dirname, "submissions.json");

const COMMUNITY_FUND_RESERVE_ADDRESS =
  (process.env.COMMUNITY_FUND_RESERVE_ADDRESS || "").trim();
const SUBMISSION_FEE = Number(process.env.SUBMISSION_FEE) || 1000;
const SUBMISSION_TTL_HOURS = Number(process.env.SUBMISSION_TTL_HOURS) || 24;

// ── NODER NFT TERMINAL config ──────────────────────────────────────────────────
const NFT_TREASURY_ADDRESS = (process.env.NFT_TREASURY_ADDRESS || "").trim();
const MINT_FEE = Number(process.env.MINT_FEE) || 50;
const POINTS_STARTING_BALANCE = 1000;  // default starting points for new users

const EXPLORER_PROD_HOST = "testnet-explorer.usernodelabs.org";
const EXPLORER_PROD_BASE = "/api";
const EXPLORER_LOCAL_HOST = process.env.LOCAL_EXPLORER_UPSTREAM || "localhost:4173";
const EXPLORER_LOCAL_BASE = process.env.LOCAL_EXPLORER_BASE || "/api";

const EXPLORER_UPSTREAM = LOCAL_DEV ? EXPLORER_LOCAL_HOST : EXPLORER_PROD_HOST;
const EXPLORER_UPSTREAM_BASE = LOCAL_DEV ? EXPLORER_LOCAL_BASE : EXPLORER_PROD_BASE;
const EXPLORER_PROXY_PREFIX = "/explorer-api/";

const EXPLORER_USE_HTTP = (() => {
  const host = EXPLORER_UPSTREAM.replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host);
})();

// ── Database initialization ──────────────────────────────────────────────────
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_points (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(255),
        points_balance BIGINT NOT NULL DEFAULT ${POINTS_STARTING_BALANCE},
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("[db] user_points table initialized");
  } catch (err) {
    console.error("[db] failed to initialize database:", err.message);
    process.exit(1);
  }
}

// Get or create user points record (ensures user exists with starting balance).
async function getOrCreateUserPoints(userId, username) {
  try {
    const result = await pool.query(
      `INSERT INTO user_points (user_id, username, points_balance, last_updated)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET username = $2, last_updated = NOW()
       RETURNING points_balance;`,
      [userId, username || null, POINTS_STARTING_BALANCE]
    );
    return result.rows[0]?.points_balance || POINTS_STARTING_BALANCE;
  } catch (err) {
    console.error("[db] getOrCreateUserPoints error:", err.message);
    throw err;
  }
}

// Deduct points from a user's balance (transaction-style: only deduct if sufficient balance).
async function deductUserPoints(userId, amount) {
  try {
    const result = await pool.query(
      `UPDATE user_points SET points_balance = points_balance - $2, last_updated = NOW()
       WHERE user_id = $1 AND points_balance >= $2
       RETURNING points_balance;`,
      [userId, amount]
    );
    if (result.rows.length === 0) {
      return { ok: false, reason: "insufficient_balance" };
    }
    return { ok: true, newBalance: result.rows[0].points_balance };
  } catch (err) {
    console.error("[db] deductUserPoints error:", err.message);
    throw err;
  }
}

// ── Express app setup ────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "64kb" }));

// ── Auth middleware ─────────────────────────────────────────────────────────
// The platform injects JWT via ?token=... on iframe load; frontend forwards it
// via x-usernode-token header. Both token and header are optional for public routes.
const PUBLIC_PATHS = new Set([
  "/",
  "/dapps.json",
  "/nft-terminal",
  "/nft-terminal/",
  "/api/stats",
  "/api/transactions",
  "/user_activity",
  "/api/submit-config",
  "/screenshots",
  "/health",
]);

const PUBLIC_PREFIXES = [
  "/explorer-api/",
  "/api/submissions",  // submission polling is public
];

app.use((req, res, next) => {
  // Extract JWT from query (?token=...) or header (x-usernode-token).
  const token = req.query.token || req.headers["x-usernode-token"];

  if (token && JWT_SECRET) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      console.warn("[auth] token verification failed:", err.message);
    }
  }

  // Deny non-GET requests and all /api/* routes by default (unless public).
  const isPublic = PUBLIC_PATHS.has(req.path) ||
                   PUBLIC_PREFIXES.some((p) => req.path.startsWith(p));

  if (!isPublic && (req.method !== "GET" || req.path.startsWith("/api/"))) {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
  }

  next();
});

// ── Submission store (file-backed, same as before) ───────────────────────────
let submissions = [];
const consumedTxIds = new Set();
const SUBMIT_MEMO_APP = "dapp-homepage";
const SUBMIT_MEMO_TYPE = "submit";

function atomicWriteJson(targetPath, value) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, "." + path.basename(targetPath) + ".tmp-" + crypto.randomBytes(6).toString("hex"));
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, targetPath);
}

function loadSubmissions() {
  try {
    if (!fs.existsSync(SUBMISSIONS_PATH)) {
      submissions = [];
      return;
    }
    const raw = fs.readFileSync(SUBMISSIONS_PATH, "utf8");
    const data = JSON.parse(raw);
    submissions = Array.isArray(data) ? data : (Array.isArray(data.submissions) ? data.submissions : []);
  } catch (e) {
    console.warn(`[submit] could not read submissions.json: ${e.message}`);
    submissions = [];
  }
  consumedTxIds.clear();
  for (const s of submissions) {
    if (s && s.payment_tx_hash) consumedTxIds.add(s.payment_tx_hash);
  }
}

function saveSubmissions() {
  try {
    atomicWriteJson(SUBMISSIONS_PATH, submissions);
  } catch (e) {
    console.warn(`[submit] could not write submissions.json: ${e.message}`);
  }
}

function findSubmission(id) {
  return submissions.find((s) => s && s.id === id) || null;
}

function isLiveSubmission(s) {
  return s && (s.status === "awaiting_payment" || s.status === "published");
}

function submitMemoString(id) {
  return JSON.stringify({ app: SUBMIT_MEMO_APP, type: SUBMIT_MEMO_TYPE, sid: id });
}

function publicSubmissionView(s) {
  return {
    id: s.id,
    status: s.status,
    pay_to: s.fee_recipient,
    amount: SUBMISSION_FEE,
    memo: submitMemoString(s.id),
    payment_tx_hash: s.payment_tx_hash || null,
    created_at: s.created_at,
    expires_at: s.expires_at,
    published_at: s.published_at || null,
    dapp: s.dapp,
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────
function httpJson(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === "https:" ? https : http;
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = transport.request(url, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(bodyBuf ? { "content-length": bodyBuf.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function explorerBaseUrl() {
  const proto = EXPLORER_USE_HTTP ? "http" : "https";
  return `${proto}://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}`;
}

function proxyExplorer(req, res, subPath) {
  const upstreamPath = EXPLORER_UPSTREAM_BASE + "/" + subPath;
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyBuf = chunks.length ? Buffer.concat(chunks) : null;
    const transport = EXPLORER_USE_HTTP ? http : https;
    const [hostname, portStr] = EXPLORER_UPSTREAM.split(":");
    const port = portStr ? Number(portStr) : (EXPLORER_USE_HTTP ? 80 : 443);
    const upReq = transport.request(
      {
        hostname,
        port,
        path: upstreamPath,
        method: req.method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(bodyBuf ? { "content-length": bodyBuf.length } : {}),
        },
      },
      (upRes) => {
        const rChunks = [];
        upRes.on("data", (c) => rChunks.push(c));
        upRes.on("end", () => {
          const body = Buffer.concat(rChunks);
          res.status(upRes.statusCode).set({
            "content-type": upRes.headers["content-type"] || "application/json",
            "access-control-allow-origin": "*",
          }).end(body);
        });
      }
    );
    upReq.on("error", (err) => {
      res.status(502).set("content-type", "text/plain").end(`Explorer proxy error: ${err.message}`);
    });
    if (bodyBuf) upReq.write(bodyBuf);
    upReq.end();
  });
}

// ── Stats poller ────────────────────────────────────────────────────────────
const statsCache = {};
const txCache = {};
const seenTxIds = {};
const lastHeight = {};
let statsChainId = null;

const USERNAMES_PUBKEY =
  process.env.USERNAMES_PUBKEY ||
  "ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az";

async function discoverStatsChainId() {
  try {
    const data = await httpJson("GET", `${explorerBaseUrl()}/active_chain`);
    if (data && data.chain_id) {
      if (statsChainId && statsChainId !== data.chain_id) {
        console.log(`[stats] chain_id changed: ${statsChainId} -> ${data.chain_id} — clearing all caches`);
        for (const key of Object.keys(statsCache)) delete statsCache[key];
        for (const key of Object.keys(txCache)) delete txCache[key];
        for (const key of Object.keys(seenTxIds)) delete seenTxIds[key];
        for (const key of Object.keys(lastHeight)) delete lastHeight[key];
      } else if (!statsChainId) {
        console.log(`[stats] discovered chain_id: ${data.chain_id}`);
      }
      statsChainId = data.chain_id;
    }
  } catch (e) {
    console.warn(`[stats] could not discover chain ID: ${e.message}`);
  }
}

async function pollPubkey(pubkey) {
  if (!statsChainId) return;

  if (!seenTxIds[pubkey]) seenTxIds[pubkey] = new Set();
  if (!txCache[pubkey]) txCache[pubkey] = [];

  const url = `${explorerBaseUrl()}/${statsChainId}/transactions`;
  const MAX_PAGES = 200;
  const SEEN_CAP = 5000;
  let cursor = null;
  const newTxs = [];
  const fromHeight = lastHeight[pubkey] || null;
  let maxHeight = fromHeight;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = { recipient: pubkey, limit: 50 };
      if (cursor) body.cursor = cursor;
      if (fromHeight) body.from_height = fromHeight;

      const resp = await httpJson("POST", url, body);
      const items = (resp && Array.isArray(resp.items)) ? resp.items : [];
      if (items.length === 0) break;

      let allSeen = true;
      for (const tx of items) {
        const txId = tx.tx_id || tx.id || tx.txid || tx.hash;
        if (!txId || seenTxIds[pubkey].has(txId)) continue;
        allSeen = false;
        seenTxIds[pubkey].add(txId);
        newTxs.push(tx);

        const bh = tx.block_height;
        if (typeof bh === "number" && (maxHeight == null || bh > maxHeight)) {
          maxHeight = bh;
        }
      }

      if (allSeen) break;
      if (!resp.has_more || !resp.next_cursor) break;
      cursor = resp.next_cursor;
    }

    if (maxHeight != null) lastHeight[pubkey] = maxHeight;

    if (newTxs.length > 0) {
      txCache[pubkey].push(...newTxs);
      console.log(`[stats] ${pubkey.slice(0, 16)}…: ${newTxs.length} new tx(s), ${txCache[pubkey].length} total`);
    }

    if (seenTxIds[pubkey].size > SEEN_CAP) {
      const arr = Array.from(seenTxIds[pubkey]);
      seenTxIds[pubkey] = new Set(arr.slice(arr.length - SEEN_CAP));
    }

    const senders = new Set();
    for (const tx of txCache[pubkey]) {
      const sender = tx.source || tx.from_pubkey || tx.from;
      if (sender) senders.add(sender);
    }
    statsCache[pubkey] = { users: senders.size, txns: txCache[pubkey].length };
  } catch (e) {
    console.warn(`[stats] poll error for ${pubkey.slice(0, 16)}…: ${e.message}`);
  }
}

function loadDapps() {
  try {
    const raw = fs.readFileSync(DAPPS_PATH, "utf8");
    const data = JSON.parse(raw);
    const apps = data.apps || data.items || [];
    return apps
      .filter((a) => a.pubkey && a.pubkey.trim())
      .map((a) => ({ name: a.name || "(unnamed)", pubkey: a.pubkey.trim() }));
  } catch (e) {
    console.warn(`[stats] could not read dapps.json: ${e.message}`);
    return [];
  }
}

function loadPubkeys() {
  return loadDapps().map((d) => d.pubkey);
}

const STATS_POLL_INTERVAL_MS = 30000;

async function pollAllStats() {
  await discoverStatsChainId();
  if (!statsChainId) return;

  const pubkeys = loadPubkeys();
  const extra = [USERNAMES_PUBKEY];
  if (COMMUNITY_FUND_RESERVE_ADDRESS) extra.push(COMMUNITY_FUND_RESERVE_ADDRESS);
  const all = Array.from(new Set([...pubkeys, ...extra]));
  for (const pk of all) {
    await pollPubkey(pk);
  }

  reconcileSubmissionPayments();
  expireStaleSubmissions();
}

function deriveUsernamesByWallet() {
  const out = new Map();
  const latestKey = new Map();
  const txs = txCache[USERNAMES_PUBKEY] || [];
  for (const tx of txs) {
    const sender = tx.source || tx.from_pubkey || tx.from;
    if (!sender) continue;
    let memo;
    try { memo = JSON.parse(tx.memo || ""); } catch (_) { continue; }
    if (!memo || memo.app !== "usernames" || memo.type !== "set_username") continue;
    if (typeof memo.username !== "string" || !memo.username) continue;
    const key =
      (typeof tx.timestamp_ms === "number" ? tx.timestamp_ms : 0) ||
      (typeof tx.block_height === "number" ? tx.block_height : 0);
    const prev = latestKey.has(sender) ? latestKey.get(sender) : -Infinity;
    if (key >= prev) {
      latestKey.set(sender, key);
      out.set(sender, memo.username);
    }
  }
  return out;
}

function buildUserActivity() {
  const dapps = loadDapps();
  const dappByPubkey = new Map(dapps.map((d) => [d.pubkey, d]));
  const usernames = deriveUsernamesByWallet();

  const wallets = new Map();
  function ensure(wallet) {
    let w = wallets.get(wallet);
    if (!w) { w = { byDapp: new Map(), total: 0 }; wallets.set(wallet, w); }
    return w;
  }

  for (const dapp of dapps) {
    const txs = txCache[dapp.pubkey] || [];
    for (const tx of txs) {
      const sender = tx.source || tx.from_pubkey || tx.from;
      if (!sender) continue;
      if (sender === dapp.pubkey) continue;
      const w = ensure(sender);
      w.total += 1;
      w.byDapp.set(dapp.pubkey, (w.byDapp.get(dapp.pubkey) || 0) + 1);
    }
  }

  for (const wallet of usernames.keys()) ensure(wallet);

  const out = {};
  for (const [wallet, w] of wallets) {
    const byDapp = {};
    for (const [pk, count] of w.byDapp) {
      const dapp = dappByPubkey.get(pk);
      byDapp[pk] = {
        dapp_name: dapp ? dapp.name : "(unknown)",
        transactions: count,
      };
    }
    const username = usernames.get(wallet) || null;
    out[wallet] = {
      wallet_address: wallet,
      wallet_public_key: wallet,
      has_set_username: username != null,
      username,
      total_dapp_transactions: w.total,
      transactions_by_dapp: byDapp,
    };
  }
  return out;
}

function reconcileSubmissionPayments() {
  if (!COMMUNITY_FUND_RESERVE_ADDRESS) return;
  const txs = txCache[COMMUNITY_FUND_RESERVE_ADDRESS] || [];
  let dirty = false;

  for (const tx of txs) {
    const txId = tx.tx_id || tx.id || tx.txid || tx.hash;
    if (!txId || consumedTxIds.has(txId)) continue;

    const status = tx.status;
    if (status && status !== "confirmed") continue;

    const amount = typeof tx.amount === "number" ? tx.amount : Number(tx.amount);
    if (!(amount >= SUBMISSION_FEE)) continue;

    let memo;
    try { memo = JSON.parse(tx.memo || ""); } catch (_) { continue; }
    if (!memo || memo.app !== SUBMIT_MEMO_APP || memo.type !== SUBMIT_MEMO_TYPE) continue;
    if (typeof memo.sid !== "string" || !memo.sid) continue;

    const sub = findSubmission(memo.sid);
    if (!sub) continue;
    if (sub.status !== "awaiting_payment" && sub.status !== "expired") continue;

    try {
      if (!listingHas(sub.dapp.url, sub.dapp.pubkey)) {
        appendDappToListing(sub.dapp);
      }
    } catch (e) {
      console.warn(`[submit] could not publish ${sub.id} to dapps.json (will retry): ${e.message}`);
      continue;
    }

    sub.payer = tx.source || tx.from_pubkey || tx.from || null;
    sub.payment_tx_hash = txId;
    sub.paid_amount = amount;
    sub.published_at = Date.now();
    sub.status = "published";
    consumedTxIds.add(txId);
    dirty = true;
    console.log(`[submit] payment confirmed for ${sub.id} (${amount} tokens from ${sub.payer}) — published "${sub.dapp.name}"`);
  }

  if (dirty) saveSubmissions();
}

function expireStaleSubmissions() {
  const now = Date.now();
  let dirty = false;
  for (const s of submissions) {
    if (s.status === "awaiting_payment" && typeof s.expires_at === "number" && now > s.expires_at) {
      s.status = "expired";
      dirty = true;
    }
  }
  if (dirty) saveSubmissions();
}

function appendDappToListing(dapp) {
  const raw = fs.readFileSync(DAPPS_PATH, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.apps)) data.apps = data.apps || data.items || [];
  data.apps.push(dapp);
  atomicWriteJson(DAPPS_PATH, data);
}

function listingHas(url, pubkey) {
  const dapps = loadDapps();
  if (pubkey && dapps.some((d) => d.pubkey === pubkey)) return true;
  try {
    const data = JSON.parse(fs.readFileSync(DAPPS_PATH, "utf8"));
    const apps = data.apps || data.items || [];
    return apps.some((a) => (url && a.url === url) || (pubkey && a.pubkey === pubkey));
  } catch (_) {
    return false;
  }
}

// Start poller on boot
loadSubmissions();
initializeDatabase().then(() => {
  (async function startStatsPoller() {
    await pollAllStats();
    setInterval(pollAllStats, STATS_POLL_INTERVAL_MS);
  })();
});

// ── Express routes ──────────────────────────────────────────────────────────

// Explorer proxy
app.all(EXPLORER_PROXY_PREFIX + "*", (req, res) => {
  const subPath = req.path.slice(EXPLORER_PROXY_PREFIX.length);
  proxyExplorer(req, res, subPath);
});

// Stats
app.get("/api/stats", (req, res) => {
  res.set("access-control-allow-origin", "*");
  res.json(statsCache);
});

// User activity
app.get("/user_activity", (req, res) => {
  res.set("access-control-allow-origin", "*");
  const minimal = req.query.minimal === "1";
  let activity = buildUserActivity();
  if (minimal) {
    const trimmed = {};
    for (const [key, val] of Object.entries(activity)) {
      trimmed[key] = {
        wallet_address: val.wallet_address,
        has_set_username: val.has_set_username,
        total_dapp_transactions: val.total_dapp_transactions,
      };
    }
    activity = trimmed;
  }
  res.json(activity);
});

// Transactions lookup
app.get("/api/transactions", (req, res) => {
  res.set("access-control-allow-origin", "*");
  const pubkey = (req.query.pubkey || "").trim();
  if (!pubkey) {
    return res.status(400).json({ error: "pubkey query param required" });
  }
  const items = txCache[pubkey] || [];
  res.json({ items });
});

// Submit config
app.get("/api/submit-config", (req, res) => {
  res.json({
    enabled: !!COMMUNITY_FUND_RESERVE_ADDRESS,
    fee: SUBMISSION_FEE,
    reserve_address: COMMUNITY_FUND_RESERVE_ADDRESS || null,
  });
});

// NFT config (now with authenticated points balance)
app.get("/api/nft-config", async (req, res) => {
  const config = {
    enabled: !!NFT_TREASURY_ADDRESS,
    mintFee: MINT_FEE,
    treasuryAddress: NFT_TREASURY_ADDRESS || null,
  };

  // If user is authenticated, include their points balance.
  if (req.user) {
    try {
      const balance = await getOrCreateUserPoints(req.user.id, req.user.username);
      config.pointsBalance = balance;
    } catch (err) {
      console.error("[nft-config] failed to fetch user points:", err.message);
      res.status(500).json({ error: "Failed to fetch user points" });
      return;
    }
  }

  res.json(config);
});

// Create submission
app.post("/api/submissions", (req, res) => {
  if (!COMMUNITY_FUND_RESERVE_ADDRESS) {
    return res.status(503).json({
      error: "Submissions are not currently open (no Reserve address configured).",
    });
  }

  const body = req.body;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const name = str(body.name);
  const description = str(body.description);
  const author = str(body.author);
  const url = str(body.url);
  const pubkey = str(body.pubkey);
  const category = str(body.category);
  const logo = str(body.logo);

  if (!name) return res.status(400).json({ error: "Name is required." });
  if (name.length > 80) return res.status(400).json({ error: "Name is too long (max 80 chars)." });
  if (!url) return res.status(400).json({ error: "URL is required." });

  let parsed;
  try { parsed = new URL(url); } catch (_) {
    return res.status(400).json({ error: "URL is not valid." });
  }
  if (parsed.protocol !== "https:") {
    return res.status(400).json({ error: "URL must start with https://" });
  }

  if (!pubkey) return res.status(400).json({ error: "Dapp pubkey (ut1…) is required." });
  if (!pubkey.startsWith("ut1")) {
    return res.status(400).json({ error: "Pubkey must be a Usernode address (starts with ut1)." });
  }
  if (description.length > 280) {
    return res.status(400).json({ error: "Description is too long (max 280 chars)." });
  }
  if (logo && logo.length > 8000) {
    return res.status(400).json({ error: "Logo SVG is too large." });
  }

  const dapp = { name, description, author: author || "unknown", url, pubkey };
  if (category) dapp.category = category;
  if (logo) dapp.logo = logo;

  if (listingHas(url, pubkey)) {
    return res.status(409).json({ error: "A dapp with this URL or pubkey is already listed." });
  }

  const dupe = submissions.find(
    (s) => isLiveSubmission(s) && s.dapp &&
      (s.dapp.url === url || s.dapp.pubkey === pubkey)
  );
  if (dupe) {
    return res.status(409).json({ error: "A submission for this URL or pubkey is already in progress." });
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const record = {
    id,
    status: "awaiting_payment",
    dapp,
    payer: null,
    payment_tx_hash: null,
    paid_amount: null,
    fee_recipient: COMMUNITY_FUND_RESERVE_ADDRESS,
    created_at: now,
    expires_at: now + SUBMISSION_TTL_HOURS * 3600 * 1000,
    published_at: null,
  };
  submissions.push(record);
  saveSubmissions();

  res.status(201).json({
    id,
    pay_to: COMMUNITY_FUND_RESERVE_ADDRESS,
    amount: SUBMISSION_FEE,
    memo: submitMemoString(id),
    status: record.status,
    expires_at: record.expires_at,
  });
});

// Get submission status
app.get("/api/submissions/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const sub = findSubmission(id);
  if (!sub) return res.status(404).json({ error: "Submission not found." });
  res.json(publicSubmissionView(sub));
});

// Mint NFTs (requires auth, deducts points)
app.post("/api/mint", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  if (!NFT_TREASURY_ADDRESS) {
    return res.status(503).json({ error: "Minting is not currently available." });
  }

  const { quantity } = req.body;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return res.status(400).json({ error: "Invalid quantity (must be 1-100)" });
  }

  const totalCost = quantity * MINT_FEE;

  try {
    // Deduct points — will fail if insufficient balance.
    const deduct = await deductUserPoints(req.user.id, totalCost);
    if (!deduct.ok) {
      return res.status(400).json({
        error: "Insufficient points",
        reason: deduct.reason,
      });
    }

    // Allocate NFT IDs (1-100, session-only, deterministic within this tx).
    const nftIds = [];
    for (let i = 0; i < quantity; i++) {
      nftIds.push(Math.floor(Math.random() * 100) + 1);
    }

    res.json({
      ok: true,
      nftIds,
      newBalance: deduct.newBalance,
    });
  } catch (err) {
    console.error("[mint] error:", err.message);
    res.status(500).json({ error: "Mint failed" });
  }
});

// Dapps listing
app.get("/dapps.json", (req, res) => {
  fs.readFile(DAPPS_PATH, (err, buf) => {
    if (err) {
      return res.status(500).set("content-type", "text/plain").end(
        `Failed to read dapps.json: ${err.message}\n`
      );
    }
    res.set("content-type", "application/json; charset=utf-8");
    res.end(buf);
  });
});

// NFT Terminal
app.get(["/nft-terminal", "/nft-terminal/"], (req, res) => {
  fs.readFile(NFT_TERMINAL_PATH, (err, buf) => {
    if (err) {
      const missing = err.code === "ENOENT";
      console.error(
        `[/nft-terminal] failed to read ${NFT_TERMINAL_PATH}: ${err.code || ""} ${err.message}`
      );
      return res.status(missing ? 404 : 500).set("content-type", "text/plain").end(
        missing
          ? "NODER NFT TERMINAL is unavailable: page file not found on the server.\n"
          : `Failed to read nft-terminal.html: ${err.message}\n`
      );
    }
    res.set("content-type", "text/html; charset=utf-8");
    res.end(buf);
  });
});

// Screenshots
app.get("/screenshots/*", (req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(req.path.slice("/screenshots/".length));
  } catch (_) {
    return res.status(400).set("content-type", "text/plain").end("Bad Request");
  }

  const filePath = path.resolve(SCREENSHOTS_DIR, rel);
  const rootWithSep = SCREENSHOTS_DIR + path.sep;
  if (filePath !== SCREENSHOTS_DIR && !filePath.startsWith(rootWithSep)) {
    return res.status(403).set("content-type", "text/plain").end("Forbidden");
  }

  const ext = path.extname(filePath).toLowerCase();
  const ctype = STATIC_CONTENT_TYPES[ext];
  if (!ctype) {
    return res.status(404).set("content-type", "text/plain").end("Not Found");
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return res.status(404).set("content-type", "text/plain").end("Not Found");
    }
    res.set({
      "content-type": ctype,
      "content-length": stat.size,
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    });
    fs.createReadStream(filePath)
      .on("error", () => {
        if (!res.headersSent) {
          res.status(500).set("content-type", "text/plain").end("Read error");
        } else {
          res.destroy();
        }
      })
      .pipe(res);
  });
});

// Index (homepage)
app.get(["/", "/index.html"], (req, res) => {
  fs.readFile(INDEX_PATH, (err, buf) => {
    if (err) {
      return res.status(500).set("content-type", "text/plain").end(
        `Failed to read index.html: ${err.message}\n`
      );
    }
    res.set("content-type", "text/html; charset=utf-8");
    res.end(buf);
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// 404 fallback
app.all("*", (req, res) => {
  res.status(404).set("content-type", "text/plain").end("Not Found");
});

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Serving ${INDEX_PATH}`);
  console.log(`NFT Terminal: ${NFT_TERMINAL_PATH}`);
  console.log(`Dapps config: ${DAPPS_PATH}${LOCAL_DEV ? " (local-dev)" : ""}`);
  console.log(`Explorer proxy: ${EXPLORER_USE_HTTP ? "http" : "https"}://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}`);
  console.log(`Stats poller: every ${STATS_POLL_INTERVAL_MS / 1000}s → GET /api/stats, GET /api/transactions?pubkey=..., GET /user_activity`);
  console.log(`Listening on http://localhost:${PORT}`);
});
