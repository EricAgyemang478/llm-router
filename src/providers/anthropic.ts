import type {
  FinishReason,
  LLMProvider,
  NormalizedRequest,
  ProviderCapabilities,
  ProviderResult,
} from "../types.js";
import { RouterError, classifyStatus } from "../errors.js";
import { parseRetryAfter } from "../lib/backoff.js";

function mapStop(reason: unknown): FinishReason {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "max_tokens") return "length";
  return "unknown";
}

/** Adapter for the Anthropic Messages API (system prompt is a top-level field, not a message). */
export function anthropic(
  opts: {
    apiKey?: string;
    id?: string;
    capabilities?: Partial<ProviderCapabilities>;
  } = {},
): LLMProvider {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";

  return {
    id: opts.id ?? "anthropic",
    capabilities: { streaming: true, ...opts.capabilities },
    async complete(req: NormalizedRequest, signal: AbortSignal): Promise<ProviderResult> {
      const system = req.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const messages = req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: req.model,
          system: system || undefined,
          messages,
          max_tokens: req.maxTokens ?? 1024,
          temperature: req.temperature,
          top_p: req.topP,
          stop_sequences: req.stop,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new RouterError(
          classifyStatus(res.status, body),
          `anthropic HTTP ${res.status}`,
          res.status,
          parseRetryAfter(res.headers.get("retry-after")),
        );
      }

      const json = (await res.json().catch(() => null)) as Record<string, any> | null;
      const text = json?.content?.[0]?.text;
      if (typeof text !== "string") {
        throw new RouterError("malformed", "anthropic: response missing content", res.status);
      }
      const u = json?.usage ?? {};
      const promptTokens = u.input_tokens ?? 0;
      const completionTokens = u.output_tokens ?? 0;
      return {
        text,
        model: json?.model ?? req.model,
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        finishReason: mapStop(json?.stop_reason),
        raw: json,
      };
    },
  };
}
