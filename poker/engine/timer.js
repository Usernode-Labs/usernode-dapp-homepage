"use strict";
// Pure action-timer helpers. The wall-clock and the chain-pending flag live in
// the server; these functions just decide *what* happens, so they're testable.

// Decide the auto-action when a player's shot-clock expires: auto-check when
// checking is free, otherwise auto-fold.
function timeoutAction(legal) {
  if (legal && legal.canCheck) return { type: "check" };
  return { type: "fold" };
}

// The timer is considered ACTIVE only when there is a player to act AND no
// on-chain action transaction is currently pending/confirming for that seat.
// While pending, the deadline is frozen (paused) and never fires.
function timerActive({ hasActor, actionPending }) {
  return !!hasActor && !actionPending;
}

// Given consecutive-timeout counts, decide whether a seat should be sat out
// (auto-fold each hand until they act again).
function shouldSitOut(consecutiveTimeouts, threshold) {
  return consecutiveTimeouts >= (threshold || 3);
}

module.exports = { timeoutAction, timerActive, shouldSitOut };
