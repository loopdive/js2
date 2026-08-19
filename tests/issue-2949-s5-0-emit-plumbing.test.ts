// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 S5.0 — builder-level box/unbox/tag.test emit plumbing.
//
// Slice 1 (PR #2486) put `{kind:"dynamic", tag?}` in the IrType lattice with
// verifier rules R1–R6; slices 2/3 added the move-only producers and the
// node-level LOWERING (lower.ts box/unbox/tag.test → `resolveDynamicLowering`
// → `IrDynamicLowering`, backed by `$AnyValue` / `__any_box_*` on WasmGC and
// the `__box_number` / classifier import family on host). What was MISSING
// (the work of S5.0) is the BUILDER vocabulary the S5.1–S5.P dynamic-use-in-
// body producers construct the nodes with: `emitBox` / `emitUnbox` /
// `emitTagTest` on `IrFunctionBuilder`.
//
// This slice is byte-inert by construction — no producer calls the new
// methods yet, so no compiled function's Wasm changes (proven separately by
// prove-emit-identity, 39/39 IDENTICAL). These tests exercise the builder
// methods DIRECTLY: they assert the emitted node shape + result IrType (the
// `jsTagUnboxKind` payload mapping), that the built functions are verifier-
// clean, and — RAISED to full runtime execution, per the slice-3 standard —
// that a `box → tag.test → unbox` round-trip lowered against the PRODUCTION
// handle over a real CodegenContext actually round-trips the value and
// classifies the tag, in BOTH the gc (fast/standalone) and host strategies.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ensureAnyHelpers } from "../src/codegen/any-helpers.js";
// Side-effect import: registers the `flushLateImportShifts` codegen delegate
// that `addUnionImports` requires (owned by expressions/late-imports.ts, which
// expressions.ts registers on module load — same pattern as the slice-3 test).
import "../src/codegen/expressions.js";
import { addUnionImports, createCodegenContext } from "../src/codegen/index.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
// #3954 phase 1 — `IrType`'s dynamic leaf carries an opaque TagId, so a
// refinement is named through the JS tag domain, not the enum.
import { JS_TAG_DOMAIN, JS_TAG_IDS } from "../src/ir/js-tag-domain.js";
import type { TagId } from "../src/ir/tag-domain.js";
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

const identities = createTestIrFunctionIdentityFactory("issue-2949-s5-0-emit-plumbing");
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const DYN: IrType = irDynamic();

// ---------------------------------------------------------------------------
// Harness — real context, production handle, production encoder
// (identical to the slice-3 test; the box/unbox/tag.test lowering is shared)
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
      // biome-ignore lint/suspicious/useValidTypeof: t is derived from the import name — same dynamic dispatch src/runtime.ts uses
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
// Node shape + result type — the emitted nodes and their result IrTypes
// ---------------------------------------------------------------------------

