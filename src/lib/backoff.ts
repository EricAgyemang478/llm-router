/** Exponential backoff with full jitter: random(0, min(base * 2^(n-1), cap)). */
export function backoffDelay(
  attempt: number,
  base: number,
  cap: number,
  jitter: boolean,
  rng: () => number = Math.random,
): number {
  const ceiling = Math.min(base * 2 ** (attempt - 1), cap);
  return jitter ? Math.floor(rng() * ceiling) : ceiling;
}

/** A provider's Retry-After (when present) wins over computed backoff. */
export function withRetryAfter(computedMs: number, retryAfterMs?: number): number {
  return retryAfterMs != null ? Math.max(retryAfterMs, computedMs) : computedMs;
}

/** Sleep that resolves after `ms`, or rejects immediately if the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date) into ms. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
