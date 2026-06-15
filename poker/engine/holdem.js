"use strict";
// Pure No-Limit Texas Hold'em hand engine. Deterministic given (players,
// button, blinds, deck). No I/O, no clock, no chain — the server is the only
// thing that touches those. `applyAction` returns a NEW state object so the
// engine is trivially unit-testable and replayable.
//
// Card consumption order from `deck` (matches fairness verification):
//   2*N hole cards dealt round-robin starting at the small blind, then
//   3 flop, 1 turn, 1 river — no burn cards.

const { evaluate, compareScore } = require("./evaluator");
const { buildSidePots, awardPots } = require("./pots");

const STREETS = ["preflop", "flop", "turn", "river"];

function clone(state) {
  return structuredClone(state);
}

// Index helpers operate on the players array (ordered by seat ascending).
function nextOccupied(players, from) {
  const n = players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    return i; // every entry in players is an in-hand player
  }
  return from;
}

function nextActor(state, from) {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    const p = state.players[i];
    if (!p.folded && !p.allIn && p.stack > 0) return i;
  }
  return -1;
}

function activeNotFolded(state) {
  return state.players.filter((p) => !p.folded);
}

function canStillAct(state) {
  return state.players.filter((p) => !p.folded && !p.allIn && p.stack > 0);
}

// players: [{ seat, userId, username, wallet, stack }] ordered by seat asc.
// button: index into players. Returns the initial hand state with blinds posted
// and hole cards dealt.
function createHand({ players, button, sb, bb, deck, handId }) {
  const n = players.length;
  if (n < 2) throw new Error("need at least 2 players");
  const ps = players.map((p) => ({
    seat: p.seat,
    userId: p.userId,
    username: p.username,
    wallet: p.wallet || null,
    startingStack: p.stack,
    stack: p.stack,
    holeCards: [],
    committedTotal: 0,
    committedStreet: 0,
    folded: false,
    allIn: false,
    hasActed: false,
  }));

  // Heads-up: button is the small blind and acts first preflop.
  const sbIdx = n === 2 ? button : nextOccupied(ps, button);
  const bbIdx = n === 2 ? nextOccupied(ps, button) : nextOccupied(ps, sbIdx);

  const state = {
    handId,
    sb,
    bb,
    button,
    sbIdx,
    bbIdx,
    street: "preflop",
    board: [],
    deck: deck.slice(),
    deckCursor: 0,
    players: ps,
    betToMatch: 0,
    lastRaiseSize: bb,
    toAct: -1,
    complete: false,
    result: null,
    log: [],
  };

  postBlind(state, sbIdx, sb);
  postBlind(state, bbIdx, bb);
  state.betToMatch = Math.max(ps[sbIdx].committedStreet, ps[bbIdx].committedStreet);
  state.lastRaiseSize = bb;

  // Deal hole cards round-robin starting at SB.
  for (let round = 0; round < 2; round++) {
    let i = sbIdx;
    for (let c = 0; c < n; c++) {
      ps[i].holeCards.push(state.deck[state.deckCursor++]);
      i = (i + 1) % n;
    }
  }

  // First to act preflop: left of BB (heads-up: the SB/button).
  state.toAct = n === 2 ? sbIdx : nextActor(state, bbIdx);
  // If nobody can act (everyone all-in from blinds), run it out.
  if (state.toAct === -1) runout(state);
  return state;
}

function postBlind(state, idx, amount) {
  const p = state.players[idx];
  const put = Math.min(p.stack, amount);
  p.stack -= put;
  p.committedStreet += put;
  p.committedTotal += put;
  if (p.stack === 0) p.allIn = true;
  state.log.push({ type: "blind", seat: p.seat, amount: put });
}

// Legal actions for the player to act. callAmount/min/max in chips.
function legalActions(state) {
  if (state.complete || state.toAct < 0) return null;
  const p = state.players[state.toAct];
  const toCall = state.betToMatch - p.committedStreet;
  const out = {
    seat: p.seat,
    canFold: true,
    canCheck: toCall === 0,
    canCall: toCall > 0,
    callAmount: Math.min(toCall, p.stack),
    canBet: false,
    canRaise: false,
    minBet: 0,
    minRaiseTo: 0,
    maxTo: p.committedStreet + p.stack, // shove target
  };
  if (state.betToMatch === 0) {
    out.canBet = p.stack > 0;
    out.minBet = Math.min(p.stack, state.bb); // min bet = one big blind
  } else if (p.stack > toCall) {
    out.canRaise = true;
    // Min raise-to = current bet + last full raise size (capped by shove).
    out.minRaiseTo = Math.min(out.maxTo, state.betToMatch + state.lastRaiseSize);
  }
  return out;
}

