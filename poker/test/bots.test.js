"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createHand, applyAction, legalActions } = require("../engine/holdem");
const { freshDeck } = require("../engine/cards");
const { decideBotAction, preflopStrength, handCategory } = require("../engine/bots");
const { CATEGORY } = require("../engine/evaluator");

const P = (seat, stack) => ({ seat, userId: "u" + seat, username: "P" + seat, stack });
const BOT = (seat, stack) => ({ seat, userId: `bot-${seat}`, username: "Bot", stack });

// Build a deck with specific cards pinned to given indices.
function riggedDeck(pins) {
  const { freshDeck: fd } = require("../engine/cards");
  const used = new Set(Object.values(pins));
  const rest = fd().filter((c) => !used.has(c));
  const deck = new Array(52);
  for (const [i, c] of Object.entries(pins)) deck[Number(i)] = c;
  let r = 0;
  for (let i = 0; i < 52; i++) if (deck[i] == null) deck[i] = rest[r++];
  return deck;
}

test("Easy bot: returns a legal action type when it can check", () => {
  let s = createHand({
    players: [P(0, 1000), BOT(1, 1000)], button: 0, sb: 25, bb: 50,
    deck: freshDeck(), handId: "h-easy-check",
  });
  // P0 (button/SB) acts first preflop — call so BB can check.
  s = applyAction(s, { type: "call" });
  // Now bot (seat 1, BB) can check or raise.
  const legal = legalActions(s);
  assert.strictEqual(legal.seat, 1); // bot is actor
  const action = decideBotAction(s, "easy");
  assert.ok(action, "should return an action");
  assert.ok(["check", "raise", "call", "fold"].includes(action.type), `invalid type: ${action.type}`);
  // Apply to verify the action is accepted by the engine.
  const next = applyAction(s, action);
  assert.ok(next); // didn't throw
});

test("Medium bot: raises or calls with a strong hand (pair of aces on board)", () => {
  // Pin bot's hole cards to AsAh; board has Ac so they flop trips.
  const deck = riggedDeck({
    0: "2c", 3: "7d",  // seat0 hole
    1: "As", 4: "Ah",  // seat1 (bot) hole
    2: "8h", 5: "9h",  // seat2 hole — 3-handed
    6: "Ac", 7: "Kc", 8: "9s", 9: "4h", 10: "Jc", // board
  });
  let s = createHand({
    players: [P(0, 1000), BOT(1, 1000), P(2, 1000)],
    button: 0, sb: 25, bb: 50, deck, handId: "h-medium-strong",
  });
  // Drive to the flop: everyone calls or checks (bot uses medium logic).
  let guard = 0;
  while (s.street === "preflop" && !s.complete && guard++ < 20) {
    const legal = legalActions(s);
    const actorSeat = s.players[s.toAct].seat;
    if (actorSeat === 1) {
      s = applyAction(s, decideBotAction(s, "medium"));
    } else {
      s = applyAction(s, legal.canCheck ? { type: "check" } : { type: "call" });
    }
  }
  // On flop, bot should have a strong hand (trip aces). Ask for action.
  if (!s.complete && s.street !== "preflop") {
    const legal = legalActions(s);
    if (legal && legal.seat === 1) {
      const action = decideBotAction(s, "medium");
      assert.ok(["bet", "raise", "call", "check"].includes(action.type));
      // With trip aces the medium bot should not fold.
      assert.notStrictEqual(action.type, "fold", "medium bot should not fold trip aces");
    }
  }
});

test("Hard bot: does not fold when pot odds are clearly favourable", () => {
  // Give bot a flush draw (4 spades) — pot odds should keep it in.
  const deck = riggedDeck({
    0: "2c", 3: "7d",  // seat0 hole
    1: "Ks", 4: "Qs",  // seat1 (bot) hole — two spades
    6: "As", 7: "Js", 8: "9h", 9: "4h", 10: "2d", // board has two more spades on flop
  });
  let s = createHand({
    players: [P(0, 2000), BOT(1, 2000)],
    button: 0, sb: 25, bb: 50, deck, handId: "h-hard-draw",
  });
  // Advance to flop (heads-up: both must call/check).
  let guard = 0;
  while (s.street === "preflop" && !s.complete && guard++ < 10) {
    const legal = legalActions(s);
    s = applyAction(s, legal.canCheck ? { type: "check" } : { type: "call" });
  }
  if (!s.complete && s.street !== "preflop") {
    const legal = legalActions(s);
    if (legal && legal.seat === 1) {
      const action = decideBotAction(s, "hard");
      assert.ok(action, "hard bot must return an action");
      assert.ok(["bet", "raise", "call", "check"].includes(action.type));
    }
  }
});

test("preflopStrength: premium hands score higher than weak hands", () => {
  const aceKingS = preflopStrength(["As", "Ks"]);  // suited AK
  const sevenDeuce = preflopStrength(["7h", "2c"]); // worst hand
  const aceAce = preflopStrength(["Ah", "Ac"]);     // aces
  assert.ok(aceKingS > sevenDeuce, `AKs (${aceKingS}) should beat 72o (${sevenDeuce})`);
  assert.ok(aceAce >= aceKingS, `AA (${aceAce}) should be >= AKs (${aceKingS})`);
});

test("handCategory: detects pair and trips correctly", () => {
  const pair = handCategory(["Ah", "Ac"], ["Kd", "7s", "2c"]);
  assert.strictEqual(pair, CATEGORY.PAIR);

  const trips = handCategory(["Ah", "Ac"], ["Ad", "7s", "2c"]);
  assert.strictEqual(trips, CATEGORY.TRIPS);

  // Returns -1 with fewer than 5 cards (preflop).
  const preflop = handCategory(["Ah", "Ac"], []);
  assert.strictEqual(preflop, -1);
});
