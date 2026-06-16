"use strict";

// Optimistic-concurrency-control tests for the dapp listing + submissions store.
// Zero-dependency: uses Node's built-in test runner + assert. Run with:
//   node --test
// The store paths are pointed at throwaway temp fixtures via env BEFORE the
// server module is required (paths resolve at require time), so nothing touches
// the real dapps.json / submissions.json.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "occ-test-"));
const DAPPS_PATH = path.join(TMP, "dapps.json");
const SUBS_PATH = path.join(TMP, "submissions.json");
const RESERVE = "ut1reserve0000000000000000000000000000000000000000000000000000";

process.env.DAPPS_JSON_PATH = DAPPS_PATH;
process.env.SUBMISSIONS_JSON_PATH = SUBS_PATH;
process.env.COMMUNITY_FUND_RESERVE_ADDRESS = RESERVE;
process.env.SUBMISSION_FEE = "1000";
process.env.USERNODE_ENV = "test"; // not "staging" → no seed fixtures
process.env.PORT = "0";

const srv = require("../server.js");

function writeDapps(doc) {
  fs.writeFileSync(DAPPS_PATH, JSON.stringify(doc, null, 2));
}
function writeSubsRaw(value) {
  fs.writeFileSync(SUBS_PATH, JSON.stringify(value, null, 2));
}
function readDapps() {
  return JSON.parse(fs.readFileSync(DAPPS_PATH, "utf8"));
}
function readSubs() {
  return JSON.parse(fs.readFileSync(SUBS_PATH, "utf8"));
}

const EXISTING_APP = {
  name: "Existing Dapp",
  description: "already listed",
  author: "team",
  url: "https://existing.example.com",
  pubkey: "ut1existing000000000000000000000000000000000000000000000000000",
  version: "1.2.3", // per-app semver — must survive doc-version bumps untouched
};

function baseDapps(version = 1) {
  return { version, updated_at: 0, apps: [JSON.parse(JSON.stringify(EXISTING_APP))] };
}

test.beforeEach(() => {
  writeDapps(baseDapps(1));
  writeSubsRaw({ version: 1, updated_at: 0, submissions: [] });
  srv._setSubmissions([], 1);
  // clear injected tx cache
  for (const k of Object.keys(srv._txCache)) delete srv._txCache[k];
});

// ── casWriteJson ───────────────────────────────────────────────────────────────

test("casWriteJson writes and bumps version when expectedVersion matches", () => {
  writeDapps(baseDapps(7));
  const res = srv.casWriteJson(DAPPS_PATH, 7, (d) => { d.apps.push({ name: "New", url: "https://new.example.com", pubkey: "ut1new" }); });
  assert.equal(res.ok, true);
  assert.equal(res.version, 8);
  const doc = readDapps();
  assert.equal(doc.version, 8);
  assert.equal(doc.apps.length, 2);
});

test("casWriteJson reports a conflict and does NOT write when versions differ", () => {
  writeDapps(baseDapps(7));
  const res = srv.casWriteJson(DAPPS_PATH, 6, (d) => { d.apps.push({ name: "Nope" }); });
  assert.equal(res.ok, false);
  assert.equal(res.conflict, true);
  assert.equal(res.version, 7);
  // unchanged on disk
  const doc = readDapps();
  assert.equal(doc.version, 7);
  assert.equal(doc.apps.length, 1);
});

// ── appendDappToListing ────────────────────────────────────────────────────────

test("appendDappToListing appends a new row and bumps the doc version, leaving per-app version intact", () => {
  writeDapps(baseDapps(3));
  srv.appendDappToListing({ name: "Fresh", url: "https://fresh.example.com", pubkey: "ut1fresh" });
  const doc = readDapps();
  assert.equal(doc.version, 4);
  assert.equal(doc.apps.length, 2);
  // existing per-app semver field untouched
  assert.equal(doc.apps[0].version, "1.2.3");
});