// action: { type: 'fold'|'check'|'call'|'bet'|'raise'|'allin', amount? }
// For bet/raise, `amount` is the TOTAL committedStreet target (raise-to). For
// allin it is ignored (player shoves entire stack). Returns a new state.
function applyAction(prev, action) {
  if (prev.complete) throw new Error("hand already complete");
  const state = clone(prev);
  const idx = state.toAct;
  if (idx < 0) throw new Error("no player to act");
  const p = state.players[idx];
  const toCall = state.betToMatch - p.committedStreet;
  const type = action.type;

  if (type === "fold") {
    p.folded = true;
    p.hasActed = true;
    state.log.push({ type: "fold", seat: p.seat });
  } else if (type === "check") {
    if (toCall !== 0) throw new Error("cannot check facing a bet");
    p.hasActed = true;
    state.log.push({ type: "check", seat: p.seat });
  } else if (type === "call") {
    if (toCall <= 0) throw new Error("nothing to call");
    commit(state, idx, Math.min(toCall, p.stack));
    p.hasActed = true;
    state.log.push({ type: "call", seat: p.seat, amount: p.committedStreet });
  } else if (type === "bet" || type === "raise" || type === "allin") {
    let target;
    if (type === "allin") target = p.committedStreet + p.stack;
    else target = action.amount;
    applyAggressive(state, idx, target, type === "allin");
  } else {
    throw new Error("unknown action " + type);
  }

  advance(state);
  return state;
}

function commit(state, idx, chips) {
  const p = state.players[idx];
  const put = Math.min(p.stack, chips);
  p.stack -= put;
  p.committedStreet += put;
  p.committedTotal += put;
  if (p.stack === 0) p.allIn = true;
}

function applyAggressive(state, idx, target, isAllIn) {
  const p = state.players[idx];
  const maxTo = p.committedStreet + p.stack;
  if (target > maxTo) target = maxTo;
  const increment = target - state.betToMatch;
  const need = target - p.committedStreet;
  if (need <= 0) throw new Error("raise must increase your commitment");
  if (need > p.stack) throw new Error("not enough chips");

  if (state.betToMatch === 0) {
    // Opening bet. Must be >= one big blind unless it's an all-in for less.
    const goingAllIn = target === maxTo;
    if (target < state.bb && !goingAllIn) throw new Error("bet below minimum");
    commit(state, idx, need);
    state.betToMatch = p.committedStreet;
    state.lastRaiseSize = Math.max(state.bb, p.committedStreet);
    reopen(state, idx);
  } else {
    const goingAllIn = target === maxTo;
    const fullRaise = increment >= state.lastRaiseSize;
    if (!fullRaise && !goingAllIn) throw new Error("raise below minimum");
    commit(state, idx, need);
    state.betToMatch = p.committedStreet;
    if (fullRaise) {
      state.lastRaiseSize = increment;
      reopen(state, idx);
    } else {
      // Short all-in: does not reopen betting for players who already acted.
      p.hasActed = true;
    }
  }
  state.log.push({
    type: isAllIn ? "allin" : state.betToMatch === p.committedStreet ? "bet" : "raise",
    seat: p.seat,
    amount: p.committedStreet,
  });
}

// After aggression: the aggressor has acted; everyone else still in must act again.
function reopen(state, aggressorIdx) {
  state.players.forEach((p, i) => {
    if (i === aggressorIdx) p.hasActed = true;
    else if (!p.folded && !p.allIn) p.hasActed = false;
  });
}

function bettingClosed(state) {
  const actable = canStillAct(state);
  // Everyone who can act must have acted and matched the bet.
  for (const p of actable) {
    if (!p.hasActed) return false;
    if (p.committedStreet !== state.betToMatch) return false;
  }
  return true;
}

function advance(state) {
  // Win by everyone folding.
  const live = activeNotFolded(state);
  if (live.length === 1) {
    finishUncontested(state, live[0]);
    return;
  }

  if (!bettingClosed(state)) {
    const next = nextActor(state, state.toAct);
    if (next !== -1) {
      state.toAct = next;
      return;
    }
    // No one left to act (all remaining are all-in) — fall through to runout.
  }

  // Betting on this street is closed. Move to the next street or showdown.
  nextStreet(state);
}

function collectStreet(state) {
  for (const p of state.players) {
    p.committedStreet = 0;
    if (!p.folded && !p.allIn) p.hasActed = false;
  }
  state.betToMatch = 0;
  state.lastRaiseSize = state.bb;
}

