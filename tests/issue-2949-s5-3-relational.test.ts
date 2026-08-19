// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 S5.3 — dynamic-value NUMERIC-ABSTRACT relational lowering.
//
// S5.0 (PR #2682) landed the builder emit vocabulary; S5.1 (PR #2690) added
// `dyn.truthy`; S5.2 (PR #2694) added `dyn.eq`. S5.3 adds `dyn.to_number`:
// `ToNumber(carrier) → f64`, the single-operand conversion the numeric-abstract
// relational lowering (`< > <= >=`) applies to a dynamic operand before the
// existing `f64.lt`/`gt`/`le`/`ge` compare — via a new `emitDynToNumber` builder
// method + `IrInstrDynToNumber` node, lowered through the new
// `IrDynamicLowering.emitToNumber` handle arm, which ROUTES to the canonical
// per-backend ToNumber (gc: `__any_to_f64`, the SAME boxed-any→f64 helper legacy
// `__any_lt` uses; host: `__unbox_number` = `Number(v)`) — one ToNumber engine
// (June-audit D4).
//
// SCOPE — numeric-abstract only. Legacy `any < any` is a FULL Abstract
// Relational Comparison (§7.2.11) mode-split three ways (host `__host_compare`,
// standalone runtime both-strings-else-numeric branch, fast numeric-hint); this
// slice implements ONLY the numeric arm. String×string lexicographic relational
// is DEFERRED: a boxed-string operand ToNumbers (host `Number("5")=5`, gc
// `__any_to_f64` reads the box's f64 slot), which is spec-correct only against a
// numeric counter-operand — hence the S5.P scan admits a dynamic relational
// operand only against a numeric literal.
//
// Byte-inert by construction: the move-only selector gate still rejects a
// dynamic-relational body, so from-ast never builds `dyn.to_number` in a CLAIMED
// function (proven separately by prove-emit-identity, 39/39 IDENTICAL). These
// tests exercise the mechanism DIRECTLY: node shape + result type, the
// construction-time + verifier operand guards, the handle→helper D4 routing, and
// — per the slice-3 standard — RUNTIME execution of hand-built IR lowered against
// the PRODUCTION handle over a real CodegenContext, in BOTH the gc (fast) and
// host strategies, asserting numeric relational semantics incl. bool→0/1,
// null→0, undefined→NaN→false, and NaN → false.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ensureAnyHelpers } from "../src/codegen/any-helpers.js";
// Side-effect import: registers the `flushLateImportShifts` codegen delegate
// that `addUnionImports` requires (same pattern as the S5.0–S5.2 tests).
import "../src/codegen/expressions.js";
import { addUnionImports, createCodegenContext } from "../src/codegen/index.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { JsTag } from "../src/ir/js-tag.js";
// #3954 phase 1 — `IrType`'s dynamic leaf carries an opaque TagId, so a
// refinement is named through the JS tag domain, not the enum.
import { JS_TAG_IDS } from "../src/ir/js-tag-domain.js";
import { emitBinary } from "../src/emit/binary.js";
import { repairStructTypeMismatches } from "../src/codegen/fixups.js";
import { peepholeOptimize } from "../src/codegen/peephole.js";
import { stackBalance } from "../src/codegen/stack-balance.js";
import {
  IrFunctionBuilder,
  irDynamic,
  irVal,
  lowerIrFunctionToWasm,
  makeDynamicLowering,
  verifyIrFunction,
  type IrBinop,
  type IrFunction,
  type IrLowerResolver,
  type IrType,
} from "../src/ir/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { FuncTypeDef } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-2949-s5-3-relational");
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const DYN: IrType = irDynamic();

// ---------------------------------------------------------------------------
// Harness — real context, production handle, production encoder (S5.2 style)
// ---------------------------------------------------------------------------

function makeGcCtx(): CodegenContext {
  const ctx = createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker, {
    fast: true,
    nativeStrings: false,
  });
  ensureAnyHelpers(ctx); // what preregisterDynamicSupport does for gc (registers __any_to_f64)
  return ctx;
}

function makeHostCtx(): CodegenContext {
  const ctx = createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker, {});
  // What preregisterDynamicSupport does for a host module carrying dyn.to_number:
  // the classifier/box/__unbox_number import family (dyn.to_number needs NO extra
  // host-eq imports — its host ToNumber is `__unbox_number`, already in the union
  // family, unlike S5.2's __host_eq).
  addUnionImports(ctx);
  return ctx;
}

