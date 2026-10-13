import { describe, expect, it } from "vitest";
import { CompilerPool } from "../../scripts/compiler-pool.js";
import { FixtureController, finite, pending } from "./fixture-controller.js";

async function fixture(body: (controller: FixtureController) => Promise<void>) {
  const controller = new FixtureController();
  let failed = false,
    primary: unknown;
  let cleanupFailed = false,
    cleanupError: unknown;
  try {
    await body(controller);
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    try {
      await controller.cleanup();
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }
  if (cleanupFailed) {
    if (failed) throw new AggregateError([primary, cleanupError], "Fixture and cleanup failed");
    throw cleanupError;
  }
  if (failed) throw primary;
}

describe.sequential("CompilerPool actual-close shutdown", () => {
  it("holds an active generation until real release/close, preserves external listeners and the original promise", async () => {
    await fixture(async (c) => {
      const pool = c.pool(),
        proc = c.first(pool);
      await finite(pool.ready(), "ready");
      expect(await pool.compile("ok")).toMatchObject({ ok: true, id: 0 });
      let externalClose = 0;
      proc.once("close", () => {
        externalClose++;
      });
      const drain = pool.shutdown(),
        state = pending(drain);
      expect(pool.shutdown(1)).toBe(drain);
      await c.message(proc, "signal");
      expect(proc.killed).toBe(true);
      expect(state.settled).toBe(false);
      expect(c.children.get(proc)!.closed).toBe(false);
      c.release(proc);
      await finite(drain, "real close drain");
      expect(c.children.get(proc)!.closed).toBe(true);
      expect(externalClose).toBe(1);
      expect(pool.shutdown()).toBe(drain);
    });
  });

  it.each(["retired-first", "replacement-first"])(
    "awaits retired and replacement generations in %s order",
    async (order) => {
      await fixture(async (c) => {
        const pool = c.pool(),
          retired = c.first(pool);
        await finite(pool.ready(), "initial ready");
        expect(await pool.compile("recycle")).toMatchObject({ ok: true, recycle: true });
        c.observe(pool);
        const replacement = c.first(pool);
        expect(replacement).not.toBe(retired);
        await c.message(replacement, "ready");
        expect(await pool.compile("ok")).toMatchObject({ ok: true, id: 1 });
        const drain = pool.shutdown(),
          state = pending(drain);
        await c.message(retired, "signal");
        await c.message(replacement, "signal");
        const first = order === "retired-first" ? retired : replacement;
        const last = first === retired ? replacement : retired;
        c.release(first);
        await finite(c.children.get(first)!.done, "first actual close");
        expect(state.settled).toBe(false);
        expect(c.children.get(last)!.closed).toBe(false);
        c.release(last);
        await finite(drain, "both actual closes");
        expect([...c.children.values()].every((child) => child.closed)).toBe(true);
      });
    },
  );

  it("does not equate worker exit with close while a real inherited stdout pipe is open", async () => {
    await fixture(async (c) => {
      const pool = c.pool("pipe"),
        proc = c.first(pool);
      await finite(pool.ready(), "pipe worker ready");
      const drain = pool.shutdown(),
        state = pending(drain);
      await c.message(proc, "signal");
      const exit = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      c.release(proc);
      await finite(exit, "real worker exit");
      const child = c.children.get(proc)!;
      expect(child.messages.find((message) => message.type === "holder").parentPid).toBe(proc.pid);
      expect(child.exit).toEqual({ code: 0, signal: null });
      expect(child.closed).toBe(false);
      expect(state.settled).toBe(false);
      await finite(drain, "natural pipe-holder exit and worker close");
      expect(child.closed).toBe(true);
    });
  });

  it("retains late errors and synchronous signal errors on the real retiring child without recursive replacement", async () => {
    await fixture(async (c) => {
      const pool = c.pool(),
        retired = c.first(pool);
      await finite(pool.ready(), "ready");
      const intended = new Error("actual-child synchronous kill error boundary"),
        originalKill = retired.kill;
      let calls = 0;
      retired.kill = function (signal) {
        calls++;
        this.emit("error", intended); // Test fault seam on a real ChildProcess; the OS signal still delegates.
        return originalKill.call(this, signal);
      };
      try {
        expect(await pool.compile("recycle")).toMatchObject({ ok: true });
      } finally {
        retired.kill = originalKill;
      }
      c.observe(pool);
      const replacement = c.first(pool);
      expect(c.children.size).toBe(2);
      expect(calls).toBe(1);
      expect(c.children.get(retired)!.errors).toContain(intended);
      expect((pool as any).outstandingChildren.get(retired).errors).toContain(intended);
      await c.message(replacement, "ready");
      const drain = pool.shutdown(),
        state = pending(drain);
      await c.message(replacement, "signal");
      const late = new Error("actual retiring child late error before close");
      retired.emit("error", late);
      expect(c.children.get(retired)!.errors).toContain(late);
      expect((pool as any).outstandingChildren.get(retired).errors).toContain(late);
      c.release(replacement);
      await finite(c.children.get(replacement)!.done, "replacement close");
      expect(state.settled).toBe(false);
      c.release(retired);
      await finite(drain, "retired close");
    });
  });

  it("ignored legacy shutdown is handled, yet the same awaited promise visibly rejects with outstanding actual child facts", async () => {
    await fixture(async (c) => {
      const pool = c.pool(),
        proc = c.first(pool);
      await finite(pool.ready(), "ready");
      const unhandled: unknown[] = [],
        listener = (error: unknown) => unhandled.push(error);
      process.on("unhandledRejection", listener);
      try {
        c.expectedTimeoutPools.add(pool);
        const drain = pool.shutdown(40); // Deliberately ignored until the real timeout has fired.
        await c.message(proc, "signal");
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(unhandled).toEqual([]);
        expect(pool.shutdown()).toBe(drain);
        await expect(drain).rejects.toMatchObject({
          name: "CompilerPoolShutdownTimeoutError",
          outstandingChildren: [expect.objectContaining({ pid: proc.pid, closeObserved: false })],
        });
        expect(c.children.get(proc)!.closed).toBe(false);
        c.release(proc);
        await finite(c.children.get(proc)!.done, "timeout child actual close");
        await expect(drain).rejects.toMatchObject({ name: "CompilerPoolShutdownTimeoutError" });
      } finally {
        process.off("unhandledRejection", listener);
      }
    });
  });

  it("settles an empty pool and rejects invalid first timeout values without replacing the promise", async () => {
    const empty = new CompilerPool(0),
      drain = empty.shutdown();
    await drain;
    expect(empty.shutdown()).toBe(drain);
    for (const timeout of [0, -1, NaN, Infinity, 5_001]) {
      const pool = new CompilerPool(0),
        failure = pool.shutdown(timeout);
      await expect(failure).rejects.toBeInstanceOf(RangeError);
      expect(pool.shutdown()).toBe(failure);
    }
  });
});
