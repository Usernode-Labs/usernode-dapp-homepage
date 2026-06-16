"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createHand } = require("../engine/holdem");
const { freshDeck } = require("../engine/cards");
const { buildTableView } = require("../view");

function makeRuntime() {
  const seats = new Map();
  seats.set(0, { seat_no: 0, userId: "alice", username: "Alice", wallet: "ut1a", stack: 1000, status: "active" });
  seats.set(1, { seat_no: 1, userId: "bob", username: "Bob", wallet: "ut1b", stack: 1000, status: "active" });
  const engineState = createHand({
    players: [
      { seat: 0, userId: "alice", username: "Alice", wallet: "ut1a", stack: 1000 },
      { seat: 1, userId: "bob", username: "Bob", wallet: "ut1b", stack: 1000 },
    ],
    button: 0, sb: 25, bb: 50, deck: freshDeck(), handId: "h",
  });
  return {
    table: { id: "t", name: "T", sb: 25, bb: 50, min_buyin: 1000, max_buyin: 10000, max_seats: 6, action_timer_seconds: 30 },
    seats,
    hand: { id: "h", handNo: 1, engineState, commitment: "abc", nonces: [], deadline: Date.now() + 30000, actionPending: false },
  };
}

test("a viewer sees their own hole cards but only counts for others", () => {
  const rt = makeRuntime();
  const view = buildTableView(rt, "alice");
  const me = view.seats.find((s) => s.seat_no === 0);
  const them = view.seats.find((s) => s.seat_no === 1);
  assert.ok(Array.isArray(me.holeCards) && me.holeCards.length === 2);
  assert.strictEqual(them.holeCards, null);       // redacted
  assert.strictEqual(them.holeCount, 2);          // count only
});

test("no opponent hole cards appear anywhere in the serialized stream", () => {
  const rt = makeRuntime();
  const bobCards = rt.hand.engineState.players.find((p) => p.seat === 1).holeCards;
  const json = JSON.stringify(buildTableView(rt, "alice"));
  for (const card of bobCards) {
    assert.ok(!json.includes('"' + card + '"'), `leaked opponent card ${card}`);
  }
});

test("only the acting viewer receives legal-action affordances", () => {
  const rt = makeRuntime();
  // Heads-up: button (seat 0, Alice) acts first preflop.
  const aliceView = buildTableView(rt, "alice");
  const bobView = buildTableView(rt, "bob");
  assert.ok(aliceView.hand.legal, "actor should get legal actions");
  assert.ok(!bobView.hand.legal, "non-actor should not");
});

test("timer reports paused while an action tx is pending", () => {
  const rt = makeRuntime();
  rt.hand.actionPending = true;
  const view = buildTableView(rt, "alice");
  assert.strictEqual(view.hand.timer.paused, true);
  assert.strictEqual(view.hand.timer.deadline, null);
});
