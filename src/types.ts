export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type FinishReason = "stop" | "length" | "content_filter" | "error" | "unknown";

/** What an adapter receives — provider-agnostic, already normalized. */
export interface NormalizedRequest {
  messages: Message[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
}

/** What a consumer passes to router.complete() / router.stream(). */
export interface CompleteRequest extends NormalizedRequest {
  /** Override the configured provider chain for this one call. */
  providers?: string[];
  /** Override the overall deadline (ms) for this call. */
  deadlineMs?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ProviderResult {
  text: string;
  model: string;
  usage: Usage;
  finishReason: FinishReason;
  raw?: unknown;
}

export type ProviderChunk =
  | { type: "delta"; text: string }
  | { type: "final"; usage: Usage; finishReason: FinishReason; model: string };

export interface ProviderCapabilities {
  streaming: boolean;
  /** When set, the provider is only tried for models it returns true for. */
  supportsModel?: (model: string) => boolean;
  /** Used to decide context-length failover targets. */
  maxContextTokens?: number;
}

/** The single interface every provider adapter implements. */
export interface LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  complete(req: NormalizedRequest, signal: AbortSignal): Promise<ProviderResult>;
  stream?(req: NormalizedRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>;
}

/** One row of the per-request audit trail. */
export interface AttemptRecord {
  provider: string;
  attempt: number; // 1-based, per provider
  ok: boolean;
  errorKind?: RouterErrorKind;
  status?: number;
  latencyMs: number;
}

export interface CompleteResult {
  text: string;
  model: string;
  /** Which provider actually served the request. */
  provider: string;
  usage: Usage;
  costUsd?: number;
  finishReason: FinishReason;
  attempts: AttemptRecord[];
  /** How many providers were advanced past before one succeeded. */
  fallbacksUsed: number;
}

export type RouterErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "malformed"
  | "bad_request"
  | "context_length"
  | "content_filter"
  | "unsupported"
  | "deadline"
  | "unknown";

export interface RetryConfig {
  maxAttemptsPerProvider: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export interface BreakerConfig {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
}

export interface PriceTable {
  [model: string]: { inputPerMTok: number; outputPerMTok: number };
}

export type RouterEvent =
  | { type: "attempt"; provider: string; attempt: number; model: string }
  | { type: "retry"; provider: string; attempt: number; delayMs: number; kind: RouterErrorKind }
  | { type: "fallback"; from: string; to: string; kind: RouterErrorKind }
  | { type: "breaker_open"; provider: string }
  | { type: "breaker_close"; provider: string }
  | { type: "success"; provider: string; attempts: number; costUsd?: number }
  | { type: "error"; provider: string; kind: RouterErrorKind; status?: number };

export interface RouterConfig {
  providers: LLMProvider[];
  /** Ordered provider ids to try. Defaults to the order of `providers`. */
  fallback?: string[];
  retry?: Partial<RetryConfig>;
  breaker?: Partial<BreakerConfig>;
  perAttemptTimeoutMs?: number;
  overallDeadlineMs?: number;
  prices?: PriceTable;
  onEvent?: (event: RouterEvent) => void;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttemptsPerProvider: 3,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  jitter: true,
};

export const DEFAULT_BREAKER: BreakerConfig = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
};

export const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 30_000;
export const DEFAULT_OVERALL_DEADLINE_MS = 120_000;
