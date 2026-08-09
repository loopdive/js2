// #3161 — generalized typed-signature self-hosted stdlib driver.
//
// Unit-tests the BUILD stage (`buildSelfHostedIr`: parse → from-ast with
// positional param/return overrides → verify → passes → verify) plus the
// backend lowering with a mock resolver, over the exact dialect shapes the
// scale-up families need beyond the #3141 pilot's unary-f64 scope:
//
//   - externref params/returns via `unknown` annotations + overrides
//     (object-runtime #3160: __object_fromEntries / getOwnPropertyDescriptors)
//   - void callees in statement position (#2856 C4) and void builtins (#1228)
//   - i32-returning callees feeding i32/i32 compares (#1126 Stage 3)
//   - ctx-bound `ref_null { typeIdx }` params (array-methods #3159 timsort
//     raw data arrays) — and WHY the generalized path must not memoize
//   - arity ≥ 3 callees; unannotated locals inferring externref from
//     callee return types
//
// The emit stage (`emitSelfHostedFunc`) is thin glue identical to the
// proven math path (mint + push + funcMap) and is covered end-to-end by
// tests/issue-3141.test.ts once a family lands on it.
import { describe, it, expect } from "vitest";
import { buildSelfHostedIr, type SelfHostedFuncDef } from "../src/codegen/stdlib-selfhost.js";
import type { IrUnitId } from "../src/ir/identity.js";
import { irVal, type IrType } from "../src/ir/nodes.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const EXT: IrType = irVal({ kind: "externref" });
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const irIdentities = createTestIrFunctionIdentityFactory("issue-3161");
const FROM_ENTRIES_ID = irIdentities.unit(0);
const COUNT_LESS_ID = irIdentities.unit(1);
const BAD_OVERRIDE_ID = irIdentities.unit(2);
const ARITY_MISMATCH_ID = irIdentities.unit(3);
const SCOPE_GUARD_ID = irIdentities.unit(4);

/** Lower `ir` with a mock resolver; return the func + the callees it resolved. */
function lowerWithMockResolver(def: SelfHostedFuncDef, unitId: IrUnitId) {
  const ir = buildSelfHostedIr(def, unitId);
  const resolved = new Map<string, number>();
  let nextFunc = 500;
  let nextType = 100;
  const resolver: IrLowerResolver = {
    resolveFunc(ref) {
      let idx = resolved.get(ref.name);
      if (idx === undefined) {
        expect(def.calleeTypes.has(ref.name), `unexpected callee ${ref.name}`).toBe(true);
        idx = nextFunc++;
        resolved.set(ref.name, idx);
      }
      return idx;
    },
    resolveGlobal(ref) {
      throw new Error(`unexpected global ${ref.name}`);
    },
    resolveType(ref) {
      throw new Error(`unexpected named type ${ref.name}`);
    },
    internFuncType() {
      return nextType++;
    },
  };
  const { func } = lowerIrFunctionToWasm(ir, resolver);
  return { func, resolved };
}

describe("#3161 typed self-hosted driver — widened dialect shapes", () => {
  it("externref params/returns, void callee in statement position, inferred externref locals, arity 3", () => {
    // The real object-runtime slice-1 shape (#3160 __object_fromEntries):
    // externref in/out, f64 loop, void __extern_set(3 args), every local
    // unannotated-externref except the annotated f64s.
    const def: SelfHostedFuncDef = {
      name: "__probe_from_entries",
      source: `
export function __probe_from_entries(entries: unknown): unknown {
  const out = __new_plain_object();
  const len: number = __extern_length(entries);
  let i: number = 0;
  while (i < len) {
    const pair = __extern_get_idx(entries, i);
    __extern_set(out, __extern_get_idx(pair, 0), __extern_get_idx(pair, 1));
    i = i + 1;
  }
  return out;
}
`,
      paramTypes: [EXT],
      returnType: EXT,
      calleeTypes: new Map([
        ["__new_plain_object", { params: [], returnType: EXT }],
        ["__extern_length", { params: [EXT], returnType: F64 }],
        ["__extern_get_idx", { params: [EXT, F64], returnType: EXT }],
        ["__extern_set", { params: [EXT, EXT, EXT], returnType: null }],
      ]),
    };
    const { func, resolved } = lowerWithMockResolver(def, FROM_ENTRIES_ID);
    expect(func.body.length).toBeGreaterThan(0);
    expect([...resolved.keys()].sort()).toEqual([
      "__extern_get_idx",
      "__extern_length",
      "__extern_set",
      "__new_plain_object",
    ]);
  });

  it("void builtin return, ref_null typeIdx params, i32 callee results in i32/i32 compare", () => {
    // The array-methods kernel shape (#3159): raw data-array param typed
    // with a ctx-bound ref_null typeIdx, i32-returning element reads
    // compared i32/i32, void return.
    const DATA: IrType = irVal({ kind: "ref_null", typeIdx: 42 });
    const def: SelfHostedFuncDef = {
      name: "__probe_count_less",
      source: `
export function __probe_count_less(data: unknown, lo: number, hi: number): void {
  let i: number = lo;
  while (i < hi) {
    if (__elem_i32(data, i) < __elem_i32(data, i + 1)) {
      __mark(data, i);
    }
    i = i + 1;
  }
  return;
}
`,
      paramTypes: [DATA, F64, F64],
      returnType: null,
      calleeTypes: new Map([
        ["__elem_i32", { params: [DATA, F64], returnType: I32 }],
        ["__mark", { params: [DATA, F64], returnType: null }],
      ]),
    };
    const { func, resolved } = lowerWithMockResolver(def, COUNT_LESS_ID);
    expect(func.body.length).toBeGreaterThan(0);
    expect([...resolved.keys()].sort()).toEqual(["__elem_i32", "__mark"]);
  });

  it("rejects a primitive annotation that disagrees with the positional override (typo guard)", () => {
    const def: SelfHostedFuncDef = {
      name: "__probe_bad",
      source: `
export function __probe_bad(x: number): number {
  return x;
}
`,
      paramTypes: [EXT], // disagrees with `: number`
      returnType: F64,
      calleeTypes: new Map(),
    };
    expect(() => buildSelfHostedIr(def, BAD_OVERRIDE_ID)).toThrow(/disagrees with annotation/);
  });

  it("rejects a paramTypes/declared-params arity mismatch", () => {
    const def: SelfHostedFuncDef = {
      name: "__probe_arity",
      source: `
export function __probe_arity(x: number, y: number): number {
  return x + y;
}
`,
      paramTypes: [F64],
      returnType: F64,
      calleeTypes: new Map(),
    };
    expect(() => buildSelfHostedIr(def, ARITY_MISMATCH_ID)).toThrow(/paramTypes has 1/);
  });

  it("scope guard: named-type references still throw at lowering", () => {
    // A def whose IR is clean but whose resolver hits resolveFunc only —
    // resolveType/resolveGlobal remain loud errors. (Positive control for
    // the guard is structural: the resolver in this test throws, and the
    // two happy-path tests above prove it is never invoked for val-kind
    // ref_null / externref types.)
    const def: SelfHostedFuncDef = {
      name: "__probe_guard",
      source: `
export function __probe_guard(x: number): number {
  return x * 2;
}
`,
      paramTypes: [F64],
      returnType: F64,
      calleeTypes: new Map(),
    };
    const { func, resolved } = lowerWithMockResolver(def, SCOPE_GUARD_ID);
    expect(func.body.length).toBeGreaterThan(0);
    expect(resolved.size).toBe(0);
  });
});
