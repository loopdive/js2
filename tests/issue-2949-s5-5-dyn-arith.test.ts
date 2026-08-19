// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 S5.5 — dynamic-value NUMERIC arithmetic lowering (mechanism, byte-inert).
//
// S5.3 (PR #2702) landed `dyn.to_number` (ToNumber(carrier) → f64, canonical
// `__any_to_f64` gc / `__unbox_number` host — D4). S5.5 adds the from-ast
// PRODUCER arms that consume it for the pure-ToNumber operators:
//
//   - binary `-` / `*` / `/` → ToNumber each dynamic operand, existing
//     `f64.sub`/`mul`/`div`;
//   - binary `%` → ToNumber operands, the shared exact-`__fmod` helper call
//     (#2945/#2056 — the SAME helper legacy `emitModulo` emits);
//   - unary `-` → ToNumber + `f64.neg` (§13.5.5); unary `+` → bare ToNumber
//     (§13.5.4 IS ToNumber); unary `!` → `dyn.truthy` (S5.1) + `i32.eqz`
//     (§13.5.7).
//
// These operators are spec-COMPLETE under ToNumber for every runtime operand
// partition (unlike relational, whose string×string lexicographic arm is
// deferred, and unlike `+`, which is concat dispatch and stays EXCLUDED — the
// Row-7 `proveAdditiveOperand` gate demotes it). This is the missing producer
// for the reduce-style `obj[idx-1]` bodies the #3053 U2 measurement flagged as
// its follow-up 2 — the `callbackfn` conjunction needs dynamic ARITHMETIC, not
// just member reads.
//
// NO new IR nodes, NO lowering/handle changes: the slice is from-ast wiring of
// the existing S5.1/S5.3 primitives. Byte-inert by construction: the move-only
// selector gate (`select.ts` `dynamicUsesAreMoveOnly`) still rejects a
// dynamic-arithmetic body, so no CLAIMED function reaches the new arms until
// S5.P opens the scan (proven separately by prove-emit-identity, 39/39
// IDENTICAL). These tests therefore drive `lowerFunctionAstToIr` DIRECTLY with
// `paramTypeOverrides: [dynamic]` — the exact contract the selector/override
// pipeline uses — and then execute the from-ast OUTPUT against the PRODUCTION
// `makeDynamicLowering` over a real CodegenContext in BOTH strategies.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ensureAnyHelpers } from "../src/codegen/any-helpers.js";
// Side-effect import: registers the `flushLateImportShifts` codegen delegate
// that `addUnionImports` requires (same pattern as the S5.0–S5.3 tests).
import "../src/codegen/expressions.js";
import { addUnionImports, createCodegenContext } from "../src/codegen/index.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { FMOD_FN, ensureFmod } from "../src/codegen/fmod.js";
import { JsTag } from "../src/ir/js-tag.js";
// #3954 phase 1 — `IrType`'s dynamic leaf carries an opaque TagId, so a
// refinement is named through the JS tag domain, not the enum.
import { JS_TAG_IDS } from "../src/ir/js-tag-domain.js";
import { analyzeSource } from "../src/checker/index.js";
import { emitBinary } from "../src/emit/binary.js";
import { repairStructTypeMismatches } from "../src/codegen/fixups.js";
import { peepholeOptimize } from "../src/codegen/peephole.js";
import { stackBalance } from "../src/codegen/stack-balance.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import {
  IrFunctionBuilder,
  irDynamic,
  irVal,
  lowerIrFunctionToWasm,
  makeDynamicLowering,
  verifyIrFunction,
  type IrFuncRef,
  type IrFunction,
  type IrLowerResolver,
  type IrType,
} from "../src/ir/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { FuncTypeDef } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-2949-s5-5-dyn-arith");
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const DYN: IrType = irDynamic();

// ---------------------------------------------------------------------------
// from-ast driver — the exact selector/override contract (paramTypeOverrides)
// ---------------------------------------------------------------------------

function irFromSource(src: string, paramTypes: readonly IrType[], returnType: IrType): IrFunction {
  const ast = analyzeSource(src);
  const fnDecl = ast.sourceFile.statements.find((s) => ts.isFunctionDeclaration(s)) as ts.FunctionDeclaration;
  return lowerFunctionAstToIr(fnDecl, {
    exported: true,
    ownerUnitId: identities.next(fnDecl.name!.text).unitId,
    paramTypeOverrides: paramTypes,
    returnTypeOverride: returnType,
  }).main;
}

function instrKinds(fn: IrFunction): string[] {
  return fn.blocks.flatMap((b) => b.instrs.map((i) => i.kind));
}

// ---------------------------------------------------------------------------
// Harness — real context, production handle, production encoder (S5.3 style)
// ---------------------------------------------------------------------------

