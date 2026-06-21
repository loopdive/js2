import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

/**
 * #2568 — two-level nested destructuring-param default returns 0 in standalone.
 *
 * `method({ w: { x, y, z } = {…} } = { w: {…} })` reads sentinels (0) in
 * standalone mode when EITHER default fires, while host mode is correct. Two
 * struct-representation mismatches caused it:
 *   - OUTER default: the in-method default object literal materialized as a
 *     struct whose nested `w` field was boxed to externref, NOT matching the
 *     shape the destructuring `ref.test`/`ref.cast` derives from the pattern's
 *     type — the fast struct path's `ref.test` failed → bindings read 0.
 *   - INNER default: in the externref destructuring path the nested default
 *     object was a closed struct, but the bindings are read back through
 *     `__extern_get`, which only indexes a `$Object` → bindings read 0.
 *
 * Fix: materialize the OUTER default as the binding-pattern's struct type, and
 * the INNER (externref-path) default as a `$Object`. Host mode is unchanged.
 */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "binary must validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

const M = `class C { method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, y: 2, z: 3 } }): number { return x * 100 + y * 10 + z; } }`;

describe("#2568 — standalone two-level nested destructuring-param default", () => {
  it("OUTER default fires (no arg) → inner fields read the outer default object", async () => {
    expect(await runStandalone(`${M} export function test(): number { return new C().method(); }`)).toBe(123);
  });

  it("INNER default fires ({ w: undefined }) → inner pattern default object is read", async () => {
    expect(
      await runStandalone(`${M} export function test(): number { return new C().method({ w: undefined } as any); }`),
    ).toBe(456);
  });

  it("explicit value overrides both defaults", async () => {
    expect(
      await runStandalone(
        `${M} export function test(): number { return new C().method({ w: { x: 1, y: 2, z: 3 } }); }`,
      ),
    ).toBe(123);
  });

  it("single-level object param default is unaffected", async () => {
    expect(
      await runStandalone(
        `class C { method({ x }: { x: number } = { x: 7 }): number { return x; } } export function test(): number { return new C().method(); }`,
      ),
    ).toBe(7);
  });

  it("returns the last field (z) from the outer default object", async () => {
    expect(
      await runStandalone(
        `class C { method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, y: 2, z: 9 } }): number { return z; } } export function test(): number { return new C().method(); }`,
      ),
    ).toBe(9);
  });

  it("plain function (not a method) two-level default also works", async () => {
    expect(
      await runStandalone(
        `function f({ w: { x } = { x: 4 } } = { w: { x: 1 } }): number { return x; } export function test(): number { return f(); }`,
      ),
    ).toBe(1);
  });
});
