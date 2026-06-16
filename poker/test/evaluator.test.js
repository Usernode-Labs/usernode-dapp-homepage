"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { evaluate, compareScore, CATEGORY } = require("../engine/evaluator");

test("ranks a flush above a straight", () => {
  const flush = evaluate(["2h", "5h", "9h", "Jh", "Kh", "3c", "4d"]);
  const straight = evaluate(["5c", "6d", "7h", "8s", "9c", "2h", "Ah"]);
  assert.strictEqual(flush.score[0], CATEGORY.FLUSH);
  assert.strictEqual(straight.score[0], CATEGORY.STRAIGHT);
  assert.ok(compareScore(flush.score, straight.score) > 0);
});

test("detects the wheel straight (A-2-3-4-5)", () => {
  const ev = evaluate(["Ah", "2d", "3c", "4s", "5h", "Kd", "Qc"]);
  assert.strictEqual(ev.score[0], CATEGORY.STRAIGHT);
  assert.strictEqual(ev.score[1], 5); // five-high
});

test("full house beats a flush", () => {
  const fh = evaluate(["Kh", "Kd", "Kc", "2h", "2d", "5s", "9h"]);
  const fl = evaluate(["2c", "5c", "8c", "Jc", "Ac", "3d", "4h"]);
  assert.strictEqual(fh.score[0], CATEGORY.FULL_HOUSE);
  assert.ok(compareScore(fh.score, fl.score) > 0);
});

test("quad aces beats full house and names correctly", () => {
  const ev = evaluate(["Ah", "Ad", "Ac", "As", "Kd", "Kc", "2h"]);
  assert.strictEqual(ev.score[0], CATEGORY.QUADS);
  assert.match(ev.name, /Four of a kind, Aces/);
});

test("kicker decides between equal pairs", () => {
  const a = evaluate(["Ah", "Ad", "Kc", "2s", "3h", "7d", "9c"]); // AA K kicker
  const b = evaluate(["Ah", "Ad", "Qc", "2s", "3h", "7d", "9c"]); // AA Q kicker
  assert.ok(compareScore(a.score, b.score) > 0);
});

test("royal flush is the top hand", () => {
  const ev = evaluate(["Th", "Jh", "Qh", "Kh", "Ah", "2c", "3d"]);
  assert.strictEqual(ev.name, "Royal flush");
});
