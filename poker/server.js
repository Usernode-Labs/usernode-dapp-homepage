"use strict";
// On-chain Texas Hold'em — slice 1. Platform-standard Usernode child app:
// Express + Postgres + JWT iframe auth, PORT 3000. One 6-max NL cash table with
// on-chain buy-in (read-verified), ledger-backed pooled-bank chips, full
// betting, side pots, automatic showdown, commit/reveal provably-fair deal, SSE
// table state with hole-card redaction, and a chain-aware action timer.

const express = require("express");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const explorer = require("./chain/explorer");
const treasury = require("./chain/treasury");
const fairness = require("./engine/fairness");
const { createHand, legalActions, applyAction } = require("./engine/holdem");
const timerLogic = require("./engine/timer");
const { buildTableView } = require("./view");
const { isBotUserId } = require("./engine/bots");
const { fillEmptySeatsWithBots, evictBotFromSeat, replenishBrokeBots, scheduleBot } = require("./engine/botManager");

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === "staging";
const DATABASE_URL = process.env.DATABASE_URL;

const SB = Number(process.env.SMALL_BLIND) || 25;
const BB = Number(process.env.BIG_BLIND) || 50;
const MIN_BUYIN = Number(process.env.MIN_BUYIN) || 1000;
const MAX_BUYIN = Number(process.env.MAX_BUYIN) || 10000;
const ACTION_TIMER_SECONDS = Number(process.env.ACTION_TIMER_SECONDS) || 30;
const MAX_SEATS = 6;
const MIN_SEATS_ALLOWED = 2;
const MAX_SEATS_ALLOWED = 9;
const SIT_OUT_AFTER = 3;
const BUYIN_TTL_MS = 30 * 60 * 1000;

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

