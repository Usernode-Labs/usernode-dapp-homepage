#!/usr/bin/env node
/**
 * Minimal Node server to host index.html on http://localhost:8000
 *
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

// Optional Postgres driver — used by the micro-blog feed and per-user dapp pins.
// Wrapped so a standalone checkout without `npm install` (or a deploy with no DB)
// still boots the public homepage; pg-backed features degrade to 503.
let PgPool = null;
try {
  PgPool = require("pg").Pool;
} catch (_) {
  console.warn("[pg] module not available — feed and pin features disabled");
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
// Platform staging flag — gates the obviously-fake seed fixtures below. A strict
// no-op in production (USERNODE_ENV=production) and in local/standalone runs.
const IS_STAGING = process.env.USERNODE_ENV === "staging";
const PORT = Number(process.env.PORT) || 8000;
const INDEX_PATH = path.join(__dirname, "index.html");
const PUBLIC_DIR = path.join(__dirname, "public");
const SCREENSHOTS_DIR = path.join(PUBLIC_DIR, "screenshots");
const MINECRAFT_PATH = path.join(PUBLIC_DIR, "minecraft.html");
const TRIVIA_PATH = path.join(PUBLIC_DIR, "trivia.html");
const STUMBLE_PATH = path.join(PUBLIC_DIR, "stumble.html");

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

const JWT_SECRET = process.env.JWT_SECRET || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

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

// ── Micro-blog feed config ────────────────────────────────────────────────────
// Consumes JWT_SECRET and DATABASE_URL (declared above). When DATABASE_URL is
// absent the feed degrades to an "unavailable" state and every existing public
// surface keeps working unchanged.
const POINTS_PER_POST = Number(process.env.POINTS_PER_POST) || 5;
const POINTS_PER_LIKE = Number(process.env.POINTS_PER_LIKE) || 1;
const POINTS_PER_TOKEN = Number(process.env.POINTS_PER_TOKEN) || 10;
const MICROBLOG_MAX_POST_LEN = Number(process.env.MICROBLOG_MAX_POST_LEN) || 280;

const pgPool = (PgPool && process.env.DATABASE_URL)
  ? new PgPool({ connectionString: process.env.DATABASE_URL })
  : null;
const MICROBLOG_ENABLED = !!pgPool;
// Stumble game high-score leaderboard (Postgres-backed, public reads, auth
// writes). Shares the same DATABASE_URL gating as the micro-blog feed.
const STUMBLE_ENABLED = !!pgPool;
const STUMBLE_LEADERBOARD_LIMIT = Number(process.env.STUMBLE_LEADERBOARD_LIMIT) || 10;
const STUMBLE_MAX_SCORE = Number(process.env.STUMBLE_MAX_SCORE) || 10000000;
if (pgPool) {
  // A pool-level error (dropped backend connection, etc.) must not crash the
  // process — log and let the next query re-establish.
  pgPool.on("error", (e) => console.warn(`[microblog] pg pool error: ${e.message}`));
}

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
      // Log the technical detail server-side; return a generic body so the
      // upstream error text never leaks to the client.
      console.warn(`[explorer-proxy] upstream error: ${err.message}`);
      send(res, 502, { "content-type": "text/plain" }, "Upstream explorer unavailable");
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
let submissionsVersion = 0;           // document-level version of submissions.json
const consumedTxIds = new Set();      // tx_id -> already credited to a submission

const SUBMIT_MEMO_APP = "dapp-homepage";
const SUBMIT_MEMO_TYPE = "submit";

function atomicWriteJson(targetPath, value) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, "." + path.basename(targetPath) + ".tmp-" + crypto.randomBytes(6).toString("hex"));
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, targetPath);
}

// ── Optimistic concurrency control (compare-and-swap on file documents) ────────
// Re-reads `targetPath`, compares its document `version` to `expectedVersion`.
//   • match    → runs mutate(doc) (edits doc in place), bumps `version`, stamps
//                `updated_at`, atomic-writes, returns { ok:true, version }.
//   • mismatch → does NOT write; returns { ok:false, conflict:true, current, version }.
// A missing/legacy `version` is treated as 0 so legacy files normalize cleanly.
function casWriteJson(targetPath, expectedVersion, mutate) {
  const raw = fs.readFileSync(targetPath, "utf8");
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${path.basename(targetPath)} is not a JSON object document`);
  }
  const currentVersion = typeof doc.version === "number" ? doc.version : 0;
  if (currentVersion !== expectedVersion) {
    return { ok: false, conflict: true, current: doc, version: currentVersion };
  }
  mutate(doc);
  doc.version = currentVersion + 1;
  doc.updated_at = Date.now();
  atomicWriteJson(targetPath, doc);
  return { ok: true, version: doc.version };
}

// Parse submissions.json supporting BOTH the legacy bare-array form and the
// wrapped { version, updated_at, submissions:[] } form. Returns normalized
// { submissions, version }.
function parseSubmissionsDoc(data) {
  if (Array.isArray(data)) return { submissions: data, version: 0 };
  if (data && Array.isArray(data.submissions)) {
    return { submissions: data.submissions, version: typeof data.version === "number" ? data.version : 0 };
  }
  return { submissions: [], version: 0 };
}

function loadSubmissions() {
  try {
    if (!fs.existsSync(SUBMISSIONS_PATH)) {
      submissions = [];
      submissionsVersion = 0;
      consumedTxIds.clear();
      return;
    }
    const raw = fs.readFileSync(SUBMISSIONS_PATH, "utf8");
    const parsed = parseSubmissionsDoc(JSON.parse(raw));
    submissions = parsed.submissions;
    submissionsVersion = parsed.version;
  } catch (e) {
    console.warn(`[submit] could not read submissions.json: ${e.message}`);
    submissions = [];
    submissionsVersion = 0;
  }
  // Re-seed the consumed-tx set so a restart can't double-credit a payment.
  consumedTxIds.clear();
  for (const s of submissions) {
    if (s && s.payment_tx_hash) consumedTxIds.add(s.payment_tx_hash);
  }
}

// Bump a record's revision + timestamp on every server-side mutation.
function touchSubmission(s) {
  if (!s) return s;
  s.rev = (typeof s.rev === "number" ? s.rev : 0) + 1;
  s.updated_at = Date.now();
  return s;
}

// Persist the in-memory submissions. Re-reads the on-disk document first and
// merges by `id` (higher `rev` wins; in-memory wins ties) so a co-resident
// writer's records are preserved rather than clobbered, then bumps the document
// version. Single-process behavior is unchanged (nothing else writes the file).
// Always writes the wrapped { version, updated_at, submissions } form, which
// also migrates a legacy bare-array file on its first mutation.
function saveSubmissions() {
  try {
    let onDisk = [];
    let onDiskVersion = submissionsVersion;
    try {
      if (fs.existsSync(SUBMISSIONS_PATH)) {
        const parsed = parseSubmissionsDoc(JSON.parse(fs.readFileSync(SUBMISSIONS_PATH, "utf8")));
        onDisk = parsed.submissions;
        onDiskVersion = parsed.version;
      }
    } catch (_) { /* unreadable/corrupt on disk — fall back to in-memory only */ }

    const byId = new Map();
    for (const s of onDisk) if (s && s.id) byId.set(s.id, s);
    for (const s of submissions) {
      if (!s || !s.id) continue;
      const existing = byId.get(s.id);
      if (!existing || (s.rev || 0) >= (existing.rev || 0)) byId.set(s.id, s);
    }
    const merged = Array.from(byId.values());
    submissions = merged;
    submissionsVersion = Math.max(submissionsVersion, onDiskVersion) + 1;
    atomicWriteJson(SUBMISSIONS_PATH, {
      version: submissionsVersion,
      updated_at: Date.now(),
      submissions: merged,
    });
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
    touchSubmission(sub);
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
      touchSubmission(s);
      dirty = true;
    }
  }
  if (dirty) saveSubmissions();
}

