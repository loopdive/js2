// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2632 Phase 1 — WASI async runtime (event-loop reactor): scheduler + timers
 * + microtasks.
 *
 * Under `--target wasi` the compiler now lowers `setTimeout` / `setInterval` /
 * `clearTimeout` / `clearInterval` / `queueMicrotask` onto a standalone
 * timer-heap + run-loop reactor (`src/codegen/async-scheduler.ts`), replacing
 * the one-shot `__drain_microtasks` call in the WASI `_start` wrapper with
 * `__run_event_loop`. The loop drains microtasks, fires due timers from a
 * deadline-ordered timer table, blocks until the nearest deadline via the
 * existing single-clock `poll_oneoff` sleep, and exits when no pending handles
 * remain.
 *
 * These cases compile each program under `--target wasi`, run the produced
 * module under real wasmtime, and assert the observed stdout ORDERING matches
 * Node's event-loop semantics:
 *   - all synchronous top-level code runs first,
 *   - then the microtask queue drains,
 *   - then timers fire in non-decreasing deadline order,
 *   - a `setTimeout(…, 0)` fires after sync code AND after pending microtasks,
 *   - a timer scheduled inside a timer callback runs on a later turn,
 *   - `setInterval` re-arms until `clearInterval`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) Asserts a literal `call <n>` in `_start` — an absolute function
// index, which the tuned passes shift by adding helpers. Pin the inliner off.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

// wasmtime feature flags required for the WasmGC + exception-handling binaries
// js2wasm emits (structs/arrays + the exception tag).
const WASMTIME_FLAGS = ["-W", "gc=y,function-references=y,exceptions=y"];

/** Resolve a usable `wasmtime` binary, or null when none is on PATH. */
function findWasmtime(): string | null {
  for (const cand of ["wasmtime", "/usr/local/bin/wasmtime"]) {
    try {
      execFileSync(cand, ["--version"], { stdio: "ignore" });
      return cand;
    } catch {
      /* try next */
    }
  }
  return null;
}

