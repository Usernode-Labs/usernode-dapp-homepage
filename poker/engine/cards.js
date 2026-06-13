"use strict";
// Pure card + deterministic-shuffle helpers. No I/O. Given the same seed the
// shuffle is byte-for-byte reproducible, which is the foundation of the
// provably-fair commit/reveal deal (see engine/fairness.js).

const crypto = require("crypto");

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["c", "d", "h", "s"];

// Canonical 52-card deck in a fixed order. "As" = ace of spades, "Td" = ten of
// diamonds, etc. Verification re-derives the shuffle from THIS exact ordering,
// so it must never change.
function freshDeck() {
  const deck = [];
  for (const r of RANKS) {
    for (const s of SUITS) deck.push(r + s);
  }
  return deck;
}

const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2])); // 2..14

function rankValue(card) {
  return RANK_VALUE[card[0]];
}
function suitOf(card) {
  return card[1];
}

// Counter-based CSPRNG stream seeded by a hex string. Each draw consumes the
// next 6 bytes of sha256(seed || ":" || counter), giving a uniform-ish integer
// we reduce with rejection sampling to avoid modulo bias.
function makeRng(seedHex) {
  let counter = 0;
  let pool = Buffer.alloc(0);
  let offset = 0;
  function refill() {
    pool = crypto.createHash("sha256").update(seedHex + ":" + counter).digest();
    counter += 1;
    offset = 0;
  }
  function nextUint32() {
    if (offset + 4 > pool.length) refill();
    const v = pool.readUInt32BE(offset);
    offset += 4;
    return v;
  }
  // Uniform integer in [0, max) via rejection sampling.
  return function below(max) {
    if (max <= 1) return 0;
    const limit = Math.floor(0x100000000 / max) * max;
    let v;
    do {
      v = nextUint32();
    } while (v >= limit);
    return v % max;
  };
}

// Deterministic Fisher–Yates over a copy of the canonical deck.
function shuffleDeck(seedHex) {
  const deck = freshDeck();
  const below = makeRng(seedHex);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = below(i + 1);
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

module.exports = {
  RANKS,
  SUITS,
  RANK_VALUE,
  freshDeck,
  shuffleDeck,
  makeRng,
  rankValue,
  suitOf,
};
