"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { timeoutAction, timerActive, shouldSitOut } = require("../engine/timer");

test("auto-checks when checking is free on timeout", () => {
  assert.deepStrictEqual(timeoutAction({ canCheck: true }), { type: "check" });
});

test("auto-folds when facing a bet on timeout", () => {
  assert.deepStrictEqual(timeoutAction({ canCheck: false }), { type: "fold" });
});

test("timer is inactive (paused) while an action tx is pending", () => {
  assert.strictEqual(timerActive({ hasActor: true, actionPending: true }), false);
  assert.strictEqual(timerActive({ hasActor: true, actionPending: false }), true);
  assert.strictEqual(timerActive({ hasActor: false, actionPending: false }), false);
});

test("sits a player out after the configured consecutive timeouts", () => {
  assert.strictEqual(shouldSitOut(2, 3), false);
  assert.strictEqual(shouldSitOut(3, 3), true);
});
