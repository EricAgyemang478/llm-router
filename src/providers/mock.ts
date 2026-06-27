import type {
  LLMProvider,
  NormalizedRequest,
  ProviderCapabilities,
  ProviderResult,
} from "../types.js";
import { RouterError } from "../errors.js";
import { sleep } from "../lib/backoff.js";

export interface MockBehavior {
  /** Return this result (merged over sensible defaults). */
  result?: Partial<ProviderResult>;
  /** Throw this error instead. */
  error?: RouterError;
  /** Simulate latency before resolving/throwing. */
  delayMs?: number;
  /** Never settle until the request is aborted (for timeout tests). */
  hang?: boolean;
}

export interface MockProvider extends LLMProvider {
  /** How many times complete() was called — assert fast-skip / fallback in tests. */
  readonly invocations: number;
}

const DEFAULT_RESULT: ProviderResult = {
  text: "ok",
  model: "mock-model",
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
};

/**
 * A deterministic, key-free provider for tests. Give it a script of behaviors;
 * each call consumes the next one (the last repeats once exhausted).
 */
export function mock(opts: {
  id: string;
  script: MockBehavior[];
  capabilities?: Partial<ProviderCapabilities>;
}): MockProvider {
  let calls = 0;

  return {
    id: opts.id,
    capabilities: { streaming: false, ...opts.capabilities },
    get invocations() {
      return calls;
    },
    async complete(req: NormalizedRequest, signal: AbortSignal): Promise<ProviderResult> {
      const behavior = opts.script[Math.min(calls, opts.script.length - 1)] ?? {};
      calls++;

      if (behavior.hang) {
        await new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        });
      }
      if (behavior.delayMs) await sleep(behavior.delayMs, signal);
      if (behavior.error) throw behavior.error;

      const usage = behavior.result?.usage ?? DEFAULT_RESULT.usage;
      return {
        ...DEFAULT_RESULT,
        model: req.model || DEFAULT_RESULT.model,
        ...behavior.result,
        usage: { ...usage, totalTokens: usage.promptTokens + usage.completionTokens },
      };
    },
  };
}
