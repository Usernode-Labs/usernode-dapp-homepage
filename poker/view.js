"use strict";
// Builds the per-viewer table snapshot pushed over SSE. The critical job is
// REDACTION: a viewer only ever receives their own hole cards, plus any cards
// the engine has explicitly revealed at showdown. Everyone else's hole cards
// are reduced to a count. Pure function of (runtime, viewerUserId) so it can be
// unit-tested for leaks.

const { legalActions } = require("./engine/holdem");

function buildTableView(runtime, viewerUserId) {
  const t = runtime.table;
  const hand = runtime.hand;
  const engine = hand ? hand.engineState : null;
  const revealed = engine && engine.complete && engine.result ? engine.result.revealed || {} : {};

  // Engine player state keyed by seat (only present while a hand is live).
  const enginePlayers = {};
  if (engine) for (const p of engine.players) enginePlayers[p.seat] = p;

  const actorSeat = engine && !engine.complete ? seatOfActor(engine) : null;

  const seats = [];
  for (let n = 0; n < t.max_seats; n++) {
    const s = runtime.seats.get(n) || null;
    const ep = enginePlayers[n];
    const out = {
      seat_no: n,
      occupied: !!(s && s.userId),
      username: s && s.userId ? s.username : null,
      stack: ep ? ep.stack : s ? s.stack : 0,
      status: s ? s.status : "empty",
      inHand: !!ep,
      folded: ep ? ep.folded : false,
      allIn: ep ? ep.allIn : false,
      committed: ep ? ep.committedStreet : 0,
      isActor: actorSeat === n,
      isYou: !!(s && s.userId && s.userId === viewerUserId),
      holeCards: null,
      holeCount: 0,
    };
    if (ep && ep.holeCards.length) {
      out.holeCount = ep.holeCards.length;
      const own = s && s.userId === viewerUserId;
      if (own || revealed[n]) out.holeCards = (revealed[n] || ep.holeCards).slice();
    }
    seats.push(out);
  }

  const view = {
    table: {
      id: t.id,
      name: t.name,
      sb: Number(t.sb),
      bb: Number(t.bb),
      min_buyin: Number(t.min_buyin),
      max_buyin: Number(t.max_buyin),
      max_seats: t.max_seats,
      action_timer_seconds: t.action_timer_seconds,
      visibility: t.visibility || "public",
      is_private: (t.visibility || "public") === "private",
    },
    seats,
    hand: null,
    you: { seat: youSeat(runtime, viewerUserId) },
  };

  if (engine) {
    view.hand = {
      id: hand.id,
      handNo: hand.handNo,
      street: engine.street,
      board: engine.board.slice(),
      betToMatch: engine.betToMatch,
      button: buttonSeat(engine),
      sbSeat: seatAtIdx(engine, engine.sbIdx),
      bbSeat: seatAtIdx(engine, engine.bbIdx),
      commitment: hand.commitment,
      complete: engine.complete,
      pots: engine.complete && engine.result ? engine.result.pots : derivePots(engine),
      actorSeat,
      // Timer: a deadline only when active; paused while an action tx confirms.
      timer: {
        paused: !!hand.actionPending,
        deadline: hand.actionPending ? null : hand.deadline || null,
        seconds: t.action_timer_seconds,
      },
      result: engine.complete ? engine.result : null,
    };
    // Only the actor gets legal-action affordances, and only if it's the viewer.
    if (actorSeat != null) {
      const actorMeta = runtime.seats.get(actorSeat);
      if (actorMeta && actorMeta.userId === viewerUserId) {
        view.hand.legal = legalActions(engine);
      }
    }
  }

  return view;
}

function seatOfActor(engine) {
  if (engine.toAct == null || engine.toAct < 0) return null;
  const p = engine.players[engine.toAct];
  return p ? p.seat : null;
}

function buttonSeat(engine) {
  const p = engine.players[engine.button];
  return p ? p.seat : null;
}

// Resolve a player-array index (sbIdx/bbIdx) to its seat number. Returns null
// when the index is absent (e.g. a hand persisted before these fields existed).
function seatAtIdx(engine, idx) {
  if (idx == null) return null;
  const p = engine.players[idx];
  return p ? p.seat : null;
}

function youSeat(runtime, viewerUserId) {
  for (const [seatNo, s] of runtime.seats) {
    if (s && s.userId === viewerUserId) return seatNo;
  }
  return null;
}

// Rough live pot total for display before showdown (sum of all commitments).
function derivePots(engine) {
  let total = 0;
  for (const p of engine.players) total += p.committedTotal;
  return total > 0 ? [{ amount: total, eligible: [] }] : [];
}

module.exports = { buildTableView };
