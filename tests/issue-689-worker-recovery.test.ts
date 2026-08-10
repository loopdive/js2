// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerPool } from "../scripts/compiler-pool.js";

let pool: CompilerPool | undefined;

afterEach(() => {
  pool?.shutdown();
  pool = undefined;
});

describe("#689 Test262 dead-worker recovery", () => {
  it("bounds a repeatedly crashing job and continues queued work on a replacement", async () => {
    const workerPath = join(import.meta.dirname, "fixtures", "compiler-pool-crash-worker.mjs");
    pool = new CompilerPool(1, "compile", workerPath);
    await pool.ready();

    const crashed = await pool.compile("__crash_worker__", 5_000, false, undefined, "crash fixture");
    expect(crashed).toMatchObject({
      ok: false,
      compileMs: 0,
    });
    expect(crashed.ok ? "" : crashed.error).toContain("worker terminated unexpectedly after retry");

    const recovered = await pool.compile("ok", 5_000);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(Array.from(recovered.binary)).toEqual([0]);
    }
  });

  it("records a bounded Test262 compile error instead of abandoning the shard", async () => {
    const workerPath = join(import.meta.dirname, "fixtures", "compiler-pool-crash-worker.mjs");
    pool = new CompilerPool(1, "unified", workerPath);
    await pool.ready();

    await expect(pool.runTest("__crash_worker__", {}, 5_000)).resolves.toMatchObject({
      status: "compile_error",
      compileMs: 0,
      error: expect.stringContaining("worker terminated unexpectedly after retry"),
    });
    await expect(pool.runTest("ok", {}, 5_000)).resolves.toMatchObject({ status: "pass" });
  });
});
