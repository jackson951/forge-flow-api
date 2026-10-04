/**
 * Per-provider concurrency (Part 21, FR-21.3). A worker runs WORKER_CONCURRENCY jobs at once;
 * without a limit, one slow or degraded provider (every call waiting for its timeout) could
 * occupy all of them and stall runs that only need other providers.
 *
 * The engine takes a slot before a step starts (before its RUNNING marker is written). When
 * the provider is at its limit the step does not start: the engine throws
 * ProviderSlotsBusyError, and the worker postpones the whole run without using up a retry
 * attempt or holding a worker slot while it waits. Pure TypeScript: no Nest, no Redis.
 */

/** Gives back the slot taken for a step. Calling it more than once has no effect. */
export type ReleaseSlot = () => void;

export interface StepSlots {
  /** A release function, or null when the node type's provider is at its limit. */
  tryAcquire(nodeType: string): ReleaseSlot | null;
  /** The provider a node type counts against (undefined: not limited). */
  providerOf(nodeType: string): string | undefined;
}

/** Node type prefixes that call an external provider. Built-in types are never limited. */
export const PROVIDER_PREFIXES = [
  'github',
  'slack',
  'microsoft',
  'ai',
  'http',
  'jira',
  'gmail',
] as const;

export function providerOf(nodeType: string): string | undefined {
  const prefix = nodeType.split('.', 1)[0];
  return (PROVIDER_PREFIXES as readonly string[]).includes(prefix) ? prefix : undefined;
}

/**
 * Not an ExecutionError: it says nothing about the step's outcome (the step never started).
 * The worker turns it into a delayed job.
 */
export class ProviderSlotsBusyError extends Error {
  constructor(
    readonly provider: string,
    readonly retryAfterMs: number,
  ) {
    super(`All ${provider} slots are busy; the run is postponed`);
    this.name = 'ProviderSlotsBusyError';
  }
}

const noop: ReleaseSlot = () => undefined;
const defaultProviderOf = providerOf;

/** In-process counting semaphore per provider (the limit applies per worker process). */
export class ProviderConcurrencyLimiter implements StepSlots {
  private readonly inFlight = new Map<string, number>();

  constructor(
    readonly limit: number,
    readonly providerOf: (nodeType: string) => string | undefined = defaultProviderOf,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  }

  tryAcquire(nodeType: string): ReleaseSlot | null {
    const provider = this.providerOf(nodeType);
    if (!provider) return noop;
    const current = this.inFlight.get(provider) ?? 0;
    if (current >= this.limit) return null;
    this.inFlight.set(provider, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.set(provider, (this.inFlight.get(provider) ?? 1) - 1);
    };
  }

  /** Steps of `provider` running now (diagnostics and tests). */
  active(provider: string): number {
    return this.inFlight.get(provider) ?? 0;
  }
}