function resolverFor(ctx: CodegenContext): IrLowerResolver {
  const dyn = makeDynamicLowering(ctx);
  return {
    resolveFunc: (ref) => {
      const idx = ctx.funcMap.get(ref.name);
      if (idx === undefined) throw new Error(`test resolver: unknown func ${ref.name}`);
      return idx;
    },
    resolveGlobal: () => {
      throw new Error("test resolver: no globals");
    },
    resolveType: () => {
      throw new Error("test resolver: no type refs");
    },
    internFuncType: (t: FuncTypeDef) => addFuncType(ctx, t.params, t.results, t.name),
    resolveDynamic: () => (dyn ? dyn.carrier : { kind: "externref" }),
    resolveDynamicLowering: () => dyn,
  };
}

function install(ctx: CodegenContext, fns: IrFunction[]): void {
  const resolver = resolverFor(ctx);
  for (const f of fns) {
    const { func } = lowerIrFunctionToWasm(f, resolver);
    const handle = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, handle, func);
    ctx.mod.exports.push({ name: f.name, desc: { kind: "func", index: handle } });
  }
}

async function instantiateCtx(
  ctx: CodegenContext,
  env: Record<string, unknown> = {},
): Promise<Record<string, (...args: unknown[]) => unknown>> {
  repairStructTypeMismatches(ctx.mod);
  peepholeOptimize(ctx.mod);
  stackBalance(ctx.mod);
  const binary = emitBinary(ctx.mod);
  const jsString: Record<string, unknown> = {
    concat: (a: string, b: string) => `${a}${b}`,
    length: (s: string) => s.length,
    equals: (a: unknown, b: unknown) => (a === b ? 1 : 0),
    substring: (s: string, a: number, b: number) => s.substring(a, b),
    charCodeAt: (s: string, i: number) => s.charCodeAt(i),
    fromCharCode: (c: number) => String.fromCharCode(c),
  };
  const { instance } = await WebAssembly.instantiate(binary as BufferSource, {
    env,
    "wasm:js-string": jsString,
  });
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

// Realistic host import stubs — dyn.to_number reaches `__unbox_number`, which
// MUST mean `Number(v)` (a `() => 0` fallback would silently answer 0 for
// everything and hide the ToNumber semantics under test).
function hostEnvFor(ctx: CodegenContext): Record<string, unknown> {
  const stub = (name: string): unknown => {
    if (name.startsWith("__typeof_")) {
      const t = name.slice("__typeof_".length);
      // biome-ignore lint/suspicious/useValidTypeof: t derives from the import name.
      return (v: unknown) => (typeof v === t ? 1 : 0);
    }
    switch (name) {
      case "__box_number":
        return (v: number) => v;
      case "__box_boolean":
        return (v: number) => Boolean(v);
      case "__unbox_number":
        return (v: unknown) => Number(v);
      case "__unbox_boolean":
        return (v: unknown) => (v ? 1 : 0);
      case "__is_truthy":
        return (v: unknown) => (v ? 1 : 0);
      default:
        return () => 0;
    }
  };
  const env: Record<string, unknown> = {};
  for (const imp of ctx.mod.imports) {
    if (imp.module === "env" && imp.desc.kind === "func") env[imp.name] = stub(imp.name);
  }
  return env;
}

// ---------------------------------------------------------------------------
// IR builders — hand-built dyn.to_number relational functions
// ---------------------------------------------------------------------------

const RELOP: Record<string, IrBinop> = {
  "<": "f64.lt",
  "<=": "f64.le",
  ">": "f64.gt",
  ">=": "f64.ge",
};

/**
 * gc: `f(a: f64, b: f64): i32` — box `a` as a NumberF64 carrier, ToNumber it,
 * compare against the CONCRETE f64 `b`. Exercises `dyn(number) <rel> concrete`.
 */
function gcRelBoxNum(name: string, op: keyof typeof RELOP): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const a = b.addParam("a", F64);
  const c = b.addParam("c", F64);
  b.openBlock();
  const da = b.emitBox(a, irDynamic(JS_TAG_IDS.NumberF64));
  const na = b.emitDynToNumber(da);
  const r = b.emitBinary(RELOP[op], na, c, I32);
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

/**
 * gc: `f(a: i32, b: f64): i32` — box `a` as a Boolean (tag-4) carrier, ToNumber
 * it (`true`→1 / `false`→0), compare against concrete `b`. Exercises the
 * boolean-partition ToNumber arm.
 */
function gcRelBoxBool(name: string, op: keyof typeof RELOP): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const a = b.addParam("a", I32);
  const c = b.addParam("c", F64);
  b.openBlock();
  const da = b.emitBox(a, irDynamic(JS_TAG_IDS.Boolean));
  const na = b.emitDynToNumber(da);
  const r = b.emitBinary(RELOP[op], na, c, I32);
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

/**
 * gc: `f(a: f64, b: f64): i32` — box BOTH as NumberF64 carriers, ToNumber both,
 * compare. Exercises `dyn <rel> dyn` (both carriers).
 */
function gcRelDynDyn(name: string, op: keyof typeof RELOP): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const a = b.addParam("a", F64);
  const c = b.addParam("c", F64);
  b.openBlock();
  const da = b.emitBox(a, irDynamic(JS_TAG_IDS.NumberF64));
  const dc = b.emitBox(c, irDynamic(JS_TAG_IDS.NumberF64));
  const na = b.emitDynToNumber(da);
  const nc = b.emitDynToNumber(dc);
  const r = b.emitBinary(RELOP[op], na, nc, I32);
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

/**
 * host: `f(a: dynamic, b: f64): i32` — ToNumber the dynamic `a`, compare against
 * concrete f64 `b`. `a` is an externref (a real JS value passed from the test).
 * Exercises `dyn(<any JS value>) <rel> numericLiteral`.
 */
function hostRelDynConc(name: string, op: keyof typeof RELOP): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const a = b.addParam("a", DYN);
  const c = b.addParam("c", F64);
  b.openBlock();
  const na = b.emitDynToNumber(a);
  const r = b.emitBinary(RELOP[op], na, c, I32);
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

/** host: `f(a: dynamic, b: dynamic): i32` — ToNumber BOTH, compare. */
function hostRelDynDyn(name: string, op: keyof typeof RELOP): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const a = b.addParam("a", DYN);
  const c = b.addParam("c", DYN);
  b.openBlock();
  const na = b.emitDynToNumber(a);
  const nc = b.emitDynToNumber(c);
  const r = b.emitBinary(RELOP[op], na, nc, I32);
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

// ---------------------------------------------------------------------------
// Node shape + result type + construction-time operand guard
// ---------------------------------------------------------------------------

describe("#2949 S5.3 — emitDynToNumber emits a verifier-clean f64 dyn.to_number node", () => {
  it("appends a dyn.to_number node with f64 result and registers typeOf", () => {
    const b = new IrFunctionBuilder(identities.next("tn1"), [F64], true);
    const x = b.addParam("x", DYN);
    b.openBlock();
    const r = b.emitDynToNumber(x);
    expect(b.typeOf(r)).toEqual(F64);
    b.terminate({ kind: "return", values: [r] });
    const fn = b.finish();
    const [node] = fn.blocks[0].instrs;
    expect(node).toMatchObject({ kind: "dyn.to_number", value: x, result: r, resultType: F64 });
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("rejects a non-dynamic operand at construction (carrier ToNumber only)", () => {
    const b = new IrFunctionBuilder(identities.next("tnBad"), [F64], true);
    const c = b.addParam("c", F64);
    b.openBlock();
    expect(() => b.emitDynToNumber(c)).toThrow(/operand .* is not dynamic/);
  });

  it("a dyn.to_number fed a concrete operand fails the verifier (defense in depth)", () => {
    const b = new IrFunctionBuilder(identities.next("tnVerify"), [F64], true);
    const c = b.addParam("c", F64);
    b.openBlock();
    b.terminate({ kind: "return", values: [c] });
    const fn = b.finish();
    const bad: IrFunction = {
      ...fn,
      blocks: [
        {
          ...fn.blocks[0],
          instrs: [{ kind: "dyn.to_number", value: c, result: 999, resultType: F64 } as never],
        },
      ],
    };
    const errs = verifyIrFunction(bad);
    expect(errs.some((e) => /dyn\.to_number operand must be a dynamic/.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handle → helper routing (D4): one ToNumber engine, both strategies
// ---------------------------------------------------------------------------

describe("#2949 S5.3 — IrDynamicLowering.emitToNumber routes to the canonical ToNumber helper", () => {
  it("gc: emitToNumber calls __any_to_f64 (the boxed-any→f64 helper legacy __any_lt uses)", () => {
    const ctx = makeGcCtx();
    const dyn = makeDynamicLowering(ctx);
    expect(dyn).not.toBeNull();
    const idx = ctx.funcMap.get("__any_to_f64");
    expect(idx).toBeDefined();
    expect(dyn!.emitToNumber()).toEqual([{ op: "call", funcIdx: idx }]);
  });

  it("host: emitToNumber calls __unbox_number (Number(v)) — the canonical host ToNumber", () => {
    const ctx = makeHostCtx();
    const dyn = makeDynamicLowering(ctx);
    expect(dyn).not.toBeNull();
    const idx = ctx.funcMap.get("__unbox_number");
    expect(idx).toBeDefined();
    expect(dyn!.emitToNumber()).toEqual([{ op: "call", funcIdx: idx }]);
  });
});

// ---------------------------------------------------------------------------
// gc runtime — dyn.to_number over the $AnyValue carrier (number/bool partitions)
// ---------------------------------------------------------------------------

describe("#2949 S5.3 — gc runtime: numeric-abstract relational over the $AnyValue carrier", () => {
  it("dyn(number) <rel> concrete, dyn<dyn, bool→0/1, NaN → false", async () => {
    const fns = [
      gcRelBoxNum("ltN", "<"),
      gcRelBoxNum("gtN", ">"),
      gcRelBoxNum("leN", "<="),
      gcRelBoxNum("geN", ">="),
      gcRelBoxBool("gtB", ">"),
      gcRelDynDyn("ltDD", "<"),
    ];
    for (const f of fns) expect(verifyIrFunction(f)).toEqual([]);
    const ctx = makeGcCtx();
    install(ctx, fns);
    const ex = await instantiateCtx(ctx);

    // dyn(number) vs concrete
    expect(ex.ltN(3, 5)).toBe(1);
    expect(ex.ltN(5, 3)).toBe(0);
    expect(ex.ltN(5, 5)).toBe(0);
    expect(ex.gtN(5, 3)).toBe(1);
    expect(ex.gtN(3, 5)).toBe(0);
    expect(ex.leN(5, 5)).toBe(1);
    expect(ex.leN(6, 5)).toBe(0);
    expect(ex.geN(5, 5)).toBe(1);
    expect(ex.geN(4, 5)).toBe(0);
    // fractional operands go through f64 compare (not an i32 truncation)
    expect(ex.ltN(1.5, 1.6)).toBe(1);
    expect(ex.ltN(1.6, 1.5)).toBe(0);
    // NaN comparisons are always false (spec §7.2.11)
    expect(ex.ltN(NaN, 5)).toBe(0);
    expect(ex.gtN(NaN, 5)).toBe(0);
    expect(ex.geN(NaN, 5)).toBe(0);

    // boolean partition: ToNumber(true)=1, ToNumber(false)=0
    expect(ex.gtB(1, 0.5)).toBe(1); // true(1) > 0.5
    expect(ex.gtB(0, 0.5)).toBe(0); // false(0) > 0.5

    // dyn < dyn (both boxed numbers)
    expect(ex.ltDD(3, 5)).toBe(1);
    expect(ex.ltDD(5, 3)).toBe(0);
    expect(ex.ltDD(NaN, 5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// host runtime — dyn.to_number over the externref carrier (full ToNumber spectrum)
// ---------------------------------------------------------------------------

describe("#2949 S5.3 — host runtime: numeric-abstract relational over the externref carrier", () => {
  it("dyn(JS value) <rel> numeric: number/bool/null(→0)/undefined(→NaN→false)/string(Number())", async () => {
    const fns = [
      hostRelDynConc("ltH", "<"),
      hostRelDynConc("gtH", ">"),
      hostRelDynConc("geH", ">="),
      hostRelDynDyn("ltHDD", "<"),
    ];
    for (const f of fns) expect(verifyIrFunction(f)).toEqual([]);
    const ctx = makeHostCtx();
    install(ctx, fns);
    const ex = await instantiateCtx(ctx, hostEnvFor(ctx));

    // number
    expect(ex.ltH(3, 5)).toBe(1);
    expect(ex.ltH(5, 3)).toBe(0);
    expect(ex.gtH(5, 3)).toBe(1);
    expect(ex.geH(5, 5)).toBe(1);
    // boolean → 0/1
    expect(ex.gtH(true, 0.5)).toBe(1); // Number(true)=1 > 0.5
    expect(ex.gtH(false, 0.5)).toBe(0); // Number(false)=0 > 0.5
    // null → 0 (ToNumber(null)=0)
    expect(ex.ltH(null, 5)).toBe(1); // 0 < 5
    expect(ex.gtH(null, 5)).toBe(0); // 0 > 5 → false
    // undefined → NaN → every relational false
    expect(ex.ltH(undefined, 5)).toBe(0);
    expect(ex.gtH(undefined, 5)).toBe(0);
    expect(ex.geH(undefined, 5)).toBe(0);
    // string ToNumbers via Number() (spec-correct against a numeric operand —
    // ARC does NOT take the both-strings lexicographic branch here)
    expect(ex.ltH("3", 5)).toBe(1); // Number("3")=3 < 5
    expect(ex.gtH("7", 5)).toBe(1); // Number("7")=7 > 5
    expect(ex.ltH("abc", 5)).toBe(0); // Number("abc")=NaN → false

    // dyn < dyn, both JS values
    expect(ex.ltHDD(3, 5)).toBe(1);
    expect(ex.ltHDD(5, 3)).toBe(0);
    expect(ex.ltHDD(undefined, 5)).toBe(0); // NaN → false
    expect(ex.ltHDD(null, 5)).toBe(1); // 0 < 5
  });
});
