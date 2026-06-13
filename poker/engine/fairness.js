"use strict";
// Provably-fair commit/reveal deal. Pure + deterministic.
//
//   commitment   = sha256(S)                                  (published before deal)
//   shuffleSeed  = sha256(S || sortedJoin(nonces) || handId)  (drives the shuffle)
//   deck         = Fisher-Yates(canonical, shuffleSeed)
//
// Before any card is dealt the server writes `commitment` on-chain. At hand end
// it writes `S` on-chain. Anyone can then recompute the deck from (S, nonces,
// handId) and confirm both that sha256(S) matches the earlier commitment and
// that the deck matches the cards that were dealt. This proves the deal was not
// manipulated after the commitment — it does NOT hide cards from the operator
// (mental-poker encryption is a deferred phase).

const crypto = require("crypto");
const { shuffleDeck } = require("./cards");

function sha256Hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function newSecret() {
  return crypto.randomBytes(32).toString("hex");
}

function commitmentOf(secretHex) {
  return sha256Hex(secretHex);
}

// nonces: array of hex strings contributed by seated players (verifiable
// randomness). Sorted so order can't be gamed and verification is canonical.
function computeShuffleSeed(secretHex, nonces, handId) {
  const joined = (nonces || []).slice().sort().join("|");
  return sha256Hex(secretHex + "::" + joined + "::" + handId);
}

function dealtDeck(secretHex, nonces, handId) {
  return shuffleDeck(computeShuffleSeed(secretHex, nonces, handId));
}

// Returns { ok, reasons } — recomputes everything from the revealed inputs and
// checks it against the recorded commitment and deck.
function verifyHand({ secret, nonces, handId, commitment, deck }) {
  const reasons = [];
  if (!secret) reasons.push("missing revealed seed");
  if (!commitment) reasons.push("missing commitment");
  const recomputedCommit = secret ? commitmentOf(secret) : null;
  if (secret && commitment && recomputedCommit !== commitment) {
    reasons.push("sha256(seed) does not match commitment");
  }
  if (secret && Array.isArray(deck)) {
    const recomputed = dealtDeck(secret, nonces, handId);
    if (recomputed.join(",") !== deck.join(",")) {
      reasons.push("recomputed deck does not match recorded deck");
    }
  }
  return { ok: reasons.length === 0, reasons, recomputedCommitment: recomputedCommit };
}

module.exports = {
  sha256Hex,
  newSecret,
  commitmentOf,
  computeShuffleSeed,
  dealtDeck,
  verifyHand,
};
