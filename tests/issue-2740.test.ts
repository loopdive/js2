// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #2740 — instanceof residual: non-callable RHS eval-order & Symbol.hasInstance
 * dispatch (ECMA-262 §13.10.2 InstanceofOperator, §7.3.20 OrdinaryHasInstance).
 *
 * Locks in the semantics delivered by #2702 (ordering) + #2764 (handler arity)
 * and the #2740 residual fix (decidably non-callable dynamic RHS → TypeError):
 *   - step 2 GetMethod(target, @@hasInstance) runs BEFORE the step-4
 *     IsCallable check, so a non-callable RHS with a custom handler dispatches
 *     instead of throwing;
 *   - the handler is invoked with exactly ONE argument and its result is
 *     ToBoolean-coerced; a throwing handler propagates (ReturnIfAbrupt);
 *   - LHS evaluates before RHS, and the non-object-RHS TypeError fires only
 *     AFTER both operands evaluated;
 *   - a decidably non-callable dynamic RHS (host object like `Math`, an array)
 *     throws TypeError per step 4.
 *
 * Deliberately NOT asserted here (blocked on the class-value rep unification,
 * #2763/#3134): wasm-struct RHS values (class constructors / instances /
 * object literals share one representation) stay conservatively `false`, and
 * a `null`/`undefined` dynamic RHS stays `false` because the params+body
 * `Function("name", "body")` form still lowers to `null` (S15.3.5.3_A1_T1..T8
 * depend on `primitive instanceof FACTORY` being `false`, not a throw).
 */

async function run(src: string): Promise<unknown> {
  const r = await compile(src, {});
  expect(r.success, r.success ? "" : r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  if (!r.success) throw new Error("unreachable");
  // (#6779) The `Function(params, body)` guard below needs the hostEval policy.
  const imports = buildImports(r.imports, undefined, r.stringPool, { dynamicCode: "hostEval" });
  const { instance } = await WebAssembly.instantiate(r.binary, imports as never);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2740 — @@hasInstance dispatch", { timeout: 20000 }, () => {
  it("non-callable RHS with custom @@hasInstance dispatches (step 2 before step 4)", async () => {
    expect(
      await run(`export function test(): number {
        const o: any = {};
        o[Symbol.hasInstance] = function (v: any) { return v === 42; };
        return ((42 as any) instanceof o) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("handler is called with exactly one argument; truthy result coerces to true (#2764)", async () => {
    expect(
      await run(`export function test(): number {
        const o: any = {};
        let argc = -1;
        o[Symbol.hasInstance] = function (v: any) { argc = arguments.length; return "truthy"; };
        const r = (({} as any) instanceof o) ? 1 : 0;
        return r === 1 && argc === 1 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("custom @@hasInstance on a function overrides OrdinaryHasInstance", async () => {
    expect(
      await run(`export function test(): number {
        function C(): void {}
        (C as any)[Symbol.hasInstance] = function (_v: any) { return false; };
        const c: any = {};
        return ((c instanceof (C as any)) === false) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("non-callable custom @@hasInstance value throws TypeError (GetMethod)", async () => {
    expect(
      await run(`export function test(): number {
        const o: any = {};
        o[Symbol.hasInstance] = 5;
        try { (({} as any) instanceof o); return 0; }
        catch (e) { return (e instanceof TypeError) ? 1 : 2; }
      }`),
    ).toBe(1);
  });

  it("throwing @@hasInstance handler propagates with its identity (ReturnIfAbrupt)", async () => {
    expect(
      await run(`export function test(): number {
        const o: any = {};
        o[Symbol.hasInstance] = function (_v: any) { throw new RangeError("boom"); };
        try { (({} as any) instanceof o); return 0; }
        catch (e) { return (e instanceof RangeError) ? 1 : 2; }
      }`),
    ).toBe(1);
  });
});

describe("#2740 — non-callable RHS eval order & TypeError", { timeout: 20000 }, () => {
  it("LHS evaluates before RHS; non-object RHS TypeError fires after both", async () => {
    expect(
      await run(`export function test(): number {
        let log = "";
        function lhs(): any { log += "L"; return {}; }
        function rhs(): any { log += "R"; return 1; }
        try { (lhs() instanceof rhs()); log += "X"; }
        catch (e) { log += (e instanceof TypeError) ? "T" : "?"; }
        return log === "LRT" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("host non-callable object RHS (Math via any-typed var) throws TypeError", async () => {
    expect(
      await run(`export function test(): number {
        const m: any = Math;
        try { (({} as any) instanceof m); return 0; }
        catch (e) { return (e instanceof TypeError) ? 1 : 2; }
      }`),
    ).toBe(1);
  });

  it("array RHS via any-typed var throws TypeError", async () => {
    expect(
      await run(`export function test(): number {
        const a: any = [1, 2];
        try { (({} as any) instanceof a); return 0; }
        catch (e) { return (e instanceof TypeError) ? 1 : 2; }
      }`),
    ).toBe(1);
  });

  it("Function(body) result as dynamic RHS stays a callable: false, no throw", async () => {
    expect(
      await run(`export function test(): number {
        const F: any = Function("return 1;");
        const t = typeof F;
        let r: number;
        try { r = ((1 as any) instanceof F) ? 2 : 1; } catch (e) { r = 3; }
        return (t === "function" && r === 1) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("GUARD: Function(params, body) RHS with primitive LHS is false, NOT a throw (S15.3.5.3_A1)", async () => {
    // The params+body Function form still lowers to null (see #2763); the
    // dynamic path must stay conservatively false for it — a throw here
    // regresses 8 baseline tests (S15.3.5.3_A1_T1..T8).
    expect(
      await run(`export function test(): number {
        const FACTORY: any = Function("name", "this.name=name;");
        try { return ((1 as any) instanceof FACTORY) ? 2 : 1; } catch (e) { return 3; }
      }`),
    ).toBe(1);
  });

  it("GUARD: wasm-struct RHS (object literal) stays conservative false pending #2763", async () => {
    // Spec says TypeError, but class ctors / instances / literals share one
    // undecidable representation — flipping this to a throw breaks
    // `x instanceof C` for var-held classes. Documented conservative.
    expect(
      await run(`export function test(): number {
        const o: any = { x: 1 };
        try { return ((({} as any) instanceof o) === false) ? 1 : 2; } catch (e) { return 3; }
      }`),
    ).toBe(1);
  });
});
