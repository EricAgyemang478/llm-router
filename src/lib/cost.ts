import type { PriceTable, Usage } from "../types.js";

/**
 * Estimate dollar cost from token usage and a price table (USD per 1M tokens).
 * Returns undefined when the model isn't priced or usage is unknown, so callers
 * can distinguish "free" from "we don't know".
 */
export function estimateCost(
  model: string,
  usage: Usage | undefined,
  prices: PriceTable | undefined,
): number | undefined {
  if (!usage || !prices) return undefined;
  const price = prices[model];
  if (!price) return undefined;
  const input = (usage.promptTokens / 1_000_000) * price.inputPerMTok;
  const output = (usage.completionTokens / 1_000_000) * price.outputPerMTok;
  return input + output;
}
