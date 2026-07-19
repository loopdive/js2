// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3227 S4 — async post-drain verdict re-read must exist in EVERY execution
// lane, not only `runTest262File` (S1, PR #3161). The sharded-CI baseline rows
// all go through `scripts/test262-worker.mjs` (fork worker), with a smaller
// worker-thread diagnostic lane in `scripts/wasm-exec-worker.mjs`; S1 patched
// neither of them, so the corpus
// verdicts never changed (1,679 rows stayed vacuous, and the intended honest
// pass/fail flips "nearly cancelled" — they simply never ran). These are
// source-shape assertions in the established #1862/#2961 style: the re-read
// block must be present, gated on the sync 1/-262 verdict, and positioned
// BEFORE the -262 vacuity scoring so the re-read result is what gets scored.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORACLE_VERSION, ORACLE_VERSION_HISTORY } from "./test262-oracle-version.js";

const ROOT = join(__dirname, "..");

function readRepo(path: string) {
  return readFileSync(join(ROOT, path), "utf-8");
}

const RE_READ_GATE = /typeof (?:fixture)?resultFn === "function" && \(ret === 1 \|\| ret === -262\)/;

describe("#3227 S4 — post-drain re-read in the CI worker lane", () => {
  it("fork worker (scripts/test262-worker.mjs) re-reads __result after the drain", () => {
    const worker = readRepo("scripts/test262-worker.mjs");

    expect(worker).toContain("const resultFn = instance.exports.__result;");
    expect(worker).toMatch(RE_READ_GATE);
    // Two event-loop yields — the whole microtask queue plus a macrotask hop.
    expect(worker.match(/await new Promise\(\(r\) => setImmediate\(r\)\);/g)?.length).toBeGreaterThanOrEqual(2);

    // The re-read must happen BEFORE the -262 vacuity scoring, so the
    // post-drain verdict is what gets scored.
    const reRead = worker.indexOf("const resultFn = instance.exports.__result;");
    const vacuityScore = worker.indexOf("} else if (ret === -262) {");
    expect(reRead).toBeGreaterThan(-1);
    expect(vacuityScore).toBeGreaterThan(-1);
    expect(reRead).toBeLessThan(vacuityScore);

    // A continuation THROW inside the drain window is the test's async
    // outcome — captured and scored as a fail for THIS test (the module-level
    // unhandledRejection suppressor would otherwise swallow it).
    expect(worker).toContain("async continuation threw after test() returned (#3227)");
    expect(worker).toContain('process.on("uncaughtException", onDeferred);');
    expect(worker).toContain('process.off("uncaughtException", onDeferred);');
  });

  it("worker_thread exec lane (scripts/wasm-exec-worker.mjs) has the same re-read", () => {
    const worker = readRepo("scripts/wasm-exec-worker.mjs");

    expect(worker).toContain("const resultFn = instance.exports.__result;");
    expect(worker).toMatch(RE_READ_GATE);
  });

  it("in-process fixture lane uses original-harness async markers", () => {
    const shared = readRepo("tests/test262-shared.ts");

    expect(shared).toContain("assembleOriginalHarness(source, meta)");
    expect(shared).toContain('marker("Test262:AsyncTestComplete")');
    expect(shared).toContain('marker("Test262:AsyncTestFailure")');
    expect(shared).not.toContain("const fixtureResultFn = (instance.exports as any).__result;");
  });

  it("retains the v7 async-worker oracle history", () => {
    expect(ORACLE_VERSION).toBeGreaterThanOrEqual(7);
    const v7 = ORACLE_VERSION_HISTORY.find((h) => h.version === 7);
    expect(v7).toBeDefined();
    expect(v7!.note).toContain("#3227 S4");
    expect(v7!.note).toContain("test262-worker.mjs");
  });
});