// Read dapps.json as a normalized document: ensures `apps` is an array and a
// numeric `version` (legacy/missing → 0). Throws on read/parse failure.
function readDappsDoc() {
  const data = JSON.parse(fs.readFileSync(DAPPS_PATH, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("dapps.json is not a JSON object document");
  }
  if (!Array.isArray(data.apps)) data.apps = data.items || [];
  if (typeof data.version !== "number") data.version = 0;
  return data;
}

// Current document version of dapps.json (0 if unreadable/legacy).
function dappsVersion() {
  try { return readDappsDoc().version; } catch (_) { return 0; }
}

function listingRowMatches(a, url, pubkey) {
  return Boolean((url && a.url === url) || (pubkey && a.pubkey === pubkey));
}

// The full listing row matching a url/pubkey, or null. Rows are all public data.
function findListingRow(url, pubkey) {
  try {
    return readDappsDoc().apps.find((a) => listingRowMatches(a, url, pubkey)) || null;
  } catch (_) {
    return null;
  }
}

// Trim a listing row to the fields the conflict UI needs. Everything on a dapp
// row is public anyway; this just keeps the response small and predictable.
function publicListingRow(a) {
  if (!a || typeof a !== "object") return null;
  return {
    name: a.name || "(unnamed)",
    description: a.description || "",
    author: a.author || "unknown",
    url: a.url || "",
    pubkey: a.pubkey || "",
    category: a.category || null,
    logo: a.logo || null,
  };
}

// Append a published submission's dapp entry into dapps.json so the homepage
// shows it and the poller tracks its pubkey on the next tick. Conflict-aware:
// compare-and-swap on the document version, with bounded retry so a concurrent
// rewrite (deploy / git merge / co-resident writer) cannot silently clobber the
// row. Idempotent when the url/pubkey is already present (no write). Throws only
// if it cannot converge after MAX_ATTEMPTS — callers leave the tx unconsumed and
// retry on the next poll tick.
function appendDappToListing(dapp) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const doc = readDappsDoc();
    if (doc.apps.some((a) => listingRowMatches(a, dapp.url, dapp.pubkey))) {
      return; // already applied — idempotent
    }
    const res = casWriteJson(DAPPS_PATH, doc.version, (d) => { d.apps.push(dapp); });
    if (res.ok) return;
    // Version moved under us → reload and reapply on the fresh document.
  }
  throw new Error("dapps.json changed concurrently; giving up after retries (will retry next tick)");
}

// True if a url/pubkey is already present in the live listing.
function listingHas(url, pubkey) {
  return findListingRow(url, pubkey) != null;
}

// ── Staging seed fixtures ──────────────────────────────────────────────────────
// Obviously-fake, idempotent rows so the conflict UI + reconciliation can be
// exercised on a staging preview without real on-chain payments. A strict no-op
// outside staging (gated on USERNODE_ENV=staging via IS_STAGING).
const STAGING_LISTED_URL = "https://staging-demo-listed.example.com";
const STAGING_LISTED_PUBKEY = "ut1stagingdemolisted0000000000000000000000000000000000000000";
const STAGING_INPROGRESS_URL = "https://staging-demo-inprogress.example.com";
const STAGING_INPROGRESS_PUBKEY = "ut1stagingdemoinprogress00000000000000000000000000000000000000";

function seedStagingFixtures() {
  if (!IS_STAGING) return;
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;

  // Seed submissions (wrapped form, per-record rev) — one per status. Idempotent
  // by fixed id. The published one mirrors the listed dapps.json row below.
  const seeds = [
    {
      id: "staging-demo-awaiting",
      status: "awaiting_payment",
      rev: 1,
      dapp: {
        name: "Staging Demo In-Progress Dapp",
        description: "Staging demo — a submission still awaiting payment.",
        author: "staging-demo-user",
        url: STAGING_INPROGRESS_URL,
        pubkey: STAGING_INPROGRESS_PUBKEY,
        category: "Utility",
      },
      payer: null, payment_tx_hash: null, paid_amount: null,
      fee_recipient: COMMUNITY_FUND_RESERVE_ADDRESS || STAGING_LISTED_PUBKEY,
      created_at: now, updated_at: now, expires_at: now + DAY, published_at: null,
    },
    {
      id: "staging-demo-published",
      status: "published",
      rev: 2,
      dapp: {
        name: "Staging Demo Listed Dapp",
        description: "Staging demo — already published and live on the homepage.",
        author: "staging-demo-user",
        url: STAGING_LISTED_URL,
        pubkey: STAGING_LISTED_PUBKEY,
        category: "Game",
      },
      payer: "ut1stagingdemopayer000000000000000000000000000000000000000000",
      payment_tx_hash: "staging-demo-tx-published",
      paid_amount: SUBMISSION_FEE,
      fee_recipient: COMMUNITY_FUND_RESERVE_ADDRESS || STAGING_LISTED_PUBKEY,
      created_at: now - DAY, updated_at: now, expires_at: now - DAY + DAY, published_at: now,
    },
    {
      id: "staging-demo-expired",
      status: "expired",
      rev: 2,
      dapp: {
        name: "Staging Demo Expired Dapp",
        description: "Staging demo — a submission that expired unpaid.",
        author: "staging-demo-user",
        url: "https://staging-demo-expired.example.com",
        pubkey: "ut1stagingdemoexpired00000000000000000000000000000000000000000",
        category: "Utility",
      },
      payer: null, payment_tx_hash: null, paid_amount: null,
      fee_recipient: COMMUNITY_FUND_RESERVE_ADDRESS || STAGING_LISTED_PUBKEY,
      created_at: now - 2 * DAY, updated_at: now, expires_at: now - DAY, published_at: null,
    },
  ];
  let seededSubs = false;
  for (const seed of seeds) {
    if (!submissions.some((s) => s && s.id === seed.id)) {
      submissions.push(seed);
      seededSubs = true;
    }
  }
  if (seededSubs) saveSubmissions();

  // Seed the matching listed row in dapps.json so submitting STAGING_LISTED_URL
  // deterministically reproduces the already_listed 409. Version-aware append.
  try {
    if (!listingHas(STAGING_LISTED_URL, STAGING_LISTED_PUBKEY)) {
      appendDappToListing({
        name: "Staging Demo Listed Dapp",
        description: "Staging demo — already on the homepage (used to demo the conflict flow).",
        author: "staging-demo-user",
        url: STAGING_LISTED_URL,
        pubkey: STAGING_LISTED_PUBKEY,
        category: "Game",
      });
    }
  } catch (e) {
    console.warn(`[staging] could not seed listed dapp: ${e.message}`);
  }
  console.log("[staging] seeded demo submissions + listed dapp for conflict testing");
}

// Start background polling
function startBackground() {
  loadSubmissions();
  seedStagingFixtures();
  (async function startStatsPoller() {
    await pollAllStats();
    setInterval(pollAllStats, STATS_POLL_INTERVAL_MS);
  })();
}

