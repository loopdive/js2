// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 S5.1 — dynamic-value truthiness lowering.
//
// S5.0 (PR #2682) landed the builder emit vocabulary (emitBox/emitUnbox/
// emitTagTest). S5.1 adds `ToBoolean` on a boxed-any carrier: a new
// `emitDynTruthy` builder method + `IrInstrDynTruthy` node, lowered via the
// new `IrDynamicLowering.emitToBoolean` handle arm, which ROUTES to the
// canonical `coercion-engine.emitToBoolean` (`__any_unbox_bool` gc /
// `__is_truthy` host) — one ToBoolean engine, byte-parity with the legacy
// condition path (June-audit D4). It is NOT `unbox{Boolean}` (that reads a
// PROVEN boolean's payload); general truthiness is defined over EVERY
// partition.
//
// This slice is byte-inert by construction — the selector's move-only gate
// still rejects a dynamic condition, so from-ast never builds `dyn.truthy`
// in a claimed function (proven separately by prove-emit-identity, 39/39
// IDENTICAL). These tests exercise the mechanism DIRECTLY: node shape +
// result type, the construction-time operand guard, the handle→helper D4
// routing, and — RAISED to full runtime execution per the slice-3 standard —
// truthiness of hand-built IR lowered against the PRODUCTION handle over a
// real CodegenContext, in BOTH the gc (fast) and host strategies, asserting
// JS truthiness across 0 / NaN / "" / null / undefined / {} / "a" / 5.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ensureAnyHelpers } from "../src/codegen/any-helpers.js";
// Side-effect import: registers the `flushLateImportShifts` codegen delegate
// that `addUnionImports` requires (same pattern as the S5.0 / slice-3 tests).
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
  type IrFunction,
  type IrLowerResolver,
  type IrType,
} from "../src/ir/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { FuncTypeDef } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-2949-s5-1-truthiness");
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const DYN: IrType = irDynamic();

// ---------------------------------------------------------------------------
// Harness — real context, production handle, production encoder (S5.0 style)
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
  addUnionImports(ctx); // what preregisterDynamicSupport does for host
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

