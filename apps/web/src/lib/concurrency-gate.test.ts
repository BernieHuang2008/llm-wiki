import { describe, expect, it } from "vitest";

import { ConcurrencyGate } from "./concurrency-gate";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ConcurrencyGate", () => {
  it("allows exactly `limit` holders at once, whatever the number of workers", async () => {
    // The bug this pins: ten worker lanes each carrying their own counter ran
    // ten tasks at a time even with the limit set to 1.
    const gate = new ConcurrencyGate("ingest", () => 1);
    let peak = 0;
    let inFlight = 0;

    const workers = Array.from({ length: 10 }, async () => {
      await gate.acquire();
      try {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await delay(10);
        inFlight -= 1;
      } finally {
        gate.release();
      }
    });

    await Promise.all(workers);
    expect(peak).toBe(1);
    expect(gate.activeCount()).toBe(0);
    expect(gate.waitingCount()).toBe(0);
  });

  it("allows up to the configured limit in parallel", async () => {
    const gate = new ConcurrencyGate("ingest", () => 3);
    let peak = 0;
    let inFlight = 0;

    const workers = Array.from({ length: 10 }, async () => {
      await gate.acquire();
      try {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await delay(10);
        inFlight -= 1;
      } finally {
        gate.release();
      }
    });

    await Promise.all(workers);
    expect(peak).toBe(3);
  });

  it("re-reads the limit live, so a settings change applies without a restart", async () => {
    let limit = 1;
    const gate = new ConcurrencyGate("ingest", () => limit);
    expect(gate.limit()).toBe(1);

    limit = 4;
    expect(gate.limit()).toBe(4);

    let peak = 0;
    let inFlight = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        await gate.acquire();
        try {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await delay(10);
          inFlight -= 1;
        } finally {
          gate.release();
        }
      }),
    );
    expect(peak).toBe(4);
  });

  it("frees a slot when the holder throws", async () => {
    const gate = new ConcurrencyGate("ingest", () => 1);
    await gate.acquire();
    // A throwing worker must still return its slot or the queue wedges.
    try {
      throw new Error("boom");
    } catch {
      gate.release();
    }

    let ran = false;
    await gate.acquire();
    ran = true;
    gate.release();
    expect(ran).toBe(true);
  });

  it("never deadlocks on a nonsensical limit", async () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const gate = new ConcurrencyGate("ingest", () => bad);
      expect(gate.limit()).toBe(1);
      await gate.acquire();
      gate.release();
    }
  });

  it("hands a released slot straight to the next waiter (no lost wakeups)", async () => {
    const gate = new ConcurrencyGate("ingest", () => 1);
    const order: number[] = [];

    const first = (async () => {
      await gate.acquire();
      order.push(1);
      await delay(15);
      gate.release();
    })();

    // Queued behind `first` while it holds the only slot.
    await delay(2);
    const second = (async () => {
      await gate.acquire();
      order.push(2);
      gate.release();
    })();

    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
    expect(gate.activeCount()).toBe(0);
  });
});
