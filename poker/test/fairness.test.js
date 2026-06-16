"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fairness = require("../engine/fairness");

test("commitment matches reveal and deck reproduces", () => {
  const secret = fairness.newSecret();
  const nonces = ["alice", "bob"];
  const handId = "h-1";
  const commitment = fairness.commitmentOf(secret);
  const deck = fairness.dealtDeck(secret, nonces, handId);
  const check = fairness.verifyHand({ secret, nonces, handId, commitment, deck });
  assert.strictEqual(check.ok, true);
  assert.deepStrictEqual(check.reasons, []);
});

test("nonce order does not matter (sorted canonically)", () => {
  const secret = fairness.newSecret();
  const a = fairness.dealtDeck(secret, ["x", "y", "z"], "h");
  const b = fairness.dealtDeck(secret, ["z", "x", "y"], "h");
  assert.deepStrictEqual(a, b);
});

test("tampering with the seed fails verification", () => {
  const secret = fairness.newSecret();
  const nonces = ["a"];
  const handId = "h-2";
  const commitment = fairness.commitmentOf(secret);
  const deck = fairness.dealtDeck(secret, nonces, handId);
  const evil = fairness.newSecret();
  const check = fairness.verifyHand({ secret: evil, nonces, handId, commitment, deck });
  assert.strictEqual(check.ok, false);
  assert.ok(check.reasons.some((r) => /commitment/.test(r)));
});

test("tampering with the deck fails verification", () => {
  const secret = fairness.newSecret();
  const nonces = ["a"];
  const handId = "h-3";
  const commitment = fairness.commitmentOf(secret);
  const deck = fairness.dealtDeck(secret, nonces, handId).slice();
  [deck[0], deck[1]] = [deck[1], deck[0]]; // swap two cards
  const check = fairness.verifyHand({ secret, nonces, handId, commitment, deck });
  assert.strictEqual(check.ok, false);
  assert.ok(check.reasons.some((r) => /deck/.test(r)));
});

test("shuffle produces a full 52-card permutation", () => {
  const deck = fairness.dealtDeck(fairness.newSecret(), [], "h");
  assert.strictEqual(deck.length, 52);
  assert.strictEqual(new Set(deck).size, 52);
});
