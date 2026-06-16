#!/usr/bin/env node
// staging rebuild trigger #3
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── .env loader ───────────────────────────────────────────────────────────────
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[k] == null) process.env[k] = v;
  }
})();

// ── Config ────────────────────────────────────────────────────────────────────
const PORT                 = Number(process.env.PORT) || 3000;
const JWT_SECRET           = process.env.JWT_SECRET || '';
const DATABASE_URL         = process.env.DATABASE_URL || '';
const IS_STAGING           = process.env.USERNODE_ENV === 'staging';
const TURN_TIMER_SECONDS   = Number(process.env.TURN_TIMER_SECONDS) || 30;
const REMATCH_WINDOW_SECS  = Number(process.env.REMATCH_WINDOW_SECONDS) || 30;
const CHAT_MAX_LEN         = Number(process.env.CHAT_MAX_LEN) || 200;
const ROOM_IDLE_TTL_SECS   = Number(process.env.ROOM_IDLE_TTL_SECONDS) || 300;
const LEADERBOARD_LIMIT    = Number(process.env.LEADERBOARD_LIMIT) || 50;
const QUEUE_TIMEOUT_SECS   = Number(process.env.QUEUE_TIMEOUT_SECONDS) || 60;

const INDEX_PATH = path.join(__dirname, 'index.html');
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');

// ── Postgres ──────────────────────────────────────────────────────────────────
let PgPool = null;
try { PgPool = require('pg').Pool; } catch (_) { console.warn('[ttt] pg module not available — DB features disabled'); }
const pool = (PgPool && DATABASE_URL) ? new PgPool({ connectionString: DATABASE_URL }) : null;
if (pool) pool.on('error', (e) => console.warn(`[ttt] pg pool error: ${e.message}`));
const DB = !!pool;

// ── Engine ────────────────────────────────────────────────────────────────────
const { checkWinner, isDraw, applyMove, emptyCells } = require('./engine/game');
const { getAIMove } = require('./engine/ai');

// ── In-memory state ───────────────────────────────────────────────────────────
const runtimes = new Map();        // roomId -> GameRuntime
const matchQueue = new Map();      // userId -> { userId, username, queuedAt }
const moveLimiter = new Map();     // userId -> lastMoveAt ms