// Bring up the micro-blog schema (and staging seed) if a database is configured.
if (pgPool) {
  microblogBootstrap()
    .then(() => console.log(`[microblog] schema ready${IS_STAGING ? " (staging seed on)" : ""}`))
    .catch((e) => console.warn(`[microblog] bootstrap failed: ${e.message}`));
  stumbleBootstrap()
    .then(() => console.log(`[stumble] schema ready${IS_STAGING ? " (staging seed on)" : ""}`))
    .catch((e) => console.warn(`[stumble] bootstrap failed: ${e.message}`));
} else {
  console.log("[microblog] DATABASE_URL not set — feed disabled (homepage unaffected)");
}

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
  const displayName = str(body.displayName);
  const description = str(body.description);
  const author = str(body.author);
  const url = str(body.url);
  const pubkey = str(body.pubkey);
  const category = str(body.category);
  const logo = str(body.logo);

  if (!name) return { ok: false, error: "Name is required." };
  if (name.length > 80) return { ok: false, error: "Name is too long (max 80 chars)." };
  if (displayName.length > 80) return { ok: false, error: "Display name is too long (max 80 chars)." };
  if (!url) return { ok: false, error: "URL is required." };
  let parsed;
  try { parsed = new URL(url); } catch (_) { return { ok: false, error: "URL is not valid." }; }
  if (parsed.protocol !== "https:") return { ok: false, error: "URL must start with https://" };
  if (!pubkey) return { ok: false, error: "Dapp pubkey (ut1…) is required." };
  if (!pubkey.startsWith(TX_PREFIX)) return { ok: false, error: "Pubkey must be a Usernode address (starts with ut1)." };
  if (description.length > 280) return { ok: false, error: "Description is too long (max 280 chars)." };
  if (logo && logo.length > 8000) return { ok: false, error: "Logo SVG is too large." };

  const dapp = { name, description, author: author || "unknown", url, pubkey };
  if (displayName) dapp.displayName = displayName;
  if (category) dapp.category = category;
  if (logo) dapp.logo = logo;
  return { ok: true, dapp };
}
// Resolve the authenticated user for micro-blog routes from ?token= or the
// x-usernode-token header. Returns { id, username, usernode_pubkey } or null.
function userFromReq(req, urlObj) {
  const token =
    (urlObj && urlObj.searchParams.get("token")) ||
    req.headers["x-usernode-token"] ||
    "";
  const payload = verifyJwt(token);
  if (!payload) return null;
  const id = payload.id != null ? payload.id : (payload.sub != null ? payload.sub : null);
  if (id == null) return null;
  const username =
    payload.username || payload.name || payload.preferred_username || `user_${String(id).slice(0, 8)}`;
  return { id: String(id), username: String(username), usernode_pubkey: payload.usernode_pubkey || null };
}

// ── Micro-blog schema bootstrap + staging seed ───────────────────────────────
// Idempotent on every boot (CREATE TABLE IF NOT EXISTS). microblog_conversions
// is the only private table — it's the convertible-token ledger (financial data)
// so it is copied schema-only to staging and seeded here under IS_STAGING.

async function microblogBootstrap() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS microblog_posts (
      id BIGSERIAL PRIMARY KEY,
      author_user_id TEXT NOT NULL,
      author_username TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS microblog_likes (
      id BIGSERIAL PRIMARY KEY,
      post_id BIGINT NOT NULL REFERENCES microblog_posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (post_id, user_id)
    )`);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS microblog_points (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      points_earned BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS microblog_conversions (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      points_spent BIGINT NOT NULL,
      tokens_credited BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // Financial / convertible-balance ledger → private (schema-only to staging).
  await pgPool.query(`COMMENT ON TABLE microblog_conversions IS 'staging:private'`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS microblog_posts_id_desc_idx ON microblog_posts (id DESC)`);
  if (IS_STAGING) await microblogSeedStaging();
}

// Seed a small, obviously-fake demo dataset so the feed, leaderboard, like
// counts and balances render in a staging preview. Idempotent (fixed ids +
// ON CONFLICT DO NOTHING); a strict no-op outside staging (guarded by caller).
async function microblogSeedStaging() {
  const authors = [
    { id: "staging-demo-alice", points: 28 },
    { id: "staging-demo-bob", points: 19 },
    { id: "staging-demo-carol", points: 17 },
    { id: "staging-demo-dave", points: 11 },
  ];
  // [fixed id, author id, body, age-ago interval]
  const posts = [
    [900001, "staging-demo-alice", "Staging demo: just shipped my first dapp on Usernode 🎉", "3 days"],
    [900002, "staging-demo-bob", "Staging demo: gm builders, who's hacking this weekend?", "2 days 6 hours"],
    [900003, "staging-demo-carol", "Staging demo: the new sort menu on the homepage is so clean", "2 days"],
    [900004, "staging-demo-alice", "Staging demo: points for posting? I'm farming the leaderboard 😄", "30 hours"],
    [900005, "staging-demo-dave", "Staging demo: first post here. hello feed!", "26 hours"],
    [900006, "staging-demo-bob", "Staging demo: converted my points to tokens, felt great", "20 hours"],
    [900007, "staging-demo-carol", "Staging demo: anyone tried Falling Sands? wild physics", "14 hours"],
    [900008, "staging-demo-alice", "Staging demo: liking good posts is the whole vibe", "8 hours"],
    [900009, "staging-demo-dave", "Staging demo: leaderboard szn ☀️", "5 hours"],
    [900010, "staging-demo-bob", "Staging demo: short and sweet. that's microblogging.", "2 hours"],
    [900011, "staging-demo-carol", "Staging demo: building in public on Usernode 🛠️", "40 minutes"],
  ];
  // Likes among demo users → non-uniform counts for an interesting leaderboard.
  const likes = [
    [900001, "staging-demo-bob"], [900001, "staging-demo-carol"], [900001, "staging-demo-dave"],
    [900002, "staging-demo-alice"], [900002, "staging-demo-carol"],
    [900003, "staging-demo-alice"], [900003, "staging-demo-bob"], [900003, "staging-demo-dave"],
    [900004, "staging-demo-bob"], [900004, "staging-demo-carol"], [900004, "staging-demo-dave"],
    [900006, "staging-demo-alice"],
    [900007, "staging-demo-alice"], [900007, "staging-demo-bob"],
    [900008, "staging-demo-carol"], [900008, "staging-demo-dave"],
    [900010, "staging-demo-alice"], [900010, "staging-demo-carol"],
  ];
  try {
    for (const a of authors) {
      await pgPool.query(
        `INSERT INTO microblog_points (user_id, username, points_earned)
         VALUES ($1, $1, $2) ON CONFLICT (user_id) DO NOTHING`,
        [a.id, a.points]
      );
    }
    for (const [id, author, body, ago] of posts) {
      await pgPool.query(
        `INSERT INTO microblog_posts (id, author_user_id, author_username, body, created_at)
         VALUES ($1, $2, $2, $3, now() - ($4)::interval) ON CONFLICT (id) DO NOTHING`,
        [id, author, body, ago]
      );
    }
    for (const [pid, uid] of likes) {
      await pgPool.query(
        `INSERT INTO microblog_likes (post_id, user_id) VALUES ($1, $2)
         ON CONFLICT (post_id, user_id) DO NOTHING`,
        [pid, uid]
      );
    }
    // Private ledger row: alice converted 20 points → 2 tokens (rate default 10),
    // so her available points show as 8 and token balance as 2 in staging.
    await pgPool.query(
      `INSERT INTO microblog_conversions (id, user_id, username, points_spent, tokens_credited)
       VALUES (900001, 'staging-demo-alice', 'staging-demo-alice', 20, 2)
       ON CONFLICT (id) DO NOTHING`
    );
    // Advance the serial sequences past our fixed demo ids so real inserts don't collide.
    await pgPool.query(
      `SELECT setval(pg_get_serial_sequence('microblog_posts', 'id'),
        GREATEST((SELECT MAX(id) FROM microblog_posts), 1))`
    );
    await pgPool.query(
      `SELECT setval(pg_get_serial_sequence('microblog_conversions', 'id'),
        GREATEST((SELECT MAX(id) FROM microblog_conversions), 1))`
    );
    console.log("[microblog] staging seed applied");
  } catch (e) {
    console.warn(`[microblog] staging seed failed: ${e.message}`);
  }
}

// ── Micro-blog API ───────────────────────────────────────────────────────────
// GET  /api/microblog/feed         — public (reverse-chron posts + like counts)
// GET  /api/microblog/leaderboard  — public (top users by points earned)
// GET  /api/microblog/me           — auth (caller's points/token balances)
// POST /api/microblog/posts        — auth (create post, +POINTS_PER_POST)
// POST|DELETE /api/microblog/posts/:id/like — auth (toggle like; author earns)
// POST /api/microblog/convert      — auth (simulated points → token conversion)

