"use strict";
// Read-only block-explorer client. Mirrors the proven homepage poller pattern
// (server.js reconcileSubmissionPayments / pollPubkey): discover the chain id
// via GET /active_chain, then page POST /<chain_id>/transactions filtered by
// recipient. Server-only reads; never trusts a client claim of payment.

const DEFAULT_HOST = process.env.EXPLORER_UPSTREAM || "testnet-explorer.usernodelabs.org";
const DEFAULT_BASE = process.env.EXPLORER_UPSTREAM_BASE || "/api";

function useHttp(host) {
  const h = host.replace(/:\d+$/, "");
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(h)
  );
}

function baseUrl() {
  const proto = useHttp(DEFAULT_HOST) ? "http" : "https";
  return `${proto}://${DEFAULT_HOST}${DEFAULT_BASE}`;
}

async function getJson(url, init) {
  const resp = await fetch(url, init);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
  return resp.json();
}

async function discoverChainId() {
  const data = await getJson(`${baseUrl()}/active_chain`);
  return data && data.chain_id ? data.chain_id : null;
}

// Pull confirmed inbound transactions to `recipient`, paging until exhausted or
// MAX_PAGES. `fromHeight` enables incremental fetches. Returns raw tx objects.
async function fetchInbound(chainId, recipient, fromHeight) {
  const url = `${baseUrl()}/${chainId}/transactions`;
  const MAX_PAGES = 200;
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = { recipient, limit: 50 };
    if (cursor) body.cursor = cursor;
    if (fromHeight) body.from_height = fromHeight;
    const resp = await getJson(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const items = resp && Array.isArray(resp.items) ? resp.items : [];
    if (items.length === 0) break;
    out.push(...items);
    if (!resp.has_more || !resp.next_cursor) break;
    cursor = resp.next_cursor;
  }
  return out;
}

// Field-fallback readers — the explorer's tx shape varies across deployments.
function txId(tx) {
  return tx.tx_id || tx.id || tx.txid || tx.hash || null;
}
function txSender(tx) {
  return tx.source || tx.from_pubkey || tx.from || null;
}
function txAmount(tx) {
  return typeof tx.amount === "number" ? tx.amount : Number(tx.amount);
}
function txHeight(tx) {
  return typeof tx.block_height === "number" ? tx.block_height : null;
}
function txConfirmed(tx) {
  return !tx.status || tx.status === "confirmed";
}
function txMemo(tx) {
  try {
    return JSON.parse(tx.memo || "");
  } catch (_) {
    return null;
  }
}

module.exports = {
  baseUrl,
  useHttp,
  discoverChainId,
  fetchInbound,
  txId,
  txSender,
  txAmount,
  txHeight,
  txConfirmed,
  txMemo,
  DEFAULT_HOST,
  DEFAULT_BASE,
};
