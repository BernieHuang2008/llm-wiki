import { AsyncLocalStorage } from "node:async_hooks";

/**
 * In-process write lock, one per wiki folder.
 *
 * Why this exists: ingest is mostly a slow model call, so several can run at
 * once — but each one *ends* by rewriting shared state: page files, the
 * `pages` table, `index.md`, and `log.md`. Those sections are read-modify-write
 * cycles. `index.md` is merge-based (read the existing entries, merge the new
 * ones, write the whole file back), so two ingests committing at the same
 * moment means the second write drops the first one's entries.
 *
 * Serializing just the commit phase keeps the expensive part parallel while
 * making the shared-state part safe. Re-entrancy is tracked with
 * AsyncLocalStorage so a caller that already holds the lock (for example
 * `applyIngestResponse` → `rebuildIndex`) does not deadlock against itself.
 */

type Waiter = () => void;

const store = new AsyncLocalStorage<Set<string>>();

/** Wiki paths whose lock is currently held, in queue order. */
const held = new Set<string>();
const queues = new Map<string, Waiter[]>();

/**
 * Safety valve: a lock that is never released would wedge every later writer
 * for that wiki. Failing loudly after this long turns a silent hang into a
 * visible error.
 */
const ACQUIRE_TIMEOUT_MS = 60_000;

function currentHolds(): Set<string> | undefined {
  return store.getStore();
}

async function acquire(key: string): Promise<void> {
  if (!held.has(key)) {
    held.add(key);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const queue = queues.get(key) ?? [];
    let settled = false;

    const waiter: Waiter = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    queue.push(waiter);
    queues.set(key, queue);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = queue.indexOf(waiter);
      if (idx !== -1) queue.splice(idx, 1);
      reject(new Error(`等待 ${key} 的写入锁超时（${ACQUIRE_TIMEOUT_MS / 1000}s）`));
    }, ACQUIRE_TIMEOUT_MS);
    // Node's timer should not keep the process alive on its own.
    timer.unref?.();
  });
}

function release(key: string): void {
  const queue = queues.get(key);
  const next = queue?.shift();
  if (next) {
    // Hand the lock straight to the next waiter — it stays "held" throughout.
    if (queue && queue.length === 0) queues.delete(key);
    next();
    return;
  }
  queues.delete(key);
  held.delete(key);
}

/**
 * Runs `fn` while holding the write lock for `wikiPath`.
 *
 * Nested calls for the same wiki run immediately: the outer holder is already
 * the only writer, so re-acquiring would be a self-deadlock.
 */
export async function withWriteLock<T>(wikiPath: string, fn: () => Promise<T>): Promise<T> {
  const alreadyHeld = currentHolds();
  if (alreadyHeld?.has(wikiPath)) {
    return fn();
  }

  await acquire(wikiPath);
  const nextHeld = alreadyHeld ?? new Set<string>();
  nextHeld.add(wikiPath);
  try {
    return await store.run(nextHeld, fn);
  } finally {
    nextHeld.delete(wikiPath);
    release(wikiPath);
  }
}

/** Diagnostics for tests: true when nothing holds any lock. */
export function _noLocksHeldForTests(): boolean {
  return held.size === 0 && queues.size === 0;
}
