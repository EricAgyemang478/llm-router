import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost } from "../src/lib/cost.js";

const prices = { m: { inputPerMTok: 1, outputPerMTok: 2 } };

test("computes cost from usage and the price table", () => {
  const cost = estimateCost(
    "m",
    { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    prices,
  );
  assert.equal(cost, 0.0002); // 100/1e6*1 + 50/1e6*2
});

test("returns undefined for an unpriced model or missing usage", () => {
  assert.equal(
    estimateCost("x", { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, prices),
    undefined,
  );
  assert.equal(estimateCost("m", undefined, prices), undefined);
  assert.equal(
    estimateCost("m", { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, undefined),
    undefined,
  );
});
