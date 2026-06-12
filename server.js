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
const PUBLIC_DIR = path.join(__dirname, "public");
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots");

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
// On-chain submission fee flow. All values are read from process.env with an
// in-code default, mirroring USERNAMES_PUBKEY. The real values are provided by
// the platform from dapp.json secrets at deploy time.
const SUBMISSIONS_PATH = process.env.SUBMISSIONS_JSON_PATH
  ? path.resolve(process.env.SUBMISSIONS_JSON_PATH)
  : path.join(__dirname, "submissions.json");

// Recipient of the submission fee (the Community Fund Reserve — may be a burn
// address). When unset, the submit flow is effectively disabled (no recipient
// to pay), and reconciliation has nothing to poll.
const COMMUNITY_FUND_RESERVE_ADDRESS =
  (process.env.COMMUNITY_FUND_RESERVE_ADDRESS || "").trim();

// Required fee in tokens. A confirmed transfer must carry amount >= this.
const SUBMISSION_FEE = Number(process.env.SUBMISSION_FEE) || 1000;

// How long an unpaid submission stays in `awaiting_payment` before it is swept
// to `expired` (the UI stops polling). A real late payment is still credited.
const SUBMISSION_TTL_HOURS = Number(process.env.SUBMISSION_TTL_HOURS) || 24;

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

// ── Submissions store ─────────────────────────────────────────────────────────
// File-backed (submissions.json) so the app stays zero-dependency / stdlib-only,
// mirroring dapps.json as the file source of truth. Loaded into memory on boot,
// flushed atomically (temp file + rename) on every mutation.

let submissions = [];                 // array of submission records
const consumedTxIds = new Set();      // tx_id -> already credited to a submission

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
  // Re-seed the consumed-tx set so a restart can't double-credit a payment.
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

// A submission is a live duplicate-blocker while it is still awaiting payment or
// already published. Expired records do not block a fresh attempt.
function isLiveSubmission(s) {
  return s && (s.status === "awaiting_payment" || s.status === "published");
}

function submitMemoString(id) {
  return JSON.stringify({ app: SUBMIT_MEMO_APP, type: SUBMIT_MEMO_TYPE, sid: id });
}

// Public-safe view returned to the submitter — a global, per-submission status
// view with no user data beyond what the submitter already supplied.
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
  const extra = [USERNAMES_PUBKEY];
  if (COMMUNITY_FUND_RESERVE_ADDRESS) extra.push(COMMUNITY_FUND_RESERVE_ADDRESS);
  const all = Array.from(new Set([...pubkeys, ...extra]));
  for (const pk of all) {
    await pollPubkey(pk);
  }

  // Credit confirmed submission payments and age out unpaid submissions.
  reconcileSubmissionPayments();
  expireStaleSubmissions();
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

// ── Submission payment reconciliation + auto-publish ──────────────────────────
// Runs each poll tick after the Reserve address has been polled. Scans the
// Reserve's inbound transfers for confirmed payments whose memo `sid` matches a
// submission still awaiting payment (or expired), appends the dapp to dapps.json,
// and marks the record `published`. Confirmation IS publication — no validator.
// Trusts only confirmed chain state — never a client claim of payment.

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
    // Credit a real confirmed payment even if the form already gave up (expired).
    if (sub.status !== "awaiting_payment" && sub.status !== "expired") continue;

    // Publish: append to dapps.json unless the dapp is already listed (race /
    // manual add — idempotent skip). If the write fails (e.g. dapps.json not
    // writable), leave the record unpublished and the tx unconsumed so the next
    // tick retries — the fee is already burned regardless.
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

// Sweep `awaiting_payment` records past their TTL to `expired` so the form stops
// polling. A genuine late payment can still re-credit an expired record.
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

// Append a published submission's dapp entry into dapps.json so the homepage
// shows it and the poller tracks its pubkey on the next tick. Atomic write.
function appendDappToListing(dapp) {
  const raw = fs.readFileSync(DAPPS_PATH, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.apps)) data.apps = data.apps || data.items || [];
  data.apps.push(dapp);
  atomicWriteJson(DAPPS_PATH, data);
}

// True if a url/pubkey is already present in the live listing.
function listingHas(url, pubkey) {
  const dapps = loadDapps(); // {name, pubkey}
  if (pubkey && dapps.some((d) => d.pubkey === pubkey)) return true;
  // loadDapps drops url; re-read raw for a url check.
  try {
    const data = JSON.parse(fs.readFileSync(DAPPS_PATH, "utf8"));
    const apps = data.apps || data.items || [];
    return apps.some((a) => (url && a.url === url) || (pubkey && a.pubkey === pubkey));
  } catch (_) {
    return false;
  }
}

// Start background polling
loadSubmissions();
(async function startStatsPoller() {
  await pollAllStats();
  setInterval(pollAllStats, STATS_POLL_INTERVAL_MS);
})();

// ── HTTP helpers for the submit/review API ───────────────────────────────────

function sendJson(res, statusCode, obj) {
  return send(res, statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  }, JSON.stringify(obj));
}

function readJsonBody(req, limitBytes, cb) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on("data", (c) => {
    if (aborted) return;
    size += c.length;
    if (size > limitBytes) {
      aborted = true;
      cb(new Error("body too large"), null);
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return cb(null, {});
    try { cb(null, JSON.parse(text)); }
    catch (e) { cb(new Error("invalid JSON body"), null); }
  });
  req.on("error", (e) => { if (!aborted) cb(e, null); });
}

const TX_PREFIX = "ut1";

