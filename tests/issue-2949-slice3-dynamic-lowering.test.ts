// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 slice 3 — dynamic box/unbox/tag.test LOWERING.
//
// Slice 1 (PR #2486) put `{kind:"dynamic", tag?}` in the IrType lattice with
// verifier rules R1–R4 and staged "lands in slice 3" lowering errors; slice 2
// (PRs #2610/#2611) added the move-only producers. This slice makes the three
// dynamic ops REAL:
//
//   - `IrDynamicLowering` handle (backend/handles.ts), produced by the
//     PRODUCTION factory `makeDynamicLowering` (integration.ts) — gc strategy
//     (fast/standalone, `ref_null $AnyValue`, canonical `__any_box_*` /
//     `__any_unbox_*` family via `boxToAny` — never a second boxing engine)
//     and host strategy (externref, `__box_number` / `__typeof_*` imports).
//   - lower.ts arms that drive the handle.
//   - Verifier R6 hardening: a `dynamic` declared result accepts ONLY dynamic
//     values, so ref→dynamic returns must go through an explicit box (the
//     latent invalid-Wasm trap the slice-2 handoff flagged).
//
// Proof standard: same as the union V1 arms (direct-IR construction), but
// RAISED to full runtime execution — these tests hand-build IrFunctions,
// lower them against the PRODUCTION handle over a REAL CodegenContext
// (real `ensureAnyHelpers` registration, real `addUnionImports`), encode via
// the production emitter, and RUN the module in both strategies.
//
// V2 numeric-class contract (deliberate, documented in the issue notes):
// tag.test on EITHER number partition is the CLASS test ("is a number") in
// both strategies, because the host carrier cannot split the partitions
// (`typeof` has one "number"); the payload choice lives in the UNBOX tag.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ensureAnyHelpers } from "../src/codegen/any-helpers.js";
// Side-effect import: registers the `flushLateImportShifts` codegen delegate
// that `addUnionImports` requires (owned by expressions/late-imports.ts, which
// expressions.ts registers on module load — same pattern as issue-1588 tests).
import "../src/codegen/expressions.js";
import { addUnionImports, createCodegenContext } from "../src/codegen/index.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
// The `IrDynamicLowering` handle contract (backend/handles.ts, frozen #3029-S1)
// still speaks `JsTag` — #3954 W6, deliberately untouched. The IR NODES do not:
// since #3954 phase 3 (W4) `unbox`/`tag.test` carry a neutral `TagId`.
import { JsTag } from "../src/ir/js-tag.js";
// #3954 phase 1 — `IrType`'s dynamic leaf carries an opaque TagId, so a
// refinement is named through the JS tag domain, not the enum.
import { JS_TAG_IDS } from "../src/ir/js-tag-domain.js";
import type { TagId } from "../src/ir/tag-domain.js";
import { emitBinary } from "../src/emit/binary.js";
import { repairStructTypeMismatches } from "../src/codegen/fixups.js";
import { peepholeOptimize } from "../src/codegen/peephole.js";
import { stackBalance } from "../src/codegen/stack-balance.js";
import {
  asBlockId,
  asValueId,
  irDynamic,
  irVal,
  lowerIrFunctionToWasm,
  makeDynamicLowering,
  verifyIrFunction,
  type IrFunction,
  type IrLowerResolver,
  type IrType,
  type IrValueId,
} from "../src/ir/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { FuncTypeDef, Instr, ValType } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-2949-slice3-dynamic-lowering");

function id(n: number): IrValueId {
  return asValueId(n);
}

const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });
const DYN = irDynamic();

/** One-block function: params in, `instrs`, return `retVals` as `resultTypes`. */
function fn(
  name: string,
  params: { type: IrType; name: string }[],
  instrs: IrFunction["blocks"][number]["instrs"],
  retVals: IrValueId[],
  resultTypes: IrType[],
  valueCount: number,
): IrFunction {
  return {
    ...irIdentities.next(name),
    params: params.map((p, i) => ({ value: id(i), type: p.type, name: p.name })),
    resultTypes,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: retVals },
      },
    ],
    exported: true,
    valueCount,
  };
}

// ---------------------------------------------------------------------------
// Harness — real context, production handle, production encoder
// ---------------------------------------------------------------------------

