import type { AttemptRecord, RouterErrorKind } from "./types.js";

/** A single normalized failure. Adapters throw these; the router reasons over them. */
export class RouterError extends Error {
  constructor(
    readonly kind: RouterErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RouterError";
  }

  /** Worth retrying on the SAME provider. */
  get retryable(): boolean {
    return (
      this.kind === "rate_limit" ||
      this.kind === "server" ||
      this.kind === "network" ||
      this.kind === "timeout" ||
      this.kind === "malformed"
    );
  }

  /** Counts toward the provider's circuit breaker (a provider fault, not a request fault). */
  get providerFault(): boolean {
    return (
      this.kind === "server" ||
      this.kind === "network" ||
      this.kind === "timeout" ||
      this.kind === "malformed" ||
      this.kind === "auth"
    );
  }

  /** Should we advance to the next provider? content_filter and bad_request are
   *  futile to retry anywhere, so they surface immediately. */
  get failover(): boolean {
    return this.kind !== "content_filter" && this.kind !== "bad_request";
  }
}

/** The terminal error when every provider in the chain failed. */
export class AllProvidersFailed extends RouterError {
  constructor(
    kind: RouterErrorKind,
    readonly perProvider: Record<
      string,
      { kind: RouterErrorKind; status?: number; message: string }
    >,
    readonly attempts: AttemptRecord[],
  ) {
    super(kind, `All providers failed (${Object.keys(perProvider).join(", ")})`);
    this.name = "AllProvidersFailed";
  }
}

/** Map an HTTP response to a normalized error kind. */
export function classifyStatus(status: number, bodyHint?: string): RouterErrorKind {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 501) return "unsupported";
  if (status >= 500) return "server";
  if (status === 400 || status === 422) {
    if (bodyHint && /context|max.?tokens|too (long|large)/i.test(bodyHint)) return "context_length";
    if (bodyHint && /content|safety|policy/i.test(bodyHint)) return "content_filter";
    return "bad_request";
  }
  return "unknown";
}

/** Wrap a thrown transport/abort error as a RouterError. */
export function fromThrown(err: unknown): RouterError {
  if (err instanceof RouterError) return err;
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError")
    return new RouterError("timeout", "aborted", undefined, undefined, err);
  const message = err instanceof Error ? err.message : String(err);
  return new RouterError("network", message, undefined, undefined, err);
}

/** Priority used to pick the most actionable error to surface from a failed chain. */
const SURFACE_PRIORITY: RouterErrorKind[] = [
  "auth",
  "context_length",
  "content_filter",
  "rate_limit",
  "deadline",
  "server",
  "network",
  "timeout",
  "malformed",
  "bad_request",
  "unsupported",
  "unknown",
];

export function mostActionable(kinds: RouterErrorKind[]): RouterErrorKind {
  for (const k of SURFACE_PRIORITY) if (kinds.includes(k)) return k;
  return "unknown";
}