function microblogRouter(req, res, pathname, urlObj) {
  if (!MICROBLOG_ENABLED) {
    return sendJson(res, 503, { error: "The feed is not available in this environment." });
  }
  const user = userFromReq(req, urlObj);
  const method = req.method;

  const run = (fn) => Promise.resolve()
    .then(fn)
    .catch((e) => {
      console.warn(`[microblog] ${method} ${pathname}: ${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error." });
    });

  if (pathname === "/api/microblog/feed" && method === "GET") {
    return run(() => mbFeed(res, urlObj, user));
  }
  if (pathname === "/api/microblog/leaderboard" && method === "GET") {
    return run(() => mbLeaderboard(res, urlObj));
  }
  if (pathname === "/api/microblog/me" && method === "GET") {
    if (!user) return sendJson(res, 401, { error: "Not authenticated" });
    return run(() => mbMe(res, user));
  }
  if (pathname === "/api/microblog/posts" && method === "POST") {
    if (!user) return sendJson(res, 401, { error: "Not authenticated" });
    return mbCreatePost(req, res, user);
  }
  const likeMatch = pathname.match(/^\/api\/microblog\/posts\/(\d+)\/like$/);
  if (likeMatch && (method === "POST" || method === "DELETE")) {
    if (!user) return sendJson(res, 401, { error: "Not authenticated" });
    return run(() => mbLike(res, Number(likeMatch[1]), user, method === "POST"));
  }
  if (pathname === "/api/microblog/convert" && method === "POST") {
    if (!user) return sendJson(res, 401, { error: "Not authenticated" });
    return mbConvert(req, res, user);
  }
  return sendJson(res, 404, { error: "Not found" });
}

async function mbFeed(res, urlObj, user) {
  const limit = Math.min(Math.max(parseInt(urlObj.searchParams.get("limit"), 10) || 30, 1), 100);
  const before = parseInt(urlObj.searchParams.get("before"), 10);
  const meId = user ? user.id : null;

  const params = [];
  const conds = [];
  if (Number.isFinite(before)) { params.push(before); conds.push(`p.id < $${params.length}`); }
  let likedExpr = "false";
  if (meId) {
    params.push(meId);
    likedExpr = `EXISTS(SELECT 1 FROM microblog_likes l2 WHERE l2.post_id = p.id AND l2.user_id = $${params.length})`;
  }
  params.push(limit);
  const limitIdx = params.length;
  const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const q = `
    SELECT p.id, p.author_username, p.author_user_id, p.body, p.created_at,
      (SELECT COUNT(*) FROM microblog_likes l WHERE l.post_id = p.id)::int AS like_count,
      ${likedExpr} AS liked_by_me
    FROM microblog_posts p
    ${whereSql}
    ORDER BY p.id DESC
    LIMIT $${limitIdx}`;
  const { rows } = await pgPool.query(q, params);
  const posts = rows.map((r) => ({
    id: String(r.id),
    author: r.author_username,
    author_user_id: r.author_user_id,
    body: r.body,
    created_at: r.created_at,
    like_count: r.like_count,
    liked_by_me: r.liked_by_me,
    mine: meId != null && r.author_user_id === meId,
  }));
  return sendJson(res, 200, {
    posts,
    signed_in: !!user,
    staging: IS_STAGING,
    max_len: MICROBLOG_MAX_POST_LEN,
  });
}

async function mbLeaderboard(res, urlObj) {
  const limit = Math.min(Math.max(parseInt(urlObj.searchParams.get("limit"), 10) || 10, 1), 50);
  const { rows } = await pgPool.query(
    `SELECT username, points_earned::int AS points FROM microblog_points
     WHERE points_earned > 0 ORDER BY points_earned DESC, username ASC LIMIT $1`,
    [limit]
  );
  return sendJson(res, 200, { leaders: rows, staging: IS_STAGING });
}

async function mbMe(res, user) {
  const pr = await pgPool.query(`SELECT points_earned::int AS earned FROM microblog_points WHERE user_id = $1`, [user.id]);
  const earned = pr.rows.length ? pr.rows[0].earned : 0;
  const cr = await pgPool.query(
    `SELECT COALESCE(SUM(points_spent), 0)::int AS spent,
            COALESCE(SUM(tokens_credited), 0)::int AS tokens
     FROM microblog_conversions WHERE user_id = $1`,
    [user.id]
  );
  const pc = await pgPool.query(`SELECT COUNT(*)::int AS c FROM microblog_posts WHERE author_user_id = $1`, [user.id]);
  return sendJson(res, 200, {
    username: user.username,
    points_earned: earned,
    points_available: earned - cr.rows[0].spent,
    token_balance: cr.rows[0].tokens,
    post_count: pc.rows[0].c,
    rate: POINTS_PER_TOKEN,
    points_per_post: POINTS_PER_POST,
    points_per_like: POINTS_PER_LIKE,
    staging: IS_STAGING,
  });
}

function mbCreatePost(req, res, user) {
  return readJsonBody(req, 64 * 1024, (err, body) => {
    if (err) return sendJson(res, 400, { error: err.message });
    const text = body && typeof body.body === "string" ? body.body.trim() : "";
    if (!text) return sendJson(res, 400, { error: "Post cannot be empty." });
    if (text.length > MICROBLOG_MAX_POST_LEN) {
      return sendJson(res, 400, { error: `Post is too long (max ${MICROBLOG_MAX_POST_LEN} characters).` });
    }
    (async () => {
      const client = await pgPool.connect();
      try {
        await client.query("BEGIN");
        const ins = await client.query(
          `INSERT INTO microblog_posts (author_user_id, author_username, body)
           VALUES ($1, $2, $3) RETURNING id, created_at`,
          [user.id, user.username, text]
        );
        await client.query(
          `INSERT INTO microblog_points (user_id, username, points_earned, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (user_id) DO UPDATE
             SET points_earned = microblog_points.points_earned + $3,
                 username = $2, updated_at = now()`,
          [user.id, user.username, POINTS_PER_POST]
        );
        await client.query("COMMIT");
        const row = ins.rows[0];
        return sendJson(res, 201, {
          id: String(row.id),
          author: user.username,
          author_user_id: user.id,
          body: text,
          created_at: row.created_at,
          like_count: 0,
          liked_by_me: false,
          mine: true,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.warn(`[microblog] create post: ${e.message}`);
        return sendJson(res, 500, { error: "Could not create post." });
      } finally {
        client.release();
      }
    })();
  });
}

async function mbLike(res, postId, user, isLike) {
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const pr = await client.query(
      `SELECT author_user_id, author_username FROM microblog_posts WHERE id = $1`,
      [postId]
    );
    if (!pr.rows.length) {
      await client.query("ROLLBACK");
      return sendJson(res, 404, { error: "Post not found." });
    }
    const authorId = pr.rows[0].author_user_id;
    const authorName = pr.rows[0].author_username;
    let changed = false;

    if (isLike) {
      const r = await client.query(
        `INSERT INTO microblog_likes (post_id, user_id) VALUES ($1, $2)
         ON CONFLICT (post_id, user_id) DO NOTHING`,
        [postId, user.id]
      );
      changed = r.rowCount > 0;
      // Self-likes are allowed but award no points (anti points-farming).
      if (changed && authorId !== user.id) {
        await client.query(
          `INSERT INTO microblog_points (user_id, username, points_earned, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (user_id) DO UPDATE
             SET points_earned = microblog_points.points_earned + $3, updated_at = now()`,
          [authorId, authorName, POINTS_PER_LIKE]
        );
      }
    } else {
      const r = await client.query(
        `DELETE FROM microblog_likes WHERE post_id = $1 AND user_id = $2`,
        [postId, user.id]
      );
      changed = r.rowCount > 0;
      if (changed && authorId !== user.id) {
        await client.query(
          `UPDATE microblog_points
             SET points_earned = GREATEST(points_earned - $2, 0), updated_at = now()
           WHERE user_id = $1`,
          [authorId, POINTS_PER_LIKE]
        );
      }
    }
    const cnt = await client.query(`SELECT COUNT(*)::int AS c FROM microblog_likes WHERE post_id = $1`, [postId]);
    await client.query("COMMIT");
    return sendJson(res, 200, { liked: isLike, like_count: cnt.rows[0].c, changed });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.warn(`[microblog] like: ${e.message}`);
    return sendJson(res, 500, { error: "Could not update like." });
  } finally {
    client.release();
  }
}

function mbConvert(req, res, user) {
  return readJsonBody(req, 16 * 1024, (err, body) => {
    if (err) return sendJson(res, 400, { error: err.message });
    const points = Number(body && body.points);
    if (!Number.isInteger(points) || points <= 0) {
      return sendJson(res, 400, { error: "Enter a positive whole number of points." });
    }
    (async () => {
      const client = await pgPool.connect();
      try {
        await client.query("BEGIN");
        // Lock the user's points row so two tabs can't double-spend the same points.
        const pr = await client.query(
          `SELECT points_earned::int AS earned FROM microblog_points WHERE user_id = $1 FOR UPDATE`,
          [user.id]
        );
        const earned = pr.rows.length ? pr.rows[0].earned : 0;
        const sr = await client.query(
          `SELECT COALESCE(SUM(points_spent), 0)::int AS spent FROM microblog_conversions WHERE user_id = $1`,
          [user.id]
        );
        const available = earned - sr.rows[0].spent;
        const tokens = Math.floor(points / POINTS_PER_TOKEN);
        if (tokens < 1) {
          await client.query("ROLLBACK");
          return sendJson(res, 400, { error: `You need at least ${POINTS_PER_TOKEN} points to get 1 token.` });
        }
        const spend = tokens * POINTS_PER_TOKEN;
        if (spend > available) {
          await client.query("ROLLBACK");
          return sendJson(res, 400, { error: "Not enough points available to convert." });
        }
        await client.query(
          `INSERT INTO microblog_conversions (user_id, username, points_spent, tokens_credited)
           VALUES ($1, $2, $3, $4)`,
          [user.id, user.username, spend, tokens]
        );
        const tot = await client.query(
          `SELECT COALESCE(SUM(points_spent), 0)::int AS spent,
                  COALESCE(SUM(tokens_credited), 0)::int AS tokens
           FROM microblog_conversions WHERE user_id = $1`,
          [user.id]
        );
        await client.query("COMMIT");
        return sendJson(res, 200, {
          converted_points: spend,
          tokens_credited: tokens,
          points_earned: earned,
          points_available: earned - tot.rows[0].spent,
          token_balance: tot.rows[0].tokens,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.warn(`[microblog] convert: ${e.message}`);
        return sendJson(res, 500, { error: "Could not convert points." });
      } finally {
        client.release();
      }
    })();
  });
}

// ── Stumble game leaderboard ─────────────────────────────────────────────────
// A real-time high-scores board for the Stumble game. Backed by a single public
// Postgres table (stumble_scores), one best-score row per player keyed on the
// platform user id. Reads (GET /api/stumble/leaderboard) are public; writes
// (POST /api/stumble/score) require a verified platform token. The submit is an
// upsert that keeps the max, so a lower score can never overwrite a higher one.
// Shares the micro-blog's DATABASE_URL gating — disabled (503) when no DB.

async function stumbleBootstrap() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS stumble_scores (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      best_score INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // Public table (an in-app-visible leaderboard) — no 'staging:private' marker.
  await pgPool.query(
    `CREATE INDEX IF NOT EXISTS stumble_scores_best_idx ON stumble_scores (best_score DESC, updated_at ASC)`
  );
  if (IS_STAGING) await stumbleSeedStaging();
}

// Seed an obviously-fake top-10 so the leaderboard renders in staging previews
// (the table is created empty by the boot migration). Idempotent via fixed
// user_ids + ON CONFLICT DO NOTHING; a strict no-op outside staging (caller-gated).
async function stumbleSeedStaging() {
  const rows = [
    ["staging-demo-1", "staging-demo-satoshi_fan", 9420],
    ["staging-demo-2", "staging-demo-block_ninja", 8730],
    ["staging-demo-3", "staging-demo-gwei_whisperer", 7980],
    ["staging-demo-4", "staging-demo-merkle_mary", 7110],
    ["staging-demo-5", "staging-demo-hodl_hannah", 6240],
    ["staging-demo-6", "staging-demo-nonce_sense", 5300],
    ["staging-demo-7", "staging-demo-gas_goblin", 4180],
    ["staging-demo-8", "staging-demo-cold_storage_carl", 3050],
    ["staging-demo-9", "staging-demo-degen_dave", 1620],
    ["staging-demo-10", "staging-demo-newbie_nina", 410],
  ];
  try {
    for (const [uid, uname, score] of rows) {
      await pgPool.query(
        `INSERT INTO stumble_scores (user_id, username, best_score)
         VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
        [uid, uname, score]
      );
    }
    console.log("[stumble] staging seed applied");
  } catch (e) {
    console.warn(`[stumble] staging seed failed: ${e.message}`);
  }
}

// ── Pure helpers (unit-tested; no DB) ─────────────────────────────────────────

// The score that should be stored after a submit — never lowers an existing best.
function stumbleBestScore(existing, incoming) {
  const a = Number.isFinite(existing) ? existing : 0;
  const b = Number.isFinite(incoming) ? incoming : 0;
  return Math.max(a, b);
}

// Normalize a client-reported score → a clamped non-negative integer, or null
// when it isn't a usable number. Caps at STUMBLE_MAX_SCORE.
function normalizeStumbleScore(raw) {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n)) return null;
  const int = Math.floor(n);
  if (int < 0) return null;
  return Math.min(int, STUMBLE_MAX_SCORE);
}

