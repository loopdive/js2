// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1806 Phase 1 (string-hint slice) — standalone OrdinaryToPrimitive in the
 * string direction.
 *
 * Before this slice, coercing an object with a compile-time-resolvable
 * `toString`/`valueOf` to a string under `--target standalone` routed through
 * the `$__any_to_string` dispatcher, which cannot introspect a user struct and
 * yields `"[object Object]"` (the concat result observed as `undefined`). The
 * numeric-hint path (`obj + 1`) already worked; only the string-hint path
 * (`obj + "s"`, `` `${obj}` ``) was broken.
 *
 * `tryStructToString` (src/codegen/type-coercion.ts) now dispatches the
 * object's own `toString` (closure field — ref or eqref — or a named
 * `${name}_toString`) per §7.1.1.1, normalising the result to a native string.
 *
 * Assertions run INSIDE Wasm (the export returns 1/0) because native-strings
 * standalone returns a `$AnyString` GC struct, not a JS string — comparing the
 * raw export to a JS string from the host would always mismatch.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors?.[0]?.message ?? "compile failed").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => unknown)();
}

describe("#1806 Phase 1 — standalone ToPrimitive (string hint)", () => {
  it("string `+` calls a user toString (closure field)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           var o = { toString: function() { return "X"; } };
           return (o + "Y") === "XY" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("template literal substitution calls a user toString", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           var o = { toString: function() { return "X"; } };
           return \`\${o}!\` === "X!" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("string hint prefers toString when both valueOf and toString exist", async () => {
    // §7.1.1.1 OrdinaryToPrimitive("string"): toString is tried first. The
    // f64-returning valueOf must NOT be dispatched for a string coercion (doing
    // so previously called the wrong closure signature → null-deref trap).
    //
    // (#4564) This case used to probe the string hint through `o + "Y"` and
    // assert "XY". That is the wrong operation: `+` is §13.15.3, which reduces
    // with hint DEFAULT — valueOf first — and only then, because the other
    // operand is a string, concatenates. Node agrees: the expression is "1Y",
    // and test262 `language/expressions/equals/S9.1_A1_T3` asserts exactly that
    // shape the other way round. The old expectation also contradicted this
    // file's own "numeric `+` still uses valueOf" case two tests below. So the
    // string hint is now probed where it actually applies — `String(o)` — and
    // the `+` shape is asserted at its real value.
    expect(
      await runStandalone(
        `export function test(): number {
           var o = { valueOf: function() { return 1; }, toString: function() { return "X"; } };
           return String(o) === "X" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
    expect(
      await runStandalone(
        `export function test(): number {
           var o = { valueOf: function() { return 1; }, toString: function() { return "X"; } };
           return (o + "Y") === "1Y" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("numeric `+` still uses valueOf (no regression)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           var o = { valueOf: function() { return 5; } };
           return (o + 1) === 6 ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("plain object without toString still yields [object Object]", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           var o = { x: 1 };
           return (o + "Y") === "[object Object]Y" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("class instance toString is dispatched for a string coercion", async () => {
    expect(
      await runStandalone(
        `class C { toString(): string { return "C!"; } }
         export function test(): number {
           const c = new C();
           return (c + "?") === "C!?" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });
});