// ── Table-access helpers (private tables) ────────────────────────────────────
// Passwords are stored only as a salted scrypt hash in the private table_access
// table; the plaintext is never persisted or logged. Whitelist entries are
// ut1… wallet addresses. A user may join a private table with EITHER the correct
// password OR a whitelisted wallet.
function hashPassword(plain, saltHex) {
  const salt = saltHex || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(plain), salt, 32).toString("hex");
  return { hash, salt };
}
function passwordMatches(access, plain) {
  if (!access.passwordHash || !access.passwordSalt) return false;
  if (typeof plain !== "string" || !plain) return false;
  const { hash } = hashPassword(plain, access.passwordSalt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(access.passwordHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function walletWhitelisted(access, wallet) {
  if (!Array.isArray(access.whitelist) || !access.whitelist.length) return false;
  if (!wallet) return false;
  const w = String(wallet).trim().toLowerCase();
  return access.whitelist.some((x) => String(x).trim().toLowerCase() === w);
}
// Returns null if access is allowed, otherwise an { code, error } to return.
function checkTableAccess(rt, { wallet, password }) {
  if (rt.access.visibility !== "private") return null;
  if (passwordMatches(rt.access, password)) return null;
  if (walletWhitelisted(rt.access, wallet)) return null;
  const needs = [];
  if (rt.access.passwordHash) needs.push("password");
  if (rt.access.whitelist && rt.access.whitelist.length) needs.push("whitelisted wallet");
  const how = needs.length ? needs.join(" or ") : "an invitation";
  return { code: 403, error: `This is a private table — ${how} required to join.` };
}

// ── Activity event logging ───────────────────────────────────────────────────
async function insertActivityEvent(tableId, eventType, userId, seatNo, handId, metadata) {
  if (!pool) return;
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO activity_events (id, table_id, event_type, user_id, seat_no, hand_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, tableId, eventType, userId || null, seatNo != null ? seatNo : null, handId || null, metadata ? JSON.stringify(metadata) : null]
  );
  // Invalidate cache so the next broadcast re-queries.
  activityCache.delete(tableId);
}

async function getRecentActivity(tableId) {
  if (!pool) return { events: [], hasMore: false };
  const now = Date.now();
  const cached = activityCache.get(tableId);
  if (cached && now - cached.ts < ACTIVITY_CACHE_STALE_MS) {
    return cached.data;
  }
  const r = await pool.query(
    `SELECT id, event_type, user_id, seat_no, metadata, created_at FROM activity_events
     WHERE table_id=$1 ORDER BY created_at DESC LIMIT 26`,
    [tableId]
  );
  const all = r.rows.map((row) => ({
    id: row.id,
    type: row.event_type,
    user_id: row.user_id,
    seat_no: row.seat_no,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: row.created_at,
  }));
  const events = all.slice(0, 25);
  const hasMore = all.length > 25;
  const data = { events, hasMore };
  activityCache.set(tableId, { ts: now, data });
  return data;
}

// ── In-memory table runtimes + chain idempotency ─────────────────────────────
const runtimes = new Map();           // tableId -> runtime
const sseClients = new Map();         // tableId -> Set<{res, userId}>
const consumedTxIds = new Set();      // buy-in tx already credited
let chainId = null;
const lastHeight = {};                // recipient -> from_height

// Activity event caching (per table: timestamp + event list)
const activityCache = new Map();      // tableId -> {ts, events}
const ACTIVITY_CACHE_STALE_MS = 5000; // re-query after 5s

// ── Boot: schema + seed ──────────────────────────────────────────────────────
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8");
  await pool.query(sql);
}

const DEMO_TABLE_ID = "staging-demo-6max";
const DEMO_PRIVATE_TABLE_ID = "staging-demo-private";

async function seedStaging() {
  if (!IS_STAGING) return;
  // Demo Play Money 6-max table with a few occupied seats so the lobby/felt
  // aren't blank. Idempotent.
  // Snappier shot-clock on the demo table so the self-running hand cycles
  // through betting → showdown quickly for testers (staging-only).
  const DEMO_TIMER = 15;
  await pool.query(
    `INSERT INTO tables (id, name, sb, bb, min_buyin, max_buyin, max_seats, action_timer_seconds, status, created_by, allow_bots, bot_difficulty)
     VALUES ($1,'Staging demo — Play Money 6-max',$2,$3,$4,$5,$6,$7,'open','staging-demo-user',true,'medium')
     ON CONFLICT (id) DO UPDATE SET allow_bots=true, bot_difficulty='medium'`,
    [DEMO_TABLE_ID, SB, BB, MIN_BUYIN, MAX_BUYIN, MAX_SEATS, DEMO_TIMER]
  );
  const demoSeats = [
    [0, "staging-demo-alice", "Staging demo Alice", 4200],
    [1, "staging-demo-bob", "Staging demo Bob", 6100],
    [3, "staging-demo-carol", "Staging demo Carol", 1850],
  ];
  for (const [seat, uid, uname, stack] of demoSeats) {
    await pool.query(
      `INSERT INTO seats (table_id, seat_no, user_id, username, wallet, stack, status, joined_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active', now())
       ON CONFLICT (table_id, seat_no) DO NOTHING`,
      [DEMO_TABLE_ID, seat, uid, uname, "ut1stagingdemowallet" + seat, stack]
    );
  }

  // 3–5 completed sample hands with VALID commitment/reveal pairs so the Verify
  // panel demonstrably passes. Built with the real fairness pipeline.
  for (let i = 1; i <= 4; i++) {
    const handId = `staging-demo-hand-${i}`;
    const exists = await pool.query(`SELECT 1 FROM hands WHERE id=$1`, [handId]);
    if (exists.rowCount) continue;
    const secret = crypto.createHash("sha256").update("staging-seed-" + i).digest("hex");
    const nonces = [`nonce-${i}-a`, `nonce-${i}-b`];
    const deck = fairness.dealtDeck(secret, nonces, handId);
    const commitment = fairness.commitmentOf(secret);
    const board = deck.slice(4, 9); // after 2*2 hole cards (2 players), 5 board
    const result = {
      uncontested: false,
      board,
      winners: [{ seat: i % 2, username: i % 2 ? "Staging demo Bob" : "Staging demo Alice", amount: 300 * i, name: "Pair of Kings" }],
      revealed: { 0: deck.slice(0, 2), 1: deck.slice(2, 4) },
    };
    await pool.query(
      `INSERT INTO hands (id, table_id, hand_no, button_seat, board, commitment, seed, nonces, deck, result, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (id) DO NOTHING`,
      [handId, DEMO_TABLE_ID, i, 0, board, commitment, secret, JSON.stringify(nonces), deck, JSON.stringify(result)]
    );
  }

  // One in-progress demo hand with private hole_cards + hand_secrets so a dev
  // can exercise redaction/verify against private rows (these tables are empty
  // in staging until seeded here).
  const liveHandId = "staging-demo-hand-live";
  const liveExists = await pool.query(`SELECT 1 FROM hand_secrets WHERE hand_id=$1`, [liveHandId]);
  if (!liveExists.rowCount) {
    const secret = crypto.createHash("sha256").update("staging-live-seed").digest("hex");
    const nonces = ["live-a", "live-b", "live-c"];
    const shuffleSeed = fairness.computeShuffleSeed(secret, nonces, liveHandId);
    const deck = fairness.dealtDeck(secret, nonces, liveHandId);
    const commitment = fairness.commitmentOf(secret);
    await pool.query(
      `INSERT INTO hand_secrets (hand_id, seed, shuffle_seed, commitment, deck, nonces, anchored, revealed)
       VALUES ($1,$2,$3,$4,$5,$6,false,false) ON CONFLICT (hand_id) DO NOTHING`,
      [liveHandId, secret, shuffleSeed, commitment, deck, JSON.stringify(nonces)]
    );
    const holeRows = [
      [0, "staging-demo-alice", deck.slice(0, 2)],
      [1, "staging-demo-bob", deck.slice(2, 4)],
      [3, "staging-demo-carol", deck.slice(4, 6)],
    ];
    for (const [seat, uid, cards] of holeRows) {
      await pool.query(
        `INSERT INTO hole_cards (hand_id, seat_no, user_id, cards) VALUES ($1,$2,$3,$4)
         ON CONFLICT (hand_id, seat_no) DO NOTHING`,
        [liveHandId, seat, uid, cards]
      );
    }
  }

  // Private + password demo table so the table-creator/private-join flow is
  // testable in staging. Password is "demo123"; one seat is pre-filled so the
  // felt isn't empty. table_access is staging:private (schema-only), so this
  // seed is the only place the demo password exists in staging.
  await pool.query(
    `INSERT INTO tables (id, name, sb, bb, min_buyin, max_buyin, max_seats, action_timer_seconds, status, created_by, visibility)
     VALUES ($1,'Staging demo — Private (password: demo123)',10,20,400,4000,4,20,'open','staging-demo-user','private')
     ON CONFLICT (id) DO NOTHING`,
    [DEMO_PRIVATE_TABLE_ID]
  );
  {
    const { hash, salt } = hashPassword("demo123");
    await pool.query(
      `INSERT INTO table_access (table_id, password_hash, password_salt, whitelist)
       VALUES ($1,$2,$3,$4) ON CONFLICT (table_id) DO NOTHING`,
      [DEMO_PRIVATE_TABLE_ID, hash, salt, JSON.stringify(["ut1stagingwhitelisteddemo000000000000000000000000000000000000"])]
    );
    await pool.query(
      `INSERT INTO seats (table_id, seat_no, user_id, username, wallet, stack, status, joined_at)
       VALUES ($1,0,'staging-demo-dave','Staging demo Dave','ut1stagingdemowalletdave',2500,'active', now())
       ON CONFLICT (table_id, seat_no) DO NOTHING`,
      [DEMO_PRIVATE_TABLE_ID]
    );
  }

  // Seed activity feed events for the demo table so the feed isn't empty.
  const demoEvents = [
    ["staging-demo-alice-join", "join", "staging-demo-alice", 0, null, { amount: 4200 }],
    ["staging-demo-bob-join", "join", "staging-demo-bob", 1, null, { amount: 6100 }],
    ["staging-demo-carol-join", "join", "staging-demo-carol", 3, null, { amount: 1850 }],
  ];
  for (const [id, type, userId, seatNo, handId, metadata] of demoEvents) {
    await pool.query(
      `INSERT INTO activity_events (id, table_id, event_type, user_id, seat_no, hand_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [id, DEMO_TABLE_ID, type, userId, seatNo, handId, JSON.stringify(metadata)]
    );
  }
}

async function ensureDefaultTable() {
  // The single production cash table (slice 1 ships exactly one live table).
  const id = "main-6max";
  await pool.query(
    `INSERT INTO tables (id, name, sb, bb, min_buyin, max_buyin, max_seats, action_timer_seconds, status, created_by)
     VALUES ($1,'No-Limit Hold''em — 6-max',$2,$3,$4,$5,$6,$7,'open','system')
     ON CONFLICT (id) DO NOTHING`,
    [id, SB, BB, MIN_BUYIN, MAX_BUYIN, MAX_SEATS, ACTION_TIMER_SECONDS]
  );
}

// ── Runtime loading ──────────────────────────────────────────────────────────
async function loadRuntime(tableId) {
  if (runtimes.has(tableId)) return runtimes.get(tableId);
  const t = await pool.query(`SELECT * FROM tables WHERE id=$1`, [tableId]);
  if (!t.rowCount) return null;
  const table = t.rows[0];
  const seatRows = await pool.query(`SELECT * FROM seats WHERE table_id=$1`, [tableId]);
  const seats = new Map();
  for (const r of seatRows.rows) {
    if (r.user_id) {
      seats.set(r.seat_no, {
        seat_no: r.seat_no,
        userId: r.user_id,
        username: r.username,
        wallet: r.wallet,
        stack: Number(r.stack),
        status: r.status,
        sitOutCount: r.sit_out_count || 0,
        nonce: null,
      });
    }
  }
  // Load private access material separately so it can never leak through the
  // public table view (buildTableView only reads runtime.table).
  let access = { visibility: table.visibility || "public", passwordHash: null, passwordSalt: null, whitelist: [] };
  if (access.visibility === "private") {
    const a = await pool.query(`SELECT * FROM table_access WHERE table_id=$1`, [tableId]);
    if (a.rowCount) {
      access.passwordHash = a.rows[0].password_hash || null;
      access.passwordSalt = a.rows[0].password_salt || null;
      access.whitelist = Array.isArray(a.rows[0].whitelist) ? a.rows[0].whitelist : [];
    }
  }
  const runtime = { table, seats, access, spectators: new Set(), hand: null, lastHandNo: 0, button: -1, starting: false };
  runtimes.set(tableId, runtime);
  return runtime;
}

// ── HTTP app ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "64kb" }));

// /api/tables (lobby read), /api/hands/* (verify), and /api/activity (feed)
// are intentionally public per the spec — they expose no user-private data.
const PUBLIC_API_PATHS = new Set(["/health", "/api/tables", "/api/activity"]);
const PUBLIC_PREFIXES = ["/explorer-api/", "/api/hands/"];

app.use((req, res, next) => {
  const token = req.query.token || req.headers["x-usernode-token"];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch (_) {}
  }
  if (req.method !== "GET" || req.path.startsWith("/api/")) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  }
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Transparent explorer proxy (public — the bridge polls it tokenless).
app.all("/explorer-api/*", async (req, res) => {
  try {
    const sub = req.path.slice("/explorer-api/".length);
    const url = `${explorer.baseUrl()}/${sub}`;
    const init = { method: req.method, headers: { "content-type": "application/json", accept: "application/json" } };
    if (req.method !== "GET" && req.method !== "HEAD") init.body = JSON.stringify(req.body || {});
    const up = await fetch(url, init);
    const text = await up.text();
    res.status(up.status).set("content-type", up.headers.get("content-type") || "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: "explorer proxy error: " + e.message });
  }
});

// ── Lobby ────────────────────────────────────────────────────────────────────
app.get("/api/tables", async (req, res) => {
  const rows = await pool.query(`SELECT * FROM tables WHERE status='open' ORDER BY id`);
  const out = [];
  for (const t of rows.rows) {
    const seatRows = await pool.query(
      `SELECT count(*)::int AS n FROM seats WHERE table_id=$1 AND user_id IS NOT NULL`, [t.id]);
    const rt = runtimes.get(t.id);
    out.push({
      id: t.id,
      name: t.name,
      sb: Number(t.sb),
      bb: Number(t.bb),
      min_buyin: Number(t.min_buyin),
      max_buyin: Number(t.max_buyin),
      max_seats: t.max_seats,
      action_timer_seconds: t.action_timer_seconds,
      visibility: t.visibility || "public",
      is_private: (t.visibility || "public") === "private",
      allow_spectators: t.allow_spectators !== false,
      allow_bots: !!t.allow_bots,
      bot_difficulty: t.bot_difficulty || "medium",
      seated: seatRows.rows[0].n,
      spectator_count: rt ? rt.spectators.size : 0,
    });
  }
  const you = req.user
    ? { id: req.user.id, username: req.user.username, wallet: req.user.usernode_pubkey || null }
    : null;
  res.json({ tables: out, treasury: treasury.address() || null, you });
});

// Create a table with full creator controls: seat count, blinds, buy-in range,
// action timer, public/private visibility, optional password + wallet whitelist.
app.post("/api/tables", async (req, res) => {
  const b = req.body || {};
  const id = "t_" + crypto.randomBytes(5).toString("hex");

  const intIn = (v, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : dflt; };
  const name = (typeof b.name === "string" && b.name.trim().slice(0, 60)) || "No-Limit Hold'em";
  const maxSeats = intIn(b.max_seats, MAX_SEATS);
  const sb = intIn(b.sb, SB);
  const bb = intIn(b.bb, BB);
  const minBuyin = intIn(b.min_buyin, MIN_BUYIN);
  const maxBuyin = intIn(b.max_buyin, MAX_BUYIN);
  const timer = intIn(b.action_timer_seconds, ACTION_TIMER_SECONDS);
  const visibility = b.visibility === "private" ? "private" : "public";
  const allowSpectators = b.allow_spectators !== false; // default true
  const allowBots = b.allow_bots === true;
  const botDifficulty = ["easy", "medium", "hard"].includes(b.bot_difficulty) ? b.bot_difficulty : "medium";

  // Validate the settings so a malformed table can't break the engine.
  if (maxSeats < MIN_SEATS_ALLOWED || maxSeats > MAX_SEATS_ALLOWED)
    return res.status(400).json({ error: `seat count must be ${MIN_SEATS_ALLOWED}–${MAX_SEATS_ALLOWED}` });
  if (!(sb >= 1) || !(bb >= 1)) return res.status(400).json({ error: "blinds must be at least 1" });
  if (bb < sb) return res.status(400).json({ error: "big blind must be ≥ small blind" });
  if (!(minBuyin >= bb)) return res.status(400).json({ error: "minimum buy-in must be at least one big blind" });
  if (maxBuyin < minBuyin) return res.status(400).json({ error: "maximum buy-in must be ≥ minimum buy-in" });
  if (timer < 5 || timer > 120) return res.status(400).json({ error: "action timer must be 5–120 seconds" });

  // Parse the whitelist (newline/comma separated ut1… addresses).
  let whitelist = [];
  if (typeof b.whitelist === "string" && b.whitelist.trim()) {
    whitelist = b.whitelist.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 200);
  } else if (Array.isArray(b.whitelist)) {
    whitelist = b.whitelist.map((x) => String(x).trim()).filter(Boolean).slice(0, 200);
  }
  const password = typeof b.password === "string" ? b.password : "";
  if (visibility === "private" && !password && !whitelist.length)
    return res.status(400).json({ error: "a private table needs a password or a wallet whitelist" });

  await pool.query(
    `INSERT INTO tables (id, name, sb, bb, min_buyin, max_buyin, max_seats, action_timer_seconds, status, created_by, visibility, allow_spectators, allow_bots, bot_difficulty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13)`,
    [id, name, sb, bb, minBuyin, maxBuyin, maxSeats, timer, req.user.id, visibility, allowSpectators, allowBots, botDifficulty]
  );
  if (visibility === "private") {
    let hash = null, salt = null;
    if (password) { const h = hashPassword(password); hash = h.hash; salt = h.salt; }
    await pool.query(
      `INSERT INTO table_access (table_id, password_hash, password_salt, whitelist)
       VALUES ($1,$2,$3,$4)`,
      [id, hash, salt, JSON.stringify(whitelist)]
    );
  }
  res.status(201).json({ id, visibility, allow_spectators: allowSpectators, allow_bots: allowBots, bot_difficulty: botDifficulty });
});

app.get("/api/tables/:id", async (req, res) => {
  const rt = await loadRuntime(req.params.id);
  if (!rt) return res.status(404).json({ error: "table not found" });
  const isSeated = [...rt.seats.values()].some((s) => s.userId === req.user.id);
  res.json(buildTableView(rt, req.user.id, !isSeated));
});

// ── Buy-in: create a pending session + on-chain pay instructions ─────────────
app.post("/api/tables/:id/buyin", async (req, res) => {
  const tableId = req.params.id;
  const rt = await loadRuntime(tableId);
  if (!rt) return res.status(404).json({ error: "table not found" });
  if (!treasury.address()) return res.status(503).json({ error: "buy-ins unavailable (no treasury configured)" });

  const seatNo = Number(req.body.seat_no);
  const amount = Number(req.body.amount);
  const wallet = req.user.usernode_pubkey || (typeof req.body.wallet === "string" ? req.body.wallet.trim() : "");
  if (!Number.isInteger(seatNo) || seatNo < 0 || seatNo >= rt.table.max_seats)
    return res.status(400).json({ error: "invalid seat" });
  if (!(amount >= Number(rt.table.min_buyin) && amount <= Number(rt.table.max_buyin)))
    return res.status(400).json({ error: `buy-in must be between ${rt.table.min_buyin} and ${rt.table.max_buyin}` });
  if (!wallet || !wallet.startsWith("ut1"))
    return res.status(400).json({ error: "no linked Usernode wallet (ut1…) found" });

  // Private-table gate: correct password OR a whitelisted wallet.
  const denied = checkTableAccess(rt, { wallet, password: req.body.password });
  if (denied) return res.status(denied.code).json({ error: denied.error });

  // Seat must be free, or already yours, or occupied by a bot (evict it).
  const existing = rt.seats.get(seatNo);
  if (existing && existing.userId && existing.userId !== req.user.id) {
    if (existing.is_bot) {
      evictBotFromSeat(rt, seatNo);
    } else {
      return res.status(409).json({ error: "seat is taken" });
    }
  }
  // One seat per user at a table.
  for (const [, s] of rt.seats) {
    if (s.userId === req.user.id && s.seat_no !== seatNo)
      return res.status(409).json({ error: "you are already seated at this table" });
  }

  const sid = crypto.randomUUID();
  const memo = JSON.stringify({ app: "poker", type: "buyin", tid: tableId, seat: seatNo, sid });
  const now = Date.now();
  await pool.query(
    `INSERT INTO seat_sessions (id, table_id, seat_no, user_id, wallet, amount, memo, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'awaiting_payment', to_timestamp($8/1000.0))`,
    [sid, tableId, seatNo, req.user.id, wallet, amount, memo, now + BUYIN_TTL_MS]
  );
  // Reserve the seat (sitting_out until the deposit confirms).
  await pool.query(
    `INSERT INTO seats (table_id, seat_no, user_id, username, wallet, stack, status, joined_at)
     VALUES ($1,$2,$3,$4,$5,0,'sitting_out', now())
     ON CONFLICT (table_id, seat_no) DO UPDATE SET user_id=$3, username=$4, wallet=$5, status='sitting_out'
     WHERE seats.user_id IS NULL OR seats.user_id=$3`,
    [tableId, seatNo, req.user.id, req.user.username, wallet]
  );
  rt.seats.set(seatNo, {
    seat_no: seatNo, userId: req.user.id, username: req.user.username, wallet,
    stack: existing ? existing.stack : 0, status: "sitting_out", sitOutCount: 0, nonce: null,
  });

  res.status(201).json({ sid, pay_to: treasury.address(), amount, memo, expires_at: now + BUYIN_TTL_MS });
  pollChainSoon(); // confirm fast
});

app.get("/api/tables/:id/session/:sid", async (req, res) => {
  const r = await pool.query(`SELECT * FROM seat_sessions WHERE id=$1`, [req.params.sid]);
  if (!r.rowCount) return res.status(404).json({ error: "session not found" });
  const s = r.rows[0];
  res.json({
    sid: s.id, status: s.status, seat_no: s.seat_no, amount: Number(s.amount),
    paid_amount: s.paid_amount != null ? Number(s.paid_amount) : null,
    payment_tx_hash: s.payment_tx_hash || null, memo: s.memo, pay_to: treasury.address(),
  });
});

// ── In-hand action ───────────────────────────────────────────────────────────
app.post("/api/tables/:id/action", async (req, res) => {
  const rt = runtimes.get(req.params.id);
  if (!rt || !rt.hand) return res.status(409).json({ error: "no active hand" });
  const engine = rt.hand.engineState;
  if (engine.complete) return res.status(409).json({ error: "hand complete" });
  const actor = engine.players[engine.toAct];
  const seatMeta = rt.seats.get(actor.seat);
  if (!seatMeta || seatMeta.userId !== req.user.id)
    return res.status(403).json({ error: "not your turn" });

  const type = String(req.body.type || "");
  const amount = req.body.amount != null ? Math.floor(Number(req.body.amount)) : undefined;
  try {
    advanceHand(rt, { type, amount });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ ok: true });
});

// Action-timer pause contract: while a player's action transaction is
// pending/confirming on-chain, the client marks the seat pending and the
// shot-clock freezes; it resumes (or the action submits) once confirmed.
app.post("/api/tables/:id/action-pending", async (req, res) => {
  const rt = runtimes.get(req.params.id);
  if (!rt || !rt.hand) return res.status(409).json({ error: "no active hand" });
  const engine = rt.hand.engineState;
  const actor = engine.players[engine.toAct];
  const seatMeta = actor ? rt.seats.get(actor.seat) : null;
  if (!seatMeta || seatMeta.userId !== req.user.id)
    return res.status(403).json({ error: "not your turn" });
  const pending = !!req.body.pending;
  rt.hand.actionPending = pending;
  if (!pending && rt.hand.deadline) {
    // Resume: give the player a fresh remainder so chain latency isn't punished.
    rt.hand.deadline = Date.now() + rt.table.action_timer_seconds * 1000;
  }
  await broadcast(rt);
  res.json({ ok: true, paused: pending });
});

// Optional player entropy nonce for the NEXT hand (verifiable randomness).
app.post("/api/tables/:id/nonce", async (req, res) => {
  const rt = await loadRuntime(req.params.id);
  if (!rt) return res.status(404).json({ error: "table not found" });
  const nonce = typeof req.body.nonce === "string" ? req.body.nonce.slice(0, 128) : "";
  for (const [, s] of rt.seats) if (s.userId === req.user.id) s.nonce = nonce || null;
  res.json({ ok: true });
});

app.post("/api/tables/:id/sitin", async (req, res) => {
  const rt = await loadRuntime(req.params.id);
  if (!rt) return res.status(404).json({ error: "table not found" });
  const s = [...rt.seats.values()].find((x) => x.userId === req.user.id);
  if (!s) return res.status(404).json({ error: "not seated" });
  s.status = "active"; s.sitOutCount = 0;
  await pool.query(`UPDATE seats SET status='active', sit_out_count=0 WHERE table_id=$1 AND seat_no=$2`, [rt.table.id, s.seat_no]);
  maybeStartHand(rt);
  await broadcast(rt);
  res.json({ ok: true });
});

// ── Cash out: leave + enqueue on-chain payout of remaining chips ─────────────
app.post("/api/tables/:id/cashout", async (req, res) => {
  const rt = await loadRuntime(req.params.id);
  if (!rt) return res.status(404).json({ error: "table not found" });
  const s = [...rt.seats.values()].find((x) => x.userId === req.user.id);
  if (!s) return res.status(404).json({ error: "not seated" });
  // Can't leave mid-hand if currently in the hand (must fold/finish first).
  if (rt.hand && !rt.hand.engineState.complete) {
    const inHand = rt.hand.engineState.players.find((p) => p.seat === s.seat_no && !p.folded);
    if (inHand) return res.status(409).json({ error: "finish or fold the current hand before leaving" });
  }
  const amount = s.stack;
  rt.seats.delete(s.seat_no);
  await pool.query(`UPDATE seats SET user_id=NULL, username=NULL, wallet=NULL, stack=0, status='empty' WHERE table_id=$1 AND seat_no=$2`, [rt.table.id, s.seat_no]);

  // Log activity event
  if (amount > 0) {
    await insertActivityEvent(rt.table.id, "cashout", s.userId, s.seat_no, null, { amount, final_stack: amount });
  }

  let payout = null;
  if (amount > 0 && s.wallet) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO treasury_ledger (id, table_id, user_id, wallet, kind, amount, status)
       VALUES ($1,$2,$3,$4,'cashout',$5,'pending')`,
      [id, rt.table.id, req.user.id, s.wallet, amount]);
    payout = { id, amount, status: "pending" };
    settlePayoutsSoon();
  }
  await broadcast(rt);
  res.json({ ok: true, cashed_out: amount, payout });
});

