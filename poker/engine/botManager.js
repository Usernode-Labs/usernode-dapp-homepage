"use strict";
// Bot seat management. Fills empty seats with virtual AI opponents when
// a table has allow_bots=true. Bots are removed when a human takes their seat.
// Virtual buy-in goes directly to the in-memory ledger — no chain tx.

const { botUserId, isBotUserId, decideBotAction } = require("./bots");
const { legalActions } = require("./holdem");

const BOT_BUYIN_MULTIPLIER = 100; // bots start with 100 BB

// Add bot seats to any empty positions at a bots-enabled table.
// Requires at least one human player to be active (bots don't play alone).
function fillEmptySeatsWithBots(rt) {
  if (!rt.table.allow_bots) return;
  const difficulty = rt.table.bot_difficulty || "medium";
  const bb = Number(rt.table.bb) || 50;
  const botStack = bb * BOT_BUYIN_MULTIPLIER;

  const hasHuman = [...rt.seats.values()].some(
    (s) => s.userId && !isBotUserId(s.userId) && s.status === "active"
  );
  if (!hasHuman) return;

  for (let seatNo = 0; seatNo < rt.table.max_seats; seatNo++) {
    const existing = rt.seats.get(seatNo);
    if (existing && existing.userId) continue; // already occupied
    const uid = botUserId(seatNo);
    rt.seats.set(seatNo, {
      seat_no: seatNo,
      userId: uid,
      username: botLabel(difficulty),
      wallet: null,
      stack: botStack,
      status: "active",
      sitOutCount: 0,
      nonce: null,
      is_bot: true,
      bot_difficulty: difficulty,
    });
  }
}

// Remove all bot seats from a table (called when bots are toggled off, or cleanup).
function clearBots(rt) {
  for (const [seatNo, s] of rt.seats) {
    if (s && s.is_bot) rt.seats.delete(seatNo);
  }
}

// Evict a bot from a specific seat so a human can take it.
function evictBotFromSeat(rt, seatNo) {
  const s = rt.seats.get(seatNo);
  if (s && s.is_bot) rt.seats.delete(seatNo);
}

// Replenish a bot's stack if it goes broke (so the game can continue).
function replenishBrokeBots(rt) {
  if (!rt.table.allow_bots) return;
  const bb = Number(rt.table.bb) || 50;
  const botStack = bb * BOT_BUYIN_MULTIPLIER;
  for (const [, s] of rt.seats) {
    if (s && s.is_bot && s.stack <= 0) {
      s.stack = botStack;
      s.status = "active";
      s.sitOutCount = 0;
    }
  }
}

// Schedule a bot action after a short random delay (1-3s) to feel natural.
// advanceHandFn is the server's advanceHand(rt, action) function.
// scheduleSelf is this same scheduleBot function (passed in to avoid circular deps
// inside the module — the server wires it up).
function scheduleBot(rt, advanceHandFn, schedSelf) {
  if (!rt.hand || rt.hand.engineState.complete) return;
  if (rt._botTimer) return; // already pending
  const engine = rt.hand.engineState;
  const legal = legalActions(engine);
  if (!legal) return;
  const actorSeat = rt.seats.get(legal.seat);
  if (!actorSeat || !actorSeat.is_bot) return;

  const difficulty = actorSeat.bot_difficulty || rt.table.bot_difficulty || "medium";
  rt._botTimer = setTimeout(() => {
    rt._botTimer = null;
    if (!rt.hand || rt.hand.engineState.complete) return;
    const action = decideBotAction(rt.hand.engineState, difficulty);
    if (!action) return;
    try {
      advanceHandFn(rt, action);
      // advanceHand triggers broadcast; schedule next bot if needed.
      schedSelf(rt, advanceHandFn, schedSelf);
    } catch (e) {
      console.warn("[bot] action failed:", e.message);
    }
  }, 1000 + Math.random() * 2000);
}

function botLabel(difficulty) {
  switch (difficulty) {
    case "easy": return "Easy Bot";
    case "hard": return "Hard Bot";
    default:     return "Bot";
  }
}

module.exports = { fillEmptySeatsWithBots, clearBots, evictBotFromSeat, replenishBrokeBots, scheduleBot };