test("appendDappToListing is idempotent (no write) when url/pubkey already present", () => {
  writeDapps(baseDapps(3));
  srv.appendDappToListing({ name: "Dup", url: EXISTING_APP.url, pubkey: "ut1other" });
  const doc = readDapps();
  assert.equal(doc.version, 3, "version must not bump when nothing was added");
  assert.equal(doc.apps.length, 1);
});

test("appendDappToListing reads fresh each call, so a concurrent replacement (deploy/git merge) is not clobbered", () => {
  writeDapps(baseDapps(1));
  // First publish appends our row A.
  srv.appendDappToListing({ name: "Row A", url: "https://a.example.com", pubkey: "ut1a" });
  assert.equal(readDapps().version, 2);

  // A deploy now ships a NEW dapps.json out-of-band: bumped version, a fresh row,
  // and (worst case) it dropped our row A. This is the real-world race.
  const deployed = baseDapps(9);
  deployed.apps.push({ name: "Deploy Row", url: "https://deploy.example.com", pubkey: "ut1deploy" });
  writeDapps(deployed);

  // Next publish must build on the CURRENT on-disk doc, not a stale copy.
  srv.appendDappToListing({ name: "Row B", url: "https://b.example.com", pubkey: "ut1b" });
  const doc = readDapps();
  const urls = doc.apps.map((a) => a.url);
  assert.ok(urls.includes("https://deploy.example.com"), "the deploy's row must survive");
  assert.ok(urls.includes("https://b.example.com"), "our newly appended row must be present");
  assert.equal(doc.version, 10, "version advances from the deployed version, not the stale one");
});

test("casWriteJson conflict return is what powers appendDappToListing's bounded retry", () => {
  // Direct proof of the retry primitive: a stale expectedVersion never overwrites.
  writeDapps(baseDapps(4));
  const stale = srv.casWriteJson(DAPPS_PATH, 3, (d) => d.apps.push({ name: "stale" }));
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  // Reapplying at the fresh version (4) succeeds — the loop's recovery step.
  const fresh = srv.casWriteJson(DAPPS_PATH, 4, (d) => d.apps.push({ name: "fresh", url: "https://f.example.com", pubkey: "ut1f" }));
  assert.equal(fresh.ok, true);
  assert.equal(fresh.version, 5);
});

// ── saveSubmissions merge-by-id ────────────────────────────────────────────────

test("saveSubmissions merges a co-resident writer's record by id instead of clobbering", () => {
  // On disk: a record this process never loaded.
  writeSubsRaw({
    version: 5,
    updated_at: 0,
    submissions: [{ id: "disk-only", status: "awaiting_payment", rev: 1, dapp: { url: "https://disk.example.com" } }],
  });
  // In memory: a different record.
  srv._setSubmissions([{ id: "mem-only", status: "awaiting_payment", rev: 1, dapp: { url: "https://mem.example.com" } }], 1);
  srv.saveSubmissions();
  const doc = readSubs();
  const ids = doc.submissions.map((s) => s.id).sort();
  assert.deepEqual(ids, ["disk-only", "mem-only"]);
  assert.equal(doc.version, 6, "version is max(inMemory, onDisk) + 1");
});

test("saveSubmissions: higher rev wins for the same id", () => {
  writeSubsRaw({ version: 2, updated_at: 0, submissions: [{ id: "x", status: "awaiting_payment", rev: 9, dapp: {} }] });
  srv._setSubmissions([{ id: "x", status: "published", rev: 3, dapp: {} }], 1);
  srv.saveSubmissions();
  const doc = readSubs();
  assert.equal(doc.submissions.length, 1);
  assert.equal(doc.submissions[0].rev, 9, "on-disk rev 9 beats in-memory rev 3");
  assert.equal(doc.submissions[0].status, "awaiting_payment");
});

// ── back-compat: legacy bare-array file ────────────────────────────────────────