// ── JWT helpers ───────────────────────────────────────────────────────────────
function b64urlToBuf(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function verifyJwt(token) {
  if (!token || !JWT_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [hB64, pB64, sB64] = parts;
  let header;
  try { header = JSON.parse(b64urlToBuf(hB64).toString('utf8')); } catch (_) { return null; }
  if (!header || header.alg !== 'HS256') return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${hB64}.${pB64}`).digest();
  const got = b64urlToBuf(sB64);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToBuf(pB64).toString('utf8')); } catch (_) { return null; }
  if (payload && typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

function getUser(req) {
  try {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const tok = req.headers['x-usernode-token'] || urlObj.searchParams.get('token') || '';
    const payload = verifyJwt(tok);
    if (!payload || payload.id == null) return null;
    const id = String(payload.id);
    const username = payload.username || payload.name || payload.preferred_username || `user_${id.slice(0, 8)}`;
    return { id, username, usernode_pubkey: payload.usernode_pubkey || null };
  } catch (_) { return null; }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  send(res, status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }, body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limitBytes) { done = true; req.destroy(); resolve(undefined); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve(null);
      try { resolve(JSON.parse(text)); } catch (_) { resolve(undefined); }
    });
    req.on('error', () => resolve(null));
  });
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
function sseWrite(res, eventType, data) {
  try { res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}

function broadcast(roomId, eventType, data) {
  const rt = runtimes.get(roomId);
  if (!rt) return;
  for (const client of rt.sseClients) {
    sseWrite(client.res, eventType, data);
  }
}

// ── Password helpers ──────────────────────────────────────────────────────────
function hashPassword(plain, saltHex) {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return { hash, salt };
}

function passwordMatches(rt, plain) {
  if (!rt.passwordHash || !rt.passwordSalt) return false;
  if (!plain) return false;
  const { hash } = hashPassword(plain, rt.passwordSalt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(rt.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Game state snapshot ───────────────────────────────────────────────────────
function buildGameState(rt) {
  return {
    roomId: rt.roomId,
    gameId: rt.gameId ? String(rt.gameId) : null,
    name: rt.name,
    status: rt.status,
    result: rt.result || null,
    board: rt.board,
    currentTurn: rt.currentTurn,
    turnDeadline: rt.turnDeadline,
    winLine: rt.winLine || null,
    playerX: rt.playerX,
    playerO: rt.playerO,
    spectatorCount: rt.spectators.size,
    chatEnabled: rt.chatEnabled,
    spectatorsAllowed: rt.spectatorsAllowed,
    opponentType: rt.opponentType,
    visibility: rt.visibility,
    turnTimerSeconds: rt.turnTimerSeconds,
  };
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function clearTimer(rt) {
  if (rt.timerHandle) { clearTimeout(rt.timerHandle); rt.timerHandle = null; }
}

function armTimer(rt) {
  clearTimer(rt);
  rt.turnDeadline = Date.now() + rt.turnTimerSeconds * 1000;
  rt.timerHandle = setTimeout(() => forfeitTimeout(rt.roomId, rt.currentTurn), rt.turnTimerSeconds * 1000 + 200);
}

// ── Stats update ──────────────────────────────────────────────────────────────
async function updateStats(userId, username, outcome) {
  if (!pool) return;
  // outcome: 'win' | 'loss' | 'draw'
  const w = outcome === 'win' ? 1 : 0;
  const l = outcome === 'loss' ? 1 : 0;
  const d = outcome === 'draw' ? 1 : 0;
  await pool.query(`
    INSERT INTO ttt_stats (user_id, username, games_played, wins, losses, draws, current_streak, best_streak, updated_at)
    VALUES ($1, $2, 1, $3, $4, $5,
      CASE WHEN $3 = 1 THEN 1 ELSE 0 END,
      CASE WHEN $3 = 1 THEN 1 ELSE 0 END,
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      username       = EXCLUDED.username,
      games_played   = ttt_stats.games_played + 1,
      wins           = ttt_stats.wins + $3,
      losses         = ttt_stats.losses + $4,
      draws          = ttt_stats.draws + $5,
      current_streak = CASE WHEN $3 = 1 THEN ttt_stats.current_streak + 1 ELSE 0 END,
      best_streak    = CASE WHEN $3 = 1 THEN GREATEST(ttt_stats.best_streak, ttt_stats.current_streak + 1) ELSE ttt_stats.best_streak END,
      updated_at     = now()
  `, [userId, username, w, l, d]);
}

// ── Achievements ──────────────────────────────────────────────────────────────
const ACHIEVEMENT_DEFS = [
  { id: 'first_win',       check: (s)     => s.wins >= 1 },
  { id: 'hat_trick',       check: (s)     => s.current_streak >= 3 },
  { id: 'decade',          check: (s)     => s.wins >= 10 },
  { id: 'centurion',       check: (s)     => s.wins >= 100 },
  { id: 'ai_crusher',      check: (s, c)  => c.justWon && c.opponentType === 'ai_hard' },
  { id: 'blitz',           check: (s, c)  => c.justWon && typeof c.timerSecondsLeft === 'number' && c.timerSecondsLeft >= 20 },
  { id: 'social',          check: (s, c)  => s.games_played >= 5 && c.chatEnabled },
  { id: 'draw_specialist', check: (s)     => s.draws >= 10 },
];

async function checkAchievements(userId, ctx) {
  if (!pool) return [];
  try {
    const sr = await pool.query('SELECT * FROM ttt_stats WHERE user_id = $1', [userId]);
    if (!sr.rows.length) return [];
    const stats = sr.rows[0];
    const er = await pool.query('SELECT achievement_id FROM ttt_achievements WHERE user_id = $1', [userId]);
    const existing = new Set(er.rows.map((r) => r.achievement_id));
    const newIds = [];
    for (const def of ACHIEVEMENT_DEFS) {
      if (existing.has(def.id)) continue;
      if (def.check(stats, ctx)) {
        await pool.query(
          'INSERT INTO ttt_achievements (user_id, achievement_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userId, def.id]
        );
        newIds.push(def.id);
      }
    }
    return newIds;
  } catch (e) {
    console.warn(`[ttt] achievement check error: ${e.message}`);
    return [];
  }
}

// ── End game ──────────────────────────────────────────────────────────────────
async function endGame(rt, result, winnerId, loserId, ctx) {
  rt.status = 'finished';
  rt.result = result;
  clearTimer(rt);

  if (pool) {
    try {
      await pool.query(
        'UPDATE ttt_games SET result=$1, board=$2, winner_id=$3, ended_at=now(), moves=$4 WHERE id=$5',
        [result, rt.board, winnerId || null, JSON.stringify(rt.moves), rt.gameId]
      );
      await pool.query('UPDATE ttt_rooms SET status=\'finished\', updated_at=now() WHERE id=$1', [rt.roomId]);

      const isDraw_ = result === 'draw';
      const isXWin = result === 'x_wins' || result === 'o_forfeit';
      const isOWin = result === 'o_wins' || result === 'x_forfeit';

      if (rt.playerX && !rt.playerX.id.startsWith('ai_')) {
        const xOutcome = isDraw_ ? 'draw' : (isXWin ? 'win' : 'loss');
        await updateStats(rt.playerX.id, rt.playerX.username, xOutcome);
        const xCtx = { ...ctx, justWon: isXWin };
        const newX = await checkAchievements(rt.playerX.id, xCtx);
        if (newX.length) broadcast(rt.roomId, 'achievement_unlocked', { userId: rt.playerX.id, achievements: newX });
      }
      if (rt.playerO && !rt.playerO.id.startsWith('ai_')) {
        const oOutcome = isDraw_ ? 'draw' : (isOWin ? 'win' : 'loss');
        await updateStats(rt.playerO.id, rt.playerO.username, oOutcome);
        const oCtx = { ...ctx, justWon: isOWin };
        const newO = await checkAchievements(rt.playerO.id, oCtx);
        if (newO.length) broadcast(rt.roomId, 'achievement_unlocked', { userId: rt.playerO.id, achievements: newO });
      }
    } catch (e) {
      console.warn(`[ttt] endGame db error: ${e.message}`);
    }
  }

  broadcast(rt.roomId, 'game_over', {
    result,
    winnerId: winnerId || null,
    board: rt.board,
    winLine: rt.winLine || null,
  });
}

// ── Forfeit on timeout ────────────────────────────────────────────────────────
async function forfeitTimeout(roomId, forfeitedTurn) {
  const rt = runtimes.get(roomId);
  if (!rt || rt.status !== 'playing') return;
  if (rt.currentTurn !== forfeitedTurn) return; // move slipped in just before

  const result = forfeitedTurn === 'X' ? 'x_forfeit' : 'o_forfeit';
  const winnerId = forfeitedTurn === 'X' ? (rt.playerO && rt.playerO.id) : (rt.playerX && rt.playerX.id);
  const loserId  = forfeitedTurn === 'X' ? (rt.playerX && rt.playerX.id) : (rt.playerO && rt.playerO.id);

  await endGame(rt, result, winnerId, loserId, {
    opponentType: rt.opponentType,
    timerSecondsLeft: 0,
    chatEnabled: rt.chatEnabled,
  });
}

// ── Start game ────────────────────────────────────────────────────────────────
async function startGame(rt) {
  rt.status = 'playing';
  rt.board = Array(9).fill(null);
  rt.currentTurn = 'X';
  rt.result = null;
  rt.winLine = null;
  rt.moves = [];
  rt.rematchVotes.clear();
  if (rt.rematchHandle) { clearTimeout(rt.rematchHandle); rt.rematchHandle = null; }

  if (pool) {
    try {
      const r = await pool.query(
        `INSERT INTO ttt_games (room_id, player_x_id, player_o_id, player_x_username, player_o_username)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [rt.roomId, rt.playerX.id, rt.playerO.id, rt.playerX.username, rt.playerO.username]
      );
      rt.gameId = r.rows[0].id;
      await pool.query('UPDATE ttt_rooms SET status=\'playing\', updated_at=now() WHERE id=$1', [rt.roomId]);
    } catch (e) {
      console.warn(`[ttt] startGame db error: ${e.message}`);
    }
  }

  armTimer(rt);
  broadcast(rt.roomId, 'game_state', buildGameState(rt));

  // If it's an AI room and X goes first (AI is O), AI goes after first human move.
  // X is always the human creator, so AI (O) waits for human's first move.
}

// ── Schedule AI move ──────────────────────────────────────────────────────────
function scheduleAI(rt) {
  if (!rt.playerO || !rt.playerO.id.startsWith('ai_')) return;
  if (rt.currentTurn !== 'O') return;
  if (rt.status !== 'playing') return;

  const difficulty = rt.playerO.id.replace('ai_', '');
  setTimeout(async () => {
    const current = runtimes.get(rt.roomId);
    if (!current || current.status !== 'playing' || current.currentTurn !== 'O') return;

    const cell = getAIMove(current.board, difficulty, 'O');
    await applyGameMove(current, 'O', current.playerO.id, cell, 0);
  }, 400);
}