function makeGcCtx(): CodegenContext {
  const ctx = createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker, {
    fast: true,
    nativeStrings: false,
  });
  ensureAnyHelpers(ctx); // what preregisterDynamicSupport does for gc (registers __any_to_f64)
  ensureFmod(ctx); // the `%` arm's shared exact-remainder helper (#2945)
  return ctx;
}

function makeHostCtx(): CodegenContext {
  const ctx = createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker, {});
  // What preregisterDynamicSupport does for a host module carrying
  // dyn.to_number / dyn.truthy: the classifier/box/__unbox_number/__is_truthy
  // import family (arithmetic needs no extra host imports beyond it).
  addUnionImports(ctx);
  ensureFmod(ctx);
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
    // Register by name so a later hand-built wrapper can `call` it (the gc
    // runtime tests box an f64 into the carrier and call the from-ast fn).
    ctx.funcMap.set(f.name, handle);
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

// Realistic host import stubs — `__unbox_number` MUST mean `Number(v)` and
// `__is_truthy` MUST mean JS truthiness (a `() => 0` fallback would silently
// answer 0 for everything and hide the semantics under test).
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
// from-ast producer arms — node shapes (the NEW code under test)
// ---------------------------------------------------------------------------

describe("#2949 S5.5 — from-ast lowers dynamic numeric arithmetic via dyn.to_number", () => {
  it("`x - 1` (dyn ⊖ concrete): ONE dyn.to_number + f64.sub, verifier-clean", () => {
    const fn = irFromSource(`export function dec(x) { return x - 1; }`, [DYN], F64);
    expect(verifyIrFunction(fn)).toEqual([]);
    const kinds = instrKinds(fn);
    expect(kinds.filter((k) => k === "dyn.to_number")).toHaveLength(1); // NOT the concrete literal
    const bin = fn.blocks.flatMap((b) => b.instrs).find((i) => i.kind === "binary");
    expect(bin).toMatchObject({ kind: "binary", op: "f64.sub" });
  });

  it("`x * y` / `x / y` (dyn ⊗ dyn): TWO dyn.to_number + the f64 op", () => {
    const mul = irFromSource(`export function mul(x, y) { return x * y; }`, [DYN, DYN], F64);
    expect(verifyIrFunction(mul)).toEqual([]);
    expect(instrKinds(mul).filter((k) => k === "dyn.to_number")).toHaveLength(2);
    expect(mul.blocks.flatMap((b) => b.instrs).find((i) => i.kind === "binary")).toMatchObject({ op: "f64.mul" });

    const div = irFromSource(`export function div(x, y) { return x / y; }`, [DYN, DYN], F64);
    expect(verifyIrFunction(div)).toEqual([]);
    expect(div.blocks.flatMap((b) => b.instrs).find((i) => i.kind === "binary")).toMatchObject({ op: "f64.div" });
  });

  it("`x % y` routes through the shared exact-__fmod helper (#2945), not a hand-rolled sequence", () => {
    const fn = irFromSource(`export function mod(x, y) { return x % y; }`, [DYN, DYN], F64);
    expect(verifyIrFunction(fn)).toEqual([]);
    expect(instrKinds(fn).filter((k) => k === "dyn.to_number")).toHaveLength(2);
    const call = fn.blocks.flatMap((b) => b.instrs).find((i) => i.kind === "call");
    expect(call).toMatchObject({ kind: "call", target: { kind: "func", name: FMOD_FN } });
  });

  it("unary `-x` is ToNumber + f64.neg; unary `+x` is a BARE dyn.to_number (§13.5.4 IS ToNumber)", () => {
    const neg = irFromSource(`export function neg(x) { return -x; }`, [DYN], F64);
    expect(verifyIrFunction(neg)).toEqual([]);
    expect(instrKinds(neg)).toContain("dyn.to_number");
    expect(neg.blocks.flatMap((b) => b.instrs).find((i) => i.kind === "unary")).toMatchObject({ op: "f64.neg" });

    const plus = irFromSource(`export function toNum(x) { return +x; }`, [DYN], F64);
    expect(verifyIrFunction(plus)).toEqual([]);
    const kinds = instrKinds(plus);
    expect(kinds).toContain("dyn.to_number");
    expect(kinds).not.toContain("unary"); // no negate, no extra op — ToNumber alone
  });

  it("unary `!x` is dyn.truthy (S5.1 ToBoolean) + i32.eqz — NOT a numeric coercion", () => {
    const fn = irFromSource(`export function notx(x) { return !x; }`, [DYN], I32);
    expect(verifyIrFunction(fn)).toEqual([]);
    const kinds = instrKinds(fn);
    expect(kinds).toContain("dyn.truthy");
    expect(kinds).not.toContain("dyn.to_number");
    expect(fn.blocks.flatMap((b) => b.instrs).find((i) => i.kind === "unary")).toMatchObject({ op: "i32.eqz" });
  });

  it("`+` stays EXCLUDED from the numeric arm (concat dispatch), and non-f64 concrete counter-operands demote", () => {
    // `x + 1` on a dynamic operand must NOT take a numeric fast path — JS `+`
    // is ToPrimitive + concat-or-add, so ToNumber-ing the operand is wrong.
    //
    // The MECHANISM changed under this test and the assertion moved with it.
    // It used to demote by throwing out of from-ast; the `+` guard in
    // `lowerBinary` is now conditioned on `!expressionProducesDynamic(...)`
    // for BOTH operands, so a dynamic operand skips the throw and lowers to a
    // call to the safe runtime helper instead. Same exclusion, expressed in IR
    // rather than by demoting — so assert the exclusion directly (no
    // `dyn.to_number`; the helper does the dispatch) rather than asserting the
    // old escape hatch.
    const addFn = irFromSource(`export function add(x) { return x + 1; }`, [DYN], F64);
    expect(instrKinds(addFn)).not.toContain("dyn.to_number");
    expect(addFn.blocks.flatMap((b) => b.instrs).find((i) => i.kind === "call")).toMatchObject({
      target: { name: "__ir_dyn_add" },
    });
    // A string counter-operand cannot feed the numeric arm (relOperandToF64
    // returns null) — the mixed string/dynamic pair demotes.
    expect(() => irFromSource(`export function subs(x) { return x - "a"; }`, [DYN], F64)).toThrow();
    // Bitwise ops are ToInt32 territory — not in this slice; demote.
    expect(() => irFromSource(`export function band(x) { return x & 1; }`, [DYN], F64)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// gc runtime — the from-ast OUTPUT executed over the $AnyValue carrier
// ---------------------------------------------------------------------------

/**
 * gc: the exported from-ast functions take `(ref null $AnyValue)` params the JS
 * host cannot construct, so each gets a hand-built wrapper that boxes f64
 * (NumberF64) / i32 (Boolean-refined) params into the carrier and direct-calls
 * the from-ast function — the same dyn-arg → dyn-param call shape slice 2
 * claims.
 */
/**
 * A wrapper's call target must carry a STRUCTURAL callable binding — the
 * verifier rejects legacy name-only refs ("call target is missing required
 * callable binding"). So the wrappers take the callee `IrFunction` itself and
 * read its `unitId`, rather than a bare name resolved after the fact.
 */
function calleeRef(callee: IrFunction): IrFuncRef {
  return { kind: "func", name: callee.name, binding: { kind: "unit", unitId: callee.unitId } };
}

function gcWrapperF64(name: string, callee: IrFunction, arity: 1 | 2): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [F64], true);
  const a = b.addParam("a", F64);
  const c = arity === 2 ? b.addParam("c", F64) : null;
  b.openBlock();
  const da = b.emitBox(a, irDynamic(JS_TAG_IDS.NumberF64));
  const args = [da];
  if (c !== null) args.push(b.emitBox(c, irDynamic(JS_TAG_IDS.NumberF64)));
  const r = b.emitCall(calleeRef(callee), args, F64);
  if (r === null) throw new Error("wrapper call produced no value");
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

function gcWrapperBool(name: string, callee: IrFunction): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [F64], true);
  const a = b.addParam("a", I32);
  b.openBlock();
  const da = b.emitBox(a, irDynamic(JS_TAG_IDS.Boolean));
  const r = b.emitCall(calleeRef(callee), [da], F64);
  if (r === null) throw new Error("wrapper call produced no value");
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

describe("#2949 S5.5 — gc runtime: from-ast dynamic arithmetic over the $AnyValue carrier", () => {
  it("dec/mul/div/mod/neg/toNum on boxed numbers and booleans (incl. NaN, -0, fmod edges)", async () => {
    const fns = [
      irFromSource(`export function dec(x) { return x - 1; }`, [DYN], F64),
      irFromSource(`export function mul(x, y) { return x * y; }`, [DYN, DYN], F64),
      irFromSource(`export function div(x, y) { return x / y; }`, [DYN, DYN], F64),
      irFromSource(`export function mod(x, y) { return x % y; }`, [DYN, DYN], F64),
      irFromSource(`export function neg(x) { return -x; }`, [DYN], F64),
      irFromSource(`export function toNum(x) { return +x; }`, [DYN], F64),
    ];
    const [dec, mul, div, mod, neg, toNum] = fns;
    const wrappers = [
      gcWrapperF64("decW", dec!, 1),
      gcWrapperF64("mulW", mul!, 2),
      gcWrapperF64("divW", div!, 2),
      gcWrapperF64("modW", mod!, 2),
      gcWrapperF64("negW", neg!, 1),
      gcWrapperBool("toNumB", toNum!),
    ];
    for (const f of [...fns, ...wrappers]) expect(verifyIrFunction(f)).toEqual([]);
    const ctx = makeGcCtx();
    install(ctx, fns); // callees first — each wrapper ref is bound to its callee unitId
    install(ctx, wrappers);
    const ex = await instantiateCtx(ctx);

    // subtraction: the `obj[idx-1]` producer shape
    expect(ex.decW(5)).toBe(4);
    expect(ex.decW(0.5)).toBe(-0.5);
    expect(ex.decW(NaN)).toBeNaN();
    // multiplicative family
    expect(ex.mulW(3, 4)).toBe(12);
    expect(ex.mulW(1.5, 2)).toBe(3);
    expect(ex.divW(9, 3)).toBe(3);
    expect(ex.divW(1, 0)).toBe(Infinity);
    expect(ex.divW(0, 0)).toBeNaN();
    // fmod edges bit-for-bit with legacy's __fmod (#2945/#2056)
    expect(ex.modW(7, 3)).toBe(1);
    expect(ex.modW(7.5, 2)).toBe(1.5);
    expect(ex.modW(-7, 3)).toBe(-1); // JS sign-of-dividend, not Euclidean
    expect(ex.modW(7, 0)).toBeNaN(); // x % 0 → NaN
    expect(Object.is(ex.modW(-0, 3), -0)).toBe(true); // -0 % x → -0
    // unary minus incl. -0 production
    expect(ex.negW(5)).toBe(-5);
    expect(Object.is(ex.negW(0), -0)).toBe(true);
    expect(ex.negW(NaN)).toBeNaN();
    // unary plus on a Boolean-refined carrier: ToNumber(true)=1 / (false)=0
    expect(ex.toNumB(1)).toBe(1);
    expect(ex.toNumB(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// host runtime — from-ast functions called DIRECTLY with real JS values
// ---------------------------------------------------------------------------

describe("#2949 S5.5 — host runtime: full ToNumber spectrum through the externref carrier", () => {
  it("number/string/bool/null/undefined operands across - * / % and unary -/+/!", async () => {
    const fns = [
      irFromSource(`export function dec(x) { return x - 1; }`, [DYN], F64),
      irFromSource(`export function sub(x, y) { return x - y; }`, [DYN, DYN], F64),
      irFromSource(`export function mul(x, y) { return x * y; }`, [DYN, DYN], F64),
      irFromSource(`export function mod(x, y) { return x % y; }`, [DYN, DYN], F64),
      irFromSource(`export function neg(x) { return -x; }`, [DYN], F64),
      irFromSource(`export function toNum(x) { return +x; }`, [DYN], F64),
      irFromSource(`export function notx(x) { return !x; }`, [DYN], I32),
    ];
    for (const f of fns) expect(verifyIrFunction(f)).toEqual([]);
    const ctx = makeHostCtx();
    install(ctx, fns);
    const ex = await instantiateCtx(ctx, hostEnvFor(ctx));

    // the reduce-body shape: obj[idx-1] with a dynamic idx
    expect(ex.dec(5)).toBe(4);
    expect(ex.dec("5")).toBe(4); // Number("5") - 1 (§7.1.4 via __unbox_number)
    expect(ex.dec(true)).toBe(0); // 1 - 1
    expect(ex.dec(null)).toBe(-1); // 0 - 1
    expect(ex.dec(undefined)).toBeNaN(); // NaN - 1

    expect(ex.sub(7, 2)).toBe(5);
    expect(ex.sub("7", "2")).toBe(5); // BOTH ToNumber — `-` never concatenates
    expect(ex.mul("3", 4)).toBe(12);
    expect(ex.mul("abc", 4)).toBeNaN();
    expect(ex.mod(7, 3)).toBe(1);
    expect(ex.mod(7, 0)).toBeNaN();

    expect(ex.neg(5)).toBe(-5);
    expect(ex.neg("5")).toBe(-5);
    expect(ex.neg(undefined)).toBeNaN();
    expect(ex.toNum("42")).toBe(42);
    expect(ex.toNum(true)).toBe(1);
    expect(ex.toNum(null)).toBe(0);
    expect(ex.toNum("")).toBe(0); // Number("") = 0

    // `!x` = ToBoolean + negate — full JS truthiness spectrum (host
    // __is_truthy is spec-correct; incl. NaN → falsy → !NaN = true)
    expect(ex.notx(0)).toBe(1);
    expect(ex.notx(NaN)).toBe(1);
    expect(ex.notx("")).toBe(1);
    expect(ex.notx(null)).toBe(1);
    expect(ex.notx(undefined)).toBe(1);
    expect(ex.notx(5)).toBe(0);
    expect(ex.notx("a")).toBe(0);
    expect(ex.notx({})).toBe(0);
  });
});