// Validate + normalize an incoming dapp submission. Returns { ok, dapp } or
// { ok:false, error }.
function validateSubmissionInput(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "Missing submission body." };
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const name = str(body.name);
  const description = str(body.description);
  const author = str(body.author);
  const url = str(body.url);
  const pubkey = str(body.pubkey);
  const category = str(body.category);
  const logo = str(body.logo);

  if (!name) return { ok: false, error: "Name is required." };
  if (name.length > 80) return { ok: false, error: "Name is too long (max 80 chars)." };
  if (!url) return { ok: false, error: "URL is required." };
  let parsed;
  try { parsed = new URL(url); } catch (_) { return { ok: false, error: "URL is not valid." }; }
  if (parsed.protocol !== "https:") return { ok: false, error: "URL must start with https://" };
  if (!pubkey) return { ok: false, error: "Dapp pubkey (ut1…) is required." };
  if (!pubkey.startsWith(TX_PREFIX)) return { ok: false, error: "Pubkey must be a Usernode address (starts with ut1)." };
  if (description.length > 280) return { ok: false, error: "Description is too long (max 280 chars)." };
  if (logo && logo.length > 8000) return { ok: false, error: "Logo SVG is too large." };

  const dapp = { name, description, author: author || "unknown", url, pubkey };
  if (category) dapp.category = category;
  if (logo) dapp.logo = logo;
  return { ok: true, dapp };
}

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

  // ── Submit-a-dapp API ──────────────────────────────────────────────────────

  // Public config the form needs to render (fee amount, whether submissions are
  // open). Never exposes the validator token.
  if (pathname === "/api/submit-config" && req.method === "GET") {
    return sendJson(res, 200, {
      enabled: !!COMMUNITY_FUND_RESERVE_ADDRESS,
      fee: SUBMISSION_FEE,
      reserve_address: COMMUNITY_FUND_RESERVE_ADDRESS || null,
    });
  }

  // Create a submission → returns on-chain payment instructions.
  if (pathname === "/api/submissions" && req.method === "POST") {
    if (!COMMUNITY_FUND_RESERVE_ADDRESS) {
      return sendJson(res, 503, { error: "Submissions are not currently open (no Reserve address configured)." });
    }
    return readJsonBody(req, 64 * 1024, (err, body) => {
      if (err) return sendJson(res, 400, { error: err.message });
      const v = validateSubmissionInput(body);
      if (!v.ok) return sendJson(res, 400, { error: v.error });

      // Pre-payment duplicate gate — block before the user spends tokens.
      if (listingHas(v.dapp.url, v.dapp.pubkey)) {
        return sendJson(res, 409, { error: "A dapp with this URL or pubkey is already listed." });
      }
      const dupe = submissions.find(
        (s) => isLiveSubmission(s) && s.dapp &&
          (s.dapp.url === v.dapp.url || s.dapp.pubkey === v.dapp.pubkey)
      );
      if (dupe) {
        return sendJson(res, 409, { error: "A submission for this URL or pubkey is already in progress." });
      }

      const now = Date.now();
      const id = crypto.randomUUID();
      const record = {
        id,
        status: "awaiting_payment",
        dapp: v.dapp,
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
      return sendJson(res, 201, {
        id,
        pay_to: COMMUNITY_FUND_RESERVE_ADDRESS,
        amount: SUBMISSION_FEE,
        memo: submitMemoString(id),
        status: record.status,
        expires_at: record.expires_at,
      });
    });
  }

  // Per-submission status poll (public). /api/submissions/:id
  if (pathname.startsWith("/api/submissions/") && req.method === "GET") {
    const id = decodeURIComponent(pathname.slice("/api/submissions/".length));
    const sub = findSubmission(id);
    if (!sub) return sendJson(res, 404, { error: "Submission not found." });
    return sendJson(res, 200, publicSubmissionView(sub));
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { "content-type": "text/plain" }, "Method Not Allowed");
  }

  // Static screenshot assets committed under public/screenshots/. Served here
  // (before the index.html catch-all) so image requests resolve to real files
  // instead of falling through to the SPA shell. A 404 lets the preview
  // modal's per-image onerror handler hide thumbnails whose file isn't present.
  if (pathname.startsWith("/screenshots/")) {
    let rel;
    try {
      rel = decodeURIComponent(pathname.slice("/screenshots/".length));
    } catch (_) {
      return send(res, 400, { "content-type": "text/plain" }, "Bad Request");
    }
    // Resolve and confirm the target stays within SCREENSHOTS_DIR (no traversal).
    const filePath = path.resolve(SCREENSHOTS_DIR, rel);
    const rootWithSep = SCREENSHOTS_DIR + path.sep;
    if (filePath !== SCREENSHOTS_DIR && !filePath.startsWith(rootWithSep)) {
      return send(res, 403, { "content-type": "text/plain" }, "Forbidden");
    }
    const ext = path.extname(filePath).toLowerCase();
    const ctype = STATIC_CONTENT_TYPES[ext];
    if (!ctype) {
      return send(res, 404, { "content-type": "text/plain" }, "Not Found");
    }
    return fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        return send(res, 404, { "content-type": "text/plain" }, "Not Found");
      }
      const headers = {
        "content-type": ctype,
        "content-length": stat.size,
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
      };
      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      fs.createReadStream(filePath)
        .on("error", () => {
          if (!res.headersSent) {
            send(res, 500, { "content-type": "text/plain" }, "Read error");
          } else {
            res.destroy();
          }
        })
        .pipe(res);
    });
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
