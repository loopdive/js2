// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #4433 — a top-level expression statement was eliminated WHOLE, taking its
 * operands' side effects and the operator's own TypeError with it.
 *
 * `collectDeclarations`' top-level `ExpressionStatement` arm is an ALLOW-LIST
 * (call/`new`, `++`/`--`, `delete`, property read, assignment operators).
 * Anything it did not name fell off the end and never reached `__module_init`,
 * so `f() + g();`, `f() instanceof Object;`, `f(), g();` and `[f(), g()];`
 * evaluated NEITHER operand. The identical statement inside a function body has
 * always compiled its operands and `drop`ped the result — a collection gap, not
 * a lowering gap, and the eighth instance of the family catalogued in
 * `src/codegen/module-init-collection.ts`.
 *
 * The fix changes the DEFAULT rather than adding a ninth arm: an `unhandled`
 * statement whose expression tree provably runs user code is collected.
 *
 * Second, independent site (`typeof f();`, wrong in a function body TOO):
 * `compileTypeofExpression` const-folds on the operand's static TS type and
 * emits only the folded string, never compiling the operand. In statement
 * position the result is discarded anyway, so the statement now evaluates the
 * operand and drops it.
 *
 * Every case below is a MODULE-TOP-LEVEL statement unless it says otherwise —
 * that is the whole point; putting it in a function body hides the bug.
 */

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, () => number>;
  ex.__module_init?.();
  return ex.test!();
}

/** `a()` adds 1 to `hit` and returns 1; `b()` adds 10 and returns 2. */
const PRELUDE = `
  var hit = 0;
  function a() { hit = hit + 1; return 1; }
  function b() { hit = hit + 10; return 2; }
`;
const EXPORT = `export function test(): number { return hit; }`;

/** `stmt` at module top level; resolves to the resulting `hit`. */
const atTopLevel = (stmt: string) => runStandalone(`${PRELUDE}\n${stmt}\n${EXPORT}`);

describe("#4433 a top-level expression statement evaluates its operands", () => {
  // The reported shape: an operator whose operands were both discarded.
  it.each([
    ["binary +", `a() + b();`, 11],
    ["binary -", `a() - b();`, 11],
    ["binary *", `a() * b();`, 11],
    ["relational <", `a() < b();`, 11],
    ["equality ==", `a() == b();`, 11],
    ["comma sequence", `a(), b();`, 11],
    ["conditional", `a() ? b() : b();`, 11],
    ["array literal", `[a(), b()];`, 11],
    ["object literal", `({ p: a(), q: b() });`, 11],
    ["a call on one side only", `a() + 1;`, 1],
    ["a call on the other side only", `1 + a();`, 1],
    ["instanceof with a builtin RHS", `a() instanceof Object;`, 1],
    ["typeof of a call", `typeof a();`, 1],
  ])("evaluates both operands of %s", async (_label, stmt, want) => {
    expect(await atTopLevel(stmt)).toBe(want);
  });

  it("still short-circuits `&&` — the RHS must NOT run", async () => {
    // a() returns 0 (falsy), so b() is never evaluated.
    expect(
      await runStandalone(`
        var hit = 0;
        function a() { hit = hit + 1; return 0; }
        function b() { hit = hit + 10; return 2; }
        a() && b();
        ${EXPORT}`),
    ).toBe(1);
  });

  it("still short-circuits `||` — the RHS must NOT run", async () => {
    expect(await atTopLevel(`a() || b();`)).toBe(1);
  });

  it("evaluates only the taken arm of a conditional", async () => {
    expect(
      await runStandalone(`
        var hit = 0;
        function a() { hit = hit + 1; return 1; }
        function b() { hit = hit + 10; return 2; }
        function c() { hit = hit + 100; return 3; }
        a() ? b() : c();
        ${EXPORT}`),
    ).toBe(11);
  });

  it("runs a getter reached through a top-level bare comparison", async () => {
    expect(
      await runStandalone(`
        var hit = 0;
        var o = { get p() { hit = 1; return 1; } };
        o.p < 2;
        ${EXPORT}`),
    ).toBe(1);
  });

  it("propagates the operator's own TypeError out of a bare statement", async () => {
    // `instanceof` with a non-callable RHS must throw. With the statement
    // dropped, no tri-state answer could ever reach the catch.
    expect(
      await runStandalone(`
        var log = 0;
        var bad = 42;
        function f() { log = log + 1; return {}; }
        try { f() instanceof bad; log = log + 100; } catch (e) { log = log + 1000; }
        export function test(): number { return log; }`),
    ).toBe(1001);
  });

  // ── The elisions that must SURVIVE ───────────────────────────────────────
  it("does NOT invoke an un-invoked closure appearing as a bare statement", async () => {
    expect(
      await runStandalone(`
        var hit = 0;
        (function () { hit = 99; });
        ${EXPORT}`),
    ).toBe(0);
  });

  it("keeps `typeof undeclared;` from throwing (§13.5.3)", async () => {
    // typeof short-circuits an unresolvable Reference BEFORE GetValue, so a
    // bare-identifier operand must keep the const-fold path, not be evaluated.
    expect(
      await runStandalone(`
        var ok = 0;
        try { typeof zzzUndeclaredBinding; ok = 1; } catch (e) { ok = 2; }
        export function test(): number { return ok; }`),
    ).toBe(1);
  });

  // ── The in-function control: these have always worked, and must keep ─────
  it("still evaluates operands inside a function body", async () => {
    expect(
      await runStandalone(`
        var hit = 0;
        function a() { hit = hit + 1; return 1; }
        function b() { hit = hit + 10; return 2; }
        export function test(): number { hit = 0; a() + b(); return hit; }`),
    ).toBe(11);
  });

  it("evaluates a `typeof` operand inside a function body too", async () => {
    // The second site: this one was wrong in BOTH positions, because the fold
    // happens in compileTypeofExpression rather than in the collector.
    expect(
      await runStandalone(`
        var hit = 0;
        function a() { hit = hit + 1; return 1; }
        export function test(): number { hit = 0; typeof a(); return hit; }`),
    ).toBe(1);
  });
});
