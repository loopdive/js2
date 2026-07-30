// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2063 — switch must use per-case StrictEquality (§14.12.2 CaseClauseIsSelected),
// not unify the whole statement into one f64/string comparison domain.
//
// Before the fix, a non-homogeneous switch coerced: `switch(true){case 1}`
// matched (true→1.0→f64.eq), `switch("1"){case 1}` matched ("1"→1.0), and a
// mixed numeric+string case set crashed (numeric value shoved through
// wasm:js-string equals → host "Illegal argument"). The fix keeps the
// discriminant boxed and compares each case with §7.2.16 StrictEquality
// (JS-host `__host_eq`, or the standalone #1776 tag dispatch), so cross-type
// cases never match and never crash. Homogeneous numeric/string/boolean
// switches keep the fast path unchanged.
//
// `assertEquivalent` runs the source as JS and compares the wasm result (and
// runs WebAssembly.validate on the binary).
import { describe, expect, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("#2063 switch StrictEquality (JS-host / default mode)", () => {
  it("switch(true){case 1} -> default (true !== 1)", async () => {
    await assertEquivalent(
      `export function t3(): number { const x: any = true; switch (x) { case 1: return 100; default: return 0; } }`,
      [{ fn: "t3", args: [] }],
    );
  });
  it("switch('1'){case 1} -> default ('1' !== 1)", async () => {
    await assertEquivalent(
      `export function s(): number { const x: any = "1"; switch (x) { case 1: return 100; default: return 0; } }`,
      [{ fn: "s", args: [] }],
    );
  });
  it("switch('1'){case 1, case '1'} -> '1' (no crash on mixed cases)", async () => {
    await assertEquivalent(
      `export function t2(): number { const x: any = "1"; switch (x) { case 1: return 100; case "1": return 50; default: return 0; } }`,
      [{ fn: "t2", args: [] }],
    );
  });
  it("switch(1){case '1'} -> default (no crash, no match)", async () => {
    await assertEquivalent(
      `export function f(): number { const x: any = 1; switch (x) { case "1": return 50; default: return 0; } }`,
      [{ fn: "f", args: [] }],
    );
  });
  it("any-number discriminant matches a numeric case", async () => {
    await assertEquivalent(
      `export function f(): number { const x: any = 2; switch (x) { case 1: return 10; case 2: return 20; default: return 0; } }`,
      [{ fn: "f", args: [] }],
    );
  });
  it("any-string discriminant matches a string case", async () => {
    await assertEquivalent(
      `export function f(): number { const x: any = "b"; switch (x) { case "a": return 10; case "b": return 20; default: return 0; } }`,
      [{ fn: "f", args: [] }],
    );
  });
  it("mixed number|string discriminant picks the right typed case", async () => {
    await assertEquivalent(
      `export function f(x: number | string): number { switch (x) { case 1: return 10; case "1": return 50; case 2: return 20; default: return 0; } }`,
      [
        { fn: "f", args: [1] },
        { fn: "f", args: [2] },
      ],
    );
  });

  // Homogeneous fast paths must stay unchanged (no coercion regression).
  it("homogeneous numeric switch keeps the fast path", async () => {
    await assertEquivalent(
      `export function f(n: number): number { switch (n) { case 1: return 10; case 2: return 20; default: return 0; } }`,
      [
        { fn: "f", args: [1] },
        { fn: "f", args: [2] },
        { fn: "f", args: [3] },
      ],
    );
  });
  it("homogeneous string switch keeps the fast path", async () => {
    await assertEquivalent(
      `export function f(s: string): number { switch (s) { case "a": return 10; case "b": return 20; default: return 0; } }`,
      [
        { fn: "f", args: ["a"] },
        { fn: "f", args: ["b"] },
        { fn: "f", args: ["c"] },
      ],
    );
  });
});

// Standalone (pure-WasmGC) mode: the strict-eq tag dispatch must also validate
// and run with no JS host. Compiles with --target standalone and runs binary
// with no imports.
describe("#2063 switch StrictEquality (standalone / pure WasmGC)", () => {
  async function runStandalone(src: string, fn: string, args: unknown[] = []) {
    const result = await compile(src, { target: "standalone" });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports[fn] as (...a: unknown[]) => unknown)(...args);
  }

  it("switch(true){case 1} -> 0", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const x: any = true; switch (x) { case 1: return 100; default: return 0; } }`,
        "f",
      ),
    ).toBe(0);
  });
  it("switch('1'){case 1, case '1'} -> 50", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const x: any = "1"; switch (x) { case 1: return 100; case "1": return 50; default: return 0; } }`,
        "f",
      ),
    ).toBe(50);
  });
  it("switch(true){case true} -> 7; switch(true){case false} -> 0", async () => {
    expect(
      await runStandalone(
        `export function f(): number { const x: any = true; switch (x) { case true: return 7; default: return 0; } }`,
        "f",
      ),
    ).toBe(7);
    expect(
      await runStandalone(
        `export function f(): number { const x: any = true; switch (x) { case false: return 7; default: return 0; } }`,
        "f",
      ),
    ).toBe(0);
  });
  it("homogeneous numeric switch validates and runs standalone", async () => {
    expect(
      await runStandalone(
        `export function f(n: number): number { switch (n) { case 1: return 10; case 2: return 20; default: return 0; } }`,
        "f",
        [2],
      ),
    ).toBe(20);
  });

  it("object-only cases use identity and reject primitives and distinct objects", async () => {
    const source = `
      const first: any = { id: 1 };
      const second: any = { id: 1 };
      export function f(which: number): number {
        const value: any =
          which === 0 ? first :
          which === 1 ? second :
          which === 2 ? {} :
          which === 3 ? 1 :
          which === 4 ? "first" :
          which === 5 ? true :
          which === 6 ? null :
          undefined;
        switch (value) {
          case first: return 10;
          case second: return 20;
          default: return 0;
        }
      }
    `;
    expect(await runStandalone(source, "f", [0])).toBe(10);
    expect(await runStandalone(source, "f", [1])).toBe(20);
    expect(await runStandalone(source, "f", [2])).toBe(0);
    expect(await runStandalone(source, "f", [3])).toBe(0);
    expect(await runStandalone(source, "f", [4])).toBe(0);
    expect(await runStandalone(source, "f", [5])).toBe(0);
    expect(await runStandalone(source, "f", [6])).toBe(0);
    expect(await runStandalone(source, "f", [7])).toBe(0);
  });

  it("mixed object and primitive cases keep full StrictEquality semantics", async () => {
    const source = `
      const objectCase: any = {};
      export function f(which: number): number {
        const value: any = which === 0 ? objectCase : which === 1 ? 1 : {};
        switch (value) {
          case objectCase: return 10;
          case 1: return 20;
          default: return 0;
        }
      }
    `;
    expect(await runStandalone(source, "f", [0])).toBe(10);
    expect(await runStandalone(source, "f", [1])).toBe(20);
    expect(await runStandalone(source, "f", [2])).toBe(0);
  });

  it("guards an any discriminant once for homogeneous numeric cases without coercion", async () => {
    const source = `
      var visits = 0;
      function numericCase(value: number): number {
        visits++;
        return value;
      }
      export function f(which: number): number {
        visits = 0;
        const value: any =
          which === 0 ? 2 :
          which === 1 ? "2" :
          which === 2 ? { valueOf: function(): number { return 2; } } :
          NaN;
        var result = 0;
        switch (value) {
          case numericCase(1): result = 10; break;
          case numericCase(2): result = 20; break;
          case numericCase(3): result = 30; break;
          default: result = 40;
        }
        return result + visits;
      }
    `;
    expect(await runStandalone(source, "f", [0])).toBe(22);
    expect(await runStandalone(source, "f", [1])).toBe(43);
    expect(await runStandalone(source, "f", [2])).toBe(43);
    expect(await runStandalone(source, "f", [3])).toBe(43);
  });
});
