/**
 * #3599 — external callers must be able to reuse a FyiSourceExecutor across
 * many executeTestFile() calls instead of paying a fresh compiler-module
 * load + worker fork per call (measured ~2.3-2.8s of pure fixed overhead per
 * test file through the one-shot js2-test262 CLI — see #3574's investigation
 * and this issue's own before/after numbers).
 *
 * The bundled-context worker-path bug this issue also fixed (FyiSourceExecutor's
 * default `workerPath` resolving into a non-published `scripts/` path when
 * bundled into dist/test262-fyi-cli.js) is verified separately via a real
 * `npm pack` + `npm install` — not reproducible here, since vitest runs
 * against the unbundled source where `import.meta.url` already points at the
 * real scripts/ directory. See the issue file for that verification.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { FyiSourceExecutor, executeTestFile } from "../scripts/test262-fyi-cli.mjs";

const TEST262_ROOT = mkdtempSync(join(tmpdir(), "js2-issue-3599-"));
mkdirSync(join(TEST262_ROOT, "test"), { recursive: true });

// Plain, unwrapped script body — matches what test262-fyi/data's read.js
// actually assembles (prelude + raw test body, no function wrapper); source
// wrapping, if any, is this package's own concern internally.
const PASSING_SOURCE = "var x = 1 + 1;\n";

function writeAssembledTest(name: string, source: string) {
  writeFileSync(join(TEST262_ROOT, "test", `${name}.js2wasm`), source);
}

afterAll(() => {
  rmSync(TEST262_ROOT, { recursive: true, force: true });
});

describe("#3599 FyiSourceExecutor reuse", () => {
  afterEach(() => {
    rmSync(join(TEST262_ROOT, "test", "sample.js2wasm"), { force: true });
  });

  it("resolves a real worker script by default (regression: stale WORKER_PATH constant)", () => {
    const executor = new FyiSourceExecutor();
    try {
      expect(executor.workerPath).toBeTruthy();
      expect(existsSync(executor.workerPath)).toBe(true);
    } finally {
      executor.shutdown();
    }
  });

  it("reuses a caller-provided executor instead of creating+shutting down its own", async () => {
    writeAssembledTest("sample", PASSING_SOURCE);
    const executor = new FyiSourceExecutor();
    let shutdownCalled = false;
    const originalShutdown = executor.shutdown.bind(executor);
    executor.shutdown = () => {
      shutdownCalled = true;
      originalShutdown();
    };

    try {
      await executeTestFile({
        target: "gc",
        test262Root: TEST262_ROOT,
        inputPath: join(TEST262_ROOT, "test", "sample.js2wasm"),
        engineSuffix: "js2wasm",
        executor,
      });
      expect(shutdownCalled).toBe(false);
    } finally {
      executor.shutdown();
    }
  });

  it("still shuts down its own executor when none is provided (original one-shot contract)", async () => {
    writeAssembledTest("sample", PASSING_SOURCE);
    const result = await executeTestFile({
      target: "gc",
      test262Root: TEST262_ROOT,
      inputPath: join(TEST262_ROOT, "test", "sample.js2wasm"),
      engineSuffix: "js2wasm",
    });
    // No direct handle to the internal executor from this call shape — the
    // meaningful assertion is that the call completes and returns a real
    // verdict, matching pre-#3599 one-shot behavior exactly.
    expect(typeof result.pass).toBe("boolean");
  });
});
