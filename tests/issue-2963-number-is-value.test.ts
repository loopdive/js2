// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2963 Tier 2a — `Number.is{Integer,Finite,NaN,SafeInteger}` as first-class
 * VALUES under `--target standalone`.
 *
 * Before this change, extracting one of these predicates
 * (`const f: any = Number.isInteger`) reified a spec-shaped, identity-stable
 * closure whose BODY threw a catchable TypeError (#2984 Phase 3) — the value
 * existed for feature-detection / identity / reflection, but INVOKING it threw.
 * This wires the real body: the fixed 1-arg closure takes the boxed arg as
 * externref (the all-externref convention), applies the `__typeof_number` guard
 * (NO ToNumber — a non-Number arg is `false` per §21.1.2.x, and the settled
 * guard excludes the #2979 UNDEF_F64-sentinel box that carries `undefined`),
 * then `__unbox_number` → the SHARED `numberIsPredicateOps` f64 test — the SAME
 * ops the direct `Number.is*(n)` call emits, so the reified call is
 * observationally identical to the direct call.
 *
 * Host mode is untouched: this path lives in
 * `ensureStandaloneBuiltinStaticMethodClosure` (standalone-only) and the shared
 * predicate-ops refactor of the direct call path is byte-identical (proven over
 * the 56-entry emit-identity corpus). NB `.length` reflective reads on a reified
 * builtin value return 0 in standalone for EVERY wired static today (Math.max,
 * Array.isArray, Reflect.get included) — a pre-existing reflective-length gap
 * orthogonal to this tier; `.name` and identity are correct.
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

describe("#2963 Tier 2a — Number.is* value reads (standalone)", () => {
  it("invokes an extracted Number.isInteger with spec results", async () => {
    const exports = await runStandalone(`
      export function integer(): number { const f: any = Number.isInteger; return f(4) ? 1 : 0; }
      export function nonInteger(): number { const f: any = Number.isInteger; return f(4.5) ? 1 : 0; }
      export function negZero(): number { const f: any = Number.isInteger; return f(-0) ? 1 : 0; }
      export function infinite(): number { const f: any = Number.isInteger; return f(1 / 0) ? 1 : 0; }
    `);
    expect(exports.integer!()).toBe(1);
    expect(exports.nonInteger!()).toBe(0);
    expect(exports.negZero!()).toBe(1); // -0 is an integer
    expect(exports.infinite!()).toBe(0); // Infinity is not an integer
  });

  it("invokes an extracted Number.isNaN / isFinite", async () => {
    const exports = await runStandalone(`
      export function nan(): number { const g: any = Number.isNaN; return g(0 / 0) ? 1 : 0; }
      export function notNan(): number { const g: any = Number.isNaN; return g(3) ? 1 : 0; }
      export function finite(): number { const h: any = Number.isFinite; return h(3) ? 1 : 0; }
      export function notFinite(): number { const h: any = Number.isFinite; return h(1 / 0) ? 1 : 0; }
    `);
    expect(exports.nan!()).toBe(1);
    expect(exports.notNan!()).toBe(0);
    expect(exports.finite!()).toBe(1);
    expect(exports.notFinite!()).toBe(0);
  });

  it("invokes an extracted Number.isSafeInteger at the 2^53-1 boundary", async () => {
    const exports = await runStandalone(`
      export function atMax(): number { const s: any = Number.isSafeInteger; return s(9007199254740991) ? 1 : 0; }
      export function overMax(): number { const s: any = Number.isSafeInteger; return s(9007199254740992) ? 1 : 0; }
    `);
    expect(exports.atMax!()).toBe(1); // 2^53 - 1 = MAX_SAFE_INTEGER
    expect(exports.overMax!()).toBe(0); // 2^53 is not safe
  });

  it("does NOT coerce its argument — a non-Number is false (§21.1.2.x)", async () => {
    const exports = await runStandalone(`
      export function str(): number { const f: any = Number.isInteger; return f("4") ? 1 : 0; }
      export function undef(): number { const f: any = Number.isNaN; return f(undefined) ? 1 : 0; }
      export function nul(): number { const f: any = Number.isFinite; return f(null) ? 1 : 0; }
      export function bool(): number { const f: any = Number.isInteger; return f(true) ? 1 : 0; }
    `);
    expect(exports.str!()).toBe(0); // "4" is a String, not a Number → false (no ToNumber)
    expect(exports.undef!()).toBe(0); // undefined is not NaN (the UNDEF_F64 sentinel is excluded)
    expect(exports.nul!()).toBe(0); // null is not a Number → false
    expect(exports.bool!()).toBe(0); // true is a Boolean, not a Number → false
  });

  it("is observationally identical to the direct call over a fixed input set", async () => {
    // The reified closure and the direct `Number.is*(n)` lowering share the SAME
    // `numberIsPredicateOps` body, so every (method, input) pair must agree. Fold
    // the agreement into one i32 (avoids array methods, which pull host runtime
    // imports the empty-import standalone harness doesn't provide).
    const exports = await runStandalone(`
      export function agree(): number {
        const fi: any = Number.isInteger;
        const fn: any = Number.isNaN;
        const ff: any = Number.isFinite;
        const inputs: number[] = [0, -0, 4, 4.5, -7, 1 / 0, -1 / 0, 0 / 0, 9007199254740992];
        for (let i = 0; i < inputs.length; i++) {
          const x = inputs[i]!;
          if ((fi(x) ? 1 : 0) !== (Number.isInteger(x) ? 1 : 0)) return 0;
          if ((fn(x) ? 1 : 0) !== (Number.isNaN(x) ? 1 : 0)) return 0;
          if ((ff(x) ? 1 : 0) !== (Number.isFinite(x) ? 1 : 0)) return 0;
        }
        return 1;
      }
    `);
    expect(exports.agree!()).toBe(1);
  });

  it("keeps value identity singleton-stable and distinct per method", async () => {
    const exports = await runStandalone(`
      export function ident(): number {
        const a: any = Number.isNaN;
        const b: any = Number.isNaN;
        const c: any = Number.isInteger;
        return (a === b && a !== c) ? 1 : 0;
      }
    `);
    expect(exports.ident!()).toBe(1);
  });

  it("exposes the spec .name on a reified value (single-value module)", async () => {
    // NB `.name` reflective reads on reified builtin values have a PRE-EXISTING
    // multi-value dispatch collision on `main` — co-extracting two statics that
    // share a wrapper signature (e.g. Object.keys + Reflect.ownKeys, both
    // externref→externref) breaks the SECOND one's `.name`. That gap predates
    // and is orthogonal to this tier (verified on main); assert `.name` per
    // single-value module, where it is correct.
    for (const [method, want] of [
      ["isInteger", "isInteger"],
      ["isNaN", "isNaN"],
      ["isFinite", "isFinite"],
      ["isSafeInteger", "isSafeInteger"],
    ]) {
      const exports = await runStandalone(`
        export function test(): number { const f: any = Number.${method}; return f.name === "${want}" ? 1 : 0; }
      `);
      expect(exports.test!(), `Number.${method}.name`).toBe(1);
    }
  });

  it("does not regress the direct call forms", async () => {
    const exports = await runStandalone(`
      export function directIsInteger(): number { const x: any = 6; return Number.isInteger(x) ? 1 : 0; }
      export function directIsNaN(): number { const x: any = 0 / 0; return Number.isNaN(x) ? 1 : 0; }
    `);
    expect(exports.directIsInteger!()).toBe(1);
    expect(exports.directIsNaN!()).toBe(1);
  });
});
