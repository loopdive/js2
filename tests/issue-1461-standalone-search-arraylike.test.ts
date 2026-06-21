import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1461 / #54 — standalone `Array.prototype.{indexOf,lastIndexOf,includes}.call(
 * arrayLike, value)` over a non-array receiver.
 *
 * The standalone search arm refused (it would leak the `__host_eq` /
 * `__same_value_zero` host imports, which have no native impl). It now routes
 * element comparison through the pure-Wasm `__extern_strict_eq` (===, indexOf/
 * lastIndexOf) / `__extern_same_value_zero` (SameValueZero, includes) helpers —
 * composed from the engine-owned `__any_from_extern` + `__any_strict_eq` — so the
 * module needs ZERO env imports.
 *
 * These assert valid host-free Wasm + spec-correct numeric/boolean/NaN results.
 * (String-element comparison routes through `__any_strict_eq`'s string arm, whose
 * standalone path is a separate, pre-existing follow-up.)
 */
function envImports(imports: ReadonlyArray<{ module: string; name: string }>): string[] {
  return imports.filter((i) => i.module === "env").map((i) => i.name);
}

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaked = envImports(r.imports);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#1461/#54 — standalone indexOf/lastIndexOf/includes.call over an array-like (host-free)", () => {
  it("indexOf finds a numeric element", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o: any = {0:10,1:20,2:30,length:3}; return Array.prototype.indexOf.call(o, 20); }`,
      ),
    ).toBe(1);
  });

  it("indexOf returns -1 when absent", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o: any = {0:10,1:20,length:2}; return Array.prototype.indexOf.call(o, 99); }`,
      ),
    ).toBe(-1);
  });

  it("lastIndexOf finds the last numeric match", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o: any = {0:5,1:5,2:9,length:3}; return Array.prototype.lastIndexOf.call(o, 5); }`,
      ),
    ).toBe(1);
  });

  it("includes returns true for a present element", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o: any = {0:1,1:2,length:2}; return Array.prototype.includes.call(o, 2) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("includes uses SameValueZero — NaN matches NaN", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o: any = {0:1,1:NaN,length:2}; return Array.prototype.includes.call(o, NaN) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("indexOf uses StrictEqualityComparison — NaN never matches", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const o: any = {0:1,1:NaN,length:2}; return Array.prototype.indexOf.call(o, NaN); }`,
      ),
    ).toBe(-1);
  });

  it("indexOf over an arguments object", async () => {
    expect(
      await runStandalone(
        `function g(): number { return Array.prototype.indexOf.call(arguments, 7); }
         export function run(): number { return g(); }`,
      ),
    ).toBe(-1); // no args passed → length 0 → not found
  });
});