// Rank best-per-player rows into the leaderboard display shape. Ordering:
// best_score DESC, then earliest updated_at (whoever reached the score first),
// then username for a fully stable order. Assigns 1-based ranks.
function rankStumbleRows(rows, limit) {
  const sorted = (rows || []).slice().sort((a, b) => {
    const bs = (b.best_score || 0) - (a.best_score || 0);
    if (bs !== 0) return bs;
    const at = new Date(a.updated_at || 0).getTime();
    const bt = new Date(b.updated_at || 0).getTime();
    if (at !== bt) return at - bt;
    return String(a.username || "").localeCompare(String(b.username || ""));
  });
  const max = typeof limit === "number" && limit > 0 ? limit : sorted.length;
  const out = [];
  for (let i = 0; i < sorted.length && i < max; i++) {
    out.push({ rank: i + 1, username: sorted[i].username, score: sorted[i].best_score });
  }
  return out;
}

// ── Stumble API ───────────────────────────────────────────────────────────────
// GET  /api/stumble/leaderboard — public (top players by best score)
// POST /api/stumble/score       — auth (upsert keeping the max; returns best+rank)

function stumbleRouter(req, res, pathname, urlObj) {
  if (!STUMBLE_ENABLED) {
    return sendJson(res, 503, { error: "The leaderboard is not available in this environment." });
  }
  const user = userFromReq(req, urlObj);
  const method = req.method;

  const run = (fn) => Promise.resolve()
    .then(fn)
    .catch((e) => {
      console.warn(`[stumble] ${method} ${pathname}: ${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error." });
    });

  if (pathname === "/api/stumble/leaderboard" && method === "GET") {
    return run(() => stumbleLeaderboard(res, urlObj));
  }
  if (pathname === "/api/stumble/score" && method === "POST") {
    if (!user) return sendJson(res, 401, { error: "Not authenticated" });
    return stumbleSubmitScore(req, res, user);
  }
  return sendJson(res, 404, { error: "Not found" });
}

async function stumbleLeaderboard(res, urlObj) {
  const limit = Math.min(
    Math.max(parseInt(urlObj.searchParams.get("limit"), 10) || STUMBLE_LEADERBOARD_LIMIT, 1),
    50
  );
  const { rows } = await pgPool.query(
    `SELECT username, best_score, updated_at FROM stumble_scores
     ORDER BY best_score DESC, updated_at ASC LIMIT $1`,
    [limit]
  );
  return sendJson(res, 200, { players: rankStumbleRows(rows, limit), staging: IS_STAGING });
}

function stumbleSubmitScore(req, res, user) {
  return readJsonBody(req, 16 * 1024, (err, body) => {
    if (err) return sendJson(res, 400, { error: err.message });
    const score = normalizeStumbleScore(body && body.score);
    if (score == null) {
      return sendJson(res, 400, { error: "Score must be a non-negative integer." });
    }
    Promise.resolve()
      .then(async () => {
        // Keep the max; only bump updated_at when the best actually improves so
        // ties keep "first to reach the score" ahead.
        const { rows } = await pgPool.query(
          `INSERT INTO stumble_scores (user_id, username, best_score, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (user_id) DO UPDATE
             SET best_score = GREATEST(stumble_scores.best_score, EXCLUDED.best_score),
                 username = EXCLUDED.username,
                 updated_at = CASE WHEN EXCLUDED.best_score > stumble_scores.best_score
                                   THEN now() ELSE stumble_scores.updated_at END
           RETURNING best_score`,
          [user.id, user.username, score]
        );
        const best = rows[0] ? rows[0].best_score : score;
        const rk = await pgPool.query(
          `SELECT COUNT(*)::int AS ahead FROM stumble_scores WHERE best_score > $1`,
          [best]
        );
        const rank = (rk.rows[0] ? rk.rows[0].ahead : 0) + 1;
        return sendJson(res, 200, { best_score: best, rank });
      })
      .catch((e) => {
        console.warn(`[stumble] POST score: ${e.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: "Internal error." });
      });
  });
}

