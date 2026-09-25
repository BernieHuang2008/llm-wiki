// Shared concurrency gate for the background task executor.
//
// Extracted from task-executor so the "shared vs per-lane" distinction can be
// tested directly. That distinction is the whole point: when each worker lane
// carried its own counter, ten lanes each allowed one task, so a setting of 1
// still ran ten jobs at once.

export type GateClock = {
  sleep: (ms: number) => Promise<void>;
};

const defaultClock: GateClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * In-memory semaphore with a dynamically read limit.
 *
 * One instance must be shared by every worker of a given class of work. The
 * limit is read live, so a settings change applies to the next acquisition
 * without restarting anything.
 *
 * Slots are process-local: a restart resets them, so a worker that dies
 * mid-task cannot leak a slot permanently.
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly label: string,
    private readonly limitFn: () => number,
  ) {}

  /** Current ceiling; always at least 1 so the queue can never deadlock. */
  limit(): number {
    const raw = this.limitFn();
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  }

  /** Slots currently held. Diagnostics only. */
  activeCount(): number {
    return this.active;
  }

  /** Number of callers blocked in `acquire`. Diagnostics only. */
  waitingCount(): number {
    return this.waiters.length;
  }

  labelName(): string {
    return this.label;
  }

  /** Waits for a free slot, then holds it. Always pair with `release()`. */
  async acquire(): Promise<void> {
    if (this.active < this.limit()) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // `release` hands the slot straight to this waiter, so it is already
    // counted as active — do not increment here.
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Transfer the slot: `active` stays the same, ownership moves.
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

/** Runs `fn` while holding a slot, releasing it even if `fn` throws. */
export async function withGate<T>(gate: ConcurrencyGate, fn: () => Promise<T>): Promise<T> {
  await gate.acquire();
  try {
    return await fn();
  } finally {
    gate.release();
  }
}

export { defaultClock };
