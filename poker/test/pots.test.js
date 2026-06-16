"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { buildSidePots, awardPots } = require("../engine/pots");

test("single pot when everyone commits equally", () => {
  const pots = buildSidePots({ 0: 100, 1: 100, 2: 100 }, []);
  assert.strictEqual(pots.length, 1);
  assert.strictEqual(pots[0].amount, 300);
  assert.deepStrictEqual(pots[0].eligible.sort(), [0, 1, 2]);
});

test("main + side pot for an all-in short stack", () => {
  // seat0 all-in 50, seat1 & seat2 commit 200 each.
  const pots = buildSidePots({ 0: 50, 1: 200, 2: 200 }, []);
  assert.strictEqual(pots.length, 2);
  assert.strictEqual(pots[0].amount, 150); // 50*3 main pot
  assert.deepStrictEqual(pots[0].eligible.sort(), [0, 1, 2]);
  assert.strictEqual(pots[1].amount, 300); // 150*2 side pot
  assert.deepStrictEqual(pots[1].eligible.sort(), [1, 2]);
});

test("folded seats contribute dead money but cannot win", () => {
  const pots = buildSidePots({ 0: 100, 1: 100, 2: 100 }, [2]);
  assert.strictEqual(pots[0].amount, 300);
  assert.deepStrictEqual(pots[0].eligible.sort(), [0, 1]);
});

test("awards split pot evenly with odd chip to first seat in order", () => {
  const pots = [{ amount: 101, eligible: [0, 1], contributors: [0, 1] }];
  // Equal scores -> tie. order says seat 1 is first to the left of button.
  const score = [2, 14];
  const winnings = awardPots(pots, { 0: score, 1: score }, cmp, [1, 0]);
  assert.strictEqual(winnings[1], 51); // odd chip
  assert.strictEqual(winnings[0], 50);
});

test("best hand takes the whole pot", () => {
  const pots = [{ amount: 200, eligible: [0, 1], contributors: [0, 1] }];
  const winnings = awardPots(pots, { 0: [5, 14], 1: [2, 10] }, cmp, [0, 1]);
  assert.strictEqual(winnings[0], 200);
  assert.strictEqual(winnings[1], undefined);
});

function cmp(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; }
  return 0;
}
