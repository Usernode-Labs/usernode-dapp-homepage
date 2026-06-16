"use strict";
// Pure pot math: main + side pots from per-seat total contributions, and award
// distribution with deterministic odd-chip handling. All amounts are integers
// (token base units == chips); never use floats here.

// contributions: { [seat]: totalChipsCommittedThisHand }
// Returns ordered pots [{ amount, eligible: [seat,...] }], main pot first.
// `eligible` is every seat that contributed to that layer (including folded
// seats' dead money is folded INTO the layers but folded seats are NOT eligible
// to win — caller filters eligibility by folded status separately when awarding;
// here `eligible` is "contributed at least up to this layer").
function buildSidePots(contributions, foldedSeats) {
  const folded = new Set(foldedSeats || []);
  const entries = Object.entries(contributions)
    .map(([seat, amt]) => [Number(seat), amt])
    .filter(([, amt]) => amt > 0);
  if (entries.length === 0) return [];

  // Distinct positive commitment levels, ascending.
  const levels = [...new Set(entries.map(([, amt]) => amt))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    const layer = level - prev;
    if (layer <= 0) {
      prev = level;
      continue;
    }
    const contributors = entries.filter(([, amt]) => amt >= level).map(([s]) => s);
    const amount = layer * contributors.length;
    // Only non-folded contributors can WIN this layer.
    const eligible = contributors.filter((s) => !folded.has(s));
    pots.push({ amount, eligible, contributors });
    prev = level;
  }
  return pots;
}

// Award each pot to the best-ranked eligible seat(s).
// rankBySeat: { [seat]: score-array } (higher better; see evaluator.compareScore)
// compare: (a, b) => number  (positive if a beats b)
// order: seats in award order for odd chips (first seat left of button first).
// Returns { [seat]: chipsWon }.
function awardPots(pots, rankBySeat, compare, order) {
  const winnings = {};
  const add = (seat, n) => {
    winnings[seat] = (winnings[seat] || 0) + n;
  };
  for (const pot of pots) {
    const contenders = pot.eligible.filter((s) => rankBySeat[s] != null);
    if (contenders.length === 0) {
      // No eligible non-folded contender (everyone folded into a layer they
      // can't win) — return the chips to the lone remaining contributor if any.
      const fallback = pot.contributors.filter((s) => rankBySeat[s] != null);
      if (fallback.length === 1) add(fallback[0], pot.amount);
      continue;
    }
    // Find the best score among contenders.
    let best = null;
    for (const s of contenders) {
      if (best == null || compare(rankBySeat[s], rankBySeat[best]) > 0) best = s;
    }
    const winners = contenders.filter((s) => compare(rankBySeat[s], rankBySeat[best]) === 0);
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const s of winners) add(s, share);
    // Odd chips go one at a time to winners in `order` (first left of button).
    const ordered = (order || winners).filter((s) => winners.includes(s));
    for (let i = 0; remainder > 0 && i < ordered.length; i++, remainder--) {
      add(ordered[i], 1);
    }
  }
  return winnings;
}

module.exports = { buildSidePots, awardPots };