// ── Hand history + verification (public table data) ──────────────────────────
app.get("/api/tables/:id/hands", async (req, res) => {
  const r = await pool.query(
    `SELECT id, hand_no, board, commitment, seed, result, commit_tx, reveal_tx, ended_at
     FROM hands WHERE table_id=$1 AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 50`, [req.params.id]);
  res.json({ hands: r.rows.map((h) => ({
    id: h.id, hand_no: h.hand_no, board: h.board, commitment: h.commitment,
    revealed_seed: h.seed, result: h.result, commit_tx: h.commit_tx, reveal_tx: h.reveal_tx, ended_at: h.ended_at,
  })) });
});

// ── Activity feed: recent events across all tables (public) ──────────────────────
app.get("/api/activity", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "activity feed unavailable" });
  const r = await pool.query(
    `SELECT id, table_id, event_type, user_id, seat_no, metadata, created_at FROM activity_events
     ORDER BY created_at DESC LIMIT 50`);
  const events = r.rows.map((row) => ({
    id: row.id,
    table_id: row.table_id,
    type: row.event_type,
    user_id: row.user_id,
    seat_no: row.seat_no,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: row.created_at,
  }));
  res.json({ events });
});

app.get("/api/hands/:id/verify", async (req, res) => {
  const r = await pool.query(`SELECT * FROM hands WHERE id=$1`, [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: "hand not found" });
  const h = r.rows[0];
  const nonces = Array.isArray(h.nonces) ? h.nonces : (h.nonces || []);
  const check = fairness.verifyHand({
    secret: h.seed, nonces, handId: h.id, commitment: h.commitment, deck: h.deck,
  });
  res.json({
    hand_id: h.id, commitment: h.commitment, revealed_seed: h.seed, nonces,
    shuffle_seed: h.seed ? fairness.computeShuffleSeed(h.seed, nonces, h.id) : null,
    deck: h.deck, board: h.board, result: h.result,
    commit_tx: h.commit_tx, reveal_tx: h.reveal_tx,
    verification: check,
  });
});

