import { test } from "node:test";
import assert from "node:assert/strict";
import { BreakerRegistry } from "../src/lib/circuit-breaker.js";

function make(now: { t: number }) {
  return new BreakerRegistry({ failureThreshold: 3, windowMs: 1000, cooldownMs: 100 }, () => now.t);
}

test("opens after threshold failures and then fast-skips", () => {
  const now = { t: 0 };
  const b = make(now);
  assert.equal(b.canAttempt("A"), true);
  b.recordFailure("A");
  b.recordFailure("A");
  b.recordFailure("A");
  assert.equal(b.stateOf("A"), "open");
  assert.equal(b.canAttempt("A"), false);
});

test("a hard-down (auth) failure trips open immediately", () => {
  const now = { t: 0 };
  const b = make(now);
  b.recordFailure("A", true);
  assert.equal(b.stateOf("A"), "open");
});

test("half-opens after cooldown; a success closes it", () => {
  const now = { t: 0 };
  const b = make(now);
  b.recordFailure("A", true);
  assert.equal(b.canAttempt("A"), false);
  now.t = 150; // past 100ms cooldown
  assert.equal(b.canAttempt("A"), true); // half-open probe allowed
  assert.equal(b.stateOf("A"), "half_open");
  b.recordSuccess("A");
  assert.equal(b.stateOf("A"), "closed");
});

test("a failed half-open probe re-opens", () => {
  const now = { t: 0 };
  const b = make(now);
  b.recordFailure("A", true);
  now.t = 150;
  b.canAttempt("A"); // -> half-open
  b.recordFailure("A");
  assert.equal(b.stateOf("A"), "open");
});

test("stale failures fall out of the window", () => {
  const now = { t: 0 };
  const b = make(now);
  b.recordFailure("A");
  b.recordFailure("A");
  now.t = 2000; // both older than 1000ms window
  b.recordFailure("A");
  assert.equal(b.stateOf("A"), "closed"); // only 1 recent failure
});