describe("#2949 S5.0 — builder emits verifier-clean box/unbox/tag.test nodes", () => {
  it("emitBox appends a box node with resultType == toType and registers typeOf", () => {
    const b = new IrFunctionBuilder(identities.next("box1"), [DYN], true);
    const x = b.addParam("x", F64);
    b.openBlock();
    const d = b.emitBox(x, DYN);
    expect(b.typeOf(d)).toEqual(DYN);
    b.terminate({ kind: "return", values: [d] });
    const fn = b.finish();
    const [node] = fn.blocks[0].instrs;
    expect(node).toMatchObject({ kind: "box", value: x, toType: DYN, result: d, resultType: DYN });
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("emitBox carries a refinement onto the box target (irDynamic(tag))", () => {
    const b = new IrFunctionBuilder(identities.next("boxRefined"), [DYN], true);
    const x = b.addParam("x", I32);
    b.openBlock();
    const refined = irDynamic(JS_TAG_IDS.Boolean);
    const d = b.emitBox(x, refined);
    expect(b.typeOf(d)).toEqual(refined);
    b.terminate({ kind: "return", values: [d] });
    expect(verifyIrFunction(b.finish())).toEqual([]);
  });

  it("emitUnbox result IrType follows the DOMAIN's carrier kinds (i32 / f64 / ref→externref)", () => {
    // NumberF64 → f64, NumberI32 / Boolean → i32, String/Object/Function → externref.
    // #3954 W5 — the builder takes a neutral `TagId` and asks its `TagDomain`;
    // the JS producer names its partitions via `JS_TAG_IDS`.
    const cases: Array<[TagId, IrType]> = [
      [JS_TAG_IDS.NumberF64, F64],
      [JS_TAG_IDS.NumberI32, I32],
      [JS_TAG_IDS.Boolean, I32],
      [JS_TAG_IDS.String, irVal({ kind: "externref" })],
      [JS_TAG_IDS.Object, irVal({ kind: "externref" })],
      [JS_TAG_IDS.Function, irVal({ kind: "externref" })],
    ];
    for (const [tag, expected] of cases) {
      const name = `unbox_${JS_TAG_DOMAIN.nameOf(tag)}`;
      const b = new IrFunctionBuilder(identities.next(name), [expected], true);
      const x = b.addParam("x", F64);
      b.openBlock();
      const d = b.emitBox(x, DYN);
      const u = b.emitUnbox(d, tag);
      expect(b.typeOf(u)).toEqual(expected);
      b.terminate({ kind: "return", values: [u] });
      const node = b.finish().blocks[0].instrs[1];
      expect(node).toMatchObject({ kind: "unbox", value: d, tagId: tag, resultType: expected });
    }
  });

  it("emitTagTest always yields an i32 node for ANY partition (incl. singletons)", () => {
    for (const tag of [
      JS_TAG_IDS.NumberF64,
      JS_TAG_IDS.String,
      JS_TAG_IDS.Object,
      JS_TAG_IDS.Null,
      JS_TAG_IDS.Undefined,
    ]) {
      const name = `tagtest_${JS_TAG_DOMAIN.nameOf(tag)}`;
      const b = new IrFunctionBuilder(identities.next(name), [I32], true);
      const x = b.addParam("x", F64);
      b.openBlock();
      const d = b.emitBox(x, DYN);
      const t = b.emitTagTest(d, tag);
      expect(b.typeOf(t)).toEqual(I32);
      b.terminate({ kind: "return", values: [t] });
      const node = b.finish().blocks[0].instrs[1];
      expect(node).toMatchObject({ kind: "tag.test", value: d, tagId: tag, resultType: I32 });
    }
  });

  it("emitBox rejects a re-box of an already-dynamic operand (verifier R1, at construction)", () => {
    const b = new IrFunctionBuilder(identities.next("rebox"), [DYN], true);
    const x = b.addParam("x", F64);
    b.openBlock();
    const d = b.emitBox(x, DYN);
    expect(() => b.emitBox(d, DYN)).toThrow(/already dynamic/);
  });

  it("emitUnbox rejects a payload-less singleton partition (verifier R2, at construction)", () => {
    const b = new IrFunctionBuilder(identities.next("unboxSingleton"), [I32], true);
    const x = b.addParam("x", F64);
    b.openBlock();
    const d = b.emitBox(x, DYN);
    expect(() => b.emitUnbox(d, JS_TAG_IDS.Null)).toThrow(/payload-less/);
    expect(() => b.emitUnbox(d, JS_TAG_IDS.Undefined)).toThrow(/payload-less/);
  });
});

// ---------------------------------------------------------------------------
// Round-trip execution — box → tag.test → unbox, real handle, both strategies
// ---------------------------------------------------------------------------

/**
 * `boxTagUnbox(x): f64` — box x into the carrier, tag.test it against `tag`,
 * unbox as NumberF64, and `select(t, u, 0)`. When the tag matches (`t==1`)
 * the value round-trips; when it does not (`t==0`) the guard returns 0. This
 * single function exercises ALL THREE builder methods and USES every value.
 */
function boxTagUnboxF64(name: string, tag: TagId): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [F64], true);
  const x = b.addParam("x", F64);
  b.openBlock();
  const d = b.emitBox(x, DYN);
  const t = b.emitTagTest(d, tag);
  const u = b.emitUnbox(d, JS_TAG_IDS.NumberF64);
  const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
  const r = b.emitSelect(t, u, zero, F64);
  b.terminate({ kind: "return", values: [r] });
  return b.finish();
}

