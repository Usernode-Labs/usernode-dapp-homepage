"use strict";
// Custodial table treasury — signs OUTBOUND transactions: cash-out/win payouts
// to players and the per-hand commit/reveal audit writes.
//
// The treasury address is a public on-chain address (TREASURY_ADDRESS); the
// signing key is a private secret (TREASURY_SIGNING_KEY) and must never be
// logged or returned by any API. Submission goes through the platform node RPC
// (NODE_RPC_URL, platform-managed).
//
// The exact node submit/sign wire format is environment-specific. This module
// isolates that behind submit(); when signing is unavailable (no key, no RPC,
// or staging where real funds must never move) it DEGRADES GRACEFULLY: it
// returns { ok:false, skipped:true } and the caller leaves the payout queued /
// the audit record un-anchored and retries on the next tick. Gameplay and
// fairness verification never depend on a successful submit.

const IS_STAGING = process.env.USERNODE_ENV === "staging";
const TREASURY_ADDRESS = (process.env.TREASURY_ADDRESS || "").trim();
const SIGNING_KEY = (process.env.TREASURY_SIGNING_KEY || "").trim();
const NODE_RPC_URL = (process.env.NODE_RPC_URL || "").trim();

// Real funds must never move from a staging container (platform rule: skip real
// side effects in staging). Staging records payouts/anchors as "simulated".
function signingEnabled() {
  return !IS_STAGING && !!TREASURY_ADDRESS && !!SIGNING_KEY && !!NODE_RPC_URL;
}

function address() {
  return TREASURY_ADDRESS;
}

// Submit a signed transfer { to, amount, memo }. Returns { ok, txHash } on
// success, { ok:false, skipped, reason } otherwise. memo is a string (JSON
// envelope). amount is an integer (chips == token base units).
async function submit({ to, amount, memo }) {
  if (IS_STAGING) {
    // Simulated hash so staging flows are observable without moving funds.
    return { ok: true, simulated: true, txHash: "staging-" + simHash(to, amount, memo) };
  }
  if (!signingEnabled()) {
    return { ok: false, skipped: true, reason: "treasury signing not configured" };
  }
  try {
    // Assumed node submit interface; isolated here so it can be re-wired when
    // the canonical signing endpoint is confirmed. Never include the signing
    // key in logs.
    const resp = await fetch(`${NODE_RPC_URL}/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        from: TREASURY_ADDRESS,
        to,
        recipient: to,
        amount,
        value: amount,
        memo,
        signing_key: SIGNING_KEY,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, reason: `node ${resp.status} ${text.slice(0, 120)}` };
    }
    const data = await resp.json().catch(() => ({}));
    const txHash = data.tx_id || data.txid || data.hash || data.id || null;
    return { ok: true, txHash };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

const crypto = require("crypto");
function simHash(to, amount, memo) {
  return crypto.createHash("sha256").update(`${to}|${amount}|${memo}`).digest("hex").slice(0, 24);
}

module.exports = { signingEnabled, address, submit, IS_STAGING };
