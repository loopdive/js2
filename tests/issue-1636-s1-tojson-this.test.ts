// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1636-S1 — `__call_fn_method_N` codegen + runtime ABI.
//
// The host walk for `JSON.stringify` (#1636 Slice B/C) needs a way to
// invoke a Wasm closure with a host-supplied `this`-value so that the
// closure's `ThisKeyword` reference observes the holder identity per
// §25.5.2.2 step 2.b (`toJSON`) and step 3 (replacer). The existing
// `__call_fn_N` exports drop `this` — the closure-struct itself fills
// the `self` slot of the underlying `call_ref`, and there is no separate
// host-controlled receiver.
//
// Slice 1 of the architect spec adds `__call_fn_method_<arity>` exports
// (arity 0..2) that take a leading `thisVal: externref` parameter and
// store it in a new `__current_this` (mut externref) module global
// across the inner `call_ref`. A `ThisKeyword` reference in a
// free-function-closure body — i.e. a closure with no local `this`
// binding and not inside a static-class context — now reads that
// global instead of the previous `undefined` fallback.
//
// Acceptance per the spec: no test262 movement (no consumer yet); the
// unit test below exercises the ABI directly.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndInstantiate(source: string): Promise<Record<string, unknown>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`);
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`invalid wasm binary\nWAT:\n${result.wat}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown> & {
    setExports?: (e: Record<string, Function>) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exp = instance.exports as Record<string, unknown>;
  if (typeof imports.setExports === "function") {
    imports.setExports(exp as Record<string, Function>);
  }
  return exp;
}

describe("#1636-S1 __call_fn_method_N — host-supplied `this` for Wasm closures", () => {
  it("emits __call_fn_method_0 / _1 / _2 exports when the module has closures", async () => {
    // Any free closure literal forces the dispatcher emitters to fire.
    const src = `
      const f = function (): number {
        return 7;
      };
      export function getF(): any { return f; }
      export function test(): number {
        return f();
      }
    `;
    const exp = await compileAndInstantiate(src);
    expect(typeof exp.__call_fn_method_0).toBe("function");
    expect(typeof exp.__call_fn_method_1).toBe("function");
    expect(typeof exp.__call_fn_method_2).toBe("function");
  });

  it("free-function closure with no local `this` resolves to __current_this", async () => {
    // Closure body reads `this`. With no local binding the resolution
    // previously emitted `undefined`. Now it emits `global.get
    // __current_this`. __call_fn_method_0 installs its first arg into
    // that global before dispatching into the closure body.
    //
    // We probe via a host-side `inspectThis` import that the closure
    // calls and records what `this` it received. This isolates the
    // assertion from externref-identity round-tripping through the
    // call_ref return value (the (result externref) path appears to
    // surface as `undefined` to JS when the body returns a non-null
    // externref — a pre-existing #1308/#1382 wrapping limitation that
    // also affects `__call_fn_0`, tracked separately).
    const src = `
      declare function inspectThis(v: any): void;
      const probe = function (): number {
        inspectThis(this);
        return 0;
      };
      export function getProbe(): any { return probe; }
      export function test(): number { return 0; }
    `;
    const result = await compile(src);
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown> & {
      env?: Record<string, unknown>;
      setExports?: (e: Record<string, Function>) => void;
    };
    imports.env = imports.env ?? {};
    let captured: unknown = "uninitialized";
    (imports.env as Record<string, unknown>).inspectThis = (v: unknown) => {
      captured = v;
    };
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exp = instance.exports as Record<string, unknown>;
    if (typeof imports.setExports === "function") imports.setExports(exp as Record<string, Function>);

    const getProbe = exp.getProbe as () => unknown;
    const closure = getProbe();
    const callFnMethod0 = exp.__call_fn_method_0 as (thisVal: unknown, closure: unknown) => unknown;
    const host = { tag: "hello" };
    callFnMethod0(host, closure);
    // captured is whatever the host received as the `this` argument.
    // With Slice 1, that should be the host JS object identity.
    expect(captured).toBe(host);
  });

  it("__call_fn_method_1 forwards both `this` and one positional arg (parity with __call_fn_1)", async () => {
    // A 1-arg closure that ignores `this` and returns its arg verbatim;
    // ensures the dispatcher still wires arg 0 even after threading `this`.
    // We compare against __call_fn_1 — both should return the same value
    // for the same closure + arg, which is the parity invariant Slice 1
    // really cares about.
    const src = `
      const id = function (x: any): any {
        return x;
      };
      export function getId(): any { return id; }
      export function test(): any {
        return id(undefined);
      }
    `;
    const exp = await compileAndInstantiate(src);
    const getId = exp.getId as () => unknown;
    const closure = getId();
    const callFn1 = exp.__call_fn_1 as (closure: unknown, a0: unknown) => unknown;
    const callFnMethod1 = exp.__call_fn_method_1 as (thisVal: unknown, closure: unknown, a0: unknown) => unknown;
    // Sanity check: __call_fn_1 wires the arg through.
    const baseline = callFn1(closure, "hi");
    expect(callFnMethod1(null, closure, "hi")).toBe(baseline);
    expect(callFnMethod1({ k: 1 }, closure, 42)).toBe(callFn1(closure, 42));
  });

  it("__call_fn_method_2 passes a 2-arg closure (replacer shape)", async () => {
    // §25.5.2.2 replacer shape — (key, value). The dispatcher routes
    // `thisVal` into __current_this and `(key, value)` into the two
    // positional slots. We don't observe `this` here — just confirm
    // the closure is invoked with both args.
    const src = `
      const repl = function (k: any, v: any): any {
        return v;
      };
      export function getRepl(): any { return repl; }
      export function test(): any {
        return repl("k", 99);
      }
    `;
    const exp = await compileAndInstantiate(src);
    const getRepl = exp.getRepl as () => unknown;
    const closure = getRepl();
    const callFn2 = exp.__call_fn_2 as (closure: unknown, a0: unknown, a1: unknown) => unknown;
    const callFnMethod2 = exp.__call_fn_method_2 as (
      thisVal: unknown,
      closure: unknown,
      a0: unknown,
      a1: unknown,
    ) => unknown;
    const baseline = callFn2(closure, "k", 99);
    expect(callFnMethod2({ holder: 1 }, closure, "k", 99)).toBe(baseline);
  });

  it("__call_fn_method_0 forwards return-value parity with __call_fn_0", async () => {
    // Two sequential calls observe stable dispatch and result shape
    // (Slice 1 ABI invariant: the Wasm-side dispatch into the closure
    // body is unchanged from __call_fn_N; only the leading thisVal +
    // global save/restore differ). For a 0-arg closure that returns a
    // constant, both dispatchers must yield the same value.
    const src = `
      const constFn = function (): number {
        return 17;
      };
      export function getConstFn(): any { return constFn; }
      export function test(): number {
        return 0;
      }
    `;
    const exp = await compileAndInstantiate(src);
    const getConstFn = exp.getConstFn as () => unknown;
    const closure = getConstFn();
    const callFnMethod0 = exp.__call_fn_method_0 as (thisVal: unknown, closure: unknown) => unknown;
    const callFn0 = exp.__call_fn_0 as (closure: unknown) => unknown;
    const baseline = callFn0(closure);
    expect(callFnMethod0({ tag: "a" }, closure)).toBe(baseline);
    expect(callFnMethod0({ tag: "b" }, closure)).toBe(baseline);
    expect(callFnMethod0(null, closure)).toBe(baseline);
  });

  it("free closure with no installed receiver resolves `this` to undefined (#1702)", async () => {
    // Invoking the closure via __call_fn_0 (no `this` threading) leaves the
    // `__current_this` global at its `ref.null.extern` initial value. The
    // first cut of #1636-S1 surfaced that raw null to JS, but a free function
    // / function-expression that reads `this` with no installed receiver must
    // observe the spec default — `undefined` for a strict free function (and
    // the pre-#1636-S1 `undefined` fallback for sloppy) — NOT `null`
    // (`typeof null === "object"`, `null === undefined` ⇒ false). #1702
    // null-guards the `__current_this` read so the direct-call path yields
    // `undefined`; only a host-installed (non-null) receiver flows through.
    // This fixed the residual `language/function-code/10.4.3-1-*-s` +
    // class-method strict-`this` test262 cases (the #873/#895 follow-up).
    const src = `
      const probe3 = function (): any {
        return this;
      };
      export function getProbe3(): any { return probe3; }
      export function test(): number { return 0; }
    `;
    const exp = await compileAndInstantiate(src);
    const getProbe3 = exp.getProbe3 as () => unknown;
    const closure = getProbe3();
    const callFn0 = exp.__call_fn_0 as (closure: unknown) => unknown;
    expect(callFn0(closure)).toBe(undefined);
  });
});
