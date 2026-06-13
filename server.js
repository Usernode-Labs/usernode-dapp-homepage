#!/usr/bin/env node
/**
 * Minimal Node server to host index.html on http://localhost:8000
 *
 * Run:
 *   node server.js              # production dapps.json
 *   node server.js --local-dev  # uses dapps.local.json (localnet URLs)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// `pg` is the app's single runtime dependency (see package.json). Require it
// lazily/defensively so a stray local run without `npm install` still serves
// the public homepage — pin routes degrade to 503 when the client is absent.
let PgPool = null;
try {
  PgPool = require("pg").Pool;
} catch (_) {
  console.warn("[pins] 'pg' module not available — pin features disabled");
}

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
const INDEX_PATH = path.join(__dirname, "index.html");

const DAPPS_PATH = (() => {
  if (process.env.DAPPS_JSON_PATH) return path.resolve(process.env.DAPPS_JSON_PATH);
  if (LOCAL_DEV) {
    const localPath = path.join(__dirname, "dapps.local.json");
    if (fs.existsSync(localPath)) return localPath;
  }
  return path.join(__dirname, "dapps.json");
})();

const JWT_SECRET = process.env.JWT_SECRET || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const IS_STAGING = process.env.USERNODE_ENV === "staging";

const EXPLORER_PROD_HOST = "testnet-explorer.usernodelabs.org";
const EXPLORER_PROD_BASE = "/api";
const EXPLORER_LOCAL_HOST = process.env.LOCAL_EXPLORER_UPSTREAM || "localhost:4173";
const EXPLORER_LOCAL_BASE = process.env.LOCAL_EXPLORER_BASE || "/api";

const EXPLORER_UPSTREAM = LOCAL_DEV ? EXPLORER_LOCAL_HOST : EXPLORER_PROD_HOST;
const EXPLORER_UPSTREAM_BASE = LOCAL_DEV ? EXPLORER_LOCAL_BASE : EXPLORER_PROD_BASE;
const EXPLORER_PROXY_PREFIX = "/explorer-api/";

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

const EXPLORER_USE_HTTP = (() => {
  const host = EXPLORER_UPSTREAM.replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host);
})();

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
          res.writeHead(upRes.statusCode, {
            "content-type": upRes.headers["content-type"] || "application/json",
            "access-control-allow-origin": "*",
          });
          res.end(body);
        });
      }
    );
    upReq.on("error", (err) => {
      send(res, 502, { "content-type": "text/plain" }, `Explorer proxy error: ${err.message}`);
    });
    if (bodyBuf) upReq.write(bodyBuf);
    upReq.end();
  });
}

// ── Stats poller ─────────────────────────────────────────────────────────────
// Background chain poller: caches raw transactions per app pubkey and derives
// stats. Clients fetch GET /api/stats or GET /api/transactions?pubkey=... 
// instead of each independently paginating the explorer.

const statsCache = {};    // { [pubkey]: { users, txns } }
const txCache = {};       // { [pubkey]: Transaction[] }
const seenTxIds = {};     // { [pubkey]: Set }
const lastHeight = {};    // { [pubkey]: number } — for from_height incremental
let statsChainId = null;

// Global usernames address — polled the same way as dapp pubkeys so we can
// derive `username` / `has_set_username` per wallet for /user_activity.
const USERNAMES_PUBKEY =
  process.env.USERNAMES_PUBKEY ||
  "ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az";

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

    // Bound seenTxIds
    if (seenTxIds[pubkey].size > SEEN_CAP) {
      const arr = Array.from(seenTxIds[pubkey]);
      seenTxIds[pubkey] = new Set(arr.slice(arr.length - SEEN_CAP));
    }

    // Derive stats
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
  const all = Array.from(new Set([...pubkeys, USERNAMES_PUBKEY]));
  for (const pk of all) {
    await pollPubkey(pk);
  }
}

// ── /user_activity derivation ────────────────────────────────────────────────
// Walk the per-dapp txCaches plus the usernames txCache and roll them up
// into a per-wallet view. Computed on demand so it's always live.

function deriveUsernamesByWallet() {
  const out = new Map();        // wallet -> latest username
  const latestKey = new Map();  // wallet -> latest ordering key (ts or block)
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

  // wallet -> { byDapp: Map<dappPk, count>, total: number }
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
      if (sender === dapp.pubkey) continue; // skip self-sends (e.g. consolidation)
      const w = ensure(sender);
      w.total += 1;
      w.byDapp.set(dapp.pubkey, (w.byDapp.get(dapp.pubkey) || 0) + 1);
    }
  }

  // Include any wallet that set a username, even if it never sent to a dapp.
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

// Start background polling
(async function startStatsPoller() {
  await pollAllStats();
  setInterval(pollAllStats, STATS_POLL_INTERVAL_MS);
})();

// ── Database (per-user dapp pins) ────────────────────────────────────────────
// The homepage itself is public, but pinning a dapp is a per-user action, so it
// needs the platform's Postgres (DATABASE_URL) + JWT auth (JWT_SECRET). Only the
// /api/pins routes consult auth/DB; every existing route stays public.

let pinsPool = null;   // pg.Pool once initialised
let pinsReady = false; // true after a successful migration

// dapp_pins is marked `staging:private` (see migration COMMENT) because a row
// ties a Usernode identity to the dapps they personally favorite — that's
// owner-only preference data, not public app content. Staging therefore gets
// the table schema-only and must seed its own rows (IS_STAGING block below).
const SEED_PINS = [
  // Obviously-synthetic staging users pinning real dapps from dapps.json so the
  // Pinned section + sorting can be exercised in a staging preview.
  { user_id: "staging-demo-user-1", pubkey: "ut1zkj9p90e0w0hqsnmr70xmzdcvhrj80upajpw67eywszu2g0qknksl3mlms" }, // Opinion Market
  { user_id: "staging-demo-user-1", pubkey: "ut1r96pdaa7h2k4vf62w3w598fyrelv9wru4t53qtgswgfzpsvz77msj588uu" }, // Falling Sands
  { user_id: "staging-demo-user-2", pubkey: "ut1y8t50glzr7gm424yxm0tpkkyr8w5q64933sgd0dm3vzzm9ntwruqjncx05" }, // Last One Wins
];

async function initPinsDb() {
  if (!PgPool) return;
  if (!DATABASE_URL) {
    console.warn("[pins] DATABASE_URL not set — pin features disabled");
    return;
  }
  try {
    pinsPool = new PgPool({ connectionString: DATABASE_URL });
    pinsPool.on("error", (err) => console.warn(`[pins] pool error: ${err.message}`));

    await pinsPool.query(`
      CREATE TABLE IF NOT EXISTS dapp_pins (
        user_id     TEXT        NOT NULL,
        dapp_pubkey TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, dapp_pubkey)
      )
    `);
    await pinsPool.query(
      `CREATE INDEX IF NOT EXISTS dapp_pins_user_id_idx ON dapp_pins (user_id)`
    );
    // staging:private — staging gets structure only, never prod rows.
    await pinsPool.query(`COMMENT ON TABLE dapp_pins IS 'staging:private'`);

    pinsReady = true;
    console.log("[pins] dapp_pins table ready");

    if (IS_STAGING) {
      for (const p of SEED_PINS) {
        await pinsPool.query(
          `INSERT INTO dapp_pins (user_id, dapp_pubkey)
           VALUES ($1, $2)
           ON CONFLICT (user_id, dapp_pubkey) DO NOTHING`,
          [p.user_id, p.pubkey]
        );
      }
      console.log(`[pins] seeded ${SEED_PINS.length} staging demo pin(s)`);
    }
  } catch (e) {
    pinsReady = false;
    console.warn(`[pins] could not initialise database: ${e.message}`);
  }
}

// ── JWT auth (built-in crypto, HS256 only) ───────────────────────────────────
// The platform shell injects a `?token=…` JWT on iframe load; the frontend
// forwards it via the `x-usernode-token` header. We verify HS256 against
// JWT_SECRET without pulling in a `jsonwebtoken` dependency.

function b64urlToBuf(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function verifyJwt(token) {
  if (!token || !JWT_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header;
  try {
    header = JSON.parse(b64urlToBuf(headerB64).toString("utf8"));
  } catch (_) {
    return null;
  }
  if (!header || header.alg !== "HS256") return null;

  const expected = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const got = b64urlToBuf(sigB64);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(b64urlToBuf(payloadB64).toString("utf8"));
  } catch (_) {
    return null;
  }
  // Reject expired tokens (exp is seconds since epoch, per JWT spec).
  if (payload && typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) {
    return null;
  }
  return payload;
}

function getUser(req) {
  const headerTok = req.headers["x-usernode-token"];
  let token = Array.isArray(headerTok) ? headerTok[0] : headerTok;
  if (!token) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      token = u.searchParams.get("token") || "";
    } catch (_) {}
  }
  const payload = verifyJwt(token);
  if (!payload || payload.id == null) return null;
  return payload;
}

function jsonRes(res, status, obj) {
  return send(
    res,
    status,
    { "content-type": "application/json", "cache-control": "no-store" },
    JSON.stringify(obj)
  );
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        resolve(undefined); // signals malformed JSON
      }
    });
    req.on("error", () => resolve(null));
  });
}

async function handlePins(req, res, urlObj) {
  const user = getUser(req);
  if (!user) return jsonRes(res, 401, { error: "auth required" });
  if (!pinsReady) return jsonRes(res, 503, { error: "pins unavailable" });
  const userId = String(user.id);

  try {
    if (req.method === "GET") {
      const { rows } = await pinsPool.query(
        `SELECT dapp_pubkey FROM dapp_pins WHERE user_id = $1`,
        [userId]
      );
      return jsonRes(res, 200, { pins: rows.map((r) => r.dapp_pubkey) });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (body === undefined) return jsonRes(res, 400, { error: "invalid JSON" });
      const pubkey = body && typeof body.pubkey === "string" ? body.pubkey.trim() : "";
      if (!pubkey) return jsonRes(res, 400, { error: "pubkey required" });
      // Only honour pins for dapps we actually list; unknown keys are ignored
      // (still 200 to keep the client simple).
      if (loadPubkeys().includes(pubkey)) {
        await pinsPool.query(
          `INSERT INTO dapp_pins (user_id, dapp_pubkey)
           VALUES ($1, $2)
           ON CONFLICT (user_id, dapp_pubkey) DO NOTHING`,
          [userId, pubkey]
        );
      }
      return jsonRes(res, 200, { pinned: true });
    }

    if (req.method === "DELETE") {
      const pubkey = (urlObj.searchParams.get("pubkey") || "").trim();
      if (!pubkey) return jsonRes(res, 400, { error: "pubkey required" });
      await pinsPool.query(
        `DELETE FROM dapp_pins WHERE user_id = $1 AND dapp_pubkey = $2`,
        [userId, pubkey]
      );
      return jsonRes(res, 200, { pinned: false });
    }

    return jsonRes(res, 405, { error: "method not allowed" });
  } catch (e) {
    console.warn(`[pins] request error: ${e.message}`);
    return jsonRes(res, 500, { error: "internal error" });
  }
}

// Kick off DB init (non-blocking — the homepage serves regardless).
initPinsDb();

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const pathname = (() => {
    try {
      return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
        .pathname;
    } catch (_) {
      return req.url || "/";
    }
  })();

  if (pathname.startsWith(EXPLORER_PROXY_PREFIX)) {
    const subPath = pathname.slice(EXPLORER_PROXY_PREFIX.length);
    return proxyExplorer(req, res, subPath);
  }

  if (pathname === "/api/pins") {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    handlePins(req, res, urlObj);
    return;
  }

  if (pathname === "/api/stats" && (req.method === "GET" || req.method === "HEAD")) {
    const body = JSON.stringify(statsCache);
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      return res.end();
    }
    return send(res, 200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    }, body);
  }

  if (pathname === "/user_activity" && (req.method === "GET" || req.method === "HEAD")) {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const minimal = urlObj.searchParams.get("minimal") === "1";
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
    const body = JSON.stringify(activity);
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      return res.end();
    }
    return send(res, 200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    }, body);
  }

  if (pathname === "/api/transactions" && (req.method === "GET" || req.method === "HEAD")) {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pubkey = (urlObj.searchParams.get("pubkey") || "").trim();
    if (!pubkey) {
      return send(res, 400, { "content-type": "application/json" }, JSON.stringify({ error: "pubkey query param required" }));
    }
    const items = txCache[pubkey] || [];
    const body = JSON.stringify({ items });
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      return res.end();
    }
    return send(res, 200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    }, body);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { "content-type": "text/plain" }, "Method Not Allowed");
  }

  if (pathname === "/dapps.json") {
    return fs.readFile(DAPPS_PATH, (err, buf) => {
      if (err) {
        return send(
          res,
          500,
          { "content-type": "text/plain" },
          `Failed to read dapps.json: ${err.message}\n`
        );
      }

      if (req.method === "HEAD") {
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": buf.length,
          "cache-control": "no-store",
        });
        return res.end();
      }

      return send(
        res,
        200,
        {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
        buf
      );
    });
  }

  fs.readFile(INDEX_PATH, (err, buf) => {
    if (err) {
      return send(
        res,
        500,
        { "content-type": "text/plain" },
        `Failed to read index.html: ${err.message}\n`
      );
    }

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": buf.length,
        "cache-control": "no-store",
      });
      return res.end();
    }

    return send(
      res,
      200,
      {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
      buf
    );
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Serving ${INDEX_PATH}`);
  console.log(`Dapps config: ${DAPPS_PATH}${LOCAL_DEV ? " (local-dev)" : ""}`);
  console.log(`Explorer proxy: ${EXPLORER_USE_HTTP ? "http" : "https"}://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}`);
  console.log(`Stats poller: every ${STATS_POLL_INTERVAL_MS / 1000}s → GET /api/stats, GET /api/transactions?pubkey=..., GET /user_activity`);
  console.log(`Listening on http://localhost:${PORT}`);
});
