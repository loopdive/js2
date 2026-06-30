// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2883 — object-literal `[Symbol.toPrimitive]` with NO declared hint param
// produced an INVALID Wasm module. The `__call_@@toPrimitive` runtime dispatcher
// (`emitToPrimitiveMethodExport` in src/codegen/index.ts) unconditionally pushed
// `self + hint` (2 args) into the resolved method, but a hint-less
// `[Symbol.toPrimitive]() { … }` (the very common abrupt-completion test shape)
// compiles to a single-param `(self) -> result` body. The arity mismatch was
// "repaired" by a downstream arg-coercion pass that dropped the result and left
// the struct ref on the stack, so the dispatcher fell through with `(ref N)`
// where its block type demanded `externref` —
//   "type error in fallthru[0] (expected externref, got (ref N))"
// — failing `WebAssembly.instantiate` for ~40 suite-wide test262 tests
// (AggregateError/SuppressedError message-ToString-abrupt, String.replaceAll
// this-tostring, Array flatMap poisoned-length, Atomics.waitAsync arg coercion,
// TypedArray sort-tonumber, annexB escape/unescape, …; +14 flip straight to pass).
//
// ECMA-262 §7.1.1 ToPrimitive step 2: when `input[@@toPrimitive]` is callable,
// `Return ? Call(exoticToPrim, input, « hint »)`. The hint is *passed*, but a
// method that ignores it (declares zero params) is still valid — the dispatcher
// must forward the hint ONLY when the method declared it.
//
// Fix: branch the dispatch on the resolved method's real param count — forward
// the hint to a 2-param `(self, hint)` method, call a 1-param `(self)` method
// with `self` only.
//
// `compileToWasm` internally runs `WebAssembly.validate` + `instantiate` and
// THROWS on an invalid module, so a callable `test` export guards the core
// regression (the pre-fix module was invalid). `assertEquivalent` runs compiled
// wasm AND native JS and asserts agreement on the runtime ToPrimitive paths
// (`String`/`Number`/object-key) the dispatcher actually backs.
import { describe, it, expect } from "vitest";
import { assertEquivalent, compileToWasm } from "./equivalence/helpers.js";

describe("#2883 hint-less object-literal [Symbol.toPrimitive] dispatch", () => {
  it("hint-less [Symbol.toPrimitive]() that throws compiles to a VALID module", async () => {
    // Pre-fix this failed WebAssembly.instantiate outright (compileToWasm throws).
    const exports = await compileToWasm(`
      export function test(): number {
        const o: any = { [Symbol.toPrimitive]() { throw 7; } };
        const s: any = String(o as any);
        return 0;
      }
    `);
    expect(typeof exports.test).toBe("function");
  });

  it("two forked hint-less object literals compile to a VALID module", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const a: any = { [Symbol.toPrimitive]() { return 1; } };
        const b: any = { [Symbol.toPrimitive]() { return 2; } };
        const s: any = String(a as any);
        const t: any = String(b as any);
        return 0;
      }
    `);
    expect(typeof exports.test).toBe("function");
  });

  it("multi-method object (toPrimitive+toString+valueOf) compiles to a VALID module", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const o: any = {
          [Symbol.toPrimitive]() { return 9; },
          toString() { return "ts"; },
          valueOf() { return 3; },
        };
        return Number(o as any);
      }
    `);
    expect(typeof exports.test).toBe("function");
  });

  it("Number(o): hint-less toPrimitive numeric result is dispatched correctly", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const o: any = { [Symbol.toPrimitive]() { return 7; } };
        return Number(o as any) === 7 ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("String(o): hint-less toPrimitive string-coercion is dispatched correctly", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const o: any = { [Symbol.toPrimitive]() { return "hi"; } };
        const s: any = String(o as any);
        return s === "hi" ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object-key coercion routes through hint-less toPrimitive", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const o: any = { [Symbol.toPrimitive]() { return "k"; } };
        const m: any = {};
        m[o as any] = 9;
        return m["k"] === 9 ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("with-hint [Symbol.toPrimitive](hint) still receives the hint (unchanged 2-param path)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const o: any = { [Symbol.toPrimitive](hint: string) { return hint === "number" ? 11 : 22; } };
        return Number(o as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
