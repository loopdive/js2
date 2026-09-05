import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood helper has no declaration file
import {
  readWorkerCompileDuration,
  runSequentialUpstreamTests,
  stripWorkerProtocol,
} from "./upstream-suite-worker-protocol.mjs";

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
});