// ── Trivia Quiz ───────────────────────────────────────────────────────────────
// A public, server-graded trivia game. The question bank ships in
// quiz-questions.json (curated content, committed). Sessions live in memory
// (ephemeral — a restart only voids in-flight quizzes). Scores persist to
// quiz-scores.json, file-backed and atomic just like submissions.json, keeping
// one best record per player and capped at QUIZ_SCORE_CAP rows.

const QUIZ_QUESTIONS_PATH = process.env.QUIZ_QUESTIONS_JSON_PATH
  ? path.resolve(process.env.QUIZ_QUESTIONS_JSON_PATH)
  : path.join(__dirname, "quiz-questions.json");

const QUIZ_SCORES_PATH = process.env.QUIZ_SCORES_JSON_PATH
  ? path.resolve(process.env.QUIZ_SCORES_JSON_PATH)
  : path.join(__dirname, "quiz-scores.json");

const QUIZ_QUESTIONS_PER_SESSION = Number(process.env.QUIZ_QUESTIONS_PER_SESSION) || 10;
const QUIZ_TIME_LIMIT_SECONDS = Number(process.env.QUIZ_TIME_LIMIT_SECONDS) || 120;
const QUIZ_ELIGIBILITY_MIN_CORRECT = Number(process.env.QUIZ_ELIGIBILITY_MIN_CORRECT) || 8;
const QUIZ_PRIZE_POOL_ADDRESS = (process.env.QUIZ_PRIZE_POOL_ADDRESS || "").trim();

const QUIZ_POINTS_PER_CORRECT = 100;
const QUIZ_SCORE_CAP = 500;            // bound quiz-scores.json
const QUIZ_LEADERBOARD_LIMIT = 50;     // rows returned by /api/quiz/leaderboard
const QUIZ_SESSION_GRACE_MS = 5000;    // slack on top of the time limit for the round-trip
const QUIZ_DISPLAY_NAME_MAX = 32;

let quizBank = [];                     // [{ id, category, difficulty, question, options[4], answer }]
const quizBankById = new Map();
const quizSessions = new Map();        // sessionId -> { questionIds, startedAt, expiresAt, used, result? }
let quizScores = [];                   // persisted best-per-player records

function loadQuizBank() {
  try {
    const raw = fs.readFileSync(QUIZ_QUESTIONS_PATH, "utf8");
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : (Array.isArray(data.questions) ? data.questions : []);
    quizBank = list.filter(
      (q) =>
        q && typeof q.id === "string" &&
        typeof q.question === "string" &&
        Array.isArray(q.options) && q.options.length >= 2 &&
        Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length
    );
    quizBankById.clear();
    for (const q of quizBank) quizBankById.set(q.id, q);
    console.log(`[quiz] loaded ${quizBank.length} question(s) from ${QUIZ_QUESTIONS_PATH}`);
  } catch (e) {
    console.warn(`[quiz] could not read quiz-questions.json: ${e.message}`);
    quizBank = [];
    quizBankById.clear();
  }
}

function loadQuizScores() {
  try {
    if (!fs.existsSync(QUIZ_SCORES_PATH)) {
      quizScores = [];
    } else {
      const raw = fs.readFileSync(QUIZ_SCORES_PATH, "utf8");
      const data = JSON.parse(raw);
      quizScores = Array.isArray(data) ? data : (Array.isArray(data.scores) ? data.scores : []);
    }
  } catch (e) {
    console.warn(`[quiz] could not read quiz-scores.json: ${e.message}`);
    quizScores = [];
  }
  // Populate a fresh staging board so the leaderboard isn't empty in previews.
  // In-memory only — never written back to disk, never runs in production.
  if (IS_STAGING && quizScores.length === 0) {
    quizScores = stagingSeedScores();
    console.log(`[quiz] staging: seeded ${quizScores.length} demo leaderboard rows (in-memory)`);
  }
}

function saveQuizScores() {
  // Don't persist the in-memory staging seed; it re-seeds on each boot.
  if (IS_STAGING) return;
  try {
    atomicWriteJson(QUIZ_SCORES_PATH, quizScores);
  } catch (e) {
    console.warn(`[quiz] could not write quiz-scores.json: ${e.message}`);
  }
}

// Obviously-fake demo rows for staging — mix of eligible/not and with/without
// wallets so the leaderboard UI exercises every badge state.
function stagingSeedScores() {
  const now = Date.now();
  const mk = (i, displayName, score, correct, wallet) => ({
    id: `staging-demo-${i}`,
    displayName,
    displayNameKey: displayName.toLowerCase(),
    wallet: wallet || null,
    score,
    correct,
    total: 10,
    durationMs: 60000,
    eligible: correct >= QUIZ_ELIGIBILITY_MIN_CORRECT && !!wallet,
    eligibilityReason:
      correct >= QUIZ_ELIGIBILITY_MIN_CORRECT && !!wallet
        ? "Scored at or above the eligibility threshold with a linked wallet."
        : (correct >= QUIZ_ELIGIBILITY_MIN_CORRECT
            ? "Add a Usernode wallet to become reward-eligible."
            : "Score higher to become reward-eligible."),
    created_at: now - i * 60000,
  });
  return [
    mk(1, "satoshi_fan", 1180, 10, "ut1qzdemostagingseedwalletaaaaaaaaaaaaaaaaaaaaaak3a9"),
    mk(2, "block_ninja", 1095, 9, "ut1pfdemostagingseedwalletbbbbbbbbbbbbbbbbbbbbbbm2c7"),
    mk(3, "gwei_whisperer", 980, 9, null),
    mk(4, "merkle_mary", 940, 8, "ut1rrdemostagingseedwalletcccccccccccccccccccccc8h2d"),
    mk(5, "hodl_hannah", 720, 7, "ut1aademostagingseedwalletdddddddddddddddddddddd91x0"),
    mk(6, "nonce_sense", 690, 7, null),
    mk(7, "gas_goblin", 540, 6, "ut1ttdemostagingseedwalleteeeeeeeeeeeeeeeeeeeeeeff34"),
    mk(8, "cold_storage_carl", 510, 5, null),
    mk(9, "degen_dave", 300, 4, "ut1uudemostagingseedwalletffffffffffffffffffffff00ab"),
    mk(10, "newbie_nina", 180, 2, null),
  ];
}

// Stable ordering: higher score, then faster, then earlier.
function compareScores(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ad = typeof a.durationMs === "number" ? a.durationMs : Infinity;
  const bd = typeof b.durationMs === "number" ? b.durationMs : Infinity;
  if (ad !== bd) return ad - bd;
  return (a.created_at || 0) - (b.created_at || 0);
}

function quizIdentityKey(rec) {
  return rec.wallet ? `w:${rec.wallet}` : `n:${rec.displayNameKey}`;
}