test("loadSubmissions reads a legacy bare-array file and first write migrates it to the wrapped form", () => {
  writeSubsRaw([{ id: "legacy-1", status: "awaiting_payment", dapp: { url: "https://legacy.example.com" } }]);
  srv.loadSubmissions();
  assert.equal(srv._getSubmissions().length, 1);
  assert.equal(srv._getSubmissions()[0].id, "legacy-1");
  // first mutation rewrites in wrapped form without losing records
  srv.saveSubmissions();
  const doc = readSubs();
  assert.ok(!Array.isArray(doc), "should be migrated to wrapped object form");
  assert.equal(typeof doc.version, "number");
  assert.equal(doc.submissions.length, 1);
  assert.equal(doc.submissions[0].id, "legacy-1");
});

// ── rev / version increment on publish + expire ────────────────────────────────

test("reconcileSubmissionPayments publishes, bumps record rev, and appends to dapps.json", () => {
  const sub = {
    id: "sub-pub", status: "awaiting_payment", rev: 1,
    dapp: { name: "Pub Dapp", url: "https://pub.example.com", pubkey: "ut1pub" },
    payment_tx_hash: null, fee_recipient: RESERVE,
  };
  srv._setSubmissions([sub], 1);
  srv._txCache[RESERVE] = [{
    tx_id: "tx-1", status: "confirmed", amount: 1000, source: "ut1payer",
    memo: JSON.stringify({ app: "dapp-homepage", type: "submit", sid: "sub-pub" }),
  }];
  srv.reconcileSubmissionPayments();
  const published = srv._getSubmissions().find((s) => s.id === "sub-pub");
  assert.equal(published.status, "published");
  assert.ok(published.rev >= 2, "rev must increment on publish");
  assert.ok(readDapps().apps.some((a) => a.url === "https://pub.example.com"), "row appended to dapps.json");
});

test("expireStaleSubmissions flips overdue awaiting records to expired and bumps rev", () => {
  const sub = { id: "sub-exp", status: "awaiting_payment", rev: 1, expires_at: 1, dapp: {} };
  srv._setSubmissions([sub], 1);
  srv.expireStaleSubmissions();
  const expired = srv._getSubmissions().find((s) => s.id === "sub-exp");
  assert.equal(expired.status, "expired");
  assert.ok(expired.rev >= 2, "rev must increment on expire");
});

// ── endpoint: POST /api/submissions structured 409 + clean 201 ──────────────────

function httpPost(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "POST", headers: { "content-type": "application/json", "content-length": payload.length } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) {}
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

test("POST /api/submissions returns structured 409s and a clean 201", async (t) => {
  const server = srv.server;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(() => new Promise((r) => server.close(r)));

  // already_listed: submit the existing row's URL.
  const r1 = await httpPost(port, "/api/submissions", {
    name: "X", url: EXISTING_APP.url, pubkey: "ut1whatever", seen_dapps_version: 0,
  });
  assert.equal(r1.status, 409);
  assert.equal(r1.json.code, "conflict");
  assert.equal(r1.json.reason, "already_listed");
  assert.equal(r1.json.listed, true);
  assert.equal(r1.json.dapp.url, EXISTING_APP.url);
  assert.equal(typeof r1.json.latest_dapps_version, "number");

  // submission_in_progress: a live awaiting submission exists for a url.
  srv._setSubmissions([{ id: "live-1", status: "awaiting_payment", rev: 1, dapp: { url: "https://inflight.example.com", pubkey: "ut1inflight" } }], 1);
  const r2 = await httpPost(port, "/api/submissions", {
    name: "Y", url: "https://inflight.example.com", pubkey: "ut1different",
  });
  assert.equal(r2.status, 409);
  assert.equal(r2.json.reason, "submission_in_progress");
  assert.equal(r2.json.listed, false);

  // clean 201: brand-new url + pubkey.
  srv._setSubmissions([], 1);
  const r3 = await httpPost(port, "/api/submissions", {
    name: "Z", url: "https://brand-new.example.com", pubkey: "ut1brandnew",
  });
  assert.equal(r3.status, 201);
  assert.equal(typeof r3.json.id, "string");
  assert.equal(typeof r3.json.dapps_version, "number");
});
