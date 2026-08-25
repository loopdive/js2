// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 S5.2 — dynamic-value strict/loose equality lowering.
//
// S5.0 (PR #2682) landed the builder emit vocabulary (emitBox/emitUnbox/
// emitTagTest). S5.1 (PR #2690) added `dyn.truthy`. S5.2 adds `dyn.eq`:
// `===`/`!==`/`==`/`!=` between two boxed-any carriers via a new
// `emitDynEq` builder method + `IrInstrDynEq` node, lowered through the new
// `IrDynamicLowering.emitEqOperand` / `emitStrictEq` / `emitLooseEq` handle
// arms, which ROUTE to the canonical `__any_strict_eq` / `__any_eq` helpers —
// one equality engine, byte-parity with legacy's `compileAnyBinaryDispatch`
// (June-audit D4). The tag-5 field-4 classifier (cross-type falsity,
// numeric-class `23 === 23.0`, `NaN === NaN → false` via the helper's
// `f64.eq`, reference identity) stays in the helper body, NEVER
// re-implemented. Payload-less `dyn === null` / `dyn === undefined` STRICT
// cases lower via the cheaper exact `tag.test{Null|Undefined}` primitive.
//
// This slice is byte-inert by construction — the selector's move-only gate
// still rejects a dynamic-eq body, so from-ast never builds `dyn.eq` in a
// CLAIMED function (proven separately by prove-emit-identity, 39/39
// IDENTICAL). These tests exercise the mechanism DIRECTLY: node shape +
// result type, the construction-time operand guard, the handle→helper D4
// routing, and — per the slice-3 standard — RUNTIME execution of hand-built
// IR lowered against the PRODUCTION handle over a real CodegenContext, in
// BOTH the gc (fast) and host strategies, asserting SameValue / `===`
// semantics incl. cross-type falsity, numeric-class, NaN, null/undefined.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ensureAnyHelpers } from "../src/codegen/any-helpers.js";
// Side-effect import: registers the `flushLateImportShifts` codegen delegate
// that `addUnionImports` requires (same pattern as the S5.0 / S5.1 tests).
import "../src/codegen/expressions.js";
import { addUnionImports, createCodegenContext } from "../src/codegen/index.js";
import { ensureLateImport } from "../src/codegen/shared.js";
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
  type IrFunction,
  type IrLowerResolver,
  type IrType,
} from "../src/ir/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { FuncTypeDef } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-2949-s5-2-eq");
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const DYN: IrType = irDynamic();

// ---------------------------------------------------------------------------
// Harness — real context, production handle, production encoder (S5.1 style)
// ---------------------------------------------------------------------------

function makeGcCtx(): CodegenContext {
  const ctx = createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker, {
    fast: true,
    nativeStrings: false,
  });
  ensureAnyHelpers(ctx); // what preregisterDynamicSupport does for gc
  return ctx;
}

