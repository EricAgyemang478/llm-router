import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, withRetryAfter, parseRetryAfter } from "../src/lib/backoff.js";

test("backoffDelay grows exponentially and caps", () => {
  assert.equal(backoffDelay(1, 100, 1000, false), 100);
  assert.equal(backoffDelay(2, 100, 1000, false), 200);
  assert.equal(backoffDelay(3, 100, 1000, false), 400);
  assert.equal(backoffDelay(5, 100, 1000, false), 1000); // capped
});

test("full jitter stays within [0, ceiling]", () => {
  for (let i = 0; i < 100; i++) {
    const d = backoffDelay(3, 100, 1000, true);
    assert.ok(d >= 0 && d <= 400, `out of range: ${d}`);
  }
});

test("withRetryAfter prefers the larger of retry-after and backoff", () => {
  assert.equal(withRetryAfter(100, 500), 500);
  assert.equal(withRetryAfter(800, 500), 800);
  assert.equal(withRetryAfter(100, undefined), 100);
});

test("parseRetryAfter handles seconds and missing header", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(null), undefined);
});