function makeGcCtx(): CodegenContext {
  // fast + host js-string builtins — the playground fast-mode configuration.
  // (fast + standalone ALSO uses the gc strategy, but a bare test context
  // there pulls in native-string/object-runtime helper bodies whose validity
  // depends on later production passes; the js-string configuration keeps
  // the module minimal while exercising the identical $AnyValue lowering.)
  const ctx = createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker, {
    fast: true,
    nativeStrings: false,
  });
  // What preregisterDynamicSupport does for the gc strategy.
  ensureAnyHelpers(ctx);
  return ctx;
}

function makeHostCtx(): CodegenContext {
  const ctx = createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker, {});
  // What preregisterDynamicSupport does for the host strategy.
  addUnionImports(ctx);
  return ctx;
}

/** Minimal production-backed resolver: real funcMap, real dynamic handle. */
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

/** Lower + install + export each IrFunction into the ctx's module. */
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
  // Mirror the production post-passes (codegen/index.ts tail): some
  // ensureAnyHelpers-family bodies (e.g. __delete_property's nullable-tee
  // into a non-null call param) only validate after these fixups run —
  // exactly as they do in every real compile.
  repairStructTypeMismatches(ctx.mod);
  peepholeOptimize(ctx.mod);
  stackBalance(ctx.mod);
  const binary = emitBinary(ctx.mod);
  // Stub any wasm:js-string builtins the helper family imported (fast
  // non-native mode) — the engine builtin semantics, JS-side.
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

/**
 * Host-side stubs for the union-import family, mirroring the PRODUCTION
 * semantics in src/runtime.ts (`typeof_check` = `typeof v === t ? 1 : 0`,
 * `truthy_check`, box/unbox intents) — the host imports ARE host-provided by
 * definition, and these one-liners are exactly what buildImports wires up.
 */