// ── Spectate: join as a watcher (no chips, all hole cards permanently redacted) ─
app.post("/api/tables/:id/spectate", async (req, res) => {
  const rt = await loadRuntime(req.params.id);
  if (!rt) return res.status(404).json({ error: "table not found" });
  if (rt.table.allow_spectators === false)
    return res.status(403).json({ error: "spectators are not allowed at this table" });
  // Seated players watch from their seat; they don't need to call this.
  const isSeated = [...rt.seats.values()].some((s) => s.userId === req.user.id);
  if (isSeated) return res.status(409).json({ error: "you are already seated — watch from your seat" });
  rt.spectators.add(req.user.id);
  res.json({ ok: true });
});

// ── SSE table stream (redacted per viewer) ───────────────────────────────────
app.get("/api/tables/:id/stream", async (req, res) => {
  const rt = await loadRuntime(req.params.id);
  if (!rt) return res.status(404).json({ error: "table not found" });

  // Load recent activity events.
  rt.recentActivity = await getRecentActivity(rt.table.id);

  // Determine if this connection is from a spectator or a seated player.
  const isSeated = [...rt.seats.values()].some((s) => s.userId === req.user.id);
  const isSpectator = !isSeated;
  if (isSpectator && rt.table.allow_spectators === false)
    return res.status(403).json({ error: "spectators are not allowed at this table" });
  // Track in the in-memory spectator set so the lobby shows an accurate count.
  if (isSpectator) rt.spectators.add(req.user.id);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const entry = { res, userId: req.user.id, isSpectator };
  if (!sseClients.has(req.params.id)) sseClients.set(req.params.id, new Set());
  sseClients.get(req.params.id).add(entry);
  // Initial snapshot.
  res.write(`data: ${JSON.stringify(buildTableView(rt, req.user.id, isSpectator))}\n\n`);
  const ka = setInterval(() => res.write(": ka\n\n"), 20000);
  req.on("close", () => {
    clearInterval(ka);
    const set = sseClients.get(req.params.id);
    if (set) set.delete(entry);
    // Remove from spectator set when disconnected (accurate count for lobby).
    if (isSpectator) {
      const stillConnected = set && [...set].some((e) => e.userId === req.user.id && e.isSpectator);
      if (!stillConnected) rt.spectators.delete(req.user.id);
    }
  });
});

