// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { instantiateWithRuntime } from "./equivalence/helpers.ts";

// #1337 — Function.prototype.bind `.name` / `.length` internals.
//
// Slice landed here: spec-correct metadata reads on a bound function, for BOTH
//   1. the immediate form  `fn.bind(...).name`  (already worked via #1632a)
//   2. the deferred form   `const g = fn.bind(...); g.name`  (this fix)
//
// Two root causes were fixed:
//
//   A. property-access.ts statically folded `.name` / `.length` on a value
//      typed as a function to the *target's* symbol name / param count. The
//      #1632a guard only skipped that fold for the *immediate* `.bind(...).name`
//      shape. `isBindResultExpr` extends the guard to the deferred form so the
//      read goes to the runtime `__extern_get` path and observes the host
//      bound exotic's real `"bound " + target.name` / `max(0, len - args)`.
//
//   B. runtime.ts `__bind_function` returned the raw wasm-struct target when
//      `_wrapWasmClosure` couldn't build the `__call_fn_<arity>` bridge — which
//      is exactly the module-level `const g = fn.bind(...)` case, because that
//      runs during instantiation *before* `setExports`. A lazy bridge now
//      resolves `__call_fn_<arity>` at call time and stamps name/length up
//      front, so deferred metadata reads are correct.
//
// Out of scope (documented #1632a Layer 2): CALLING a deferred-stored bound
// function (`g()`), and property WRITES on it (`g.prop = x`). Those traverse
// the closure-struct-cast call/access path which traps on a JS-functional
// externref; tracked under #1632a.
describe("#1337 Function.prototype.bind metadata", () => {
  it("deferred bound .name is 'bound ' + target.name", async () => {
    const r = await compile(
      `function target(a, b) { return a; }
       const bound = target.bind(undefined);
       export function test(): string { return bound.name; }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const inst = await instantiateWithRuntime(r);
    expect((inst.exports as { test(): string }).test()).toBe("bound target");
  });

  it("immediate bound .name is 'bound ' + target.name", async () => {
    const r = await compile(
      `function target(a, b) { return a; }
       export function test(): string { return target.bind(undefined).name; }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const inst = await instantiateWithRuntime(r);
    expect((inst.exports as { test(): string }).test()).toBe("bound target");
  });

  it("deferred bound .length is max(0, target.length - boundArgs.length)", async () => {
    const r = await compile(
      `function target(a, b, c) { return a; }
       const bound = target.bind(undefined, 1);
       export function test(): number { return bound.length; }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const inst = await instantiateWithRuntime(r);
    // target.length === 3, one bound arg => 3 - 1 = 2
    expect((inst.exports as { test(): number }).test()).toBe(2);
  });

  it("deferred bound .length clamps to 0 when boundArgs exceed arity", async () => {
    const r = await compile(
      `function target(a) { return a; }
       const bound = target.bind(undefined, 1, 2, 3);
       export function test(): number { return bound.length; }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const inst = await instantiateWithRuntime(r);
    // target.length === 1, three bound args => max(0, 1 - 3) = 0
    expect((inst.exports as { test(): number }).test()).toBe(0);
  });

  it("deferred bound fn invocation applies partial args (#1337 Layer-2)", async () => {
    const r = await compile(
      `function add(a: number, b: number): number { return a + b; }
       export function test(): number {
         const add5 = add.bind(undefined, 5);
         return add5(10);
       }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const inst = await instantiateWithRuntime(r);
    expect((inst.exports as { test(): number }).test()).toBe(15);
  });

  it("Function.prototype.bind.call deferred invocation (#1337 Layer-2)", async () => {
    const r = await compile(
      `function mul(a: number, b: number): number { return a * b; }
       export function test(): number {
         const triple = Function.prototype.bind.call(mul, undefined, 3);
         return triple(7);
       }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const inst = await instantiateWithRuntime(r);
    expect((inst.exports as { test(): number }).test()).toBe(21);
  });

  it("bound .name property attributes: not enumerable, not writable, configurable", async () => {
    const r = await compile(
      `const target = Object.defineProperty(function() {}, 'name', { value: 'target' });
       export function test(): boolean {
         const b = target.bind();
         const d = Object.getOwnPropertyDescriptor(b, 'name');
         return d.enumerable === false && d.writable === false && d.configurable === true;
       }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const inst = await instantiateWithRuntime(r);
    // Compiled booleans surface as i32 (1/0) across the wasm boundary.
    expect((inst.exports as { test(): number }).test()).toBeTruthy();
  });
});
