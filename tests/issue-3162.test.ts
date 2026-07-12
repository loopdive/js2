// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3162 (SOUNDNESS) — dyn-view `find`/`findIndex` through the #3058 two-arm.
//
// Adding `find`/`findIndex` to `DYN_VIEW_READ_METHODS` previously (a) emitted a
// structurally INVALID standalone module (the legacy `compileArrayFind` re-entry
// over the materialized f64-vec produced an arm-result type the two-arm branch
// could not unify — the "fallthru[0] expected (ref null 4), got i32" validation
// error) and (b) leaked the `env.__make_callback` / `env.<TA>_find` host imports
// (the ELSE arm bound `any.find(cb)` to a host %TypedArray% method).
//
// The fix routes the THEN arm (materialized `$__vec_f64`) through the #3098
// native `__hof_<name>` substrate (correct `undefined` not-found sentinel +
// thisArg threading, externref result — no coercion fixup) and adds
// `find`/`findIndex` to the calls-closures extern-class dispatch refusal list
// (#3014/#3139 precedent) so the ELSE / generic path is native + standalone-clean.

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Must be VALID wasm (no fallthru type error) AND standalone-clean (no env
  // host imports — the leak that made the module fail to instantiate).
  const mod = await WebAssembly.compile(r.binary);
  const envImports = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(envImports, `leaked host imports: ${envImports.map((i) => i.name).join(", ")}`).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

// A dynamic `$__ta_dyn_view` receiver: `new c(b)` where `c` is an `any`-typed
// element of an `any[]` and `b` is an ArrayBuffer — the runtime-kind dyn view
// the #3058 two-arm fires on. Iterating several constructors mirrors the
// test262 `testWithTypedArrayConstructors` harness that first surfaced the bug.
const H = (body: string): string => `
  export function f(): number {
    const cs: any[] = [Int8Array, Uint8Array, Int16Array, Int32Array, Float64Array];
    // 40 bytes so every kind (incl. Float64Array, 8 bytes/elem → 5 slots) holds
    // at least the three indices the body writes.
    const b = new ArrayBuffer(40);
    let r = 0;
    for (const c of cs) {
      const a: any = new c(b);
      a[0] = 1; a[1] = 2; a[2] = 3;
      ${body}
    }
    return r;
  }`;

describe("#3162 dyn-view find/findIndex two-arm (soundness)", () => {
  it("find with a MUTATING predicate compiles to valid, host-import-free wasm (the trigger)", async () => {
    // predicate mutates the view mid-iteration (test262 predicate-call-changes-value shape)
    expect(
      await runStandalone(
        H(
          `const x: any = a.find(function (v: any, i: any, arr: any) { arr[0] = 9; return v === 2; }); if (x === 2) r = r + 1;`,
        ),
      ),
    ).toBe(5);
  });

  it("find returns the matched element", async () => {
    expect(
      await runStandalone(H(`const x: any = a.find(function (v: any) { return v === 3; }); if (x === 3) r = r + 1;`)),
    ).toBe(5);
  });

  it("find returns undefined (not a NaN-boxed number) when nothing matches", async () => {
    // The legacy compileArrayFind f64-vec impl boxed a NaN sentinel, so
    // `x === undefined` was false. __hof_find returns ref.null.extern.
    expect(
      await runStandalone(
        H(`const x: any = a.find(function (v: any) { return v === 99; }); if (x === undefined) r = r + 1;`),
      ),
    ).toBe(5);
  });

  it("findIndex returns the matched index", async () => {
    expect(
      await runStandalone(
        H(`const x: any = a.findIndex(function (v: any) { return v === 2; }); if (x === 1) r = r + 1;`),
      ),
    ).toBe(5);
  });

  it("findIndex returns -1 when nothing matches", async () => {
    expect(
      await runStandalone(
        H(`const x: any = a.findIndex(function (v: any) { return v === 99; }); if (x === -1) r = r + 1;`),
      ),
    ).toBe(5);
  });

  it("find with an arrow-function predicate", async () => {
    expect(await runStandalone(H(`const x: any = a.find((v: any) => v === 3); if (x === 3) r = r + 1;`))).toBe(5);
  });

  it("find with an identifier-held (already-compiled) callback", async () => {
    expect(
      await runStandalone(
        H(
          `const pred: any = function (v: any) { return v === 2; }; const x: any = a.find(pred); if (x === 2) r = r + 1;`,
        ),
      ),
    ).toBe(5);
  });

  it("find(pred, thisArg) — the thisArg 2nd argument is accepted and the call is valid", async () => {
    // thisArg is threaded to __hof_find; the predicate here does not read
    // `this` (the harness `this`-binding is a separate #3098 substrate concern),
    // so the search proceeds normally and the module stays valid/clean.
    expect(
      await runStandalone(
        H(
          `const t: any = { k: 0 }; const x: any = a.find(function (v: any) { return v === 2; }, t); if (x === 2) r = r + 1;`,
        ),
      ),
    ).toBe(5);
  });

  it("does not disturb reduce/reduceRight (already in the two-arm set)", async () => {
    expect(
      await runStandalone(
        H(`const s: any = a.reduce(function (acc: any, v: any) { return acc + v; }, 0); if (s === 6) r = r + 1;`),
      ),
    ).toBe(5);
  });
});
