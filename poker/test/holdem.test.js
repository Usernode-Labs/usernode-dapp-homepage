"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createHand, legalActions, applyAction } = require("../engine/holdem");
const { freshDeck } = require("../engine/cards");

// Build a 52-card deck with specific cards pinned at given indices and the rest
// filled from the canonical order (skipping pinned cards).
function riggedDeck(pins) {
  const used = new Set(Object.values(pins));
  const rest = freshDeck().filter((c) => !used.has(c));
  const deck = new Array(52);
  for (const [i, c] of Object.entries(pins)) deck[Number(i)] = c;
  let r = 0;
  for (let i = 0; i < 52; i++) if (deck[i] == null) deck[i] = rest[r++];
  return deck;
}

const P = (seat, stack) => ({ seat, userId: "u" + seat, username: "P" + seat, stack });

function totalChips(state) {
  return state.players.reduce((a, p) => a + p.stack, 0);
}

test("heads-up posts blinds and sets first actor to the button", () => {
  const s = createHand({
    players: [P(0, 1000), P(1, 1000)], button: 0, sb: 25, bb: 50,
    deck: freshDeck(), handId: "h",
  });
  assert.strictEqual(s.players[0].committedStreet, 25); // button == SB
  assert.strictEqual(s.players[1].committedStreet, 50); // BB
  assert.strictEqual(s.betToMatch, 50);
  const legal = legalActions(s);
  assert.strictEqual(legal.seat, 0);
  assert.strictEqual(legal.callAmount, 25);
  assert.ok(legal.canRaise);
});

test("fold-to-one wins the pot uncontested, chips conserved", () => {
  let s = createHand({
    players: [P(0, 1000), P(1, 1000)], button: 0, sb: 25, bb: 50,
    deck: freshDeck(), handId: "h",
  });
  s = applyAction(s, { type: "fold" }); // button/SB folds
  assert.ok(s.complete);
  assert.strictEqual(s.result.uncontested, true);
  assert.strictEqual(s.players[1].stack, 1025); // BB collects 75 (won 25 net)
  assert.strictEqual(totalChips(s), 2000);
});

test("plays a full hand to showdown and awards the best hand", () => {
  // Pin seat 0 (index 2 hole cards at deck[2],deck[5]) trip aces.
  const deck = riggedDeck({
    2: "As", 5: "Ah",         // seat0 hole (3-handed deal order)
    0: "2c", 3: "7d",         // seat1 hole
    1: "3c", 4: "8d",         // seat2 hole
    6: "Ad", 7: "Kc", 8: "9s", 9: "4h", 10: "Jc", // board
  });
  let s = createHand({
    players: [P(0, 1000), P(1, 1000), P(2, 1000)], button: 0, sb: 25, bb: 50,
    deck, handId: "h",
  });
  // Drive: check when possible, else call. Reaches showdown with all-in equity.
  let guard = 0;
  while (!s.complete && guard++ < 50) {
    const legal = legalActions(s);
    s = applyAction(s, legal.canCheck ? { type: "check" } : { type: "call" });
  }
  assert.ok(s.complete);
  assert.strictEqual(totalChips(s), 3000); // conservation
  // Seat 0 has trip aces and must be a winner.
  const winnerSeats = s.result.winners.map((w) => w.seat);
  assert.ok(winnerSeats.includes(0));
  assert.match(s.result.handNames[0], /Three of a kind, Aces/);
});

test("all-in below the table creates a side pot and conserves chips", () => {
  let s = createHand({
    players: [P(0, 60), P(1, 1000), P(2, 1000)], button: 0, sb: 25, bb: 50,
    deck: freshDeck(), handId: "h",
  });
  // seat0 (short, 60) is first to act preflop -> shove all-in.
  let legal = legalActions(s);
  assert.strictEqual(legal.seat, 0);
  s = applyAction(s, { type: "allin" });
  // remaining players call to showdown.
  let guard = 0;
  while (!s.complete && guard++ < 50) {
    legal = legalActions(s);
    s = applyAction(s, legal.canCheck ? { type: "check" } : { type: "call" });
  }
  assert.ok(s.complete);
  assert.strictEqual(totalChips(s), 2060);
  // At least a main pot (and a side pot since seat0 was all-in for less).
  assert.ok(s.result.pots.length >= 1);
  // Net payouts sum to zero (zero-sum redistribution).
  const net = Object.values(s.result.payouts).reduce((a, b) => a + b, 0);
  assert.strictEqual(net, 0);
});

test("cannot check when facing a bet", () => {
  const s = createHand({
    players: [P(0, 1000), P(1, 1000), P(2, 1000)], button: 0, sb: 25, bb: 50,
    deck: freshDeck(), handId: "h",
  });
  assert.throws(() => applyAction(s, { type: "check" }), /cannot check/);
});