// ── Apply a validated move ────────────────────────────────────────────────────
async function applyGameMove(rt, player, userId, cell, timerSecondsLeft) {
  rt.board = applyMove(rt.board, cell, player);
  rt.moves.push({ cell, player, ts_ms: Date.now() });
  rt.currentTurn = player === 'X' ? 'O' : 'X';

  const winner = checkWinner(rt.board);
  const draw = !winner && isDraw(rt.board);

  if (winner) {
    rt.winLine = winner.line;
    const winnerPlayer = player === 'X' ? rt.playerX : rt.playerO;
    const loserPlayer  = player === 'X' ? rt.playerO : rt.playerX;
    const result = player === 'X' ? 'x_wins' : 'o_wins';
    await endGame(rt, result, winnerPlayer.id, loserPlayer.id, {
      opponentType: rt.opponentType,
      timerSecondsLeft,
      chatEnabled: rt.chatEnabled,
    });
  } else if (draw) {
    await endGame(rt, 'draw', null, null, {
      opponentType: rt.opponentType,
      timerSecondsLeft,
      chatEnabled: rt.chatEnabled,
    });
  } else {
    // Game continues — re-arm timer and broadcast updated state
    armTimer(rt);
    broadcast(rt.roomId, 'game_state', buildGameState(rt));
    scheduleAI(rt);
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────

// GET /api/ttt/config
function handleConfig(req, res) {
  sendJson(res, 200, {
    turnTimerSeconds:   TURN_TIMER_SECONDS,
    rematchWindowSecs:  REMATCH_WINDOW_SECS,
    chatMaxLen:         CHAT_MAX_LEN,
    leaderboardLimit:   LEADERBOARD_LIMIT,
    queueTimeoutSecs:   QUEUE_TIMEOUT_SECS,
    dbEnabled:          DB,
  });
}

// GET /api/ttt/rooms
async function handleListRooms(req, res) {
  if (!pool) {
    // Fall back to in-memory
    const rooms = [];
    for (const [, rt] of runtimes) {
      if (rt.visibility !== 'public') continue;
      if (rt.status !== 'waiting') continue;
      rooms.push({
        roomId: rt.roomId,
        name: rt.name,
        createdBy: rt.createdBy,
        playerCount: (rt.playerX ? 1 : 0) + (rt.playerO ? 1 : 0),
        spectatorCount: rt.spectators.size,
        spectatorsAllowed: rt.spectatorsAllowed,
        opponentType: rt.opponentType,
        hasPassword: !!rt.passwordHash,
        turnTimerSeconds: rt.turnTimerSeconds,
        chatEnabled: rt.chatEnabled,
      });
    }
    return sendJson(res, 200, { rooms });
  }
  try {
    const { rows } = await pool.query(`
      SELECT id, name, created_by, player_x_id, player_o_id, spectators_allowed,
             opponent_type, password_hash IS NOT NULL AS has_password,
             turn_timer_seconds, chat_enabled, created_at
      FROM ttt_rooms
      WHERE status = 'waiting' AND visibility = 'public'
      ORDER BY created_at DESC
      LIMIT 50
    `);
    const rooms = rows.map((r) => ({
      roomId: r.id,
      name: r.name,
      createdBy: r.created_by,
      playerCount: (r.player_x_id ? 1 : 0) + (r.player_o_id ? 1 : 0),
      spectatorCount: runtimes.has(r.id) ? runtimes.get(r.id).spectators.size : 0,
      spectatorsAllowed: r.spectators_allowed,
      opponentType: r.opponent_type,
      hasPassword: r.has_password,
      turnTimerSeconds: r.turn_timer_seconds,
      chatEnabled: r.chat_enabled,
    }));
    sendJson(res, 200, { rooms });
  } catch (e) {
    console.warn(`[ttt] listRooms error: ${e.message}`);
    sendJson(res, 500, { error: 'Internal error' });
  }
}

// POST /api/ttt/rooms
async function handleCreateRoom(req, res, user) {
  const body = await readBody(req, 8 * 1024);
  if (body === undefined) return sendJson(res, 400, { error: 'Invalid JSON' });

  const name         = (body && typeof body.name === 'string' ? body.name.trim() : '').slice(0, 40) || `${user.username}'s Room`;
  const visibility   = (body && body.visibility === 'private') ? 'private' : 'public';
  const opponentType = ['ai_easy', 'ai_medium', 'ai_hard'].includes(body && body.opponentType) ? body.opponentType : 'human';
  const spectatorsOk = body && body.spectatorsAllowed === false ? false : true;
  const chatEnabled  = body && body.chatEnabled === false ? false : true;
  const timer        = [15, 30, 60].includes(Number(body && body.turnTimerSeconds)) ? Number(body.turnTimerSeconds) : TURN_TIMER_SECONDS;
  const rawPassword  = (body && typeof body.password === 'string') ? body.password.trim() : '';

  let passwordHash = null, passwordSalt = null;
  if (visibility === 'private' && rawPassword) {
    const h = hashPassword(rawPassword);
    passwordHash = h.hash;
    passwordSalt = h.salt;
  }

  const roomId = crypto.randomUUID();

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO ttt_rooms (id, name, visibility, password_hash, password_salt, opponent_type, spectators_allowed, chat_enabled, turn_timer_seconds, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'waiting',$10)`,
        [roomId, name, visibility, passwordHash, passwordSalt, opponentType, spectatorsOk, chatEnabled, timer, user.id]
      );
    } catch (e) {
      console.warn(`[ttt] createRoom db error: ${e.message}`);
      return sendJson(res, 500, { error: 'Could not create room' });
    }
  }

  const rt = {
    roomId, name, visibility, opponentType,
    spectatorsAllowed: spectatorsOk, chatEnabled,
    turnTimerSeconds: timer,
    passwordHash, passwordSalt,
    createdBy: user.id,
    status: 'waiting',
    board: Array(9).fill(null),
    currentTurn: 'X',
    result: null, winLine: null,
    playerX: null, playerO: null,
    spectators: new Set(),
    sseClients: new Set(),
    timerHandle: null, turnDeadline: 0,
    moves: [], rematchVotes: new Set(), rematchHandle: null,
    gameId: null,
    lastActivityAt: Date.now(),
  };
  runtimes.set(roomId, rt);

  // Creator joins as X
  rt.playerX = { id: user.id, username: user.username };
  if (pool) {
    pool.query('UPDATE ttt_rooms SET player_x_id=$1, player_x_username=$2, updated_at=now() WHERE id=$3',
      [user.id, user.username, roomId]).catch((e) => console.warn(`[ttt] join db: ${e.message}`));
  }

  // If AI, O joins immediately and game starts
  if (opponentType !== 'human') {
    const diff = opponentType.replace('ai_', '');
    const aiName = `AI (${diff.charAt(0).toUpperCase() + diff.slice(1)})`;
    rt.playerO = { id: opponentType, username: aiName };
    if (pool) {
      pool.query('UPDATE ttt_rooms SET player_o_id=$1, player_o_username=$2, updated_at=now() WHERE id=$3',
        [opponentType, aiName, roomId]).catch(() => {});
    }
    await startGame(rt);
  }

  sendJson(res, 201, { roomId, name, visibility, opponentType });
}

// GET /api/ttt/rooms/:id
async function handleGetRoom(req, res, roomId) {
  let rt = runtimes.get(roomId);
  if (!rt && pool) {
    try {
      const { rows } = await pool.query('SELECT * FROM ttt_rooms WHERE id=$1', [roomId]);
      if (!rows.length) return sendJson(res, 404, { error: 'Room not found' });
      const r = rows[0];
      // Reconstruct a minimal runtime for read-only viewing
      rt = {
        roomId, name: r.name, visibility: r.visibility, opponentType: r.opponent_type,
        spectatorsAllowed: r.spectators_allowed, chatEnabled: r.chat_enabled,
        turnTimerSeconds: r.turn_timer_seconds, passwordHash: r.password_hash, passwordSalt: r.password_salt,
        createdBy: r.created_by, status: r.status,
        board: Array(9).fill(null), currentTurn: 'X', result: null, winLine: null,
        playerX: r.player_x_id ? { id: r.player_x_id, username: r.player_x_username } : null,
        playerO: r.player_o_id ? { id: r.player_o_id, username: r.player_o_username } : null,
        spectators: new Set(), sseClients: new Set(),
        timerHandle: null, turnDeadline: 0, moves: [], rematchVotes: new Set(),
        rematchHandle: null, gameId: null, lastActivityAt: Date.now(),
      };
      // Load current game state if playing
      if (r.status === 'playing') {
        const gr = await pool.query(
          'SELECT id, board, moves, result FROM ttt_games WHERE room_id=$1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
          [roomId]
        );
        if (gr.rows.length) {
          const g = gr.rows[0];
          rt.gameId = g.id;
          rt.board = g.board || Array(9).fill(null);
          rt.moves = g.moves || [];
          rt.result = g.result || null;
          rt.currentTurn = rt.moves.length % 2 === 0 ? 'X' : 'O';
        }
      } else if (r.status === 'finished') {
        const gr = await pool.query(
          'SELECT id, board, moves, result, winner_id FROM ttt_games WHERE room_id=$1 ORDER BY id DESC LIMIT 1',
          [roomId]
        );
        if (gr.rows.length) {
          const g = gr.rows[0];
          rt.gameId = g.id;
          rt.board = g.board || Array(9).fill(null);
          rt.moves = g.moves || [];
          rt.result = g.result || null;
        }
      }
    } catch (e) {
      console.warn(`[ttt] getRoom db error: ${e.message}`);
      return sendJson(res, 500, { error: 'Internal error' });
    }
  }
  if (!rt) return sendJson(res, 404, { error: 'Room not found' });
  sendJson(res, 200, buildGameState(rt));
}

// POST /api/ttt/rooms/:id/join
async function handleJoin(req, res, roomId, user) {
  const body = await readBody(req, 4 * 1024);
  const role = (body && body.role === 'spectator') ? 'spectator' : 'player';
  const password = (body && typeof body.password === 'string') ? body.password.trim() : '';

  let rt = runtimes.get(roomId);
  if (!rt) {
    if (!pool) return sendJson(res, 404, { error: 'Room not found' });
    // Reconstruct from DB
    try {
      const { rows } = await pool.query('SELECT * FROM ttt_rooms WHERE id=$1', [roomId]);
      if (!rows.length) return sendJson(res, 404, { error: 'Room not found' });
      const r = rows[0];
      rt = {
        roomId, name: r.name, visibility: r.visibility, opponentType: r.opponent_type,
        spectatorsAllowed: r.spectators_allowed, chatEnabled: r.chat_enabled,
        turnTimerSeconds: r.turn_timer_seconds, passwordHash: r.password_hash, passwordSalt: r.password_salt,
        createdBy: r.created_by, status: r.status,
        board: Array(9).fill(null), currentTurn: 'X', result: null, winLine: null,
        playerX: r.player_x_id ? { id: r.player_x_id, username: r.player_x_username } : null,
        playerO: r.player_o_id ? { id: r.player_o_id, username: r.player_o_username } : null,
        spectators: new Set(), sseClients: new Set(),
        timerHandle: null, turnDeadline: 0, moves: [], rematchVotes: new Set(),
        rematchHandle: null, gameId: null, lastActivityAt: Date.now(),
      };
      runtimes.set(roomId, rt);
    } catch (e) {
      return sendJson(res, 500, { error: 'Internal error' });
    }
  }

  // Private room check
  if (rt.visibility === 'private' && rt.passwordHash) {
    if (!passwordMatches(rt, password)) {
      return sendJson(res, 403, { error: 'Incorrect password' });
    }
  }

  if (role === 'spectator') {
    if (!rt.spectatorsAllowed) return sendJson(res, 403, { error: 'Spectators not allowed in this room' });
    rt.spectators.add(user.id);
    broadcast(roomId, 'player_joined', { seat: 'spectator', username: user.username, spectators: rt.spectators.size });
    return sendJson(res, 200, { role: 'spectator', state: buildGameState(rt) });
  }

  // Player join
  if (rt.status === 'finished') return sendJson(res, 409, { error: 'Game already finished' });
  if (rt.playerX && rt.playerO) return sendJson(res, 409, { error: 'Room is full' });

  // Already in the room?
  if ((rt.playerX && rt.playerX.id === user.id) || (rt.playerO && rt.playerO.id === user.id)) {
    return sendJson(res, 200, { role: 'player', state: buildGameState(rt) });
  }

  if (!rt.playerX) {
    rt.playerX = { id: user.id, username: user.username };
    if (pool) pool.query('UPDATE ttt_rooms SET player_x_id=$1, player_x_username=$2, updated_at=now() WHERE id=$3',
      [user.id, user.username, roomId]).catch(() => {});
    broadcast(roomId, 'player_joined', { seat: 'X', username: user.username, spectators: rt.spectators.size });
  } else {
    rt.playerO = { id: user.id, username: user.username };
    if (pool) pool.query('UPDATE ttt_rooms SET player_o_id=$1, player_o_username=$2, updated_at=now() WHERE id=$3',
      [user.id, user.username, roomId]).catch(() => {});
    broadcast(roomId, 'player_joined', { seat: 'O', username: user.username, spectators: rt.spectators.size });
    await startGame(rt);
  }

  sendJson(res, 200, { role: 'player', state: buildGameState(rt) });
}

// POST /api/ttt/rooms/:id/move
async function handleMove(req, res, roomId, user) {
  const body = await readBody(req, 1024);
  if (body === undefined) return sendJson(res, 400, { error: 'Invalid JSON' });

  const rt = runtimes.get(roomId);
  if (!rt) return sendJson(res, 404, { error: 'Room not found' });
  if (rt.status !== 'playing') return sendJson(res, 409, { error: 'Game is not active' });

  // Auth: must be a player
  const isX = rt.playerX && rt.playerX.id === user.id;
  const isO = rt.playerO && rt.playerO.id === user.id;
  if (!isX && !isO) return sendJson(res, 403, { error: 'You are not a player in this room' });

  const player = isX ? 'X' : 'O';
  if (rt.currentTurn !== player) return sendJson(res, 409, { error: 'Not your turn' });

  const cell = body && typeof body.cell === 'number' ? Math.floor(body.cell) : -1;
  if (cell < 0 || cell > 8 || rt.board[cell] !== null) return sendJson(res, 400, { error: 'Invalid cell' });

  const now = Date.now();
  if (now > rt.turnDeadline + 500) return sendJson(res, 409, { error: 'Turn timer expired' });

  // Rate limit: 1 move / 500ms per user
  const last = moveLimiter.get(user.id) || 0;
  if (now - last < 500) return sendJson(res, 429, { error: 'Too fast' });
  moveLimiter.set(user.id, now);

  const timerSecondsLeft = Math.max(0, Math.floor((rt.turnDeadline - now) / 1000));
  await applyGameMove(rt, player, user.id, cell, timerSecondsLeft);
  sendJson(res, 200, { ok: true, state: buildGameState(rt) });
}

// POST /api/ttt/rooms/:id/chat
async function handleChat(req, res, roomId, user) {
  const body = await readBody(req, 4 * 1024);
  if (body === undefined) return sendJson(res, 400, { error: 'Invalid JSON' });

  const rt = runtimes.get(roomId);
  if (!rt) {
    // Allow chat lookup by DB room id even if no runtime
    if (!pool) return sendJson(res, 404, { error: 'Room not found' });
  } else if (!rt.chatEnabled) {
    return sendJson(res, 403, { error: 'Chat is disabled in this room' });
  }

  const message = (body && typeof body.message === 'string' ? body.message.trim() : '').slice(0, CHAT_MAX_LEN);
  if (!message) return sendJson(res, 400, { error: 'Message cannot be empty' });

  const ts = new Date().toISOString();
  const payload = { username: user.username, userId: user.id, message, ts };

  if (pool && rt) {
    pool.query(
      'INSERT INTO ttt_chat (room_id, game_id, user_id, username, message) VALUES ($1,$2,$3,$4,$5)',
      [roomId, rt.gameId || null, user.id, user.username, message]
    ).catch((e) => console.warn(`[ttt] chat db: ${e.message}`));
  }

  if (rt) broadcast(roomId, 'chat', payload);
  sendJson(res, 201, payload);
}

// POST /api/ttt/rooms/:id/rematch
async function handleRematch(req, res, roomId, user) {
  const rt = runtimes.get(roomId);
  if (!rt) return sendJson(res, 404, { error: 'Room not found' });
  if (rt.status !== 'finished') return sendJson(res, 409, { error: 'Game not finished' });

  const isX = rt.playerX && rt.playerX.id === user.id;
  const isO = rt.playerO && rt.playerO.id === user.id;
  if (!isX && !isO) return sendJson(res, 403, { error: 'Not a player in this room' });

  rt.rematchVotes.add(user.id);
  broadcast(roomId, 'rematch_vote', { userId: user.id, votes: rt.rematchVotes.size });

  const needsBothHumans = rt.opponentType === 'human';
  const enoughVotes = needsBothHumans
    ? (rt.playerX && rt.playerO && rt.rematchVotes.has(rt.playerX.id) && rt.rematchVotes.has(rt.playerO.id))
    : rt.rematchVotes.has(user.id); // vs AI: only human needs to vote

  if (enoughVotes) {
    if (rt.rematchHandle) { clearTimeout(rt.rematchHandle); rt.rematchHandle = null; }
    await startGame(rt);
    return sendJson(res, 200, { matched: true });
  }

  // Start a timer to expire rematch votes if the other player doesn't respond
  if (!rt.rematchHandle) {
    rt.rematchHandle = setTimeout(() => {
      if (rt.status === 'finished') {
        rt.rematchVotes.clear();
        broadcast(roomId, 'rematch_expired', {});
      }
    }, REMATCH_WINDOW_SECS * 1000);
  }

  sendJson(res, 200, { matched: false, votes: rt.rematchVotes.size });
}

// GET /api/ttt/rooms/:id/events (SSE)
function handleEvents(req, res, roomId, user) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();

  let rt = runtimes.get(roomId);
  if (!rt) {
    // Create a minimal runtime if the room exists in DB (handled lazily)
    res.write(': connecting\n\n');
  }

  const client = { res, userId: user ? user.id : null };
  if (!rt) {
    // Room not found — send error event
    sseWrite(res, 'error', { message: 'Room not found' });
    res.end();
    return;
  }

  rt.sseClients.add(client);
  rt.lastActivityAt = Date.now();

  // Send current state immediately
  sseWrite(res, 'game_state', buildGameState(rt));

  req.on('close', () => {
    rt.sseClients.delete(client);
    if (user && rt.spectators.has(user.id)) {
      rt.spectators.delete(user.id);
      broadcast(roomId, 'player_left', { seat: 'spectator', spectators: rt.spectators.size });
    }
  });
}

// POST /api/ttt/queue
async function handleQueueJoin(req, res, user) {
  matchQueue.set(user.id, { userId: user.id, username: user.username, queuedAt: Date.now() });

  if (matchQueue.size >= 2) {
    // Pair oldest two entries
    const sorted = Array.from(matchQueue.values()).sort((a, b) => a.queuedAt - b.queuedAt);
    const [p1, p2] = sorted;
    matchQueue.delete(p1.userId);
    matchQueue.delete(p2.userId);

    const roomId = crypto.randomUUID();
    const rt = {
      roomId, name: `${p1.username} vs ${p2.username}`, visibility: 'private', opponentType: 'human',
      spectatorsAllowed: true, chatEnabled: true, turnTimerSeconds: TURN_TIMER_SECONDS,
      passwordHash: null, passwordSalt: null, createdBy: p1.userId, status: 'waiting',
      board: Array(9).fill(null), currentTurn: 'X', result: null, winLine: null,
      playerX: { id: p1.userId, username: p1.username },
      playerO: { id: p2.userId, username: p2.username },
      spectators: new Set(), sseClients: new Set(),
      timerHandle: null, turnDeadline: 0, moves: [], rematchVotes: new Set(),
      rematchHandle: null, gameId: null, lastActivityAt: Date.now(),
    };
    runtimes.set(roomId, rt);

    if (pool) {
      pool.query(
        `INSERT INTO ttt_rooms (id, name, visibility, opponent_type, spectators_allowed, chat_enabled, turn_timer_seconds, status, created_by, player_x_id, player_x_username, player_o_id, player_o_username)
         VALUES ($1,$2,'private','human',true,true,$3,'waiting',$4,$5,$6,$7,$8)`,
        [roomId, rt.name, TURN_TIMER_SECONDS, p1.userId, p1.userId, p1.username, p2.userId, p2.username]
      ).catch((e) => console.warn(`[ttt] queue room db: ${e.message}`));
    }

    await startGame(rt);

    // If the caller is one of the matched players, respond with matched
    if (user.id === p1.userId || user.id === p2.userId) {
      return sendJson(res, 200, { matched: true, roomId });
    }
    // Shouldn't happen, but respond anyway
    return sendJson(res, 200, { matched: true, roomId });
  }

  sendJson(res, 200, { matched: false });
}

// DELETE /api/ttt/queue
function handleQueueLeave(req, res, user) {
  matchQueue.delete(user.id);
  sendJson(res, 200, { ok: true });
}

// GET /api/ttt/leaderboard
async function handleLeaderboard(req, res) {
  if (!pool) return sendJson(res, 503, { error: 'Database not available' });
  try {
    const { rows } = await pool.query(`
      SELECT user_id, username,
             wins * 3 + draws AS points,
             games_played, wins, losses, draws, current_streak, best_streak
      FROM ttt_stats
      ORDER BY (wins * 3 + draws) DESC, wins DESC, username ASC
      LIMIT $1
    `, [LEADERBOARD_LIMIT]);
    const leaders = rows.map((r, i) => ({
      rank: i + 1,
      userId: r.user_id,
      username: r.username,
      points: r.points,
      gamesPlayed: r.games_played,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
    }));
    sendJson(res, 200, { leaders });
  } catch (e) {
    console.warn(`[ttt] leaderboard error: ${e.message}`);
    sendJson(res, 500, { error: 'Internal error' });
  }
}

// GET /api/ttt/stats/:userId
async function handleStats(req, res, userId) {
  if (!pool) return sendJson(res, 503, { error: 'Database not available' });
  try {
    const sr = await pool.query('SELECT * FROM ttt_stats WHERE user_id=$1', [userId]);
    if (!sr.rows.length) return sendJson(res, 404, { error: 'Player not found' });
    const s = sr.rows[0];
    const ar = await pool.query('SELECT achievement_id, unlocked_at FROM ttt_achievements WHERE user_id=$1 ORDER BY unlocked_at', [userId]);
    const hr = await pool.query(`
      SELECT g.id, g.result, g.started_at, g.ended_at,
             CASE WHEN g.player_x_id=$1 THEN g.player_o_username ELSE g.player_x_username END AS opponent
      FROM ttt_games g
      WHERE (g.player_x_id=$1 OR g.player_o_id=$1) AND g.ended_at IS NOT NULL
      ORDER BY g.ended_at DESC LIMIT 10
    `, [userId]);

    sendJson(res, 200, {
      userId: s.user_id,
      username: s.username,
      gamesPlayed: s.games_played,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      winRate: s.games_played > 0 ? Math.round((s.wins / s.games_played) * 100) : 0,
      currentStreak: s.current_streak,
      bestStreak: s.best_streak,
      achievements: ar.rows.map((r) => ({ id: r.achievement_id, unlockedAt: r.unlocked_at })),
      recentGames: hr.rows.map((r) => ({
        gameId: String(r.id),
        opponent: r.opponent,
        result: r.result,
        startedAt: r.started_at,
        endedAt: r.ended_at,
      })),
    });
  } catch (e) {
    console.warn(`[ttt] stats error: ${e.message}`);
    sendJson(res, 500, { error: 'Internal error' });
  }
}

// GET /api/ttt/history
async function handleHistory(req, res, user) {
  if (!pool) return sendJson(res, 503, { error: 'Database not available' });
  try {
    const { rows } = await pool.query(`
      SELECT g.id, g.result, g.started_at, g.ended_at, g.room_id,
             CASE WHEN g.player_x_id=$1 THEN g.player_o_username ELSE g.player_x_username END AS opponent,
             CASE WHEN g.player_x_id=$1 THEN 'X' ELSE 'O' END AS player_side,
             r.opponent_type
      FROM ttt_games g
      JOIN ttt_rooms r ON r.id = g.room_id
      WHERE (g.player_x_id=$1 OR g.player_o_id=$1) AND g.ended_at IS NOT NULL
      ORDER BY g.ended_at DESC LIMIT 50
    `, [user.id]);
    sendJson(res, 200, {
      games: rows.map((r) => ({
        gameId: String(r.id),
        roomId: r.room_id,
        opponent: r.opponent,
        playerSide: r.player_side,
        opponentType: r.opponent_type,
        result: r.result,
        startedAt: r.started_at,
        endedAt: r.ended_at,
      })),
    });
  } catch (e) {
    sendJson(res, 500, { error: 'Internal error' });
  }
}

// GET /api/ttt/games/:id
async function handleGetGame(req, res, gameId) {
  if (!pool) return sendJson(res, 503, { error: 'Database not available' });
  try {
    const { rows } = await pool.query('SELECT * FROM ttt_games WHERE id=$1', [gameId]);
    if (!rows.length) return sendJson(res, 404, { error: 'Game not found' });
    const g = rows[0];
    const cr = await pool.query(
      'SELECT username, user_id, message, created_at FROM ttt_chat WHERE game_id=$1 ORDER BY id ASC',
      [gameId]
    );
    sendJson(res, 200, {
      gameId: String(g.id),
      roomId: g.room_id,
      playerX: { id: g.player_x_id, username: g.player_x_username },
      playerO: { id: g.player_o_id, username: g.player_o_username },
      moves: g.moves,
      board: g.board,
      result: g.result,
      winnerId: g.winner_id,
      startedAt: g.started_at,
      endedAt: g.ended_at,
      chat: cr.rows,
    });
  } catch (e) {
    sendJson(res, 500, { error: 'Internal error' });
  }
}

// ── Main router ───────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  } catch (_) { pathname = '/'; }

  const method = req.method;

  // Health — public (must be before the non-API catch-all)
  if (pathname === '/health' && method === 'GET') return sendJson(res, 200, { ok: true });

  // Serve index.html for all non-API paths
  if (!pathname.startsWith('/api/')) {
    return fs.readFile(INDEX_PATH, (err, buf) => {
      if (err) return send(res, 500, { 'content-type': 'text/plain' }, 'Internal error');
      send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, buf);
    });
  }

  // Config — public, no auth
  if (pathname === '/api/ttt/config' && method === 'GET') return handleConfig(req, res);

  // Leaderboard — public
  if (pathname === '/api/ttt/leaderboard' && method === 'GET') return handleLeaderboard(req, res);

  // Room list — public
  if (pathname === '/api/ttt/rooms' && method === 'GET') return handleListRooms(req, res);

  // Room detail — public
  const roomDetailMatch = pathname.match(/^\/api\/ttt\/rooms\/([^/]+)$/);
  if (roomDetailMatch && method === 'GET') return handleGetRoom(req, res, roomDetailMatch[1]);

  // Rooms events (SSE) — public (no auth required to spectate)
  const eventsMatch = pathname.match(/^\/api\/ttt\/rooms\/([^/]+)\/events$/);
  if (eventsMatch && method === 'GET') {
    const user = getUser(req);
    return handleEvents(req, res, eventsMatch[1], user);
  }

  // Game detail — public
  const gameDetailMatch = pathname.match(/^\/api\/ttt\/games\/(\d+)$/);
  if (gameDetailMatch && method === 'GET') return handleGetGame(req, res, Number(gameDetailMatch[1]));

  // Stats — public
  const statsMatch = pathname.match(/^\/api\/ttt\/stats\/([^/]+)$/);
  if (statsMatch && method === 'GET') return handleStats(req, res, statsMatch[1]);

  // All remaining routes require auth
  const user = getUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });

  // Create room
  if (pathname === '/api/ttt/rooms' && method === 'POST') return handleCreateRoom(req, res, user);

  // Queue
  if (pathname === '/api/ttt/queue' && method === 'POST') return handleQueueJoin(req, res, user);
  if (pathname === '/api/ttt/queue' && method === 'DELETE') return handleQueueLeave(req, res, user);

  // History
  if (pathname === '/api/ttt/history' && method === 'GET') return handleHistory(req, res, user);

  // Room sub-routes
  const roomMatch = pathname.match(/^\/api\/ttt\/rooms\/([^/]+)\/([^/]+)$/);
  if (roomMatch) {
    const [, roomId, action] = roomMatch;
    if (action === 'join'    && method === 'POST') return handleJoin(req, res, roomId, user);
    if (action === 'move'    && method === 'POST') return handleMove(req, res, roomId, user);
    if (action === 'chat'    && method === 'POST') return handleChat(req, res, roomId, user);
    if (action === 'rematch' && method === 'POST') return handleRematch(req, res, roomId, user);
  }

  sendJson(res, 404, { error: 'Not found' });
}

// ── Background intervals ──────────────────────────────────────────────────────
function startIntervals() {
  // Timer tick: broadcast to all active games every second
  setInterval(() => {
    for (const [roomId, rt] of runtimes) {
      if (rt.status !== 'playing' || !rt.sseClients.size) continue;
      broadcast(roomId, 'timer_tick', { turnDeadline: rt.turnDeadline });
    }
  }, 1000);

  // SSE keep-alive every 20s
  setInterval(() => {
    for (const [, rt] of runtimes) {
      for (const client of rt.sseClients) {
        try { client.res.write(': keep-alive\n\n'); } catch (_) {}
      }
    }
  }, 20000);

  // Queue timeout cleanup every 10s
  setInterval(() => {
    const cutoff = Date.now() - QUEUE_TIMEOUT_SECS * 1000;
    for (const [uid, entry] of matchQueue) {
      if (entry.queuedAt < cutoff) {
        matchQueue.delete(uid);
        console.log(`[ttt] queue timeout: removed ${uid}`);
      }
    }
  }, 10000);

  // Room idle cleanup every 60s
  setInterval(() => {
    const cutoff = Date.now() - ROOM_IDLE_TTL_SECS * 1000;
    for (const [roomId, rt] of runtimes) {
      if (rt.status === 'waiting' && rt.sseClients.size === 0 && rt.lastActivityAt < cutoff) {
        rt.status = 'abandoned';
        runtimes.delete(roomId);
        if (pool) {
          pool.query('UPDATE ttt_rooms SET status=\'abandoned\', updated_at=now() WHERE id=$1', [roomId])
            .catch(() => {});
        }
        console.log(`[ttt] room ${roomId} abandoned (idle)`);
      }
    }
  }, 60000);
}

// ── Schema migration ──────────────────────────────────────────────────────────
async function migrate() {
  if (!pool) return;
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await pool.query(sql);
  console.log('[ttt] schema ready');
}

// ── Staging seed ──────────────────────────────────────────────────────────────
async function seedStaging() {
  if (!IS_STAGING || !pool) return;

  // Rooms
  const ROOM_OPEN     = '10000000-0000-0000-0000-000000000001';
  const ROOM_FINISHED = '10000000-0000-0000-0000-000000000002';

  await pool.query(`
    INSERT INTO ttt_rooms (id, name, visibility, opponent_type, spectators_allowed, chat_enabled, turn_timer_seconds, status, created_by, player_x_id, player_x_username)
    VALUES ($1, 'Staging demo — Open Room', 'public', 'human', true, true, 30, 'waiting', 'staging-demo-alice', 'staging-demo-alice', 'Staging demo Alice')
    ON CONFLICT (id) DO NOTHING
  `, [ROOM_OPEN]);

  await pool.query(`
    INSERT INTO ttt_rooms (id, name, visibility, opponent_type, spectators_allowed, chat_enabled, turn_timer_seconds, status, created_by, player_x_id, player_x_username, player_o_id, player_o_username)
    VALUES ($1, 'Staging demo — Finished Room', 'public', 'human', true, true, 30, 'finished', 'staging-demo-alice', 'staging-demo-alice', 'Staging demo Alice', 'staging-demo-carol', 'Staging demo Carol')
    ON CONFLICT (id) DO NOTHING
  `, [ROOM_FINISHED]);

  // Games: alice(X) beats carol(O) in 5 moves — top row win
  // Moves: X(0), O(4), X(1), O(5), X(2)  => board=[X,X,X,null,O,O,null,null,null]
  const moves1 = JSON.stringify([
    { cell: 0, player: 'X', ts_ms: 1000 },
    { cell: 4, player: 'O', ts_ms: 2000 },
    { cell: 1, player: 'X', ts_ms: 3000 },
    { cell: 5, player: 'O', ts_ms: 4000 },
    { cell: 2, player: 'X', ts_ms: 5000 },
  ]);
  const board1 = ['X', 'X', 'X', null, 'O', 'O', null, null, null];

  const gr = await pool.query(`
    INSERT INTO ttt_games (room_id, player_x_id, player_o_id, player_x_username, player_o_username, moves, board, result, winner_id, started_at, ended_at)
    VALUES ($1,'staging-demo-alice','staging-demo-carol','Staging demo Alice','Staging demo Carol',$2,$3,'x_wins','staging-demo-alice', now() - interval '1 day', now() - interval '23 hours')
    ON CONFLICT DO NOTHING RETURNING id
  `, [ROOM_FINISHED, moves1, board1]);

  const gameId1 = gr.rows.length ? gr.rows[0].id : null;

  // Extra games for history/leaderboard (alice vs bob)
  const moves2 = JSON.stringify([
    { cell: 4, player: 'X', ts_ms: 1000 }, { cell: 0, player: 'O', ts_ms: 2000 },
    { cell: 8, player: 'X', ts_ms: 3000 }, { cell: 2, player: 'O', ts_ms: 4000 },
    { cell: 3, player: 'X', ts_ms: 5000 }, { cell: 5, player: 'O', ts_ms: 6000 },
    { cell: 1, player: 'X', ts_ms: 7000 }, { cell: 7, player: 'O', ts_ms: 8000 },
    { cell: 6, player: 'X', ts_ms: 9000 },
  ]);
  const board2 = ['O', 'X', 'O', 'X', 'X', 'O', 'X', 'O', 'X'];

  // We need a room for these extra games too — reuse ROOM_FINISHED with ON CONFLICT DO NOTHING
  // Instead, just seed games with the same room (they're historical)
  for (let i = 2; i <= 6; i++) {
    await pool.query(`
      INSERT INTO ttt_games (room_id, player_x_id, player_o_id, player_x_username, player_o_username, moves, board, result, winner_id, started_at, ended_at)
      VALUES ($1,'staging-demo-alice','staging-demo-bob','Staging demo Alice','Staging demo Bob',$2,$3,
        CASE WHEN $4 % 3 = 0 THEN 'x_wins' WHEN $4 % 3 = 1 THEN 'o_wins' ELSE 'draw' END,
        CASE WHEN $4 % 3 = 0 THEN 'staging-demo-alice' WHEN $4 % 3 = 1 THEN 'staging-demo-bob' ELSE NULL END,
        now() - ($4 * interval '2 hours'),
        now() - ($4 * interval '2 hours') + interval '5 minutes')
      ON CONFLICT DO NOTHING
    `, [ROOM_FINISHED, moves2, board2, i]);
  }

  // Stats
  const statRows = [
    ['staging-demo-alice', 'Staging demo Alice', 42, 28, 9, 5, 4, 7],
    ['staging-demo-bob',   'Staging demo Bob',   17, 10, 5, 2, 2, 4],
    ['staging-demo-carol', 'Staging demo Carol',  8,  3, 4, 1, 0, 2],
    ['staging-demo-dave',  'Staging demo Dave',  31, 15, 12, 4, 1, 5],
    ['staging-demo-eve',   'Staging demo Eve',    5,  2, 2, 1, 0, 1],
  ];
  for (const [uid, uname, gp, w, l, d, cs, bs] of statRows) {
    await pool.query(`
      INSERT INTO ttt_stats (user_id, username, games_played, wins, losses, draws, current_streak, best_streak)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id) DO NOTHING
    `, [uid, uname, gp, w, l, d, cs, bs]);
  }

  // Achievements
  const achRows = [
    ['staging-demo-alice', 'first_win'],
    ['staging-demo-alice', 'hat_trick'],
    ['staging-demo-alice', 'decade'],
    ['staging-demo-alice', 'ai_crusher'],
    ['staging-demo-alice', 'blitz'],
    ['staging-demo-dave',  'first_win'],
    ['staging-demo-dave',  'hat_trick'],
    ['staging-demo-dave',  'decade'],
    ['staging-demo-bob',   'first_win'],
  ];
  for (const [uid, aid] of achRows) {
    await pool.query(
      'INSERT INTO ttt_achievements (user_id, achievement_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [uid, aid]
    );
  }

  // Chat messages for game 1
  if (gameId1) {
    const chatMsgs = [
      ['staging-demo-alice', 'Staging demo Alice', 'gl hf!'],
      ['staging-demo-carol', 'Staging demo Carol', 'you too :)'],
      ['staging-demo-alice', 'Staging demo Alice', 'top row incoming...'],
      ['staging-demo-carol', 'Staging demo Carol', 'nooo!'],
      ['staging-demo-alice', 'Staging demo Alice', 'gg!'],
    ];
    for (const [uid, uname, msg] of chatMsgs) {
      await pool.query(
        'INSERT INTO ttt_chat (room_id, game_id, user_id, username, message) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [ROOM_FINISHED, gameId1, uid, uname, msg]
      );
    }
  }

  console.log('[ttt] staging seed applied');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await migrate();
    await seedStaging();
  } catch (e) {
    console.warn(`[ttt] boot error: ${e.message}`);
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.warn(`[ttt] unhandled request error: ${e.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
  });
});

if (require.main === module) {
  // Start listening immediately so /health responds before DB is ready.
  startIntervals();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[ttt] listening on http://localhost:${PORT}`);
    console.log(`[ttt] DB: ${DB ? 'connected' : 'disabled'}`);
    console.log(`[ttt] staging: ${IS_STAGING}`);
  });
  // Migrate + seed in the background — errors are logged but don't crash the server.
  boot();
}

module.exports = { server, boot };
