import {
  DEFAULT_BREAKER,
  DEFAULT_OVERALL_DEADLINE_MS,
  DEFAULT_PER_ATTEMPT_TIMEOUT_MS,
  DEFAULT_RETRY,
  type AttemptRecord,
  type CompleteRequest,
  type CompleteResult,
  type LLMProvider,
  type RouterConfig,
  type RouterErrorKind,
  type RouterEvent,
  type RouterMetrics,
} from "./types.js";
import { AllProvidersFailed, RouterError, fromThrown, mostActionable } from "./errors.js";
import { backoffDelay, sleep, withRetryAfter } from "./lib/backoff.js";
import { BreakerRegistry } from "./lib/circuit-breaker.js";
import { estimateCost } from "./lib/cost.js";

const MIN_BUDGET_MS = 50;

export interface Router {
  complete(req: CompleteRequest): Promise<CompleteResult>;
  /** A snapshot of cumulative activity — wire it into a metrics/health endpoint. */
  metrics(): RouterMetrics;
}

export function createRouter(config: RouterConfig): Router {
  const retry = { ...DEFAULT_RETRY, ...config.retry };
  const breakerCfg = { ...DEFAULT_BREAKER, ...config.breaker };
  const perAttemptTimeoutMs = config.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS;
  const overallDeadlineMs = config.overallDeadlineMs ?? DEFAULT_OVERALL_DEADLINE_MS;
  const metrics: RouterMetrics = {
    requests: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    fallbacks: 0,
    breakerTrips: 0,
    coalesced: 0,
    byProvider: {},
  };
  const bump = (id: string, field: "served" | "failed"): void => {
    (metrics.byProvider[id] ??= { served: 0, failed: 0 })[field]++;
  };

  // One place to derive metrics from the event stream, then forward to the user.
  const emit = (e: RouterEvent): void => {
    if (e.type === "retry") metrics.retries++;
    else if (e.type === "fallback") metrics.fallbacks++;
    else if (e.type === "breaker_open") metrics.breakerTrips++;
    else if (e.type === "success") {
      metrics.successes++;
      bump(e.provider, "served");
    } else if (e.type === "error") bump(e.provider, "failed");
    config.onEvent?.(e);
  };

  const byId = new Map(config.providers.map((p) => [p.id, p]));
  const defaultChain = config.fallback ?? config.providers.map((p) => p.id);

  const breaker = new BreakerRegistry(
    breakerCfg,
    Date.now,
    (id) => emit({ type: "breaker_open", provider: id }),
    (id) => emit({ type: "breaker_close", provider: id }),
  );

  async function run(req: CompleteRequest): Promise<CompleteResult> {
    // Build the candidate chain: requested or default order, de-duped (visited
    // once), and filtered to providers that support the model.
    const chainIds = (req.providers ?? defaultChain).filter((id, i, a) => a.indexOf(id) === i);
    const candidates = chainIds
      .map((id) => byId.get(id))
      .filter((p): p is LLMProvider => Boolean(p))
      .filter((p) => !p.capabilities.supportsModel || p.capabilities.supportsModel(req.model));

    if (candidates.length === 0) {
      throw new RouterError("unsupported", `No configured provider supports model "${req.model}"`);
    }

    const deadline = Date.now() + (req.deadlineMs ?? overallDeadlineMs);
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadlineController.abort(),
      Math.max(0, deadline - Date.now()),
    );

    const attempts: AttemptRecord[] = [];
    const perProvider: Record<string, { kind: RouterErrorKind; status?: number; message: string }> =
      {};
    let prevKind: RouterErrorKind = "unknown";

    const normalized = {
      messages: req.messages,
      model: req.model,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      topP: req.topP,
      stop: req.stop,
    };

    try {
      for (let ci = 0; ci < candidates.length; ci++) {
        const provider = candidates[ci]!;
        if (ci > 0)
          emit({ type: "fallback", from: candidates[ci - 1]!.id, to: provider.id, kind: prevKind });

        // Fast-skip a provider whose breaker is open.
        if (!breaker.canAttempt(provider.id)) {
          perProvider[provider.id] = { kind: "server", message: "circuit open (skipped)" };
          prevKind = "server";
          continue;
        }

        let lastErr: RouterError | undefined;
        for (let attempt = 1; attempt <= retry.maxAttemptsPerProvider; attempt++) {
          const remaining = deadline - Date.now();
          if (remaining <= MIN_BUDGET_MS) {
            throw new RouterError(
              "deadline",
              "overall deadline exceeded",
              undefined,
              undefined,
              lastErr,
            );
          }

          const t0 = Date.now();
          emit({ type: "attempt", provider: provider.id, attempt, model: req.model });
          const signal = linkSignals([
            req.signal,
            deadlineController.signal,
            AbortSignal.timeout(Math.min(perAttemptTimeoutMs, remaining)),
          ]);

          try {
            const r = await provider.complete(normalized, signal);
            attempts.push({ provider: provider.id, attempt, ok: true, latencyMs: Date.now() - t0 });
            breaker.recordSuccess(provider.id);
            const costUsd = estimateCost(r.model, r.usage, config.prices);
            emit({ type: "success", provider: provider.id, attempts: attempt, costUsd });
            return {
              text: r.text,
              model: r.model,
              provider: provider.id,
              usage: r.usage,
              costUsd,
              finishReason: r.finishReason,
              attempts,
              fallbacksUsed: ci,
            };
          } catch (err) {
            const e = fromThrown(err);
            // Disambiguate why a request aborted.
            if (e.kind === "timeout") {
              if (deadlineController.signal.aborted) {
                throw new RouterError(
                  "deadline",
                  "overall deadline exceeded",
                  undefined,
                  undefined,
                  e,
                );
              }
              if (req.signal?.aborted) throw e; // caller cancelled
            }
            lastErr = e;
            attempts.push({
              provider: provider.id,
              attempt,
              ok: false,
              errorKind: e.kind,
              status: e.status,
              latencyMs: Date.now() - t0,
            });
            perProvider[provider.id] = { kind: e.kind, status: e.status, message: e.message };
            emit({ type: "error", provider: provider.id, kind: e.kind, status: e.status });
            if (e.providerFault) breaker.recordFailure(provider.id, e.kind === "auth");

            if (e.retryable && attempt < retry.maxAttemptsPerProvider) {
              const computed = backoffDelay(
                attempt,
                retry.baseDelayMs,
                retry.maxDelayMs,
                retry.jitter,
              );
              const delay = withRetryAfter(computed, e.retryAfterMs);
              if (delay > deadline - Date.now() - MIN_BUDGET_MS) break; // no budget → fail over
              emit({ type: "retry", provider: provider.id, attempt, delayMs: delay, kind: e.kind });
              await sleep(delay, deadlineController.signal).catch(() => {
                throw new RouterError(
                  "deadline",
                  "overall deadline exceeded",
                  undefined,
                  undefined,
                  e,
                );
              });
              continue;
            }
            break; // exhausted or non-retryable
          }
        }

        // Provider failed. content_filter / bad_request are futile elsewhere — surface now.
        if (lastErr && !lastErr.failover) throw lastErr;
        if (lastErr) prevKind = lastErr.kind;
      }

      const kinds = Object.values(perProvider).map((p) => p.kind);
      throw new AllProvidersFailed(mostActionable(kinds), perProvider, attempts);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  // Idempotency: coalesce concurrent calls that share an idempotencyKey so a
  // retry/duplicate never issues a second upstream request (or a second charge).
  const inFlight = new Map<string, Promise<CompleteResult>>();

  async function complete(req: CompleteRequest): Promise<CompleteResult> {
    metrics.requests++;
    const key = req.idempotencyKey;
    if (key && inFlight.has(key)) {
      metrics.coalesced++;
      return inFlight.get(key)!;
    }
    const p = run(req).catch((err: unknown) => {
      metrics.failures++;
      throw err;
    });
    if (key) {
      inFlight.set(key, p);
      void p.finally(() => inFlight.delete(key));
    }
    return p;
  }

  return { complete, metrics: () => structuredClone(metrics) };
}

function linkSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const real = signals.filter((s): s is AbortSignal => Boolean(s));
  return real.length === 1 ? real[0]! : AbortSignal.any(real);
}