function hostEnvFor(ctx: CodegenContext): Record<string, unknown> {
  const stub = (name: string): unknown => {
    if (name.startsWith("__typeof_")) {
      const t = name.slice("__typeof_".length);
      // biome-ignore lint/suspicious/useValidTypeof: t derives from the import name — same dynamic dispatch src/runtime.ts uses
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
        // Real JS ToBoolean — proves dyn.truthy routes here (not Boolean-unbox).
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
// Node shape + result type + construction-time operand guard
// ---------------------------------------------------------------------------

describe("#2949 S5.1 — emitDynTruthy emits a verifier-clean i32 dyn.truthy node", () => {
  it("appends a dyn.truthy node with i32 result and registers typeOf", () => {
    const b = new IrFunctionBuilder(identities.next("truthy1"), [I32], true);
    const x = b.addParam("x", DYN);
    b.openBlock();
    const t = b.emitDynTruthy(x);
    expect(b.typeOf(t)).toEqual(I32);
    b.terminate({ kind: "return", values: [t] });
    const fn = b.finish();
    const [node] = fn.blocks[0].instrs;
    expect(node).toMatchObject({ kind: "dyn.truthy", value: x, result: t, resultType: I32 });
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("rejects a non-dynamic operand at construction (general truthiness is carrier-only)", () => {
    const b = new IrFunctionBuilder(identities.next("truthyBad"), [I32], true);
    const c = b.addParam("c", F64);
    b.openBlock();
    expect(() => b.emitDynTruthy(c)).toThrow(/not dynamic/);
  });

  it("a dyn.truthy fed a concrete operand fails the verifier (defense in depth)", () => {
    // Hand-craft a malformed node bypassing the builder guard to prove the
    // verifier is the hard backstop, not just the constructor.
    const b = new IrFunctionBuilder(identities.next("truthyVerify"), [I32], true);
    const c = b.addParam("c", I32);
    b.openBlock();
    b.terminate({ kind: "return", values: [c] });
    const fn = b.finish();
    const bad: IrFunction = {
      ...fn,
      blocks: [
        {
          ...fn.blocks[0],
          instrs: [{ kind: "dyn.truthy", value: c, result: 999, resultType: I32 } as never],
        },
      ],
    };
    const errs = verifyIrFunction(bad);
    expect(errs.some((e) => /dyn\.truthy operand must be a dynamic/.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handle → helper routing (D4): one ToBoolean engine, both strategies
// ---------------------------------------------------------------------------

describe("#2949 S5.1 — IrDynamicLowering.emitToBoolean routes to the canonical helper", () => {
  it("gc: emits a single call to __any_unbox_bool", () => {
    const ctx = makeGcCtx();
    const dyn = makeDynamicLowering(ctx);
    expect(dyn).not.toBeNull();
    const ops = dyn!.emitToBoolean();
    const idx = ctx.funcMap.get("__any_unbox_bool");
    expect(idx).toBeDefined();
    expect(ops).toEqual([{ op: "call", funcIdx: idx }]);
  });

  it("host: emits a single call to __is_truthy", () => {
    const ctx = makeHostCtx();
    const dyn = makeDynamicLowering(ctx);
    expect(dyn).not.toBeNull();
    const ops = dyn!.emitToBoolean();
    const idx = ctx.funcMap.get("__is_truthy");
    expect(idx).toBeDefined();
    expect(ops).toEqual([{ op: "call", funcIdx: idx }]);
  });
});

// ---------------------------------------------------------------------------
// Runtime execution — hand-built if(x)-shaped IR, both strategies
// ---------------------------------------------------------------------------

/**
 * `truthyF64(x: f64): f64` — box x into the carrier, ToBoolean via
 * `dyn.truthy`, then `select(t, 1, 0)`: the `if (x) return 1; return 0`
 * shape the S5.1 spec names, driving a number-partition carrier. Works in
 * both strategies (gc `__any_unbox_bool` / host `__box_number`+`__is_truthy`).
 */
function truthyF64(name: string): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [F64], true);
  const x = b.addParam("x", F64);
  b.openBlock();
  const d = b.emitBox(x, DYN);
  const t = b.emitDynTruthy(d);
  const one = b.emitConst({ kind: "f64", value: 1 }, F64);
  const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
  const r = b.emitSelect(t, one, zero, F64);
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

/**
 * `truthyBool(x: i32): f64` — box a Boolean-refined i32, ToBoolean, select.
 * Exercises the tag-4 boolean partition through the SAME truthiness path.
 */
function truthyBool(name: string): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [F64], true);
  const x = b.addParam("x", I32);
  b.openBlock();
  const d = b.emitBox(x, irDynamic(JS_TAG_IDS.Boolean));
  const t = b.emitDynTruthy(d);
  const one = b.emitConst({ kind: "f64", value: 1 }, F64);
  const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
  const r = b.emitSelect(t, one, zero, F64);
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

/**
 * `truthyDyn(x: dynamic): i32` — the param IS the carrier (host: externref),
 * ToBoolean directly. Host-only: a $AnyValue carrier cannot be constructed
 * from JS to pass as a gc param, but an externref carrier accepts any JS
 * value, so this drives the FULL JS-truthiness spectrum.
 */
function truthyDyn(name: string): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const x = b.addParam("x", DYN);
  b.openBlock();
  const t = b.emitDynTruthy(x);
  b.terminate({ kind: "return", values: [t] });
  return b.finish();
}

describe("#2949 S5.1 — gc runtime: dyn.truthy over the $AnyValue carrier", () => {
  it("number + boolean partitions yield the canonical __any_unbox_bool truthiness", async () => {
    const fns = [truthyF64("tF64"), truthyBool("tBool")];
    for (const f of fns) expect(verifyIrFunction(f)).toEqual([]);
    const ctx = makeGcCtx();
    install(ctx, fns);
    const ex = await instantiateCtx(ctx);
    // 0 / -0 are falsy; every finite non-zero number is truthy. NaN is the
    // one deliberate byte-parity inheritance: the canonical `__any_unbox_bool`
    // tests a NumberF64 payload with `f64val != 0` (any-helpers.ts), and
    // `NaN != 0` is TRUE in Wasm — so a boxed NaN reads truthy in gc mode,
    // EXACTLY as legacy `if (boxedAnyNaN)` does today (this is the D4 point:
    // S5.1 reuses the ONE ToBoolean engine and inherits its behavior, it does
    // not mint a spec-corrected second policy). Host mode is spec-correct via
    // `__is_truthy` (see the host test) — the NaN divergence is a pre-existing
    // `__any_unbox_bool` gap, fixable only at the helper (a legacy-affecting
    // change, out of S5.1 scope).
    for (const [v, want] of [
      [0, 0],
      [-0, 0],
      [NaN, 1], // byte-parity with legacy __any_unbox_bool (f64.ne 0), not spec ToBoolean
      [1, 1],
      [5, 1],
      [-42, 1],
      [Math.PI, 1],
      [2 ** 40, 1],
    ] as const) {
      expect(ex.tF64(v)).toBe(want);
    }
    expect(ex.tBool(1)).toBe(1);
    expect(ex.tBool(0)).toBe(0);
  });
});

describe("#2949 S5.1 — host runtime: dyn.truthy over the externref carrier", () => {
  it('full JS-truthiness spectrum (0/NaN/""/null/undefined/{}/"a"/5) via __is_truthy', async () => {
    const fns = [truthyDyn("tDyn"), truthyF64("tF64"), truthyBool("tBool")];
    const ctx = makeHostCtx();
    install(ctx, fns);
    const ex = await instantiateCtx(ctx, hostEnvFor(ctx));
    // Directly pass JS values as the externref carrier and assert ToBoolean.
    for (const [v, want] of [
      [0, 0],
      [NaN, 0],
      ["", 0],
      [null, 0],
      [undefined, 0],
      [{}, 1],
      ["a", 1],
      [5, 1],
    ] as const) {
      expect(ex.tDyn(v)).toBe(want);
    }
    // Boxed-number / boxed-boolean paths agree in host mode too.
    for (const [v, want] of [
      [0, 0],
      [3.5, 1],
      [-42, 1],
    ] as const) {
      expect(ex.tF64(v)).toBe(want);
    }
    expect(ex.tBool(1)).toBe(1);
    expect(ex.tBool(0)).toBe(0);
  });
});
