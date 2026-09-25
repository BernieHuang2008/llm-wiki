import { describe, expect, it } from "vitest";

import { _noLocksHeldForTests, withWriteLock } from "./write-lock";

const WIKI = "/tmp/wiki-lock-test";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withWriteLock", () => {
  it("returns the function's value", async () => {
    const result = await withWriteLock(WIKI, async () => 42);
    expect(result).toBe(42);
  });

  it("serializes overlapping writers for the same wiki", async () => {
    const events: string[] = [];

    const first = withWriteLock(WIKI, async () => {
      events.push("first:enter");
      await delay(30);
      events.push("first:exit");
    });

    // Started while `first` still holds the lock.
    await delay(5);
    const second = withWriteLock(WIKI, async () => {
      events.push("second:enter");
      await delay(5);
      events.push("second:exit");
    });

    await Promise.all([first, second]);
    // No interleaving: `first` fully exits before `second` enters.
    expect(events).toEqual(["first:enter", "first:exit", "second:enter", "second:exit"]);
  });

  it("lets different wikis proceed in parallel", async () => {
    const events: string[] = [];

    const a = withWriteLock("/tmp/wiki-a", async () => {
      events.push("a:enter");
      await delay(25);
      events.push("a:exit");
    });
    const b = withWriteLock("/tmp/wiki-b", async () => {
      events.push("b:enter");
      await delay(5);
      events.push("b:exit");
    });

    await Promise.all([a, b]);
    // b finished while a was still running.
    expect(events.indexOf("b:exit")).toBeLessThan(events.indexOf("a:exit"));
  });

  it("is re-entrant so nested callers cannot deadlock", async () => {
    // Mirrors applyIngestResponse -> rebuildIndex, which both want the lock.
    const result = await withWriteLock(WIKI, async () => {
      return withWriteLock(WIKI, async () => "nested-ok");
    });
    expect(result).toBe("nested-ok");
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withWriteLock(WIKI, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A failed holder must not wedge the wiki for everyone after it.
    const after = await withWriteLock(WIKI, async () => "recovered");
    expect(after).toBe("recovered");
    expect(_noLocksHeldForTests()).toBe(true);
  });

  it("serves waiters in acquisition order", async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) =>
      withWriteLock(WIKI, async () => {
        order.push(n);
        await delay(5);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });
});