async function broadcast(rt) {
  const set = sseClients.get(rt.table.id);
  if (!set) return;
  // Reload activity cache if stale.
  rt.recentActivity = await getRecentActivity(rt.table.id);
  // Broadcast to seated players first (they see the reveal), then spectators
  // (permanently redacted). Order matters at showdown so seated viewers get
  // hole cards in the same tick that the hand completes.
  const entries = [...set];
  const seated = entries.filter((e) => !e.isSpectator);
  const watching = entries.filter((e) => e.isSpectator);
  for (const entry of seated) {
    try { entry.res.write(`data: ${JSON.stringify(buildTableView(rt, entry.userId, false))}\n\n`); } catch (_) {}
  }
  for (const entry of watching) {
    try { entry.res.write(`data: ${JSON.stringify(buildTableView(rt, entry.userId, true))}\n\n`); } catch (_) {}
  }
}

// ── Game loop ────────────────────────────────────────────────────────────────
function seatedActivePlayers(rt) {
  return [...rt.seats.values()]
    .filter((s) => s.status === "active" && s.stack > 0)
    .sort((a, b) => a.seat_no - b.seat_no);
}

async function maybeStartHand(rt) {
  if (rt.hand && !rt.hand.engineState.complete) return;
  if (rt.starting) return;
  // Replenish and fill bots before counting players.
  if (rt.table.allow_bots) {
    replenishBrokeBots(rt);
    fillEmptySeatsWithBots(rt);
  }
  const players = seatedActivePlayers(rt);
  if (players.length < 2) return;
  // Need at least one human at a bot table (bots don't play alone).
  if (rt.table.allow_bots && players.every((p) => isBotUserId(p.userId))) return;
  rt.starting = true;
  try {
    await startHand(rt, players);
  } catch (e) {
    console.warn("[hand] start failed:", e.message);
  } finally {
    rt.starting = false;
  }
}

