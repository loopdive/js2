import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood helper has no declaration file
import {
  readWorkerCompileDuration,
  runSequentialUpstreamTests,
  stripWorkerProtocol,
} from "./upstream-suite-worker-protocol.mjs";
// @ts-expect-error — .mjs dogfood helper has no declaration file
import { createUnhandledRejectionSink } from "./upstream-unhandled-rejections.mjs";

describe("upstream suite worker protocol", () => {
  it("separates the compile-complete marker from worker diagnostics", () => {
    const stderr = "before\n__JS2WASM_COMPILE_COMPLETE__:1234\nafter\n";
    expect(readWorkerCompileDuration(stderr)).toBe(1234);
    expect(stripWorkerProtocol(stderr)).toBe("before\nafter");
  });

  it("times out one async export and continues with the next export", async () => {
    const result = await runSequentialUpstreamTests({
      ids: ["never", "next"],
      invoke: (id: string) => (id === "never" ? new Promise(() => {}) : 1),
      timeoutMs: 10,
      thrownText: (error: Error) => error.message,
      failureText: () => "failed without throwing",
    });

    expect(result.statuses).toEqual([false, true]);
    expect(result.errors[0]).toContain("compiled upstream test never timed out after 10ms");
    expect(result.errors[1]).toBe("");
  });

  it("arms the uncaught-exception listener only while tests are running (#6424)", async () => {
    // The cheap guard for acceptance 2: outside this loop — compile,
    // instantiation, module init, teardown, emit — an uncaught exception must
    // still kill the worker fast instead of being swallowed into a timeout the
    // worker can never emit out of.
    const sink = createUnhandledRejectionSink({
      label: "test",
      stream: { write: () => true },
    });
    const before = process.listenerCount("uncaughtException");
    let inside = -1;
    try {
      const result = await runSequentialUpstreamTests({
        ids: [0],
        invoke: () => {
          inside = process.listenerCount("uncaughtException");
          return 1;
        },
        timeoutMs: 0,
        thrownText: (error: Error) => error.message,
        failureText: () => "",
        rejections: sink,
      });
      expect(result.statuses).toEqual([true]);
    } finally {
      sink.dispose();
    }
    expect(inside).toBe(before + 1);
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });
});