// One best record per identity (wallet if present, else lowercased name),
// sorted, capped to QUIZ_SCORE_CAP.
function rankedQuizScores() {
  const best = new Map();
  for (const rec of quizScores) {
    const key = quizIdentityKey(rec);
    const prev = best.get(key);
    if (!prev || compareScores(rec, prev) < 0) best.set(key, rec);
  }
  return Array.from(best.values()).sort(compareScores);
}

// Mask a ut1 address to "ut1xxxx…xxxx" for display.
function maskWallet(wallet) {
  if (!wallet || typeof wallet !== "string") return null;
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 7)}…${wallet.slice(-4)}`;
}

function quizLeaderboardRows(limit) {
  const ranked = rankedQuizScores();
  const out = [];
  for (let i = 0; i < ranked.length && i < limit; i++) {
    const r = ranked[i];
    out.push({
      rank: i + 1,
      displayName: r.displayName,
      walletMasked: maskWallet(r.wallet),
      score: r.score,
      correct: r.correct,
      total: r.total,
      eligible: !!r.eligible,
    });
  }
  return out;
}

// Validate + normalize the submitter-supplied fields. Returns { ok, displayName,
// wallet } or { ok:false, error }.
function validateQuizPlayer(body) {
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  let displayName = str(body && body.displayName).replace(/[\u0000-\u001f]/g, "");
  if (!displayName) return { ok: false, error: "Display name is required." };
  if (displayName.length > QUIZ_DISPLAY_NAME_MAX) displayName = displayName.slice(0, QUIZ_DISPLAY_NAME_MAX);

  let wallet = str(body && body.wallet);
  if (wallet) {
    if (!wallet.startsWith(TX_PREFIX)) {
      return { ok: false, error: "Wallet must be a Usernode address (starts with ut1)." };
    }
    if (wallet.length < 10 || wallet.length > 120) {
      return { ok: false, error: "Wallet address looks invalid." };
    }
  } else {
    wallet = null;
  }
  return { ok: true, displayName, wallet };
}

// Pick N distinct random questions from the bank (Fisher–Yates partial shuffle).
function pickQuizQuestions(n) {
  const arr = quizBank.slice();
  const count = Math.min(n, arr.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (arr.length - i));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr.slice(0, count);
}

loadQuizBank();
loadQuizScores();

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

  // ── Submit-a-dapp API ──────────────────────────────────────────────────────

  // Public config the form needs to render (fee amount, whether submissions are
  // open). Never exposes the validator token.
  if (pathname === "/api/submit-config" && req.method === "GET") {
    return sendJson(res, 200, {
      enabled: !!COMMUNITY_FUND_RESERVE_ADDRESS,
      fee: SUBMISSION_FEE,
      reserve_address: COMMUNITY_FUND_RESERVE_ADDRESS || null,
      dapps_version: dappsVersion(),
    });
  }

  // Create a submission → returns on-chain payment instructions.
  if (pathname === "/api/submissions" && req.method === "POST") {
    if (!COMMUNITY_FUND_RESERVE_ADDRESS) {
      return sendJson(res, 503, { error: "Submissions are not currently open (no Reserve address configured)." });
    }
    return readJsonBody(req, 64 * 1024, (err, body) => {
      if (err) {
        // Log the parse detail server-side; return a fixed, generic message.
        console.warn(`[submit] invalid request body: ${err.message}`);
        return sendJson(res, 400, { error: "Invalid request body." });
      }
      const v = validateSubmissionInput(body);
      if (!v.ok) return sendJson(res, 400, { error: v.error });

      const latestDappsVersion = dappsVersion();

      // Optimistic-concurrency conflict gate — caught BEFORE any fee is charged,
      // so a clash never costs tokens. Returns a structured 409 (code:"conflict")
      // the frontend can branch on, instead of a flat error string.
      //
      // already_listed: the dapp got listed underneath this submitter (another
      // submission published it, or a deploy/manual edit added it) — possibly
      // while their seen_dapps_version was stale. We hand back the live row so
      // the form can say "already on the homepage, no payment needed".
      const listedRow = findListingRow(v.dapp.url, v.dapp.pubkey);
      if (listedRow) {
        return sendJson(res, 409, {
          code: "conflict",
          reason: "already_listed",
          message: "This dapp is already on the homepage — no payment is needed.",
          latest_dapps_version: latestDappsVersion,
          listed: true,
          dapp: publicListingRow(listedRow),
        });
      }
      // submission_in_progress: someone else is mid-flow for the same url/pubkey.
      const dupe = submissions.find(
        (s) => isLiveSubmission(s) && s.dapp &&
          (s.dapp.url === v.dapp.url || s.dapp.pubkey === v.dapp.pubkey)
      );
      if (dupe) {
        return sendJson(res, 409, {
          code: "conflict",
          reason: "submission_in_progress",
          message: "A submission for this URL or pubkey is already in progress.",
          latest_dapps_version: latestDappsVersion,
          listed: false,
          dapp: null,
        });
      }

      const now = Date.now();
      const id = crypto.randomUUID();
      const record = {
        id,
        status: "awaiting_payment",
        rev: 1,
        dapp: v.dapp,
        payer: null,
        payment_tx_hash: null,
        paid_amount: null,
        fee_recipient: COMMUNITY_FUND_RESERVE_ADDRESS,
        created_at: now,
        updated_at: now,
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
        dapps_version: latestDappsVersion,
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

  // ── Micro-blog feed API ────────────────────────────────────────────────────
  // Handled before the GET/HEAD-only guard below since posts/likes/convert are
  // POST/DELETE. Reads are public; writes require a verified platform token.
  if (pathname.startsWith("/api/microblog/")) {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    return microblogRouter(req, res, pathname, urlObj);
  }

  // ── Stumble leaderboard API ─────────────────────────────────────────────────
  // Handled before the GET/HEAD-only guard since score submit is a POST. Reads
  // are public; the score write requires a verified platform token.
  if (pathname.startsWith("/api/stumble/")) {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    return stumbleRouter(req, res, pathname, urlObj);
  }

  // ── Trivia Quiz API (all public, no auth — matches the app's posture) ───────

  // Public config the page needs to render copy + rules.
  if (pathname === "/api/quiz/config" && req.method === "GET") {
    return sendJson(res, 200, {
      questionsPerSession: Math.min(QUIZ_QUESTIONS_PER_SESSION, quizBank.length),
      timeLimitSeconds: QUIZ_TIME_LIMIT_SECONDS,
      eligibilityMinCorrect: QUIZ_ELIGIBILITY_MIN_CORRECT,
      prizePoolAddress: QUIZ_PRIZE_POOL_ADDRESS || null,
      rewardsEnabled: false,
      pointsPerCorrect: QUIZ_POINTS_PER_CORRECT,
    });
  }

  // Top best-per-player rows.
  if (pathname === "/api/quiz/leaderboard" && req.method === "GET") {
    return sendJson(res, 200, {
      players: quizLeaderboardRows(QUIZ_LEADERBOARD_LIMIT),
      eligibilityMinCorrect: QUIZ_ELIGIBILITY_MIN_CORRECT,
    });
  }

  // Begin a session → returns N questions WITHOUT the answer key + a sessionId.
  if (pathname === "/api/quiz/start" && req.method === "POST") {
    if (quizBank.length === 0) {
      return sendJson(res, 503, { error: "The quiz is not available right now." });
    }
    const picked = pickQuizQuestions(QUIZ_QUESTIONS_PER_SESSION);
    const now = Date.now();
    const sessionId = crypto.randomUUID();
    quizSessions.set(sessionId, {
      questionIds: picked.map((q) => q.id),
      startedAt: now,
      expiresAt: now + QUIZ_TIME_LIMIT_SECONDS * 1000 + QUIZ_SESSION_GRACE_MS,
      used: false,
      result: null,
    });
    return sendJson(res, 201, {
      sessionId,
      timeLimitSeconds: QUIZ_TIME_LIMIT_SECONDS,
      questions: picked.map((q) => ({
        id: q.id,
        category: q.category,
        difficulty: q.difficulty,
        question: q.question,
        options: q.options, // answer index intentionally omitted
      })),
    });
  }

  // Grade a session server-side, record the score, return the breakdown.
  if (pathname === "/api/quiz/submit" && req.method === "POST") {
    return readJsonBody(req, 64 * 1024, (err, body) => {
      if (err) return sendJson(res, 400, { error: err.message });

      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const session = quizSessions.get(sessionId);
      if (!session) {
        return sendJson(res, 404, { error: "Session expired or not found. Please start a new quiz." });
      }
      // Single-use: a second submit returns the original result.
      if (session.used) {
        if (session.result) return sendJson(res, 200, session.result);
        return sendJson(res, 409, { error: "This quiz session was already submitted." });
      }

      const player = validateQuizPlayer(body);
      if (!player.ok) return sendJson(res, 400, { error: player.error });

      const now = Date.now();
      const expired = now > session.expiresAt;
      const answers = body && typeof body.answers === "object" && body.answers ? body.answers : {};

      // Grade only the session's questions; missing/extra keys are wrong.
      let correct = 0;
      const breakdown = session.questionIds.map((qid) => {
        const q = quizBankById.get(qid);
        const givenRaw = answers[qid];
        const given = Number.isInteger(givenRaw) ? givenRaw : (typeof givenRaw === "string" && givenRaw !== "" ? Number(givenRaw) : null);
        const isCorrect = q != null && given === q.answer;
        if (isCorrect) correct++;
        return {
          id: qid,
          question: q ? q.question : "(unknown)",
          options: q ? q.options : [],
          correctAnswer: q ? q.answer : null,
          givenAnswer: given == null || Number.isNaN(given) ? null : given,
          correct: isCorrect,
        };
      });

      const total = session.questionIds.length;
      const durationMs = Math.max(0, now - session.startedAt);
      // Speed bonus: 1 pt per whole second left, zero if the round expired.
      const secondsLeft = expired
        ? 0
        : Math.max(0, Math.floor((QUIZ_TIME_LIMIT_SECONDS * 1000 - durationMs) / 1000));
      const score = correct * QUIZ_POINTS_PER_CORRECT + secondsLeft;

      const meetsThreshold = correct >= QUIZ_ELIGIBILITY_MIN_CORRECT;
      const eligible = meetsThreshold && !!player.wallet;
      const eligibilityReason = eligible
        ? "Scored at or above the eligibility threshold with a linked wallet."
        : meetsThreshold
          ? "Add a Usernode wallet next time to become reward-eligible."
          : `Answer at least ${QUIZ_ELIGIBILITY_MIN_CORRECT} of ${total} correctly to become reward-eligible.`;

      const record = {
        id: crypto.randomUUID(),
        displayName: player.displayName,
        displayNameKey: player.displayName.toLowerCase(),
        wallet: player.wallet,
        score,
        correct,
        total,
        durationMs,
        eligible,
        eligibilityReason,
        created_at: now,
      };
      quizScores.push(record);

      // Keep one best record per identity, sorted, capped to QUIZ_SCORE_CAP.
      quizScores = rankedQuizScores().slice(0, QUIZ_SCORE_CAP);
      saveQuizScores();

      // Rank of this player's identity on the deduped board.
      const ranked = rankedQuizScores();
      const myKey = quizIdentityKey(record);
      let rank = ranked.findIndex((r) => quizIdentityKey(r) === myKey) + 1;
      if (rank === 0) rank = ranked.length; // fell outside the cap

      const result = {
        score,
        correct,
        total,
        durationMs,
        secondsLeft,
        eligible,
        eligibilityReason,
        rank,
        totalPlayers: ranked.length,
        expired,
        breakdown,
      };

      session.used = true;
      session.result = result;
      return sendJson(res, 200, result);
    });
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

  // Mini Minecraft — self-contained block-sandbox game page.
  if (pathname === "/minecraft" || pathname === "/minecraft.html") {
    return fs.readFile(MINECRAFT_PATH, (err, buf) => {
      if (err) {
        return send(
          res,
          500,
          { "content-type": "text/plain" },
          `Failed to read minecraft.html: ${err.message}\n`
        );
      }
      const headers = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      };
      if (req.method === "HEAD") {
        res.writeHead(200, { ...headers, "content-length": buf.length });
        return res.end();
      }
      return send(res, 200, headers, buf);
    });
  }

  // Web3 Trivia Quiz — self-contained quiz page (same pattern as /minecraft).
  if (pathname === "/trivia" || pathname === "/trivia.html") {
    return fs.readFile(TRIVIA_PATH, (err, buf) => {
      if (err) {
        return send(
          res,
          500,
          { "content-type": "text/plain" },
          `Failed to read trivia.html: ${err.message}\n`
        );
      }
      const headers = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      };
      if (req.method === "HEAD") {
        res.writeHead(200, { ...headers, "content-length": buf.length });
        return res.end();
      }
      return send(res, 200, headers, buf);
    });
  }

  // Stumble game — self-contained page (same pattern as /minecraft, /trivia).
  // Gameplay is a later phase; this page wires the score-submission integration
  // point against POST /api/stumble/score so the leaderboard is exercisable.
  if (pathname === "/stumble" || pathname === "/stumble.html") {
    return fs.readFile(STUMBLE_PATH, (err, buf) => {
      if (err) {
        return send(
          res,
          500,
          { "content-type": "text/plain" },
          `Failed to read stumble.html: ${err.message}\n`
        );
      }
      const headers = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      };
      if (req.method === "HEAD") {
        res.writeHead(200, { ...headers, "content-length": buf.length });
        return res.end();
      }
      return send(res, 200, headers, buf);
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

      const dappsVer = String(dappsVersion());
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": buf.length,
          "cache-control": "no-store",
          "x-dapps-version": dappsVer,
          "access-control-expose-headers": "x-dapps-version",
        });
        return res.end();
      }

      return send(
        res,
        200,
        {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-dapps-version": dappsVer,
          "access-control-expose-headers": "x-dapps-version",
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

function startServer() {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Serving ${INDEX_PATH}`);
    console.log(`Dapps config: ${DAPPS_PATH}${LOCAL_DEV ? " (local-dev)" : ""}`);
    console.log(`Explorer proxy: ${EXPLORER_USE_HTTP ? "http" : "https"}://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}`);
    console.log(`Stats poller: every ${STATS_POLL_INTERVAL_MS / 1000}s → GET /api/stats, GET /api/transactions?pubkey=..., GET /user_activity`);
    console.log(`Listening on http://localhost:${PORT}`);
  });
}

