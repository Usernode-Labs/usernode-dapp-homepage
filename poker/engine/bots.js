"use strict";
// Pure bot decision engine for AI opponents. No I/O — decideBotAction is a
// deterministic function of the engine state and difficulty setting.

const { evaluate, CATEGORY } = require("./evaluator");
const { rankValue } = require("./cards");
const { legalActions } = require("./holdem");

// Bot userId prefix. Seat-indexed so multiple bots can coexist at a table.
const BOT_PREFIX = "bot-";
function botUserId(seatNo) { return `${BOT_PREFIX}${seatNo}`; }
function isBotUserId(uid) { return typeof uid === "string" && uid.startsWith(BOT_PREFIX); }

// Evaluate the current strength of a hand. Returns the category integer
// (0=HIGH_CARD … 8=STRAIGHT_FLUSH) or -1 if not enough cards yet.
function handCategory(holeCards, board) {
  const all = [...(holeCards || []), ...(board || [])];
  if (all.length < 5) return -1;
  return evaluate(all).score[0];
}

// Detect a flush draw (4 of the same suit) in hole + board.
function hasFlushDraw(holeCards, board) {
  const all = [...(holeCards || []), ...(board || [])];
  const suits = { c: 0, d: 0, h: 0, s: 0 };
  for (const card of all) {
    const s = card.slice(-1);
    if (s in suits) suits[s]++;
  }
  return Object.values(suits).some((n) => n >= 4);
}

// Detect an open-ended straight draw (4 consecutive ranks) or gutshot.
function hasStraightDraw(holeCards, board) {
  const all = [...(holeCards || []), ...(board || [])];
  const vals = [...new Set(all.map(rankValue))].sort((a, b) => a - b);
  for (let i = 0; i <= vals.length - 4; i++) {
    if (vals[i + 3] - vals[i] <= 4) return true;
  }
  return false;
}

// ── Easy bot ──────────────────────────────────────────────────────────────────
// Plays randomly: mostly calls, occasionally raises, folds big bets.
function easyAction(engine, legal) {
  const toCall = legal.callAmount || 0;

  if (legal.canCheck) {
    // Small raise bluff ~15%; otherwise check.
    if (legal.canRaise && Math.random() < 0.15) {
      return { type: "raise", amount: legal.minRaiseTo };
    }
    return { type: "check" };
  }

  // Facing a bet: fold big bets ~40%, otherwise call.
  const bbsToCall = engine.bb > 0 ? toCall / engine.bb : toCall;
  if (legal.canFold && bbsToCall >= 6 && Math.random() < 0.40) {
    return { type: "fold" };
  }
  return { type: "call" };
}

// ── Medium bot ────────────────────────────────────────────────────────────────
// Uses hand strength to make rough decisions.
function mediumAction(engine, legal) {
  const toCall = legal.callAmount || 0;
  const actor = engine.players[engine.toAct];
  const cat = handCategory(actor.holeCards, engine.board);
  const bbsToCall = engine.bb > 0 ? toCall / engine.bb : toCall;

  // Preflop: use simple hole-card strength.
  if (engine.street === "preflop") {
    return preflopMedium(engine, legal, actor.holeCards, bbsToCall);
  }

  // Postflop: act on made hand category.
  if (cat >= CATEGORY.TRIPS) {
    // Very strong: raise or call (never fold).
    if (legal.canRaise && Math.random() < 0.65) return { type: "raise", amount: legal.minRaiseTo };
    if (legal.canCall) return { type: "call" };
    return { type: "check" };
  }

  if (cat >= CATEGORY.TWO_PAIR) {
    // Strong: raise sometimes, always call.
    if (legal.canRaise && Math.random() < 0.35) return { type: "raise", amount: legal.minRaiseTo };
    if (legal.canCall) return { type: "call" };
    return { type: "check" };
  }

  if (cat === CATEGORY.PAIR) {
    // Medium: call if pot odds ok, fold big bets.
    if (bbsToCall >= 8 && Math.random() < 0.55) return { type: "fold" };
    if (legal.canCheck) return { type: "check" };
    return { type: "call" };
  }

  // High card / not evaluated: fold to bets, check free.
  if (legal.canCheck) return { type: "check" };
  if (bbsToCall >= 4 && Math.random() < 0.70) return { type: "fold" };
  return { type: "call" };
}

function preflopMedium(engine, legal, holeCards, bbsToCall) {
  const strength = preflopStrength(holeCards);
  if (strength >= 8) {
    // Premium: 3-bet/raise or call.
    if (legal.canRaise) return { type: "raise", amount: legal.minRaiseTo };
    if (legal.canBet) return { type: "bet", amount: Math.max(legal.minBet, engine.bb * 3) };
    return { type: "call" };
  }
  if (strength >= 5) {
    // Playable: call reasonable bets, fold big ones.
    if (legal.canCheck) return { type: "check" };
    if (bbsToCall <= 6) return { type: "call" };
    if (Math.random() < 0.40) return { type: "call" };
    return { type: "fold" };
  }
  // Weak: fold to any real bet, check if free.
  if (legal.canCheck) return { type: "check" };
  if (bbsToCall <= 2) return { type: "call" };
  return { type: "fold" };
}

