// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3615 — a bare property/element READ in MODULE-TOP-LEVEL statement position
 * was silently dropped, so the accessor never ran.
 *
 * `collectDeclarations` builds `ctx.moduleInitStatements` from an ALLOW-LIST of
 * expression-statement shapes (call, `new`, `++`/`--`, `delete`, assignment, …).
 * A bare `o.p;` matched nothing and was dropped from `__module_init` entirely —
 * the read never happened. Same class of gap as #2992 (top-level `delete`) and
 * #3592 (top-level `throw`).
 *
 * Per §13.3.2.1 / §6.2.5.5 the read is observable: GetValue on the Reference
 * calls `[[Get]]`, which invokes an accessor's getter and throws a TypeError on
 * a nullish base.
 *
 * SCOPE — measured, and narrower than first assumed. The drop was **immediate
 * module top level only**:
 *   - inside a function body: always worked;
 *   - inside a top-level `try`/`if`/`for`/block: always worked (those statements
 *     are collected wholesale by the control-flow arm, and the read rides along);
 *   - `assert.throws(TypeError, function () { o.p; })`: always worked, because
 *     the read is inside a function body. That shape was NOT affected.
 * The `CALLBACK`/`NESTED` cases below pin those boundaries so a future narrowing
 * of the arm cannot quietly break them.
 *
 * The observable is a side effect (`hit`), not a throw, so no exception
 * machinery is involved and "not invoked" is distinguishable from
 * "invoked, threw, swallowed".
 */

async function runTopLevel(prelude: string): Promise<number> {
  const src = `${prelude}\nexport function probe(): number { return hit; }\n`;
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(r.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as { probe: () => number; __module_init?: () => void };
  exports.__module_init?.();
  return exports.probe();
}

const GETTER = `let hit = 0; const o: any = { get p() { hit = 1; return 1; } };`;

describe("#3615 — top-level bare property read must invoke the accessor", () => {
  it("object-literal getter, bare `o.p;` at top level", async () => {
    // Pre-fix: 0 — the statement never reached __module_init.
    expect(await runTopLevel(`${GETTER} o.p;`)).toBe(1);
  });

  it('element access, bare `o["p"];` at top level', async () => {
    expect(await runTopLevel(`${GETTER} o["p"];`)).toBe(1);
  });

  it("`void o.p;` at top level (void is transparent in statement position)", async () => {
    expect(await runTopLevel(`${GETTER} void o.p;`)).toBe(1);
  });

  it("parenthesized `(o.p);` at top level", async () => {
    expect(await runTopLevel(`${GETTER} (o.p);`)).toBe(1);
  });

  it("class accessor, bare `c.p;` at top level", async () => {
    expect(
      await runTopLevel(`let hit = 0; class C { get p(): number { hit = 1; return 1; } } const c: any = new C(); c.p;`),
    ).toBe(1);
  });

  it("Object.defineProperty accessor, bare `o.p;` at top level", async () => {
    expect(
      await runTopLevel(
        `let hit = 0; const o: any = {}; Object.defineProperty(o, "p", { get: function () { hit = 1; return 1; } }); o.p;`,
      ),
    ).toBe(1);
  });

  it("a nullish base throws at top level (GetValue on the Reference)", async () => {
    expect(await runTopLevel(`let hit = 0; const o: any = null; try { o.p; } catch (e) { hit = 1; }`)).toBe(1);
  });

  // ── Boundaries that were NEVER broken — pinned so a narrowing can't break them ──

  it("CALLBACK: a read inside a function value still runs (was never affected)", async () => {
    // This is the `assert.throws(TypeError, function () { o.p; })` shape. It
    // worked before the fix; the issue's prediction that it was also broken did
    // not hold up under an A/B. Pinned so the claim stays testable.
    expect(await runTopLevel(`${GETTER} function run(f: any): void { f(); } run(function () { o.p; });`)).toBe(1);
  });

  it("NESTED: a read inside a top-level block still runs (was never affected)", async () => {
    expect(await runTopLevel(`${GETTER} { o.p; }`)).toBe(1);
  });

  // ── Consumed-read controls — must be unchanged ──

  it("CONTROL: consumed read is unaffected", async () => {
    expect(await runTopLevel(`${GETTER} const v: any = o.p;`)).toBe(1);
  });

  it("CONTROL: top-level call statement is unaffected", async () => {
    expect(await runTopLevel(`let hit = 0; function f(): number { hit = 1; return 1; } f();`)).toBe(1);
  });

  it("CONTROL: top-level method call is unaffected", async () => {
    expect(await runTopLevel(`let hit = 0; const o: any = { m() { hit = 1; return 1; } }; o.m();`)).toBe(1);
  });

  it("CONTROL: a plain data-property read is a no-op, not a trap", async () => {
    // The arm is unconditional, so a non-accessor read now emits code where it
    // previously emitted none. It must still be a pure no-op.
    expect(await runTopLevel(`let hit = 1; const o: any = { p: 42 }; o.p; o["p"];`)).toBe(1);
  });
});
