"use strict";
// Pure 7-card hand evaluator. Returns a comparable score and a human name for
// the best 5-card hand out of any 5..7 cards. Correctness over cleverness: it
// enumerates the C(7,5)=21 five-card subsets and keeps the best — plenty fast
// for a 6-max table and trivially auditable.

const { rankValue, suitOf } = require("./cards");

const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

const CATEGORY_NAME = [
  "High card",
  "Pair",
  "Two pair",
  "Three of a kind",
  "Straight",
  "Flush",
  "Full house",
  "Four of a kind",
  "Straight flush",
];

const RANK_LABEL = {
  14: "Ace", 13: "King", 12: "Queen", 11: "Jack", 10: "Ten", 9: "Nine",
  8: "Eight", 7: "Seven", 6: "Six", 5: "Five", 4: "Four", 3: "Three", 2: "Two",
};

function combinations5(cards) {
  const out = [];
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++)
            out.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
  return out;
}

// Score a 5-card hand as [category, ...tiebreakers] — lexicographically
// comparable, higher is better.
function score5(cards) {
  const values = cards.map(rankValue).sort((x, y) => y - x);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  // Distinct descending values for straight detection.
  const uniq = [...new Set(values)].sort((x, y) => y - x);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    // Wheel: A-2-3-4-5 (Ace plays low).
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5;
  }

  // Group by rank: counts of each value, sorted by (count desc, value desc).
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) =>
    b[1] - a[1] || b[0] - a[0]
  );
  const shape = groups.map((g) => g[1]).join("");
  const byRank = groups.map((g) => g[0]);

  if (isFlush && straightHigh) return [CATEGORY.STRAIGHT_FLUSH, straightHigh];
  if (shape === "41") return [CATEGORY.QUADS, byRank[0], byRank[1]];
  if (shape === "32") return [CATEGORY.FULL_HOUSE, byRank[0], byRank[1]];
  if (isFlush) return [CATEGORY.FLUSH, ...values];
  if (straightHigh) return [CATEGORY.STRAIGHT, straightHigh];
  if (shape === "311") return [CATEGORY.TRIPS, byRank[0], byRank[1], byRank[2]];
  if (shape === "221") return [CATEGORY.TWO_PAIR, byRank[0], byRank[1], byRank[2]];
  if (shape === "2111") return [CATEGORY.PAIR, byRank[0], byRank[1], byRank[2], byRank[3]];
  return [CATEGORY.HIGH_CARD, ...values];
}

function compareScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function describe(score) {
  const cat = score[0];
  const base = CATEGORY_NAME[cat];
  const lab = (v) => RANK_LABEL[v] || String(v);
  switch (cat) {
    case CATEGORY.STRAIGHT_FLUSH:
      return score[1] === 14 ? "Royal flush" : `Straight flush, ${lab(score[1])} high`;
    case CATEGORY.QUADS:
      return `Four of a kind, ${lab(score[1])}s`;
    case CATEGORY.FULL_HOUSE:
      return `Full house, ${lab(score[1])}s over ${lab(score[2])}s`;
    case CATEGORY.FLUSH:
      return `Flush, ${lab(score[1])} high`;
    case CATEGORY.STRAIGHT:
      return `Straight, ${lab(score[1])} high`;
    case CATEGORY.TRIPS:
      return `Three of a kind, ${lab(score[1])}s`;
    case CATEGORY.TWO_PAIR:
      return `Two pair, ${lab(score[1])}s and ${lab(score[2])}s`;
    case CATEGORY.PAIR:
      return `Pair of ${lab(score[1])}s`;
    default:
      return `${base}, ${lab(score[1])} high`;
  }
}

// Best 5 of N (N in 5..7). Returns { score, name }.
function evaluate(cards) {
  if (cards.length < 5) throw new Error("need at least 5 cards");
  let best = null;
  for (const combo of combinations5(cards)) {
    const s = score5(combo);
    if (!best || compareScore(s, best) > 0) best = s;
  }
  return { score: best, name: describe(best) };
}

module.exports = { evaluate, score5, compareScore, describe, CATEGORY, CATEGORY_NAME };
