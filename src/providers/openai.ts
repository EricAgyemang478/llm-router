import type {
  FinishReason,
  LLMProvider,
  NormalizedRequest,
  ProviderCapabilities,
  ProviderResult,
} from "../types.js";
import { RouterError, classifyStatus } from "../errors.js";
import { parseRetryAfter } from "../lib/backoff.js";

function mapFinish(reason: unknown): FinishReason {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "content_filter";
  return "unknown";
}

/** Shared adapter for any OpenAI-compatible Chat Completions endpoint. */
export function openaiCompatible(opts: {
  id: string;
  apiKey: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  capabilities?: Partial<ProviderCapabilities>;
}): LLMProvider {
  return {
    id: opts.id,
    capabilities: { streaming: true, ...opts.capabilities },
    async complete(req: NormalizedRequest, signal: AbortSignal): Promise<ProviderResult> {
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
          ...opts.extraHeaders,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          top_p: req.topP,
          stop: req.stop,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new RouterError(
          classifyStatus(res.status, body),
          `${opts.id} HTTP ${res.status}`,
          res.status,
          parseRetryAfter(res.headers.get("retry-after")),
        );
      }

      const json = (await res.json().catch(() => null)) as Record<string, any> | null;
      const choice = json?.choices?.[0];
      const text = choice?.message?.content;
      if (typeof text !== "string") {
        throw new RouterError("malformed", `${opts.id}: response missing content`, res.status);
      }
      const u = json?.usage ?? {};
      return {
        text,
        model: json?.model ?? req.model,
        usage: {
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
        },
        finishReason: mapFinish(choice?.finish_reason),
        raw: json,
      };
    },
  };
}

export function openai(
  opts: {
    apiKey?: string;
    baseUrl?: string;
    id?: string;
    capabilities?: Partial<ProviderCapabilities>;
  } = {},
): LLMProvider {
  return openaiCompatible({
    id: opts.id ?? "openai",
    apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? "",
    baseUrl: opts.baseUrl ?? "https://api.openai.com/v1",
    capabilities: opts.capabilities,
  });
}
