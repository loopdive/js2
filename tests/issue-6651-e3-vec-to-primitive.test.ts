// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster E, slice E3) OrdinaryToPrimitive over a `$__vec_base`
 * carrier's OWN property surface in `--target standalone`, plus the symbol-key
 * write that feeds it on a TypedArray view.
 *
 * Before this slice `__to_primitive`'s vec arm was ONE step —
 * `Array.prototype.toString` — so §7.1.1 step 2 (`@@toPrimitive`) and
 * §7.1.1.1's hint-ordered `valueOf`/`toString` cascade never ran for an array,
 * an arguments-free vec, or a TypedArray view. An own method installed on the
 * carrier was invisible.
 *
 * Every comparison happens INSIDE the module and the export returns a number:
 * a standalone module's strings are WasmGC arrays with no host-readable form,
 * so returning one and comparing on the host reads `{}` for every case, pass or
 * fail.
 *
 * The negative controls carry as much weight as the positives. A carrier with
 * NO own method must keep the join verbatim — that fall-through IS the
 * §7.1.1.1 intrinsic step, and a regression there would change every
 * `"" + array` in the corpus.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-6651-e3.ts",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports, "standalone output leaked host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  const exports = instance.exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return (exports.test as () => unknown)();
}

/** A dynamically constructed view — the `$__ta_dyn_view` shape. */
const DYN_PRELUDE = `
  const ctors: any[] = [Float64Array, Int8Array];
  const TA: any = ctors[0];
`;

describe("#6651 E3 — own-method ToPrimitive over a vec carrier (standalone)", () => {
  it("honours an own valueOf on a plain array (number hint)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = [1];
          a.valueOf = function () { return 7; };
          return a + 0;
        }`),
    ).toBe(7);
  });

  it("honours an own toString on a plain array (string hint)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const b: any = [2];
          b.toString = function () { return "Z"; };
          return b + "" === "Z" ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("honours an own @@toPrimitive on a plain array, ahead of valueOf", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a: any = [1];
          let valueOfCalls = 0;
          a[Symbol.toPrimitive] = function () { return 77; };
          a.valueOf = function () { valueOfCalls++; return 1; };
          const v: number = a + 0;
          return valueOfCalls === 0 ? v : -1;
        }`),
    ).toBe(77);
  });

  it("honours an own valueOf on a STATIC TypedArray view", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const s: any = new Int8Array(1);
          s.valueOf = function () { return 42; };
          return s + 0;
        }`),
    ).toBe(42);
  });

  it("honours an own valueOf on a DYNAMIC TypedArray view", async () => {
    expect(
      await runStandalone(`${DYN_PRELUDE}
        export function test(): number {
          const v: any = new TA([1]);
          v.valueOf = function () { return 43; };
          return v + 0;
        }`),
    ).toBe(43);
  });

  // CONTROL, not a claim: it passes on BOTH trees. On base the symbol write was
  // DROPPED by the numeric element lane rather than misdirected, so element 0
  // survived there too; this pins that the new routing does not start
  // clobbering it. The behaviour CHANGE is the case immediately below.
  it("CONTROL — a symbol-keyed expando never lands in element 0 of a view", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const s: Int8Array = new Int8Array(1);
          s[0] = 3;
          (s as any)[Symbol.toPrimitive] = function () { return 99; };
          return s[0];
        }`),
    ).toBe(3);
  });

  // The ToPrimitive half of the same write, on an `any` receiver. A STATICALLY
  // typed `Int8Array` receiver folds `+` without consulting `__to_primitive`
  // at all (measured: it answers NaN on both trees), which is a separate
  // static-lowering gap recorded as a residual rather than fixed here.
  it("reduces through the symbol expando once the write lands", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const s: any = new Int8Array(1);
          s[0] = 3;
          s[Symbol.toPrimitive] = function () { return 99; };
          return s[0] * 1000 + (s + 0);
        }`),
    ).toBe(3099);
  });

  it("runs an own @@toPrimitive on a static view and skips valueOf", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const s: any = new Int8Array(1);
          s[Symbol.toPrimitive] = function () { return 99; };
          s.valueOf = function () { return 5; };
          return s + 0;
        }`),
    ).toBe(99);
  });

  it("throws a TypeError when an own toString shadows the join and yields an object", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const s: any = new Int8Array(1);
          s.valueOf = function () { return {}; };
          s.toString = function () { return {}; };
          try { return s + 0; } catch (e) { return e instanceof TypeError ? 1 : -1; }
        }`),
    ).toBe(1);
  });

  it("NEGATIVE — a carrier with no own method keeps the join verbatim", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const c: any = [3, 4];
          const s: any = new Int8Array(2);
          return c + "" === "3,4" && String(s) === "0,0" ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("NEGATIVE — a non-symbol key on a view still writes the element", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const s: any = new Int8Array(2);
          const i: any = 1;
          s[i] = 7;
          return s[1];
        }`),
    ).toBe(7);
  });
});
