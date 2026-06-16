"use strict";

// Unit tests for the Stumble leaderboard's pure helpers: score normalization,
// upsert-keeps-max, and rank ordering. Zero-dependency: Node's built-in test
// runner + assert. Run with:  node --test
// Store paths are pointed at throwaway temp fixtures and no DATABASE_URL is set,
// so requiring the server touches nothing real and boots no DB.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "stumble-test-"));
process.env.DAPPS_JSON_PATH = path.join(TMP, "dapps.json");
process.env.SUBMISSIONS_JSON_PATH = path.join(TMP, "submissions.json");
process.env.QUIZ_SCORES_JSON_PATH = path.join(TMP, "quiz-scores.json");
process.env.USERNODE_ENV = "test"; // not "staging" → no seed fixtures
process.env.PORT = "0";
delete process.env.DATABASE_URL; // no pg pool → feed/leaderboard disabled

const srv = require("../server.js");

test("stumbleBestScore keeps the maximum and never lowers", () => {
  assert.strictEqual(srv.stumbleBestScore(100, 250), 250);
  assert.strictEqual(srv.stumbleBestScore(250, 100), 250);
  assert.strictEqual(srv.stumbleBestScore(250, 250), 250);
  // Missing / non-finite existing best treated as 0.
  assert.strictEqual(srv.stumbleBestScore(undefined, 42), 42);
  assert.strictEqual(srv.stumbleBestScore(NaN, 42), 42);
  assert.strictEqual(srv.stumbleBestScore(0, 0), 0);
});

test("normalizeStumbleScore accepts non-negative integers, rejects junk", () => {
  assert.strictEqual(srv.normalizeStumbleScore(0), 0);
  assert.strictEqual(srv.normalizeStumbleScore(1234), 1234);
  assert.strictEqual(srv.normalizeStumbleScore(12.9), 12); // floored
  assert.strictEqual(srv.normalizeStumbleScore("500"), 500); // numeric string
  assert.strictEqual(srv.normalizeStumbleScore(-1), null);
  assert.strictEqual(srv.normalizeStumbleScore("abc"), null);
  assert.strictEqual(srv.normalizeStumbleScore(null), null);
  assert.strictEqual(srv.normalizeStumbleScore(undefined), null);
  assert.strictEqual(srv.normalizeStumbleScore(""), null);
});

test("normalizeStumbleScore clamps above the max cap", () => {
  const huge = 999999999999;
  const out = srv.normalizeStumbleScore(huge);
  assert.ok(out < huge, "should clamp down");
  assert.strictEqual(out, 10000000); // default STUMBLE_MAX_SCORE
});

test("rankStumbleRows orders by score desc, then earliest updated_at", () => {
  const rows = [
    { username: "low", best_score: 100, updated_at: "2026-06-01T00:00:00Z" },
    { username: "high", best_score: 900, updated_at: "2026-06-05T00:00:00Z" },
    { username: "mid", best_score: 500, updated_at: "2026-06-03T00:00:00Z" },
  ];
  const ranked = srv.rankStumbleRows(rows, 10);
  assert.deepStrictEqual(
    ranked.map((r) => [r.rank, r.username, r.score]),
    [
      [1, "high", 900],
      [2, "mid", 500],
      [3, "low", 100],
    ]
  );
});

test("rankStumbleRows breaks score ties by earliest updated_at (first to reach it wins)", () => {
  const rows = [
    { username: "later", best_score: 500, updated_at: "2026-06-10T00:00:00Z" },
    { username: "earlier", best_score: 500, updated_at: "2026-06-02T00:00:00Z" },
  ];
  const ranked = srv.rankStumbleRows(rows, 10);
  assert.strictEqual(ranked[0].username, "earlier");
  assert.strictEqual(ranked[0].rank, 1);
  assert.strictEqual(ranked[1].username, "later");
  assert.strictEqual(ranked[1].rank, 2);
});

test("rankStumbleRows honors the limit and handles empty input", () => {
  const rows = [
    { username: "a", best_score: 30, updated_at: "2026-06-01T00:00:00Z" },
    { username: "b", best_score: 20, updated_at: "2026-06-01T00:00:00Z" },
    { username: "c", best_score: 10, updated_at: "2026-06-01T00:00:00Z" },
  ];
  assert.strictEqual(srv.rankStumbleRows(rows, 2).length, 2);
  assert.strictEqual(srv.rankStumbleRows(rows, 2)[1].username, "b");
  assert.deepStrictEqual(srv.rankStumbleRows([], 10), []);
  assert.deepStrictEqual(srv.rankStumbleRows(null, 10), []);
});
