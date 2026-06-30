// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2867 — Standalone Wasm-native Promise / microtask carrier, PR-B.
//
// Two real defects sr-promisegate found made the gate-broaden (PR-A:
// `isStandalonePromiseActive` → `ctx.wasi || ctx.standalone`) a net regression
// in the test262 harness. Both are fixed here:
//
//   1. Late-import funcIdx-shift in the native `.then` path. A `.then` callback
//      body that pulls in a LATE host import (e.g. `new Test262Error(...)` →
//      `__new_Test262Error`) shifts every defined-function index up by one. The
//      enclosing function body is swapped OUT onto a JS-local `savedBody` while
//      the receiver/callback compiles into a buffer, so it was invisible to
//      `shiftLateImportIndices` — leaving an already-emitted `call
//      __new_plain_object` (for an earlier `var a = {}`) pointing one slot too
//      low, at the 1-arg `__obj_hash`: "not enough arguments on the stack for
//      call (need 1, got 0)". Fix: register `savedBody` in `ctx.liveBodies` for
//      the swap window so the shift reaches it.
//
//   2. Verdict-path drain gap. Native `.then` reactions are QUEUED, not run
//      synchronously, so the assertions inside them only set the verdict once
//      `__drain_microtasks()` runs. The new `__drain_microtasks()` compiler
//      intrinsic (calls.ts) emits the native drain when a queue is registered
//      and a byte-neutral no-op otherwise — so a harness/embedder can flush
//      pending reactions before observing module state.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/** Stub import object so a leaked host import never blocks instantiation — we
 *  are checking Wasm VALIDATION (the "not enough arguments" defect), not link. */
function stubImports(): WebAssembly.Imports {
  const env = new Proxy({}, { get: () => () => {}, has: () => true });
  return new Proxy({}, { get: () => env, has: () => true }) as WebAssembly.Imports;
}

async function instantiate(src: string) {
  const r = await compile(src, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
  expect(r.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, stubImports());
  return { r, instance };
}

describe("#2867 — native Promise carrier: funcIdx shift + verdict drain", () => {
  it("native .then callback that adds a late import no longer breaks the stack (funcIdx shift)", async () => {
    // `Promise.reject(<object>)` emits `call __new_plain_object` for `var a = {}`
    // in the enclosing body; the throwing callback then pulls in the late
    // `__new_Test262Error` import. Pre-fix: "not enough arguments on the stack".
    const { r } = await instantiate(`
      export function test(): number {
        var a = {};
        Promise.reject(a).then(
          function () { throw new Test262Error("should not fulfil"); },
          function (result) { var captured = a; }
        );
        return 1;
      }
    `);
    // Host-free: the native carrier replaces Promise_reject/then/__make_callback.
    expect((r.imports ?? []).map((i) => i.name)).not.toContain("Promise_then");
    expect((r.imports ?? []).map((i) => i.name)).not.toContain("Promise_reject");
  });

  it("chained .then(undefined, undefined).then(fn, fn).then(d, d) compiles + instantiates standalone", async () => {
    await instantiate(`
      export function test(): number {
        var arg = {};
        var p = Promise.reject(arg);
        p.then(undefined, undefined)
          .then(function () { throw new Test262Error("x"); }, function (result) { var y = arg; })
          .then(function () {}, function () {});
        return 1;
      }
    `);
  });

  it("__drain_microtasks() runs queued fulfil reactions before the verdict is read", async () => {
    const { instance } = await instantiate(`
      let failed = 0;
      export function test(): number {
        Promise.resolve(5).then(function (v) { if (v !== 5) failed = 99; });
        __drain_microtasks();
        return failed ? failed : 1;
      }
    `);
    expect((instance.exports as { test: () => number }).test()).toBe(1);
  });

  it("__drain_microtasks() runs queued reject reactions (rejection value propagates)", async () => {
    const { instance } = await instantiate(`
      let failed = 0;
      export function test(): number {
        var a = {};
        Promise.reject(a).then(undefined, function (r) { if (r !== a) failed = 7; });
        __drain_microtasks();
        return failed ? failed : 1;
      }
    `);
    expect((instance.exports as { test: () => number }).test()).toBe(1);
  });

  it("a reaction assertion that fails is observed once microtasks drain (no false pass)", async () => {
    const { instance } = await instantiate(`
      let failed = 0;
      export function test(): number {
        Promise.resolve(5).then(function (v) { if (v !== 999) failed = 42; });
        __drain_microtasks();
        return failed ? failed : 1;
      }
    `);
    // Without the drain the callback never runs and this falsely returns 1.
    expect((instance.exports as { test: () => number }).test()).toBe(42);
  });

  it("__drain_microtasks() is a byte-neutral no-op when no Promise queue is registered", async () => {
    const withCall = await compile(
      `export function test(): number { var x = 1 + 2; __drain_microtasks(); return x === 3 ? 1 : 0; }`,
      { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true },
    );
    const without = await compile(`export function test(): number { var x = 1 + 2; return x === 3 ? 1 : 0; }`, {
      fileName: "test.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(withCall.success).toBe(true);
    expect(without.success).toBe(true);
    // Identical bytes ⇒ Promise-free / JS-host wrappers are untouched.
    expect(Buffer.from(withCall.binary).equals(Buffer.from(without.binary))).toBe(true);
    // And no microtask infrastructure leaked into a Promise-free module.
    const { instance } = await WebAssembly.instantiate(withCall.binary, stubImports());
    expect((instance.exports as Record<string, unknown>).__drain_microtasks).toBeUndefined();
  });

  it("__drain_microtasks() is a no-op (not a leaked host import) under the JS-host target", async () => {
    const r = await compile(
      `export function test(): number { var x = 1 + 2; __drain_microtasks(); return x === 3 ? 1 : 0; }`,
      { fileName: "test.ts", target: "gc", skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
    expect((r.imports ?? []).map((i) => i.name)).not.toContain("__drain_microtasks");
  });
});