// ── Hard bot ──────────────────────────────────────────────────────────────────
// Uses pot odds, draw equity, and position awareness.
function hardAction(engine, legal) {
  const toCall = legal.callAmount || 0;
  const actor = engine.players[engine.toAct];
  const cat = handCategory(actor.holeCards, engine.board);
  const pot = engine.players.reduce((s, p) => s + p.committedTotal, 0);
  const potOdds = pot > 0 && toCall > 0 ? toCall / (pot + toCall) : 0;

  // Estimate equity based on hand category and draws.
  const equity = estimateEquity(cat, actor.holeCards, engine.board, engine.players.length);

  // c-bet: if we were the last aggressor preflop and now it's a new street, bet.
  const cbet = engine.street !== "preflop" && legal.canBet && Math.random() < 0.60;

  if (legal.canCheck) {
    if (cat >= CATEGORY.TWO_PAIR || equity >= 0.55) {
      if (legal.canBet) {
        // Value bet: ~65% of pot.
        const betAmt = Math.min(legal.maxTo, actor.committedStreet + Math.max(legal.minBet, Math.floor(pot * 0.65)));
        return { type: "bet", amount: betAmt };
      }
    }
    if (cbet && equity >= 0.35) {
      const betAmt = Math.min(legal.maxTo, actor.committedStreet + Math.max(legal.minBet, Math.floor(pot * 0.50)));
      return { type: "bet", amount: betAmt };
    }
    return { type: "check" };
  }

  if (equity > potOdds + 0.10) {
    // Strong enough to raise.
    if (legal.canRaise && equity >= 0.60 && Math.random() < 0.50) {
      return { type: "raise", amount: legal.minRaiseTo };
    }
    return { type: "call" };
  }

  if (equity > potOdds) {
    // Marginally profitable call.
    return { type: "call" };
  }

  // Semi-bluff with draws.
  if ((hasFlushDraw(actor.holeCards, engine.board) || hasStraightDraw(actor.holeCards, engine.board))
      && Math.random() < 0.45) {
    if (legal.canRaise) return { type: "raise", amount: legal.minRaiseTo };
    return { type: "call" };
  }

  return { type: "fold" };
}

// Rough equity estimate (0..1) given hand category + draws.
function estimateEquity(cat, holeCards, board, numPlayers) {
  const base = [0.10, 0.32, 0.48, 0.65, 0.72, 0.76, 0.85, 0.92, 0.97][cat] || 0.10;
  // Draws bump equity modestly.
  const drawBonus =
    (hasFlushDraw(holeCards, board) ? 0.12 : 0) +
    (hasStraightDraw(holeCards, board) ? 0.08 : 0);
  // Equity dilutes with more opponents.
  const playerFactor = numPlayers >= 3 ? 0.85 : 1.0;
  return Math.min(0.97, (base + drawBonus) * playerFactor);
}

// Simple preflop strength scorer (0..10):
//   Pair of aces = 10, pair of 2s = 2, AK = 9, suited connectors ~ 5..6, etc.
function preflopStrength(holeCards) {
  if (!holeCards || holeCards.length < 2) return 0;
  const [v1, v2] = holeCards.map(rankValue).sort((a, b) => b - a);
  const suited = holeCards[0].slice(-1) === holeCards[1].slice(-1);
  if (v1 === v2) return Math.min(10, Math.round((v1 - 2) * 10 / 12)); // pair: 22=0..AA=10
  const gap = v1 - v2;
  let s = Math.round(v1 * 0.5 + v2 * 0.25) - 3;
  if (suited) s += 1;
  if (gap <= 1) s += 1; // connector bonus
  return Math.max(0, Math.min(9, s)); // non-pairs capped at 9 (pairs can hit 10)
}

// ── Public interface ──────────────────────────────────────────────────────────

// decideBotAction(engine, difficulty) — call when engine.players[engine.toAct]
// is a bot seat. Returns the action object { type, amount? } to pass to
// applyAction, or null if no actor.
function decideBotAction(engine, difficulty) {
  if (!engine || engine.complete) return null;
  const legal = legalActions(engine);
  if (!legal) return null;
  switch (difficulty) {
    case "easy":  return easyAction(engine, legal);
    case "hard":  return hardAction(engine, legal);
    default:      return mediumAction(engine, legal);
  }
}

module.exports = { decideBotAction, botUserId, isBotUserId, preflopStrength, handCategory };
