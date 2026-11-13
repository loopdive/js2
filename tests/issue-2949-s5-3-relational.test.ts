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
import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";
import { emitToNumber as legacyEmitToNumber } from "../src/codegen/coercion-engine.js";
// #3954 phase 1 — `IrType`'s dynamic leaf carries an opaque TagId, so a
// refinement is named through the JS tag domain, not the enum.
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

  // (#6979 S7-a) Re-pinned: the externref carrier no longer calls the host
  // `Number(v)` import; it lowers through the SAME canonical legacy ToNumber
  // ladder (`emitToNumber` in coercion-engine.ts) every other externref
  // ToNumber uses.
  it("externref carrier: emitToNumber is the canonical legacy externref ToNumber", () => {
    // Two identical fresh contexts, so the lazy helper registration the first
    // emission performs cannot make the second one look different.
    const dyn = makeDynamicLowering(makeHostCtx());
    expect(dyn).not.toBeNull();
    const shim = { body: [], savedBodies: [] } as unknown as FunctionContext;
    legacyEmitToNumber(makeHostCtx(), shim, { kind: "externref" });
    expect(shim.body.length).toBeGreaterThan(0);
    expect(dyn!.emitToNumber()).toEqual(shim.body);
  });
});

// (#6979) host-strings variant removed with the host-assisted profile.
// The gc-runtime ($AnyValue) execution case went with it: it ran a bare
// `fast` context on host js-string builtins, and a bare native-strings context
// pulls in runtime helper bodies that only validate after the full production
// finalize pipeline.

// (#6979 S7-a) The host-runtime execution describe tested the retired host-assisted import lane (bare host context + JS-host carrier imports); deleted with it.
