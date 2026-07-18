// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2872 slice 5 — dyn-view `findLast`/`findLastIndex` host-free (two-part fix).
//
// Part 1: `findLast`/`findLastIndex` join `DYN_VIEW_READ_METHODS` +
// `FIND_METHODS` (array-methods.ts), so the #3058 two-arm's THEN arm routes the
// materialized `$__vec_f64` through the #3098 native backward `__hof_<name>`
// loops (correct `undefined` not-found sentinel + thisArg threading) instead of
// the legacy `compileArrayFind` re-entry whose missing `__call_1_f64`
// registration CE'd this path (the stale exclusion note).
//
// Part 2 (load-bearing): the scalar-HOF any-receiver decline in
// `tryExternClassMethodOnAny` (calls-closures.ts). The two-arm ALWAYS compiles
// its ELSE arm, whose re-dispatch previously first-match-bound
// `env::Uint8ClampedArray_findLast[Index]` — a host import emitted at COMPILE
// time, so the standalone module failed to instantiate even though the THEN
// arm would run (measured host_import_leak ×33). `findLast`/`findLastIndex`
// were the only `STANDALONE_TA_SCALAR_HOFS` members missing from the
// #3014/#3139 refusals; the shared noJsHost decline closes the family.

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Must be VALID wasm AND standalone-clean (no env host imports — the leak
  // that made the module fail to instantiate).
  const mod = await WebAssembly.compile(r.binary);
  const envImports = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(envImports, `leaked host imports: ${envImports.map((i) => i.name).join(", ")}`).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

// The test262 `testWithTypedArrayConstructors` harness shape: a dynamic
// `$__ta_dyn_view` receiver (`new c(b)` where `c` is an `any`-typed element of
// an `any[]`) — the runtime-kind dyn view the #3058 two-arm fires on.
const H = (body: string): string => `
  export function f(): number {
    const cs: any[] = [Int8Array, Uint8Array, Int16Array, Int32Array, Float64Array];
    const b = new ArrayBuffer(40);
    let r = 0;
    for (const c of cs) {
      const a: any = new c(b);
      a[0] = 1; a[1] = 2; a[2] = 3;
      ${body}
    }
    return r;
  }`;

describe("#2872 slice 5: dyn-view findLast/findLastIndex host-free", () => {
  it("findLast searches BACKWARD (returns the last match, not the first)", async () => {
    // a = [1,2,3,0,0]; predicate v>0 must yield 3 (index 2), not 1 (index 0).
    expect(
      await runStandalone(H(`const x: any = a.findLast(function (v: any) { return v > 0; }); if (x === 3) r = r + 1;`)),
    ).toBe(5);
  });

  it("findLastIndex returns the LAST matching index", async () => {
    expect(
      await runStandalone(
        H(`const x: any = a.findLastIndex(function (v: any) { return v > 0; }); if (x === 2) r = r + 1;`),
      ),
    ).toBe(5);
  });

  it("findLast returns undefined (not a NaN-boxed number) when nothing matches", async () => {
    expect(
      await runStandalone(
        H(`const x: any = a.findLast(function (v: any) { return v === 99; }); if (x === undefined) r = r + 1;`),
      ),
    ).toBe(5);
  });

  it("findLastIndex returns -1 when nothing matches", async () => {
    expect(
      await runStandalone(
        H(`const x: any = a.findLastIndex(function (v: any) { return v === 99; }); if (x === -1) r = r + 1;`),
      ),
    ).toBe(5);
  });

  it("findLast with an arrow predicate + a MUTATING predicate stays valid + clean", async () => {
    // Mutation mid-iteration (predicate-call-changes-value shape): backward
    // iteration reads index 2 first, so zeroing index 0 must not affect the hit.
    expect(
      await runStandalone(
        H(
          `const x: any = a.findLast((v: any, i: any, arr: any) => { arr[0] = 0; return v === 2; }); if (x === 2) r = r + 1;`,
        ),
      ),
    ).toBe(5);
  });

  it("findLast(pred, thisArg) — 2nd argument accepted, module valid/clean", async () => {
    expect(
      await runStandalone(
        H(
          `const t: any = { k: 0 }; const x: any = a.findLast(function (v: any) { return v === 2; }, t); if (x === 2) r = r + 1;`,
        ),
      ),
    ).toBe(5);
  });

  it("statically-typed direct receiver stays host-free and correct", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const a = new Uint8ClampedArray([1, 2, 3, 2]);
          let r = 0;
          const x: any = a.findLast((v: any) => v === 2);
          const i: any = a.findLastIndex((v: any) => v === 2);
          if (x === 2) r = r + 1;
          if (i === 3) r = r + 1;
          const miss: any = a.findLast((v: any) => v === 99);
          if (typeof miss === "undefined") r = r + 1;
          return r;
        }`),
    ).toBe(3);
  });

  it("GUARD: plain-array any receiver findLast is not hijacked", async () => {
    // A plain number[] held in `any` — the ELSE arm / generic ladder must
    // resolve it by runtime shape (native __hof_findLast), not a TA binding.
    expect(
      await runStandalone(`
        export function f(): number {
          const a: any = [5, 6, 7, 6];
          let r = 0;
          const x: any = a.findLast(function (v: any) { return v === 6; });
          if (x === 6) r = r + 1;
          const i: any = a.findLastIndex(function (v: any) { return v === 6; });
          if (i === 3) r = r + 1;
          return r;
        }`),
    ).toBe(2);
  });

  it("miss result is falsy and ??-coalesces (S1 singleton semantics)", async () => {
    // The S1 `$undefined` singleton the miss now returns must behave like JS
    // undefined beyond ===: falsy under ToBoolean and nullish for `??`.
    expect(
      await runStandalone(
        H(
          `const x: any = a.findLast(function (v: any) { return v === 99; }); if (!x) r = r + 1; const y: any = x ?? 7; if (y === 7) r = r + 1; r = r - 1;`,
        ),
      ),
    ).toBe(5);
  });

  it("does not disturb find/findIndex (the #3162 siblings)", async () => {
    expect(
      await runStandalone(
        H(
          `const x: any = a.find(function (v: any) { return v > 0; }); const j: any = a.findIndex(function (v: any) { return v > 1; }); if (x === 1 && j === 1) r = r + 1;`,
        ),
      ),
    ).toBe(5);
  });
});
