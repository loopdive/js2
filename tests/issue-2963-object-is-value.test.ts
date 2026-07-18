// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2963 Tier 2b — `Object.is` as a first-class VALUE under `--target standalone`.
 *
 * `Object.is` is SameValue (§20.1.2.13), NOT `===`. The direct standalone call
 * only backs COMPILE-TIME same-typed scalar args (the general boxed
 * `__object_is` is a host import); a reified value gets two boxed `any` args, so
 * the closure body composes host-free: if BOTH boxes are Numbers
 * (`__typeof_number`), run the shared `sameValueNumberOps` (IEEE-754 bit-compare
 * + both-NaN — the only place SameValue diverges from `===`: `+0`/`-0` UNEQUAL,
 * `NaN`/`NaN` EQUAL); otherwise SameValue coincides with `===` for every
 * non-Number case, so it reuses `__extern_strict_eq` (object identity via
 * `ref.eq`, string content, null/undefined/boolean by value).
 *
 * The both-Number ops are shared with the direct `Object.is` fast path
 * (`sameValueNumberOps`), so the reified and direct calls are byte-identical;
 * host/gc lanes are byte-inert (56-entry emit-identity corpus IDENTICAL).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<Record<string, Function>> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, Function>;
}

describe("#2963 Tier 2b — Object.is value reads (standalone)", () => {
  it("SameValue over Numbers: NaN equal, +0/-0 distinct", async () => {
    const exports = await runStandalone(`
      export function eq(): number { const f: any = Object.is; return f(1, 1) ? 1 : 0; }
      export function neq(): number { const f: any = Object.is; return f(1, 2) ? 1 : 0; }
      export function nanEqual(): number { const f: any = Object.is; return f(0 / 0, 0 / 0) ? 1 : 0; }
      export function signedZeroDistinct(): number { const f: any = Object.is; return f(0, -0) ? 1 : 0; }
      export function negZeroSelf(): number { const f: any = Object.is; return f(-0, -0) ? 1 : 0; }
    `);
    expect(exports.eq!()).toBe(1);
    expect(exports.neq!()).toBe(0);
    expect(exports.nanEqual!()).toBe(1); // Object.is(NaN, NaN) === true (≠ ===)
    expect(exports.signedZeroDistinct!()).toBe(0); // Object.is(+0, -0) === false (≠ ===)
    expect(exports.negZeroSelf!()).toBe(1);
  });

  it("SameValue over strings / booleans / mixed types", async () => {
    const exports = await runStandalone(`
      export function strEq(): number { const f: any = Object.is; return f("ab", "ab") ? 1 : 0; }
      export function strNeq(): number { const f: any = Object.is; return f("ab", "ac") ? 1 : 0; }
      export function boolEq(): number { const f: any = Object.is; return f(true, true) ? 1 : 0; }
      export function mixedNumStr(): number { const f: any = Object.is; return f(1, "1") ? 1 : 0; }
      export function mixedBoolNum(): number { const f: any = Object.is; return f(true, 1) ? 1 : 0; }
    `);
    expect(exports.strEq!()).toBe(1);
    expect(exports.strNeq!()).toBe(0);
    expect(exports.boolEq!()).toBe(1);
    expect(exports.mixedNumStr!()).toBe(0); // different types → false
    expect(exports.mixedBoolNum!()).toBe(0); // Boolean true is not the Number 1
  });

  it("SameValue over null / undefined / object identity", async () => {
    const exports = await runStandalone(`
      export function undefEq(): number { const f: any = Object.is; return f(undefined, undefined) ? 1 : 0; }
      export function nullEq(): number { const f: any = Object.is; return f(null, null) ? 1 : 0; }
      export function nullVsUndef(): number { const f: any = Object.is; return f(null, undefined) ? 1 : 0; }
      export function sameRef(): number { const f: any = Object.is; const o = { a: 1 }; return f(o, o) ? 1 : 0; }
      export function distinctRef(): number {
        const f: any = Object.is; const o1 = { a: 1 }; const o2 = { a: 1 }; return f(o1, o2) ? 1 : 0;
      }
    `);
    expect(exports.undefEq!()).toBe(1);
    expect(exports.nullEq!()).toBe(1);
    expect(exports.nullVsUndef!()).toBe(0);
    expect(exports.sameRef!()).toBe(1); // same reference → true
    expect(exports.distinctRef!()).toBe(0); // distinct references → false
  });

  it("is observationally identical to the direct call over a fixed input matrix", async () => {
    const exports = await runStandalone(`
      export function agree(): number {
        const f: any = Object.is;
        const xs: number[] = [0, -0, 1, -1, 4.5, 1 / 0, -1 / 0, 0 / 0];
        for (let i = 0; i < xs.length; i++) {
          for (let j = 0; j < xs.length; j++) {
            const a = xs[i]!;
            const b = xs[j]!;
            if ((f(a, b) ? 1 : 0) !== (Object.is(a, b) ? 1 : 0)) return 0;
          }
        }
        return 1;
      }
    `);
    expect(exports.agree!()).toBe(1);
  });

  it("keeps value identity singleton-stable and exposes .name", async () => {
    const exports = await runStandalone(`
      export function ident(): number { const a: any = Object.is; const b: any = Object.is; return a === b ? 1 : 0; }
      export function name(): number { const f: any = Object.is; return f.name === "is" ? 1 : 0; }
    `);
    expect(exports.ident!()).toBe(1);
    expect(exports.name!()).toBe(1);
  });

  it("does not regress the direct Object.is scalar fast paths", async () => {
    const exports = await runStandalone(`
      export function nums(): number { const a: any = 0 / 0; return Object.is(a, a) ? 1 : 0; }
      export function signedZero(): number { const a: any = 0; const b: any = -0; return Object.is(a, b) ? 1 : 0; }
    `);
    expect(exports.nums!()).toBe(1); // Object.is(NaN, NaN)
    expect(exports.signedZero!()).toBe(0); // Object.is(+0, -0)
  });
});
