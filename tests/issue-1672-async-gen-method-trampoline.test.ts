import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";
import { runTest262File } from "./test262-runner.js";

// #1672 — async / async-generator object & class method trampolines must
// return the REAL generator/iterator/promise result, not a null sentinel,
// when the method is reached through the dynamic-dispatch path. Completes #1671.
//
// Two distinct root causes (both surfaced by the test262
// `language/expressions/{object,class}` async-gen-meth / method-definition
// cluster and the `built-ins/AsyncFromSyncIteratorPrototype` accessor path):
//
//  1. Variable redeclaration + global promotion
//     (src/codegen/statements/variables.ts): `var obj = {}` followed by
//     `var obj = { async *m() { ...obj... } }` types `obj` as `{}`, so `obj.m`
//     is `any` and `obj.m(...)` lowers to the inline dynamic-dispatch path. The
//     method body's self-reference to `obj` triggers
//     `promoteAccessorCapturesToGlobals` MID-initializer, which seeds the new
//     captured global with the STALE pre-assignment value and deletes `obj` from
//     the local map. The subsequent store wrote only the local, so every later
//     read of `obj` saw the stale global, `obj.m` missed the method, and dynamic
//     dispatch returned a null externref — `result.next()` then derefs null.
//     Fix: re-sync the captured global from the local after the initializer
//     store when promotion happened during that same initializer.
//
//  2. Trampoline result reconciliation (src/codegen/closures.ts):
//     The method-as-closure-value trampoline captured the method's result struct
//     type at emit time, but the method body later resolved its return to a
//     structurally-distinct struct type (AsyncFromSyncIterator iterator-result
//     accessor path). `coercionInstrs` is a no-op for same-`kind` operands, so the
//     trampoline returned `ref methodTypeIdx` where its func type declared
//     `ref wrapperTypeIdx` — invalid wasm (`__obj_meth_tramp_*_next` result type
//     error). Fix: emit an explicit cast to the wrapper's declared result type.

describe("#1672 async/async-gen method trampoline result wrapping (unit)", () => {
  it("async object method reached via extracted ref returns a real result (not null)", async () => {
    const src = `var obj = {};
var callCount = 0;
var obj = { async method(a = 1) { callCount = callCount + 1; return a; } };
var ref = obj.method;
export function test(): number {
  const p: any = ref(5);
  return p == null ? 0 : 1;
}`;
    const ex = await compileToWasm(src);
    expect((ex.test as () => number)()).toBe(1);
  });

  it("async-generator object method reached via extracted ref yields (not null)", async () => {
    const src = `var obj = {};
var callCount = 0;
var obj = { async *method(a = 1) { callCount = callCount + 1; yield a; } };
var ref = obj.method;
export function test(): number {
  const it: any = ref(7);
  if (it == null) return 0;
  const r: any = it.next();
  return r == null ? 0 : 1;
}`;
    const ex = await compileToWasm(src);
    expect((ex.test as () => number)()).toBe(1);
  });

  it("async-generator object method runs its body exactly once on first next()", async () => {
    const src = `var obj = {};
var callCount = 0;
var obj = { async *method() { callCount = callCount + 1; yield 1; } };
var ref = obj.method;
export function test(): number {
  ref().next();
  return callCount;
}`;
    const ex = await compileToWasm(src);
    expect((ex.test as () => number)()).toBe(1);
  });

  it("plain generator object method still works through the dynamic path (no regression)", async () => {
    const src = `var obj = {};
var obj = { *method(a = 1) { yield a; yield a + 1; } };
var ref = obj.method;
export function test(): number {
  const it: any = ref(10);
  if (it == null) return -1;
  const r1: any = it.next();
  return r1 == null ? -2 : (r1.value as number);
}`;
    const ex = await compileToWasm(src);
    expect((ex.test as () => number)()).toBe(10);
  });

  it("sync object method dispatch unaffected (regression guard for #1671)", async () => {
    const src = `var obj = {};
var obj = { method(a = 2) { return a * 3; } };
var ref = obj.method;
export function test(): number {
  return (ref(4) as number);
}`;
    const ex = await compileToWasm(src);
    expect((ex.test as () => number)()).toBe(12);
  });
});

// Authoritative end-to-end checks against the real test262 files (full host
// runtime: iterator protocol, promise/$DONE chain). These are the exact tests
// from the regressed cluster — null-deref `result.next()` and the
// `__obj_meth_tramp_*` invalid-wasm compile_errors. Guarded on the submodule
// being initialised so the suite still runs in environments without test262.
const T262 = (p: string) => `test262/test/${p}`;
const RUNTIME_PASS = [
  "language/expressions/object/dstr/async-gen-meth-ary-ptrn-rest-obj-id.js",
  "built-ins/AsyncFromSyncIteratorPrototype/next/iterator-result-poisoned-done.js",
  "built-ins/AsyncFromSyncIteratorPrototype/next/iterator-result-poisoned-value.js",
  "built-ins/AsyncFromSyncIteratorPrototype/return/iterator-result-poisoned-done.js",
  "built-ins/AsyncFromSyncIteratorPrototype/throw/iterator-result-poisoned-done.js",
  "built-ins/AsyncFromSyncIteratorPrototype/next/iterator-result-unwrap-promise.js",
];

describe("#1672 async/async-gen method trampoline (test262 e2e)", () => {
  for (const rel of RUNTIME_PASS) {
    const path = T262(rel);
    const present = existsSync(path);
    it.runIf(present)(
      `passes: ${rel}`,
      async () => {
        const r = await runTest262File(path, "cluster");
        expect(r.status).toBe("pass");
      },
      30000,
    );
  }
});