/** `boxUnboxBool(x: i32): i32` — box i32 with a Boolean refinement, unbox Boolean. */
function boxUnboxBool(name: string): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const x = b.addParam("x", I32);
  b.openBlock();
  const d = b.emitBox(x, irDynamic(JS_TAG_IDS.Boolean));
  const u = b.emitUnbox(d, JS_TAG_IDS.Boolean);
  b.terminate({ kind: "return", values: [u] });
  return b.finish();
}

/** `boxUnboxI32(x: i32): i32` — box i32 (NumberI32), unbox NumberI32. */
function boxUnboxI32(name: string): IrFunction {
  const b = new IrFunctionBuilder(identities.next(name), [I32], true);
  const x = b.addParam("x", I32);
  b.openBlock();
  const d = b.emitBox(x, DYN);
  const u = b.emitUnbox(d, JS_TAG_IDS.NumberI32);
  b.terminate({ kind: "return", values: [u] });
  return b.finish();
}

function roundTripFns(): IrFunction[] {
  return [
    boxTagUnboxF64("matchNumber", JS_TAG_IDS.NumberF64), // t==1 → returns x
    boxTagUnboxF64("mismatchString", JS_TAG_IDS.String), // t==0 → returns 0
    boxUnboxBool("boolRoundTrip"),
    boxUnboxI32("i32RoundTrip"),
  ];
}

describe("#2949 S5.0 — gc runtime: builder-emitted box/tag.test/unbox round-trips", () => {
  it("verifies + runs the round-trip functions ($AnyValue carrier)", async () => {
    const fns = roundTripFns();
    for (const f of fns) expect(verifyIrFunction(f)).toEqual([]);
    const ctx = makeGcCtx();
    install(ctx, fns);
    const ex = await instantiateCtx(ctx);
    // box(f64) → tag.test(number) proves true → unbox round-trips the value.
    for (const v of [0, 1, -0, 3.5, -42, NaN, Math.PI, 2 ** 40]) {
      expect(ex.matchNumber(v)).toBe(Object.is(v, -0) ? -0 : v);
    }
    // box(f64) → tag.test(String) proves false → the guard returns 0.
    for (const v of [1, 7.25, -3]) expect(ex.mismatchString(v)).toBe(0);
    // Boolean-refined box round-trips 0/1; NumberI32 box round-trips ints.
    expect(ex.boolRoundTrip(1)).toBe(1);
    expect(ex.boolRoundTrip(0)).toBe(0);
    for (const v of [0, 1, 42, -7]) expect(ex.i32RoundTrip(v)).toBe(v);
  });
});

describe("#2949 S5.0 — host runtime: builder-emitted box/tag.test/unbox round-trips", () => {
  it("verifies + runs the round-trip functions (externref carrier, import family)", async () => {
    const fns = roundTripFns();
    const ctx = makeHostCtx();
    install(ctx, fns);
    const ex = await instantiateCtx(ctx, hostEnvFor(ctx));
    for (const v of [0, 1, 3.5, -42, Math.PI]) {
      expect(ex.matchNumber(v)).toBe(v);
    }
    for (const v of [1, 7.25, -3]) expect(ex.mismatchString(v)).toBe(0);
    expect(ex.boolRoundTrip(1)).toBe(1);
    expect(ex.boolRoundTrip(0)).toBe(0);
    for (const v of [0, 1, 42, -7]) expect(ex.i32RoundTrip(v)).toBe(v);
  });
});
