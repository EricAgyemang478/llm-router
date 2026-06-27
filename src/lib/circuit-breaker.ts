import type { BreakerConfig } from "../types.js";

type State = "closed" | "open" | "half_open";

interface ProviderState {
  state: State;
  failures: number[]; // failure timestamps within the rolling window
  openedAt: number;
}

/**
 * Per-provider circuit breaker. A provider that keeps failing is tripped OPEN and
 * skipped without a network call until a cooldown elapses, then a single HALF-OPEN
 * probe decides whether to close it again. Only *provider faults* are recorded —
 * a bad request never penalizes a healthy provider.
 */
export class BreakerRegistry {
  private readonly states = new Map<string, ProviderState>();

  constructor(
    private readonly cfg: BreakerConfig,
    private readonly now: () => number = Date.now,
    private readonly onOpen?: (id: string) => void,
    private readonly onClose?: (id: string) => void,
  ) {}

  private get(id: string): ProviderState {
    let s = this.states.get(id);
    if (!s) {
      s = { state: "closed", failures: [], openedAt: 0 };
      this.states.set(id, s);
    }
    return s;
  }

  /** May we attempt this provider right now? Transitions open → half_open after cooldown. */
  canAttempt(id: string): boolean {
    const s = this.get(id);
    if (s.state === "open") {
      if (this.now() - s.openedAt >= this.cfg.cooldownMs) {
        s.state = "half_open";
        return true; // allow a single probe
      }
      return false;
    }
    return true; // closed or half_open
  }

  recordSuccess(id: string): void {
    const s = this.get(id);
    if (s.state !== "closed") {
      s.state = "closed";
      this.onClose?.(id);
    }
    s.failures = [];
  }

  /** Record a provider fault. `hardDown` (e.g. auth) trips OPEN immediately. */
  recordFailure(id: string, hardDown = false): void {
    const s = this.get(id);
    const t = this.now();

    if (s.state === "half_open") {
      this.trip(id, s, t);
      return;
    }

    s.failures = s.failures.filter((ts) => t - ts < this.cfg.windowMs);
    s.failures.push(t);

    if (hardDown || s.failures.length >= this.cfg.failureThreshold) {
      this.trip(id, s, t);
    }
  }

  private trip(id: string, s: ProviderState, t: number): void {
    if (s.state !== "open") this.onOpen?.(id);
    s.state = "open";
    s.openedAt = t;
    s.failures = [];
  }

  stateOf(id: string): State {
    return this.get(id).state;
  }
}
