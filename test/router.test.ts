import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/router.js";
import { mock } from "../src/providers/mock.js";
import { RouterError, AllProvidersFailed } from "../src/errors.js";
import type { Message } from "../src/types.js";

const fast = { maxAttemptsPerProvider: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: false };
const once = { ...fast, maxAttemptsPerProvider: 1 };
const msg: Message[] = [{ role: "user", content: "hi" }];
const prices = { m: { inputPerMTok: 1, outputPerMTok: 2 } };

test("happy path: primary serves, no fallback, cost computed", async () => {
  const a = mock({
    id: "A",
    script: [{ result: { usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } } }],
  });
  const b = mock({ id: "B", script: [{ result: { text: "B" } }] });
  const router = createRouter({ providers: [a, b], retry: fast, prices });

  const res = await router.complete({ messages: msg, model: "m" });
  assert.equal(res.provider, "A");
  assert.equal(res.fallbacksUsed, 0);
  assert.equal(res.attempts.length, 1);
  assert.equal(res.costUsd, 0.0002);
  assert.equal(b.invocations, 0);
});

test("single fallback: A rate-limited, B serves", async () => {
  const a = mock({ id: "A", script: [{ error: new RouterError("rate_limit", "429", 429) }] });
  const b = mock({ id: "B", script: [{ result: { text: "from B" } }] });
  const router = createRouter({ providers: [a, b], retry: once });

  const res = await router.complete({ messages: msg, model: "m" });
  assert.equal(res.provider, "B");
  assert.equal(res.fallbacksUsed, 1);
  assert.equal(res.text, "from B");
});

test("retries on the same provider, then succeeds", async () => {
  const a = mock({
    id: "A",
    script: [{ error: new RouterError("server", "500", 500) }, { result: { text: "recovered" } }],
  });
  const router = createRouter({ providers: [a], retry: fast });

  const res = await router.complete({ messages: msg, model: "m" });
  assert.equal(res.text, "recovered");
  assert.equal(a.invocations, 2);
});

test("non-retryable auth fails over without retrying", async () => {
  const a = mock({ id: "A", script: [{ error: new RouterError("auth", "401", 401) }] });
  const b = mock({ id: "B", script: [{ result: { text: "B" } }] });
  const router = createRouter({ providers: [a, b], retry: fast });

  const res = await router.complete({ messages: msg, model: "m" });
  assert.equal(res.provider, "B");
  assert.equal(a.invocations, 1); // not retried
});

test("content_filter surfaces immediately, no failover", async () => {
  const a = mock({ id: "A", script: [{ error: new RouterError("content_filter", "blocked") }] });
  const b = mock({ id: "B", script: [{ result: { text: "B" } }] });
  const router = createRouter({ providers: [a, b], retry: fast });

  await assert.rejects(
    () => router.complete({ messages: msg, model: "m" }),
    (e: unknown) => e instanceof RouterError && e.kind === "content_filter",
  );
  assert.equal(b.invocations, 0);
});

test("all providers down -> AllProvidersFailed", async () => {
  const a = mock({ id: "A", script: [{ error: new RouterError("server", "500", 500) }] });
  const b = mock({ id: "B", script: [{ error: new RouterError("network", "down") }] });
  const router = createRouter({ providers: [a, b], retry: once });

  await assert.rejects(
    () => router.complete({ messages: msg, model: "m" }),
    (e: unknown) => e instanceof AllProvidersFailed,
  );
});

test("unsupported model is skipped by the capability filter", async () => {
  const a = mock({
    id: "A",
    script: [{ result: { text: "A" } }],
    capabilities: { supportsModel: () => false },
  });
  const b = mock({
    id: "B",
    script: [{ result: { text: "B" } }],
    capabilities: { supportsModel: () => true },
  });
  const router = createRouter({ providers: [a, b], retry: fast });

  const res = await router.complete({ messages: msg, model: "m" });
  assert.equal(res.provider, "B");
  assert.equal(a.invocations, 0);
});

test("an open breaker fast-skips the provider on the next request", async () => {
  const a = mock({ id: "A", script: [{ error: new RouterError("server", "500", 500) }] });
  const b = mock({ id: "B", script: [{ result: { text: "B" } }] });
  const router = createRouter({
    providers: [a, b],
    retry: once,
    breaker: { failureThreshold: 1, windowMs: 1000, cooldownMs: 60_000 },
  });

  await router.complete({ messages: msg, model: "m" }); // trips A open, B serves
  const callsAfterFirst = a.invocations;
  const res = await router.complete({ messages: msg, model: "m" });
  assert.equal(res.provider, "B");
  assert.equal(a.invocations, callsAfterFirst); // A skipped, never called again
});

test("overall deadline is terminal", async () => {
  const a = mock({ id: "A", script: [{ result: { text: "A" } }] });
  const router = createRouter({ providers: [a], retry: fast, overallDeadlineMs: 10 });

  await assert.rejects(
    () => router.complete({ messages: msg, model: "m" }),
    (e: unknown) => e instanceof RouterError && e.kind === "deadline",
  );
});

test("a per-attempt timeout retries within the deadline", async () => {
  const a = mock({ id: "A", script: [{ hang: true }, { result: { text: "second try" } }] });
  const router = createRouter({
    providers: [a],
    retry: { ...fast, maxAttemptsPerProvider: 2 },
    perAttemptTimeoutMs: 20,
    overallDeadlineMs: 3000,
  });

  const res = await router.complete({ messages: msg, model: "m" });
  assert.equal(res.text, "second try");
  assert.equal(a.invocations, 2);
});

test("emits fallback and success lifecycle events", async () => {
  const a = mock({ id: "A", script: [{ error: new RouterError("server", "500", 500) }] });
  const b = mock({ id: "B", script: [{ result: { text: "B" } }] });
  const seen: string[] = [];
  const router = createRouter({
    providers: [a, b],
    retry: once,
    onEvent: (e) => seen.push(e.type),
  });

  await router.complete({ messages: msg, model: "m" });
  assert.ok(seen.includes("fallback"));
  assert.ok(seen.includes("success"));
});

test("idempotency: concurrent calls with the same key coalesce into one upstream request", async () => {
  const a = mock({ id: "A", script: [{ delayMs: 30, result: { text: "served once" } }] });
  const router = createRouter({ providers: [a], retry: fast });

  const [r1, r2] = await Promise.all([
    router.complete({ messages: msg, model: "m", idempotencyKey: "k1" }),
    router.complete({ messages: msg, model: "m", idempotencyKey: "k1" }),
  ]);

  assert.equal(r1.text, "served once");
  assert.equal(r2.text, "served once");
  assert.equal(a.invocations, 1); // a duplicate call never reached the provider
  assert.equal(router.metrics().coalesced, 1);
});

test("metrics() snapshots cumulative activity", async () => {
  const a = mock({ id: "A", script: [{ error: new RouterError("server", "500", 500) }] });
  const b = mock({ id: "B", script: [{ result: { text: "B" } }] });
  const router = createRouter({ providers: [a, b], retry: once });

  await router.complete({ messages: msg, model: "m" });
  const m = router.metrics();
  assert.equal(m.requests, 1);
  assert.equal(m.successes, 1);
  assert.equal(m.fallbacks, 1);
  assert.equal(m.byProvider["B"]?.served, 1);
  assert.equal(m.byProvider["A"]?.failed, 1);
});