const wasmtimeBin = findWasmtime();

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "issue-2632-"));
});
afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** Compile `src` under --target wasi, run under wasmtime, return stdout lines. */
async function runWasi(src: string, name: string): Promise<string[]> {
  const r = await compile(src, { fileName: `${name}.ts`, target: "wasi", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const path = join(tmpDir, `${name}.wasm`);
  writeFileSync(path, r.binary!);
  const out = execFileSync(wasmtimeBin!, [...WASMTIME_FLAGS, path], { encoding: "utf-8" });
  return out.split("\n").filter((l) => l.length > 0);
}

describe.skipIf(!wasmtimeBin)("#2632 Phase 1 — WASI event-loop reactor (timers + microtasks)", () => {
  it("setTimeout fires after synchronous code", async () => {
    const lines = await runWasi(
      `
      console.log("sync1");
      setTimeout(() => { console.log("timeout"); }, 10);
      console.log("sync2");
      `,
      "after-sync",
    );
    expect(lines).toEqual(["sync1", "sync2", "timeout"]);
  });

  it("queueMicrotask runs before a 0ms macrotask, after sync code", async () => {
    const lines = await runWasi(
      `
      console.log("sync1");
      setTimeout(() => { console.log("timeout0"); }, 0);
      queueMicrotask(() => { console.log("micro"); });
      console.log("sync2");
      `,
      "micro-before-timer",
    );
    // Node order: sync1, sync2 (sync), micro (microtask), timeout0 (macrotask).
    expect(lines).toEqual(["sync1", "sync2", "micro", "timeout0"]);
  });

  it("timers fire in non-decreasing deadline order regardless of registration order", async () => {
    const lines = await runWasi(
      `
      setTimeout(() => { console.log("t50"); }, 50);
      setTimeout(() => { console.log("t10"); }, 10);
      setTimeout(() => { console.log("t30"); }, 30);
      `,
      "deadline-order",
    );
    expect(lines).toEqual(["t10", "t30", "t50"]);
  });

  it("a timer scheduled inside a timer callback runs on a later turn (nested)", async () => {
    const lines = await runWasi(
      `
      setTimeout(() => {
        console.log("outer");
        setTimeout(() => { console.log("inner"); }, 5);
      }, 5);
      `,
      "nested",
    );
    expect(lines).toEqual(["outer", "inner"]);
  });

  it("setInterval re-arms until clearInterval bounds it by a counter", async () => {
    const lines = await runWasi(
      `
      let n = 0;
      let id = setInterval(() => {
        n = n + 1;
        console.log("tick" + n);
        if (n >= 3) { clearInterval(id); }
      }, 5);
      `,
      "interval-bounded",
    );
    expect(lines).toEqual(["tick1", "tick2", "tick3"]);
  });

  it("clearTimeout before the deadline cancels a pending timer", async () => {
    const lines = await runWasi(
      `
      let id = setTimeout(() => { console.log("should-not-fire"); }, 30);
      setTimeout(() => { console.log("fired"); }, 5);
      clearTimeout(id);
      `,
      "clear-timeout",
    );
    expect(lines).toEqual(["fired"]);
  });

  it("microtasks chained off a timer callback drain before the next timer", async () => {
    const lines = await runWasi(
      `
      setTimeout(() => {
        console.log("t1");
        queueMicrotask(() => { console.log("t1-micro"); });
      }, 5);
      setTimeout(() => { console.log("t2"); }, 20);
      `,
      "timer-then-micro",
    );
    // t1 fires, queues a microtask that must drain before t2's later deadline.
    expect(lines).toEqual(["t1", "t1-micro", "t2"]);
  });
});

describe("#2632 Phase 1 — compile-time wiring (no wasmtime needed)", () => {
  it("setTimeout under --target wasi compiles (no longer rejected) and emits the run loop", async () => {
    const r = await compile(`setTimeout(() => { console.log("x"); }, 1);`, {
      target: "wasi",
      skipSemanticDiagnostics: true,
    });
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    const wat = r.wat!;
    expect(wat).toContain("$__run_event_loop");
    expect(wat).toContain("$__timer_add");
    // _start drives the run loop (which itself drains microtasks). The WAT
    // prints `call <idx>` (numeric), so resolve the run-loop func idx by its
    // textual position and assert _start's first body `call` targets it.
    const numImportFuncs = (wat.match(/\(import [^\n]*\(func /g) || []).length;
    let idx = numImportFuncs;
    let runLoopIdx = -1;
    for (const line of wat.split("\n")) {
      const dm = line.match(/^ {2}\(func (\$[A-Za-z0-9_$]+)/);
      if (dm) {
        if (dm[1] === "$__run_event_loop") {
          runLoopIdx = idx;
          break;
        }
        idx++;
      }
    }
    expect(runLoopIdx).toBeGreaterThanOrEqual(0);
    const startBody = wat.match(/\(func \$_start[\s\S]*?\n {2}\)/)?.[0] ?? "";
    expect(startBody).toContain(`call ${runLoopIdx}`);
  });

  it("queueMicrotask under --target wasi compiles and enqueues onto the microtask queue", async () => {
    const r = await compile(`queueMicrotask(() => { console.log("m"); });`, {
      target: "wasi",
      skipSemanticDiagnostics: true,
    });
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    expect(r.wat!).toContain("$__microtask_enqueue");
  });

  it("a program with NO timers/microtasks does NOT register the timer heap (byte-neutral path)", async () => {
    const r = await compile(`console.log("plain");`, { target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    expect(r.wat!).not.toContain("$__run_event_loop");
    expect(r.wat!).not.toContain("$__timer_add");
  });

  it("setImmediate remains rejected under --target wasi (out of Phase-1 scope)", async () => {
    const r = await compile(`setImmediate(() => {});`, { target: "wasi", skipSemanticDiagnostics: true });
    expect(r.success).toBe(false);
    const msg = r.errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(/setImmediate/);
  });

  it("a user-defined setTimeout shadow is NOT intercepted by the reactor lowering", async () => {
    // A genuine user function named setTimeout must keep its own semantics.
    const r = await compile(
      `
      function setTimeout(_cb: any, _ms: number): number { return 42; }
      const h = setTimeout(() => {}, 10);
      console.log(h);
      `,
      { target: "wasi", skipSemanticDiagnostics: true },
    );
    expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
    // No reactor lowering for the user shadow.
    expect(r.wat!).not.toContain("$__timer_add");
  });
});