// Only boot the poller + HTTP listener when run directly. When required as a
// module (e.g. from the test suite) nothing auto-starts, so tests can point the
// store env vars at temp fixtures and drive the exported functions / server.
if (require.main === module) {
  startBackground();
  startServer();
}

module.exports = {
  server,
  startBackground,
  startServer,
  // OCC + store internals (exercised by test/occ.test.js)
  atomicWriteJson,
  casWriteJson,
  parseSubmissionsDoc,
  loadSubmissions,
  saveSubmissions,
  touchSubmission,
  readDappsDoc,
  dappsVersion,
  findListingRow,
  publicListingRow,
  listingHas,
  appendDappToListing,
  reconcileSubmissionPayments,
  expireStaleSubmissions,
  validateSubmissionInput,
  // Stumble leaderboard pure helpers (exercised by test/stumble.test.js)
  stumbleBestScore,
  normalizeStumbleScore,
  rankStumbleRows,
  // state accessors for assertions
  _getSubmissions: () => submissions,
  _getSubmissionsVersion: () => submissionsVersion,
  _setSubmissions: (arr, ver) => { submissions = arr; if (typeof ver === "number") submissionsVersion = ver; },
  _addConsumedTx: (id) => consumedTxIds.add(id),
  _txCache: txCache,
  PATHS: { DAPPS_PATH, SUBMISSIONS_PATH },
  CONFIG: { SUBMISSION_FEE, COMMUNITY_FUND_RESERVE_ADDRESS },
};
