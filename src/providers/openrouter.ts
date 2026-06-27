import type { LLMProvider, ProviderCapabilities } from "../types.js";
import { openaiCompatible } from "./openai.js";

/** OpenRouter exposes an OpenAI-compatible API and is model-agnostic, so it makes
 *  a good last-resort provider in a fallback chain. */
export function openRouter(
  opts: {
    apiKey?: string;
    baseUrl?: string;
    id?: string;
    capabilities?: Partial<ProviderCapabilities>;
  } = {},
): LLMProvider {
  return openaiCompatible({
    id: opts.id ?? "openrouter",
    apiKey: opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "",
    baseUrl: opts.baseUrl ?? "https://openrouter.ai/api/v1",
    capabilities: { streaming: true, supportsModel: () => true, ...opts.capabilities },
  });
}