async function startHand(rt, players) {
  rt.lastHandNo += 1;
  const handNo = rt.lastHandNo;
  const handId = `${rt.table.id}-h${handNo}-${crypto.randomBytes(3).toString("hex")}`;

  // Button rotates to the next occupied seat.
  let buttonIdx = 0;
  if (rt.button >= 0) {
    const prevSeat = rt.button;
    const after = players.findIndex((p) => p.seat_no > prevSeat);
    buttonIdx = after === -1 ? 0 : after;
  }
  rt.button = players[buttonIdx].seat_no;

  // Provably-fair: secret, player nonces, commitment BEFORE dealing.
  const secret = fairness.newSecret();
  const nonces = players.map((p) => p.nonce || crypto.randomBytes(8).toString("hex"));
  const commitment = fairness.commitmentOf(secret);
  const shuffleSeed = fairness.computeShuffleSeed(secret, nonces, handId);
  const deck = fairness.dealtDeck(secret, nonces, handId);

  await pool.query(
    `INSERT INTO hand_secrets (hand_id, seed, shuffle_seed, commitment, deck, nonces, anchored, revealed)
     VALUES ($1,$2,$3,$4,$5,$6,false,false)`,
    [handId, secret, shuffleSeed, commitment, deck, JSON.stringify(nonces)]);

  const enginePlayers = players.map((p) => ({
    seat: p.seat_no, userId: p.userId, username: p.username, wallet: p.wallet, stack: p.stack,
  }));
  const engineState = createHand({
    players: enginePlayers, button: buttonIdx,
    sb: Number(rt.table.sb), bb: Number(rt.table.bb), deck, handId,
  });

  // Persist hole cards (private) for human seats only — bots have no DB row.
  for (const p of engineState.players) {
    const seatMeta = rt.seats.get(p.seat);
    if (seatMeta && !seatMeta.is_bot) {
      await pool.query(
        `INSERT INTO hole_cards (hand_id, seat_no, user_id, cards) VALUES ($1,$2,$3,$4)
         ON CONFLICT (hand_id, seat_no) DO NOTHING`,
        [handId, p.seat, seatMeta.userId, p.holeCards]);
    }
  }
  await pool.query(
    `INSERT INTO hands (id, table_id, hand_no, button_seat, board, commitment, nonces, deck)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
    [handId, rt.table.id, handNo, rt.button, [], commitment, JSON.stringify(nonces), deck]);

  rt.hand = {
    id: handId, handNo, engineState, commitment, nonces,
    deadline: engineState.complete ? null : Date.now() + rt.table.action_timer_seconds * 1000,
    actionPending: false,
  };

  // Anchor the commitment on-chain (best-effort; gameplay does not block on it,
  // see Considerations — the commitment is fixed before any card is revealed).
  anchorCommit(handId, commitment).catch(() => {});

  await broadcast(rt);
  if (engineState.complete) {
    finishHand(rt); // e.g. everyone all-in from blinds
  } else {
    scheduleBot(rt, advanceHand, scheduleBot);
  }
}

function advanceHand(rt, action) {
  const before = rt.hand.engineState;
  const next = applyAction(before, action);
  rt.hand.engineState = next;
  rt.hand.actionPending = false;
  if (next.complete) {
    finishHand(rt);
  } else {
    rt.hand.deadline = Date.now() + rt.table.action_timer_seconds * 1000;
    broadcast(rt).catch(() => {});
    scheduleBot(rt, advanceHand, scheduleBot);
  }
}

async function finishHand(rt) {
  const hand = rt.hand;
  const engine = hand.engineState;
  // Settle the ledger: seats.stack := engine final stacks (pot is conserved).
  // Bot seats are in-memory only — no DB writes for them.
  for (const p of engine.players) {
    const seat = rt.seats.get(p.seat);
    if (seat) {
      seat.stack = p.stack;
      if (seat.is_bot) continue;
      await pool.query(`UPDATE seats SET stack=$1 WHERE table_id=$2 AND seat_no=$3`, [p.stack, rt.table.id, p.seat]);
      if (seat.stack === 0) {
        seat.status = "sitting_out";
        await pool.query(`UPDATE seats SET status='sitting_out' WHERE table_id=$1 AND seat_no=$2`, [rt.table.id, p.seat]);
        // Log sit-out event
        await insertActivityEvent(rt.table.id, "sitout", seat.userId, p.seat, null, { reason: "broke" });
      }
    }
  }
  // Reveal: persist seed + result publicly; the deck/seed are now safe to expose.
  await pool.query(
    `UPDATE hands SET board=$1, seed=$2, result=$3, ended_at=now() WHERE id=$4`,
    [engine.board, await secretOf(hand.id), JSON.stringify(engine.result), hand.id]);
  await pool.query(`UPDATE hand_secrets SET revealed=true WHERE hand_id=$1`, [hand.id]);

  // Log hand completion and winner events
  if (engine.result && engine.result.winners) {
    for (const winner of engine.result.winners) {
      const seat = rt.seats.get(winner.seat);
      await insertActivityEvent(rt.table.id, "win", seat ? seat.userId : null, winner.seat, hand.id,
        { amount: winner.amount, hand_name: winner.name, board: engine.board, competing_count: engine.players.length });
    }
  }
  const pot = engine.result && engine.result.pots
    ? engine.result.pots.reduce((a, p) => a + p.amount, 0)
    : engine.players.reduce((a, p) => a + p.committedTotal, 0);
  await insertActivityEvent(rt.table.id, "hand_complete", null, null, hand.id,
    { board: engine.board, pot, winner_count: (engine.result && engine.result.winners ? engine.result.winners.length : 0) });

  // Write the seed reveal on-chain (best-effort, retried by the poller).
  anchorReveal(hand.id).catch(() => {});

  await broadcast(rt);

  // Start the next hand shortly so showdown is visible.
  setTimeout(() => { maybeStartHand(rt); }, 4000);
}

async function secretOf(handId) {
  const r = await pool.query(`SELECT seed FROM hand_secrets WHERE hand_id=$1`, [handId]);
  return r.rowCount ? r.rows[0].seed : null;
}

// ── On-chain audit anchoring (commit/reveal) ─────────────────────────────────
async function anchorCommit(handId, commitment) {
  const memo = JSON.stringify({ app: "poker", type: "hand-commit", hid: handId, c: commitment });
  const r = await treasury.submit({ to: treasury.address(), amount: 0, memo });
  if (r.ok) {
    await pool.query(`UPDATE hand_secrets SET anchored=true, commit_tx=$1 WHERE hand_id=$2`, [r.txHash || null, handId]);
    await pool.query(`UPDATE hands SET commit_tx=$1 WHERE id=$2`, [r.txHash || null, handId]);
  }
}

async function anchorReveal(handId) {
  const sec = await pool.query(`SELECT seed, commitment FROM hand_secrets WHERE hand_id=$1`, [handId]);
  if (!sec.rowCount) return;
  const memo = JSON.stringify({ app: "poker", type: "hand-reveal", hid: handId, s: sec.rows[0].seed });
  const r = await treasury.submit({ to: treasury.address(), amount: 0, memo });
  if (r.ok) {
    await pool.query(`UPDATE hand_secrets SET reveal_tx=$1 WHERE hand_id=$2`, [r.txHash || null, handId]);
    await pool.query(`UPDATE hands SET reveal_tx=$1 WHERE id=$2`, [r.txHash || null, handId]);
  }
}

// ── Timer tick: auto-act on expiry, respecting the chain-pending pause ────────
setInterval(() => {
  for (const rt of runtimes.values()) {
    const hand = rt.hand;
    if (!hand || hand.engineState.complete) continue;
    const engine = hand.engineState;
    const legal = legalActions(engine);
    if (!legal) continue;
    const active = timerLogic.timerActive({ hasActor: true, actionPending: hand.actionPending });
    if (!active) continue;
    if (hand.deadline && Date.now() >= hand.deadline) {
      const seat = rt.seats.get(legal.seat);
      const action = timerLogic.timeoutAction(legal);
      try {
        if (seat) {
          seat.sitOutCount = (seat.sitOutCount || 0) + 1;
          if (timerLogic.shouldSitOut(seat.sitOutCount, SIT_OUT_AFTER)) {
            seat.status = "sitting_out";
            pool.query(`UPDATE seats SET status='sitting_out', sit_out_count=$1 WHERE table_id=$2 AND seat_no=$3`,
              [seat.sitOutCount, rt.table.id, seat.seat_no]).catch(() => {});
          }
        }
        advanceHand(rt, action);
      } catch (e) {
        console.warn("[timer] auto-action failed:", e.message);
      }
    }
  }
}, 1000);

// ── Staging demo keepalive ───────────────────────────────────────────────────
// The auto-fold timer eventually sits the seeded demo players out (or busts
// them to 0), which would stop the self-running demo and leave a stale, empty
// felt for later testers. In staging only, periodically revive the demo seats
// (fresh stacks, cleared sit-out) and restart a hand so the live table always
// has something to show. Strict no-op in production.
if (IS_STAGING) {
  setInterval(async () => {
    try {
      const rt = await loadRuntime(DEMO_TABLE_ID);
      if (!rt || (rt.hand && !rt.hand.engineState.complete)) return;
      const revived = [];
      for (const [seatNo, s] of rt.seats) {
        if (!s || !s.userId) continue;
        if (s.status !== "active" || s.stack <= 0) {
          s.status = "active";
          s.sitOutCount = 0;
          if (s.stack <= 0) s.stack = 2000 + seatNo * 500;
          revived.push([seatNo, s.stack]);
        }
      }
      for (const [seatNo, stack] of revived) {
        await pool.query(
          `UPDATE seats SET status='active', sit_out_count=0, stack=$1 WHERE table_id=$2 AND seat_no=$3`,
          [stack, DEMO_TABLE_ID, seatNo]).catch(() => {});
      }
      maybeStartHand(rt).catch(() => {});
    } catch (_) {}
  }, 6000);
}

// ── Chain poller: credit buy-ins, settle payouts, expire sessions ────────────
let polling = false;
async function pollChain() {
  if (polling || !pool) return;
  polling = true;
  try {
    if (!chainId) chainId = await explorer.discoverChainId();
    if (!chainId || !treasury.address()) return;
    const recipient = treasury.address();
    const txs = await explorer.fetchInbound(chainId, recipient, lastHeight[recipient] || null);
    let maxH = lastHeight[recipient] || null;
    for (const tx of txs) {
      const h = explorer.txHeight(tx);
      if (h != null && (maxH == null || h > maxH)) maxH = h;
      await creditBuyin(tx);
    }
    if (maxH != null) lastHeight[recipient] = maxH;
    await settlePendingPayouts();
    await expireStaleSessions();
  } catch (e) {
    console.warn("[poll] error:", e.message);
  } finally {
    polling = false;
  }
}
function pollChainSoon() { setTimeout(() => pollChain().catch(() => {}), 1500); }
function settlePayoutsSoon() { setTimeout(() => settlePendingPayouts().catch(() => {}), 500); }

async function creditBuyin(tx) {
  const id = explorer.txId(tx);
  if (!id || consumedTxIds.has(id)) return;
  if (!explorer.txConfirmed(tx)) return;
  const memo = explorer.txMemo(tx);
  if (!memo || memo.app !== "poker" || memo.type !== "buyin" || typeof memo.sid !== "string") return;
  const r = await pool.query(`SELECT * FROM seat_sessions WHERE id=$1`, [memo.sid]);
  if (!r.rowCount) return;
  const sess = r.rows[0];
  if (sess.status === "credited") { consumedTxIds.add(id); return; }
  const amount = explorer.txAmount(tx);
  if (!(amount >= Number(sess.amount))) return; // under-paid: hold, don't credit

  // Credit chips 1:1 (ledger-backed pooled bank). Idempotent on tx id.
  await pool.query(
    `UPDATE seat_sessions SET status='credited', payment_tx_hash=$1, paid_amount=$2 WHERE id=$3`,
    [id, amount, sess.id]);

  const prevStack = await pool.query(
    `SELECT stack FROM seats WHERE table_id=$1 AND seat_no=$2`, [sess.table_id, sess.seat_no]);
  const oldStack = prevStack.rowCount ? Number(prevStack.rows[0].stack) : 0;

  await pool.query(
    `UPDATE seats SET stack = stack + $1, status='active' WHERE table_id=$2 AND seat_no=$3 AND user_id=$4`,
    [amount, sess.table_id, sess.seat_no, sess.user_id]);
  consumedTxIds.add(id);
  console.log(`[buyin] credited ${amount} to ${sess.user_id} seat ${sess.seat_no} (${sess.table_id})`);

  // Log activity event (join if first buy-in, buyin if adding to existing).
  const eventType = oldStack === 0 ? "join" : "buyin";
  await insertActivityEvent(sess.table_id, eventType, sess.user_id, sess.seat_no, null,
    { amount, old_stack: oldStack, new_stack: oldStack + amount });

  const rt = await loadRuntime(sess.table_id);
  if (rt) {
    const seat = rt.seats.get(sess.seat_no);
    if (seat) { seat.stack += amount; seat.status = "active"; }
    maybeStartHand(rt);
    await broadcast(rt);
  }
}

async function settlePendingPayouts() {
  if (!pool) return;
  const r = await pool.query(`SELECT * FROM treasury_ledger WHERE status='pending' ORDER BY created_at LIMIT 25`);
  for (const row of r.rows) {
    const memo = JSON.stringify({ app: "poker", type: "cashout", lid: row.id });
    const sub = await treasury.submit({ to: row.wallet, amount: Number(row.amount), memo });
    if (sub.ok) {
      await pool.query(`UPDATE treasury_ledger SET status='sent', payout_tx_hash=$1, sent_at=now() WHERE id=$2`,
        [sub.txHash || null, row.id]);
      console.log(`[payout] sent ${row.amount} to ${row.wallet} (${row.id})`);
    } else if (!sub.skipped) {
      console.warn(`[payout] ${row.id} failed: ${sub.reason} — will retry`);
    }
  }
}

async function expireStaleSessions() {
  await pool.query(
    `UPDATE seat_sessions SET status='expired'
     WHERE status='awaiting_payment' AND expires_at < now()`);
  // Free reserved seats whose only session expired and stack is still 0.
  const free = await pool.query(
    `SELECT s.table_id, s.seat_no FROM seats s
     WHERE s.status='sitting_out' AND s.stack=0
       AND NOT EXISTS (SELECT 1 FROM seat_sessions ss
            WHERE ss.table_id=s.table_id AND ss.seat_no=s.seat_no AND ss.status='awaiting_payment')`);
  for (const row of free.rows) {
    await pool.query(`UPDATE seats SET user_id=NULL, username=NULL, wallet=NULL, status='empty' WHERE table_id=$1 AND seat_no=$2`,
      [row.table_id, row.seat_no]);
    const rt = runtimes.get(row.table_id);
    if (rt) { rt.seats.delete(row.seat_no); await broadcast(rt); }
  }
}

// ── Static UI ────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!pool) {
    console.error("DATABASE_URL not set — cannot start poker app");
    process.exit(1);
  }
  await migrate();
  await ensureDefaultTable();
  await seedStaging();
  // Kick off a self-running demo hand in staging so the live felt (phase pill,
  // dealer/blind badges, action timer ring, auto-showdown) is visible without a
  // second human player. The timer tick auto-acts for the seeded demo seats.
  if (IS_STAGING) {
    const demoRt = await loadRuntime(DEMO_TABLE_ID);
    if (demoRt) {
      // Seed 2 fake spectators so the spectator count shows in the lobby.
      demoRt.spectators.add("staging-demo-spectator-1");
      demoRt.spectators.add("staging-demo-spectator-2");
      // Pre-fill bot seats so they appear in the lobby before the first hand.
      fillEmptySeatsWithBots(demoRt);
      maybeStartHand(demoRt).catch(() => {});
    }
  }
  setInterval(() => pollChain().catch(() => {}), 30000);
  pollChain().catch(() => {});
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Poker app listening on :${PORT} (${IS_STAGING ? "staging" : "production"})`);
    console.log(`Treasury: ${treasury.address() || "(unset)"} signing=${treasury.signingEnabled()}`);
  });
}

if (require.main === module) main();

module.exports = { app, fairness };