function makeHostCtx(): CodegenContext {
  const ctx = createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker, {});
  // What preregisterDynamicSupport does for a host module carrying a dyn.eq:
  // the classifier/box imports PLUS the host equality imports (__host_eq / the
  // JS `===`, __host_loose_eq / the JS `==`) — the SAME imports legacy host
  // `any === any` uses.
  addUnionImports(ctx);
  ensureLateImport(ctx, "__host_eq", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__host_loose_eq", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
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

// Realistic host import stubs — the equality helpers reach the classifier /
// host-eq family, so these must MEAN what the real runtime means (a `() => 0`
// fallback would silently answer every equality `false`).
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
      case "__host_eq":
        return (a: unknown, b: unknown) => (a === b ? 1 : 0);
      case "__host_loose_eq":
        // biome-ignore lint/suspicious/noDoubleEquals: modelling JS `==` deliberately.
        return (a: unknown, b: unknown) => (a == b ? 1 : 0);
      case "__extern_is_undefined":
        return (v: unknown) => (v === undefined ? 1 : 0);
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
// IR builders — hand-built dyn.eq functions
// ---------------------------------------------------------------------------

/** `eqNum(a,b: f64): i32` — box both f64 params, strict/loose eq. */
function eqNum(name: string, opts: { loose: boolean; negate: boolean }): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const a = b.addParam("a", F64);
  const c = b.addParam("c", F64);
  b.openBlock();
  const da = b.emitBox(a, irDynamic(JS_TAG_IDS.NumberF64));
  const dc = b.emitBox(c, irDynamic(JS_TAG_IDS.NumberF64));
  const r = b.emitDynEq(da, dc, opts);
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

/**
 * `eqI32F64(a: i32, b: f64): i32` — box an i32 (as an unrefined NUMBER, tag-2)
 * and an f64 (tag-3), strict-eq: exercises the numeric-CLASS arm (`5 === 5.0`).
 */
function eqI32F64(name: string): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const a = b.addParam("a", I32);
  const c = b.addParam("c", F64);
  b.openBlock();
  const da = b.emitBox(a, DYN); // unrefined i32 → NUMBER box
  const dc = b.emitBox(c, irDynamic(JS_TAG_IDS.NumberF64));
  const r = b.emitDynEq(da, dc, { loose: false, negate: false });
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

/** `eqNumBool(a: f64, b: i32): i32` — number vs Boolean-refined i32, strict. */
function eqNumBool(name: string): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const a = b.addParam("a", F64);
  const c = b.addParam("c", I32);
  b.openBlock();
  const da = b.emitBox(a, irDynamic(JS_TAG_IDS.NumberF64));
  const dc = b.emitBox(c, irDynamic(JS_TAG_IDS.Boolean));
  const r = b.emitDynEq(da, dc, { loose: false, negate: false });
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

/** `eqDyn(a,b: dynamic): i32` — both params ARE carriers (host: externref). */
function eqDyn(name: string, opts: { loose: boolean; negate: boolean }): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const a = b.addParam("a", DYN);
  const c = b.addParam("c", DYN);
  b.openBlock();
  const r = b.emitDynEq(a, c, opts);
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

/** `isTag(x: dynamic): i32` — the strict null/undefined FAST-PATH primitive. */
function isTag(name: string, tag: JsTag): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const x = b.addParam("x", DYN);
  b.openBlock();
  const r = b.emitTagTest(x, tag);
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

// ---------------------------------------------------------------------------
// Node shape + result type + construction-time operand guard
// ---------------------------------------------------------------------------

describe("#2949 S5.2 — emitDynEq emits a verifier-clean i32 dyn.eq node", () => {
  it("appends a dyn.eq node with i32 result, loose/negate flags, and registers typeOf", () => {
    const b = new IrFunctionBuilder(identities.next("eq1"), [I32], true);
    const x = b.addParam("x", DYN);
    const y = b.addParam("y", DYN);
    b.openBlock();
    const r = b.emitDynEq(x, y, { loose: true, negate: true });
    expect(b.typeOf(r)).toEqual(I32);
    b.terminate({ kind: "return", values: [r] });
    const fn = b.finish();
    const [node] = fn.blocks[0].instrs;
    expect(node).toMatchObject({
      kind: "dyn.eq",
      lhs: x,
      rhs: y,
      loose: true,
      negate: true,
      result: r,
      resultType: I32,
    });
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("rejects a non-dynamic operand at construction (carrier equality only)", () => {
    const b = new IrFunctionBuilder(identities.next("eqBad"), [I32], true);
    const x = b.addParam("x", DYN);
    const c = b.addParam("c", F64);
    b.openBlock();
    expect(() => b.emitDynEq(x, c, { loose: false, negate: false })).toThrow(/rhs operand .* is not dynamic/);
    expect(() => b.emitDynEq(c, x, { loose: false, negate: false })).toThrow(/lhs operand .* is not dynamic/);
  });

  it("a dyn.eq fed a concrete operand fails the verifier (defense in depth)", () => {
    const b = new IrFunctionBuilder(identities.next("eqVerify"), [I32], true);
    const x = b.addParam("x", DYN);
    const c = b.addParam("c", I32);
    b.openBlock();
    b.terminate({ kind: "return", values: [c] });
    const fn = b.finish();
    const bad: IrFunction = {
      ...fn,
      blocks: [
        {
          ...fn.blocks[0],
          instrs: [
            { kind: "dyn.eq", lhs: x, rhs: c, loose: false, negate: false, result: 999, resultType: I32 } as never,
          ],
        },
      ],
    };
    const errs = verifyIrFunction(bad);
    expect(errs.some((e) => /dyn\.eq operand must be a dynamic/.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handle → helper routing (D4): one equality engine, both strategies
// ---------------------------------------------------------------------------

describe("#2949 S5.2 — IrDynamicLowering equality arms route to the canonical helpers", () => {
  it("gc: emitEqOperand is identity; emitStrictEq/emitLooseEq call the __any_*_eq helpers (+eqz on negate)", () => {
    const ctx = makeGcCtx();
    const dyn = makeDynamicLowering(ctx);
    expect(dyn).not.toBeNull();
    expect(dyn!.emitEqOperand()).toEqual([]); // gc carrier IS $AnyValue
    const strictIdx = ctx.funcMap.get("__any_strict_eq");
    const looseIdx = ctx.funcMap.get("__any_eq");
    expect(strictIdx).toBeDefined();
    expect(looseIdx).toBeDefined();
    expect(dyn!.emitStrictEq(false)).toEqual([{ op: "call", funcIdx: strictIdx }]);
    expect(dyn!.emitStrictEq(true)).toEqual([{ op: "call", funcIdx: strictIdx }, { op: "i32.eqz" }]);
    expect(dyn!.emitLooseEq(false)).toEqual([{ op: "call", funcIdx: looseIdx }]);
    expect(dyn!.emitLooseEq(true)).toEqual([{ op: "call", funcIdx: looseIdx }, { op: "i32.eqz" }]);
  });

  it("host: emitEqOperand is identity; strict/loose call the host equality imports (__host_eq/__host_loose_eq)", () => {
    const ctx = makeHostCtx();
    const dyn = makeDynamicLowering(ctx);
    expect(dyn).not.toBeNull();
    // The host carrier (externref) IS the __host_eq operand shape → no marshalling.
    expect(dyn!.emitEqOperand()).toEqual([]);
    const strictIdx = ctx.funcMap.get("__host_eq");
    const looseIdx = ctx.funcMap.get("__host_loose_eq");
    expect(strictIdx).toBeDefined();
    expect(looseIdx).toBeDefined();
    expect(dyn!.emitStrictEq(false)).toEqual([{ op: "call", funcIdx: strictIdx }]);
    expect(dyn!.emitStrictEq(true)).toEqual([{ op: "call", funcIdx: strictIdx }, { op: "i32.eqz" }]);
    expect(dyn!.emitLooseEq(false)).toEqual([{ op: "call", funcIdx: looseIdx }]);
    expect(dyn!.emitLooseEq(true)).toEqual([{ op: "call", funcIdx: looseIdx }, { op: "i32.eqz" }]);
  });
});

// ---------------------------------------------------------------------------
// gc runtime — dyn.eq over the $AnyValue carrier (number / boolean partitions)
// ---------------------------------------------------------------------------

describe("#2949 S5.2 — gc runtime: dyn.eq over the $AnyValue carrier", () => {
  it("strict/loose number equality incl. NaN (spec-correct: NaN === NaN → 0) and ±0", async () => {
    const fns = [
      eqNum("eqN", { loose: false, negate: false }),
      eqNum("neN", { loose: false, negate: true }),
      eqNum("looseN", { loose: true, negate: false }),
      eqI32F64("eqIF"),
      eqNumBool("eqNB"),
    ];
    for (const f of fns) expect(verifyIrFunction(f)).toEqual([]);
    const ctx = makeGcCtx();
    install(ctx, fns);
    const ex = await instantiateCtx(ctx);
    // strict === : the helper's number arm is `f64.eq`, so NaN === NaN → 0
    // (spec-correct, UNLIKE S5.1's inherited truthiness NaN quirk).
    expect(ex.eqN(5, 5)).toBe(1);
    expect(ex.eqN(5, 6)).toBe(0);
    expect(ex.eqN(NaN, NaN)).toBe(0);
    expect(ex.eqN(0, -0)).toBe(1); // f64.eq(+0,-0) === true, matching JS `0 === -0`
    // strict !== negation
    expect(ex.neN(5, 6)).toBe(1);
    expect(ex.neN(5, 5)).toBe(0);
    expect(ex.neN(NaN, NaN)).toBe(1);
    // loose == over two numbers is the same as ===
    expect(ex.looseN(5, 5)).toBe(1);
    expect(ex.looseN(5, 6)).toBe(0);
    // numeric CLASS: a tag-2 i32 box === a tag-3 f64 box when numerically equal
    expect(ex.eqIF(5, 5)).toBe(1);
    expect(ex.eqIF(5, 6)).toBe(0);
    // cross-type strict: a boxed number (tag-3) vs a boxed boolean (tag-4) →
    // different tags → always false (no coercion under `===`).
    expect(ex.eqNB(1, 1)).toBe(0);
    expect(ex.eqNB(0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// host runtime — dyn.eq over the externref carrier (full spectrum)
// ---------------------------------------------------------------------------

describe("#2949 S5.2 — host runtime: dyn.eq over the externref carrier", () => {
  it("strict/loose equality across number/string/bool/null/undefined incl. cross-type + NaN", async () => {
    const fns = [
      eqDyn("eqD", { loose: false, negate: false }),
      eqDyn("neD", { loose: false, negate: true }),
      eqDyn("looseD", { loose: true, negate: false }),
      isTag("isNull", JsTag.Null),
      isTag("isUndef", JsTag.Undefined),
    ];
    for (const f of fns) expect(verifyIrFunction(f)).toEqual([]);
    const ctx = makeHostCtx();
    install(ctx, fns);
    const ex = await instantiateCtx(ctx, hostEnvFor(ctx));

    // STRICT === : same-type equal, same-type unequal, cross-type false, NaN.
    expect(ex.eqD(5, 5)).toBe(1);
    expect(ex.eqD(5, 6)).toBe(0);
    expect(ex.eqD("a", "a")).toBe(1);
    expect(ex.eqD("a", "b")).toBe(0);
    expect(ex.eqD("5", 5)).toBe(0); // cross-type: string vs number
    expect(ex.eqD(true, true)).toBe(1);
    expect(ex.eqD(true, 1)).toBe(0); // cross-type: boolean vs number
    expect(ex.eqD(NaN, NaN)).toBe(0);
    expect(ex.eqD(null, null)).toBe(1);
    expect(ex.eqD(undefined, undefined)).toBe(1);
    expect(ex.eqD(null, undefined)).toBe(0); // strict: distinct partitions

    // STRICT !== negation.
    expect(ex.neD(5, 6)).toBe(1);
    expect(ex.neD(5, 5)).toBe(0);
    expect(ex.neD(null, undefined)).toBe(1);

    // LOOSE == : §7.2.15 coercions, owned by `__host_loose_eq` (JS `==`) — the
    // SAME import legacy host `any == any` uses, so these are spec-correct AND
    // byte-parity with legacy (verified: routing host loose through the
    // standalone `__any_eq` instead would DROP these coercions to `false`).
    expect(ex.looseD(1, 1)).toBe(1);
    expect(ex.looseD("5", 5)).toBe(1); // string == number coercion
    expect(ex.looseD(null, undefined)).toBe(1); // null == undefined
    expect(ex.looseD(0, false)).toBe(1); // number == boolean coercion

    // Null/undefined STRICT FAST-PATH primitive (what from-ast's dyn===null /
    // dyn===undefined arm emits): an exact partition tag test.
    expect(ex.isNull(null)).toBe(1);
    expect(ex.isNull(undefined)).toBe(0);
    expect(ex.isNull(5)).toBe(0);
    expect(ex.isUndef(undefined)).toBe(1);
    expect(ex.isUndef(null)).toBe(0);
    expect(ex.isUndef(5)).toBe(0);
  });
});
