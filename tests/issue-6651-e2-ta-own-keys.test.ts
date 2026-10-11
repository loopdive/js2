// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster E, slice E2) The own-property surface of a dynamically
 * constructed TypedArray view in `--target standalone` — §10.4.5.6
 * `[[OwnPropertyKeys]]` and the own-ness predicates that read it.
 *
 * Every case asserts a FULL key list or an exact predicate answer, never
 * "contains", because both halves of the defect were answers of the right
 * SHAPE: the generic `$__vec_base` arm reported an ARRAY's own keys (indices
 * plus a spurious `"length"`, with the view's own expandos missing), and the
 * own-ness predicates answered a uniform `false` — including for a valid
 * integer index.
 *
 * The comparison happens INSIDE the module and the export returns a number: a
 * standalone module's strings are WasmGC arrays with no host-readable form, so
 * returning one and comparing on the host reads `{}` for every case, pass or
 * fail — a test that cannot fail for the right reason.
 *
 * The negative controls matter as much as the positives: a plain array and a
 * plain object must keep their previous answers exactly (the arms are
 * `ref.test $__ta_dyn_view`-gated, and `"length"` IS an own key of an array).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-6651-e2.ts",
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

/** A dynamically constructed view: the ctor is read out of an array, so its
 *  element kind is only known at runtime — the `$__ta_dyn_view` shape every
 *  `testWithTypedArrayConstructors` harness closure produces. */
const DYN_PRELUDE = `
  const ctors: any[] = [Float64Array, Int8Array];
  const TA: any = ctors[0];
`;

describe("#6651 E2 — dyn-view own-key surface (standalone)", () => {
  it("lists integer indices only, with no own 'length'", async () => {
    expect(
      await runStandalone(`${DYN_PRELUDE}
        export function test(): number {
          const v: any = new TA([1, 2, 3]);
          return String(Object.getOwnPropertyNames(v)) === "0,1,2" ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("appends own string expandos after the indices, in creation order", async () => {
    expect(
      await runStandalone(`${DYN_PRELUDE}
        export function test(): number {
          const v: any = new TA([1, 2]);
          v.test262 = 1;
          v.ecma262 = 2;
          return String(Object.getOwnPropertyNames(v)) === "0,1,test262,ecma262" ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("reports own symbol expandos through getOwnPropertySymbols", async () => {
    expect(
      await runStandalone(`${DYN_PRELUDE}
        export function test(): number {
          const v: any = new TA([1, 2]);
          const s: any = Symbol("s");
          v[s] = 9;
          return Object.getOwnPropertySymbols(v).length;
        }`),
    ).toBe(1);
  });

  it("answers hasOwnProperty per §10.4.5.14, not a blanket false", async () => {
    expect(
      await runStandalone(`${DYN_PRELUDE}
        export function test(): number {
          const v: any = new TA([1, 2]);
          v.foo = 1;
          // Spelled out at each site rather than aliased into a local: hoisting
          // Object.prototype.hasOwnProperty into a first-class value and
          // calling it through .call traps in standalone today (an unrelated
          // gap), which would make this case fail for a reason it is not about.
          return (Object.prototype.hasOwnProperty.call(v, 0) ? 1 : 0) +
            (Object.prototype.hasOwnProperty.call(v, 5) ? 0 : 2) +
            (Object.prototype.hasOwnProperty.call(v, "foo") ? 4 : 0) +
            (Object.prototype.hasOwnProperty.call(v, "length") ? 0 : 8) +
            (Object.prototype.hasOwnProperty.call(v, "subarray") ? 0 : 16);
        }`),
    ).toBe(31);
  });

  it("enumerates an enumerable expando in Object.keys and for-in", async () => {
    expect(
      await runStandalone(`${DYN_PRELUDE}
        export function test(): number {
          const v: any = new TA([1, 2]);
          v.foo = 1;
          Object.defineProperty(v, "hidden", { value: 2, enumerable: false });
          let seen = "";
          for (const k in v) seen += k + ";";
          return (String(Object.keys(v)) === "0,1,foo" ? 1 : 0) + (seen === "0;1;foo;" ? 2 : 0);
        }`),
    ).toBe(3);
  });

  it("runs an observable ToNumber on a defineProperty element write", async () => {
    // §10.4.5.3 step vi hands the descriptor's [[Value]] to
    // IntegerIndexedElementSet, whose step 1 is ToNumber — observable, so a
    // throwing valueOf must propagate. The native behind this path answered
    // NaN without ever calling valueOf. A PLAIN `v[0] = boxed` does NOT
    // exercise it (that spelling already coerced correctly on base), which is
    // why the case is written through defineProperty.
    expect(
      await runStandalone(`${DYN_PRELUDE}
        export function test(): number {
          const v: any = new TA([0, 0]);
          let calls = 0;
          const boxed: any = { valueOf: function () { calls++; return 7; } };
          Object.defineProperty(v, 0, { value: boxed });
          return (v[0] === 7 ? 1 : 0) + calls * 10;
        }`),
    ).toBe(11);
  });

  // ── negative controls: non-view receivers keep their previous answers ──
  it("leaves a plain array's own keys untouched ('length' IS own there)", async () => {
    expect(
      await runStandalone(`export function test(): number {
          const a: any = [1, 2];
          a.foo = 3;
          // "length" comes BEFORE the expando: it is an own string key created
          // at construction, and §10.1.11.1 orders string keys by creation.
          return (String(Object.getOwnPropertyNames(a)) === "0,1,length,foo" ? 1 : 0) +
            (Object.prototype.hasOwnProperty.call(a, "length") ? 2 : 0);
        }`),
    ).toBe(3);
  });

  it("leaves a plain object's own keys and predicates untouched", async () => {
    expect(
      await runStandalone(`export function test(): number {
          const o: any = { a: 1 };
          Object.defineProperty(o, "b", { value: 2, enumerable: false });
          return (String(Object.getOwnPropertyNames(o)) === "a,b" ? 1 : 0) +
            (String(Object.keys(o)) === "a" ? 2 : 0) +
            (Object.prototype.propertyIsEnumerable.call(o, "b") ? 0 : 4);
        }`),
    ).toBe(7);
  });
});