function nextStreet(state) {
  const streetIdx = STREETS.indexOf(state.street);
  if (streetIdx >= STREETS.length - 1) {
    showdown(state);
    return;
  }
  collectStreet(state);
  const nextName = STREETS[streetIdx + 1];
  state.street = nextName;
  if (nextName === "flop") {
    state.board.push(state.deck[state.deckCursor++], state.deck[state.deckCursor++], state.deck[state.deckCursor++]);
  } else {
    state.board.push(state.deck[state.deckCursor++]);
  }
  state.log.push({ type: "street", street: nextName, board: state.board.slice() });

  // If at most one player can still act, run out remaining streets with no betting.
  if (canStillAct(state).length <= 1) {
    // Verify there's actually a contested all-in (≥2 live players).
    if (activeNotFolded(state).length >= 2) {
      runout(state);
      return;
    }
  }
  const first = nextActor(state, state.button); // first active left of button
  state.toAct = first;
  if (first === -1) runout(state);
}

// Deal out all remaining community cards (no betting) then showdown.
function runout(state) {
  while (STREETS.indexOf(state.street) < STREETS.length - 1) {
    collectStreet(state);
    const streetIdx = STREETS.indexOf(state.street);
    const nextName = STREETS[streetIdx + 1];
    state.street = nextName;
    if (nextName === "flop") {
      state.board.push(state.deck[state.deckCursor++], state.deck[state.deckCursor++], state.deck[state.deckCursor++]);
    } else {
      state.board.push(state.deck[state.deckCursor++]);
    }
  }
  showdown(state);
}

function finishUncontested(state, winner) {
  // Winner takes the whole pot; no cards revealed.
  const contributions = {};
  for (const p of state.players) contributions[p.seat] = p.committedTotal;
  const total = Object.values(contributions).reduce((a, b) => a + b, 0);
  winner.stack += total;
  state.street = "complete";
  state.complete = true;
  state.toAct = -1;
  state.result = {
    uncontested: true,
    board: state.board.slice(),
    pots: [{ amount: total, eligible: [winner.seat] }],
    winners: [{ seat: winner.seat, username: winner.username, amount: total, name: null }],
    revealed: {},
    stacks: stacksOf(state),
    payouts: payoutsOf(state),
  };
}

function showdown(state) {
  const contributions = {};
  const foldedSeats = [];
  for (const p of state.players) {
    contributions[p.seat] = p.committedTotal;
    if (p.folded) foldedSeats.push(p.seat);
  }
  const pots = buildSidePots(contributions, foldedSeats);

  // Evaluate every non-folded player's best hand.
  const rankBySeat = {};
  const handNames = {};
  const revealed = {};
  for (const p of state.players) {
    if (p.folded) continue;
    const ev = evaluate(p.holeCards.concat(state.board));
    rankBySeat[p.seat] = ev.score;
    handNames[p.seat] = ev.name;
    revealed[p.seat] = p.holeCards.slice();
  }

  // Award order for odd chips: seats left of the button, ascending position.
  const order = [];
  const n = state.players.length;
  for (let k = 1; k <= n; k++) order.push(state.players[(state.button + k) % n].seat);

  const winnings = awardPots(pots, rankBySeat, compareScore, order);
  for (const p of state.players) {
    if (winnings[p.seat]) p.stack += winnings[p.seat];
  }

  const winners = Object.entries(winnings)
    .filter(([, amt]) => amt > 0)
    .map(([seat, amt]) => {
      const pl = state.players.find((x) => x.seat === Number(seat));
      return { seat: Number(seat), username: pl.username, amount: amt, name: handNames[Number(seat)] || null };
    });

  state.street = "complete";
  state.complete = true;
  state.toAct = -1;
  state.result = {
    uncontested: false,
    board: state.board.slice(),
    pots: pots.map((pt) => ({ amount: pt.amount, eligible: pt.eligible })),
    winners,
    handNames,
    revealed,
    stacks: stacksOf(state),
    payouts: payoutsOf(state),
  };
}

function stacksOf(state) {
  const out = {};
  for (const p of state.players) out[p.seat] = p.stack;
  return out;
}

// Net chip delta per seat for this hand (final stack - starting stack).
function payoutsOf(state) {
  const out = {};
  for (const p of state.players) out[p.seat] = p.stack - p.startingStack;
  return out;
}

module.exports = {
  STREETS,
  createHand,
  legalActions,
  applyAction,
  // exposed for tests
  buildSidePots,
};
