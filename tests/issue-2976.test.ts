// (#2976) A capture-carrying NESTED function declaration used as a VALUE
// previously materialized a FRESH closure struct (and a fresh struct type +
// trampoline) at EVERY identifier reference:
//   - `Constructor === Constructor` was false;
//   - a static/sidecar write (`Constructor.resolve = fn`) landed on a dead
//     instance the next reference never saw — V8's PerformPromiseAll then
//     rejected with "resolve is not a function" (the #2671 Promise capability
//     sub-bucket: call-resolve-element*, resolve-before-loop-exit*,
//     resolve-from-same-thenable*).
//
// Fix (src/codegen/closures.ts emitFuncRefAsClosure):
//   - module-level artifact dedupe: ONE struct type + trampoline per funcName
//     (`ctx.nestedFnClosureArtifacts`, trampoline re-resolved by NAME so
//     late-import funcIdx shifts can't desync);
//   - per-activation instance memo: each reference emits a `ref.is_null`-
//     guarded lazy build into one memo local (`fctx.nestedFnClosureMemos`).
//     The RUNTIME guard (not a prologue hoist, not compile-order memoization)
//     preserves value-capture semantics (immutable captures copy at the first
//     DYNAMIC reference — exactly where the old per-site build copied them)
//     and is control-flow-safe (a runtime-skipped reference site cannot
//     strand a later site with an uninitialized local).
//
// Capture-FREE nested/top-level functions were already identity-stable via
// the #1340 cached-singleton path and are untouched.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function runHost(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source, { fileName: "t.ts" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#2976 capture-carrying nested fn decl — per-reference closure identity", () => {
  it("F === F holds (was: fresh struct per reference)", async () => {
    const v = await runHost(`// @ts-nocheck
export function test() {
  var callCount = 0;
  function Constructor(executor) {
    function resolve(values) { callCount += 1; }
    executor(resolve, function () {});
  }
  var a = Constructor;
  var b = Constructor;
  return "" + (Constructor === Constructor) + "|" + (a === b) + "|" + (a === Constructor);
}
`);
    expect(v).toBe("true|true|true");
  });

  it("static write on one reference is visible through the next (V8 capability protocol)", async () => {
    const v = await runHost(`// @ts-nocheck
var log = "";
export function test() {
  var callCount = 0;
  function Constructor(executor) {
    function resolve(values) { callCount += 1; }
    log = log + "entered|";
    executor(resolve, function () {});
  }
  Constructor.resolve = function (v) { log = log + "C.resolve|"; return v; };
  var p1 = { then: function (onFulfilled, onRejected) { log = log + "p1.then|"; } };
  try { Promise.all.call(Constructor, [p1]); log = log + "all-ok"; }
  catch (e) { log = log + "threw:" + (e && e.message ? e.message : e); }
  return log;
}
`);
    // Pre-fix: the sidecar write landed on a dead instance → V8 rejected with
    // "resolve is not a function" (surfacing via the reject callback). Now the
    // capability protocol runs end to end.
    expect(v).toBe("entered|C.resolve|p1.then|all-ok");
  });

  it("value-capture freshness preserved: first dynamic reference snapshots the immutable capture", async () => {
    const v = await runHost(`// @ts-nocheck
export function test() {
  var a = 5;
  function f() { return a; }
  // First VALUE reference happens here — after a's initializer, same as the
  // old per-site build. (a is never reassigned → immutable capture.)
  var g = f;
  return "" + g() + "|" + (g === f);
}
`);
    expect(v).toBe("5|true");
  });

  it("reassigned-after capture: identity fixed; value staleness is a PRE-EXISTING analysis gap", async () => {
    const v = await runHost(`// @ts-nocheck
export function test() {
  var n = 1;
  function f() { return n; }
  var g = f;   // materializes the memoized instance (captures n by value: 1)
  n = 42;
  return "" + g() + "|" + f() + "|" + (g === f);
}
`);
    // Spec: g() === 42 (shared binding). Both PRE- and POST-fix the capture
    // analysis treats `n` as an immutable value-copy here (pre-fix result:
    // "1|42|false"), so g() reads the stale 1 — a pre-existing
    // capture-mutability gap, NOT introduced by the #2976 memoization (which
    // only fixed the identity: `g === f` was false, now true). If a later fix
    // boxes this capture, flip the first segment to 42.
    expect(v).toBe("1|42|true");
  });
});