function hostEnvFor(ctx: CodegenContext): Record<string, unknown> {
  const stub = (name: string): unknown => {
    if (name.startsWith("__typeof_")) {
      const t = name.slice("__typeof_".length);
      // biome-ignore lint/suspicious/useValidTypeof: t is derived from the import name — same dynamic dispatch src/runtime.ts uses for typeof_check
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
// Handle contract — production factory, both strategies
// ---------------------------------------------------------------------------

describe("#2949 s3 — IrDynamicLowering handle (production factory)", () => {
  it("gc: carrier/strategy/payload-field table match the $AnyValue layout", () => {
    const ctx = makeGcCtx();
    const dyn = makeDynamicLowering(ctx)!;
    expect(dyn.strategy).toBe("gc");
    expect(dyn.anyValueTypeIdx).toBe(ctx.anyValueTypeIdx);
    expect(dyn.carrier).toEqual({ kind: "ref_null", typeIdx: ctx.anyValueTypeIdx });
    expect(dyn.tagFieldIdx).toBe(0);
    expect(dyn.payloadFieldIdx(JsTag.NumberI32)).toBe(1);
    expect(dyn.payloadFieldIdx(JsTag.Boolean)).toBe(1);
    expect(dyn.payloadFieldIdx(JsTag.NumberF64)).toBe(2);
    expect(dyn.payloadFieldIdx(JsTag.Object)).toBe(3);
    expect(dyn.payloadFieldIdx(JsTag.Function)).toBe(3);
    // Strings ride extern-shaped in externval under tag 5 (tag-5-field-4).
    expect(dyn.payloadFieldIdx(JsTag.String)).toBe(4);
    expect(() => dyn.payloadFieldIdx(JsTag.Null)).toThrow(/singleton partition/);
    expect(() => dyn.payloadFieldIdx(JsTag.Undefined)).toThrow(/singleton partition/);
  });

  it("gc: box routes through the canonical __any_box_* family (D4 — no second engine)", () => {
    const ctx = makeGcCtx();
    const dyn = makeDynamicLowering(ctx)!;
    expect(dyn.emitBox({ kind: "f64" })).toEqual([{ op: "call", funcIdx: ctx.funcMap.get("__any_box_f64") }]);
    expect(dyn.emitBox({ kind: "i32" })).toEqual([{ op: "call", funcIdx: ctx.funcMap.get("__any_box_i32") }]);
    // Boolean-refined i32 boxes tag-4 via the hint channel.
    expect(dyn.emitBox({ kind: "i32" }, JsTag.Boolean)).toEqual([
      { op: "call", funcIdx: ctx.funcMap.get("__any_box_bool") },
    ]);
  });

  it("gc: unbox uses the canonical V2-aware numeric readers", () => {
    const ctx = makeGcCtx();
    const dyn = makeDynamicLowering(ctx)!;
    expect(dyn.emitUnbox(JsTag.NumberF64)).toEqual([{ op: "call", funcIdx: ctx.funcMap.get("__any_unbox_f64") }]);
    expect(dyn.emitUnbox(JsTag.NumberI32)).toEqual([{ op: "call", funcIdx: ctx.funcMap.get("__any_unbox_i32") }]);
    expect(dyn.emitUnbox(JsTag.Boolean)).toEqual([{ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 1 }]);
    expect(dyn.emitUnbox(JsTag.String)).toEqual([{ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 4 }]);
    expect(() => dyn.emitUnbox(JsTag.Null)).toThrow(/singleton/);
  });

  it("gc: tag.test on EITHER number partition is the same numeric-CLASS test (V2)", () => {
    const ctx = makeGcCtx();
    const dyn = makeDynamicLowering(ctx)!;
    const scratch = () => {
      throw new Error("gc arms must not need scratch");
    };
    const i32Test = dyn.emitTagTest(JsTag.NumberI32, scratch);
    const f64Test = dyn.emitTagTest(JsTag.NumberF64, scratch);
    expect(i32Test).toEqual(f64Test);
    expect(i32Test).toEqual([
      { op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 2 },
      { op: "i32.sub" },
      { op: "i32.const", value: 1 },
      { op: "i32.le_u" },
    ]);
    // Exact-tag partitions test their own tag, incl. the singletons.
    expect(dyn.emitTagTest(JsTag.Null, scratch)).toEqual([
      { op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 0 },
      { op: "i32.eq" },
    ]);
  });

  it("host: carrier is externref; box/unbox route through the import family / identity", () => {
    const ctx = makeHostCtx();
    const dyn = makeDynamicLowering(ctx)!;
    expect(dyn.strategy).toBe("host");
    expect(dyn.carrier).toEqual({ kind: "externref" });
    expect(dyn.anyValueTypeIdx).toBe(-1);
    expect(() => dyn.payloadFieldIdx(JsTag.String)).toThrow(/no payload fields/);
    // Host strings / host values ARE the carrier — identity box and unbox.
    expect(dyn.emitBox({ kind: "externref" })).toEqual([]);
    expect(dyn.emitUnbox(JsTag.String)).toEqual([]);
    expect(dyn.emitUnbox(JsTag.Object)).toEqual([]);
    // GC refs re-tag into the extern universe.
    expect(dyn.emitBox({ kind: "ref_null", typeIdx: 3 })).toEqual([{ op: "extern.convert_any" }]);
    // Numbers go through __box_number / __unbox_number.
    expect(dyn.emitBox({ kind: "f64" })).toEqual([{ op: "call", funcIdx: ctx.funcMap.get("__box_number") }]);
    expect(dyn.emitBox({ kind: "i32" }, JsTag.Boolean)).toEqual([
      { op: "call", funcIdx: ctx.funcMap.get("__box_boolean") },
    ]);
    expect(dyn.emitUnbox(JsTag.NumberI32)).toEqual([
      { op: "call", funcIdx: ctx.funcMap.get("__unbox_number") },
      { op: "i32.trunc_sat_f64_s" },
    ]);
    expect(() => dyn.emitUnbox(JsTag.Undefined)).toThrow(/singleton/);
  });

  it("host: tag.test — number partitions share __typeof_number (V2); Null is ref.is_null", () => {
    const ctx = makeHostCtx();
    const dyn = makeDynamicLowering(ctx)!;
    const noScratch = () => {
      throw new Error("unexpected scratch request");
    };
    expect(dyn.emitTagTest(JsTag.NumberI32, noScratch)).toEqual(dyn.emitTagTest(JsTag.NumberF64, noScratch));
    expect(dyn.emitTagTest(JsTag.Null, noScratch)).toEqual([{ op: "ref.is_null" }]);
    // Object needs the scratch local: typeof === "object" AND not null.
    let asked = 0;
    const ops = dyn.emitTagTest(JsTag.Object, () => {
      asked++;
      return 7;
    });
    expect(asked).toBe(1);
    expect(ops[0]).toEqual({ op: "local.tee", index: 7 });
    expect(ops).toContainEqual({ op: "ref.is_null" });
    expect(ops).toContainEqual({ op: "i32.eqz" });
    expect(ops).toContainEqual({ op: "i32.and" });
  });

  it("carrier stays in lockstep with resolveDynamic's mode split", () => {
    // The two views of the one decision (#1852 table): gc carrier is the
    // $AnyValue ref, host carrier is externref — same ctx.fast split the
    // integration resolver's resolveDynamic() uses.
    const gc = makeGcCtx();
    expect(makeDynamicLowering(gc)!.carrier).toEqual({ kind: "ref_null", typeIdx: gc.anyValueTypeIdx });
    const host = makeHostCtx();
    expect(makeDynamicLowering(host)!.carrier).toEqual({ kind: "externref" });
  });
});

// ---------------------------------------------------------------------------
// Runtime — gc strategy (fast/standalone): box → unbox/tag.test round-trips
// ---------------------------------------------------------------------------

describe("#2949 s3 — gc runtime round-trips ($AnyValue, pure module, no imports)", () => {
  async function gcExports() {
    const ctx = makeGcCtx();
    const box = (v: number, toType: IrType = DYN): IrFunction["blocks"][number]["instrs"][number] => ({
      kind: "box",
      value: id(v),
      toType,
      result: id(v + 1),
      resultType: toType,
    });
    const fns: IrFunction[] = [
      // box f64 → unbox NumberF64 → identity.
      fn(
        "rtF64",
        [{ type: F64, name: "n" }],
        [box(0), { kind: "unbox", value: id(1), tagId: JS_TAG_IDS.NumberF64, result: id(2), resultType: F64 }],
        [id(2)],
        [F64],
        3,
      ),
      // box i32 (tag 2) → unbox NumberF64: the V2 cross-tag read.
      fn(
        "i32AsNumber",
        [{ type: I32, name: "x" }],
        [box(0), { kind: "unbox", value: id(1), tagId: JS_TAG_IDS.NumberF64, result: id(2), resultType: F64 }],
        [id(2)],
        [F64],
        3,
      ),
      // box f64 (tag 3) → unbox NumberI32: trunc-sat narrowing.
      fn(
        "f64AsI32",
        [{ type: F64, name: "n" }],
        [box(0), { kind: "unbox", value: id(1), tagId: JS_TAG_IDS.NumberI32, result: id(2), resultType: I32 }],
        [id(2)],
        [I32],
        3,
      ),
      // Boolean-REFINED box (tag 4 via the hint channel) → unbox Boolean.
      fn(
        "boolRT",
        [{ type: I32, name: "b" }],
        [
          box(0, irDynamic(JS_TAG_IDS.Boolean)),
          { kind: "unbox", value: id(1), tagId: JS_TAG_IDS.Boolean, result: id(2), resultType: I32 },
        ],
        [id(2)],
        [I32],
        3,
      ),
      // Refined box → tag.test(Boolean): the refinement produced tag 4.
      fn(
        "boxedBoolIsBool",
        [{ type: I32, name: "b" }],
        [
          box(0, irDynamic(JS_TAG_IDS.Boolean)),
          { kind: "tag.test", value: id(1), tagId: JS_TAG_IDS.Boolean, result: id(2), resultType: I32 },
        ],
        [id(2)],
        [I32],
        3,
      ),
      // Unrefined f64 box (tag 3) → numeric-CLASS test via the *I32* partition
      // tag: MUST be 1 (V2 — either partition means "is a number").
      fn(
        "boxedF64IsNumViaI32Tag",
        [{ type: F64, name: "n" }],
        [box(0), { kind: "tag.test", value: id(1), tagId: JS_TAG_IDS.NumberI32, result: id(2), resultType: I32 }],
        [id(2)],
        [I32],
        3,
      ),
      // Unrefined i32 box (tag 2) → class test via the *F64* partition tag.
      fn(
        "boxedI32IsNumViaF64Tag",
        [{ type: I32, name: "x" }],
        [box(0), { kind: "tag.test", value: id(1), tagId: JS_TAG_IDS.NumberF64, result: id(2), resultType: I32 }],
        [id(2)],
        [I32],
        3,
      ),
      // Negative tags on a number box: String / Null / Undefined / Object.
      fn(
        "boxedF64IsStr",
        [{ type: F64, name: "n" }],
        [box(0), { kind: "tag.test", value: id(1), tagId: JS_TAG_IDS.String, result: id(2), resultType: I32 }],
        [id(2)],
        [I32],
        3,
      ),
      fn(
        "boxedF64IsNull",
        [{ type: F64, name: "n" }],
        [box(0), { kind: "tag.test", value: id(1), tagId: JS_TAG_IDS.Null, result: id(2), resultType: I32 }],
        [id(2)],
        [I32],
        3,
      ),
      fn(
        "boxedBoolIsNum",
        [{ type: I32, name: "b" }],
        [
          box(0, irDynamic(JS_TAG_IDS.Boolean)),
          { kind: "tag.test", value: id(1), tagId: JS_TAG_IDS.NumberF64, result: id(2), resultType: I32 },
        ],
        [id(2)],
        [I32],
        3,
      ),
    ];
    // Every hand-built function must satisfy the verifier (R1–R6).
    for (const f of fns) {
      expect(verifyIrFunction(f), f.name).toEqual([]);
    }
    install(ctx, fns);
    return instantiateCtx(ctx);
  }

  it("round-trips and tag tests behave per the JsTag table", async () => {
    const x = await gcExports();
    expect(x.rtF64!(3.5)).toBe(3.5);
    expect(x.rtF64!(-0)).toBe(-0);
    expect(Number.isNaN(x.rtF64!(NaN) as number)).toBe(true);
    // V2 cross-tag numeric reads.
    expect(x.i32AsNumber!(7)).toBe(7);
    expect(x.i32AsNumber!(-3)).toBe(-3);
    expect(x.f64AsI32!(3.9)).toBe(3);
    expect(x.f64AsI32!(-2.5)).toBe(-2);
    // Boolean refinement produced a REAL tag-4 box.
    expect(x.boolRT!(1)).toBe(1);
    expect(x.boolRT!(0)).toBe(0);
    expect(x.boxedBoolIsBool!(1)).toBe(1);
    expect(x.boxedBoolIsBool!(0)).toBe(1); // false is still a boolean
    // Numeric-CLASS tests accept BOTH numeric tags (V2)…
    expect(x.boxedF64IsNumViaI32Tag!(0.5)).toBe(1);
    expect(x.boxedI32IsNumViaF64Tag!(42)).toBe(1);
    // …and reject non-numbers; non-number tags reject numbers.
    expect(x.boxedBoolIsNum!(1)).toBe(0);
    expect(x.boxedF64IsStr!(1)).toBe(0);
    expect(x.boxedF64IsNull!(1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Runtime — host strategy (externref carrier, dynamic params from real JS)
// ---------------------------------------------------------------------------

describe("#2949 s3 — host runtime (externref carrier, __typeof_* classifiers)", () => {
  async function hostExports() {
    const ctx = makeHostCtx();
    const test = (name: string, tag: TagId): IrFunction =>
      fn(
        name,
        [{ type: DYN, name: "x" }],
        [{ kind: "tag.test", value: id(0), tagId: tag, result: id(1), resultType: I32 }],
        [id(1)],
        [I32],
        2,
      );
    const fns: IrFunction[] = [
      test("isStr", JS_TAG_IDS.String),
      test("isObj", JS_TAG_IDS.Object),
      test("isNull", JS_TAG_IDS.Null),
      test("isUndef", JS_TAG_IDS.Undefined),
      test("isNum", JS_TAG_IDS.NumberF64),
      test("isFn", JS_TAG_IDS.Function),
      // box f64 → unbox NumberF64 through the host import pair.
      fn(
        "numRT",
        [{ type: F64, name: "n" }],
        [
          { kind: "box", value: id(0), toType: DYN, result: id(1), resultType: DYN },
          { kind: "unbox", value: id(1), tagId: JS_TAG_IDS.NumberF64, result: id(2), resultType: F64 },
        ],
        [id(2)],
        [F64],
        3,
      ),
      // unbox Boolean on a dynamic param (host: ToBoolean of a proven bool).
      fn(
        "unboxBool",
        [{ type: DYN, name: "x" }],
        [{ kind: "unbox", value: id(0), tagId: JS_TAG_IDS.Boolean, result: id(1), resultType: I32 }],
        [id(1)],
        [I32],
        2,
      ),
    ];
    for (const f of fns) {
      expect(verifyIrFunction(f), f.name).toEqual([]);
    }
    install(ctx, fns);
    return instantiateCtx(ctx, hostEnvFor(ctx));
  }

  it("classifies real JS values per the JsTag partition table", async () => {
    const x = await hostExports();
    expect(x.isStr!("abc")).toBe(1);
    expect(x.isStr!(42)).toBe(0);
    expect(x.isNum!(42)).toBe(1);
    expect(x.isNum!(0.5)).toBe(1);
    expect(x.isNum!("42")).toBe(0);
    // Object partition EXCLUDES null (the scratch-local arm).
    expect(x.isObj!({})).toBe(1);
    expect(x.isObj!([])).toBe(1);
    expect(x.isObj!(null)).toBe(0);
    expect(x.isObj!("s")).toBe(0);
    // Null vs Undefined are distinct partitions.
    expect(x.isNull!(null)).toBe(1);
    expect(x.isNull!(undefined)).toBe(0);
    expect(x.isUndef!(undefined)).toBe(1);
    expect(x.isUndef!(null)).toBe(0);
    expect(x.isFn!(() => 1)).toBe(1);
    expect(x.isFn!({})).toBe(0);
    // Box/unbox round-trip through __box_number/__unbox_number.
    expect(x.numRT!(2.25)).toBe(2.25);
    expect(x.unboxBool!(true)).toBe(1);
    expect(x.unboxBool!(false)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lowering contract — failure modes stay loud
// ---------------------------------------------------------------------------

describe("#2949 s3 — lowering failure modes", () => {
  function stubResolver(overrides: Partial<IrLowerResolver> = {}): IrLowerResolver {
    const interned: FuncTypeDef[] = [];
    return {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => 0,
      internFuncType: (t) => {
        interned.push(t);
        return interned.length - 1;
      },
      resolveDynamic: (): ValType => ({ kind: "externref" }),
      ...overrides,
    };
  }

  it("box-to-dynamic without resolveDynamicLowering fails loudly", () => {
    const f = fn(
      "boxIt",
      [{ type: F64, name: "n" }],
      [{ kind: "box", value: id(0), toType: DYN, result: id(1), resultType: DYN }],
      [id(1)],
      [DYN],
      2,
    );
    expect(() => lowerIrFunctionToWasm(f, stubResolver())).toThrow(/resolveDynamicLowering missing/);
  });

  it("a resolver whose resolveDynamicLowering returns null (no dynamic ops on this backend) fails loudly", () => {
    const f = fn(
      "boxIt",
      [{ type: F64, name: "n" }],
      [{ kind: "box", value: id(0), toType: DYN, result: id(1), resultType: DYN }],
      [id(1)],
      [DYN],
      2,
    );
    expect(() => lowerIrFunctionToWasm(f, stubResolver({ resolveDynamicLowering: () => null }))).toThrow(
      /resolveDynamicLowering missing\/null/,
    );
  });

  it("unbox/tag.test dynamic arms enforce the tagId backstop (verifier R2/R3 duplicate)", () => {
    const handle = makeDynamicLowering(makeHostCtx());
    const noTag = fn(
      "noTag",
      [{ type: DYN, name: "x" }],
      [{ kind: "unbox", value: id(0), result: id(1), resultType: F64 }],
      [id(1)],
      [F64],
      2,
    );
    expect(() => lowerIrFunctionToWasm(noTag, stubResolver({ resolveDynamicLowering: () => handle }))).toThrow(
      /requires tagId/,
    );
  });
});

// ---------------------------------------------------------------------------
// Verifier R6 hardening — dynamic results only accept dynamic values
// ---------------------------------------------------------------------------

describe("#2949 s3 — R6: un-boxed ref→dynamic returns are rejected", () => {
  it("a string value returned into a dynamic result FAILS verify (needs a box)", () => {
    const f = fn("leak", [{ type: { kind: "string" }, name: "s" }], [], [id(0)], [DYN], 1);
    const errors = verifyIrFunction(f);
    expect(errors.some((e) => /not assignable to declared result dynamic/.test(e.message))).toBe(true);
  });

  it("boxing the value first makes the same shape verify clean", () => {
    const f = fn(
      "boxed",
      [{ type: { kind: "string" }, name: "s" }],
      [{ kind: "box", value: id(0), toType: DYN, result: id(1), resultType: DYN }],
      [id(1)],
      [DYN],
      2,
    );
    expect(verifyIrFunction(f)).toEqual([]);
  });

  it("dynamic and tag-refined dynamic values still flow into a dynamic result", () => {
    const bare = fn("moveDyn", [{ type: DYN, name: "x" }], [], [id(0)], [DYN], 1);
    expect(verifyIrFunction(bare)).toEqual([]);
    const refined = fn("moveRefined", [{ type: irDynamic(JS_TAG_IDS.String), name: "x" }], [], [id(0)], [DYN], 1);
    expect(verifyIrFunction(refined)).toEqual([]);
  });

  it("scalar→dynamic returns stay rejected (pre-existing rule, unchanged)", () => {
    const f = fn("scalarLeak", [{ type: F64, name: "n" }], [], [id(0)], [DYN], 1);
    const errors = verifyIrFunction(f);
    expect(errors.length).toBeGreaterThan(0);
  });
});
