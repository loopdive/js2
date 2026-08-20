// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * AnyValue boxing/unboxing helpers and wrapper struct types for
 * Number, String, and Boolean object wrappers.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import type { Instr, StructTypeDef, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import { ensureAnyToStringHelper, ensureNativeStringHelpers, nativeStringType } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { emitNativeParseNumber } from "./parse-number-native.js";
import { addFuncType } from "./registry/types.js";
import { addStringImportsDelegate, registerEnsureAnyHelpers } from "./shared.js";
import { registerAnyBoxHelpers, registerAnyUnboxHelpers } from "./any-boxing-helpers.js";
import { registerAnyEqHelpers } from "./any-eq-helpers.js";
import { buildFastStrictEqDispatch } from "./extern-eq-fast.js";
export const NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS = ["__typeof_number", "__unbox_number"] as const;
/**
 * Register the $AnyValue struct type for boxing `any` typed values.
 * The struct has a tag field to distinguish the boxed type at runtime,
 * plus payload fields for each possible value kind.
 *
 * Called lazily — only emitted when the module actually uses `any`-typed values.
 */
export function ensureAnyValueType(ctx: CodegenContext): void {
  if (ctx.anyValueTypeIdx >= 0) return; // already registered
  ctx.anyValueTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "AnyValue",
    fields: [
      { name: "tag", type: { kind: "i32" }, mutable: false },
      { name: "i32val", type: { kind: "i32" }, mutable: false },
      { name: "f64val", type: { kind: "f64" }, mutable: false },
      { name: "refval", type: { kind: "eqref" }, mutable: false },
      { name: "externval", type: { kind: "externref" }, mutable: false },
    ],
  });

  // (#2106 S1.0) Reserve the standalone `$undefined` singleton up-front, in the
  // same call that registers `$AnyValue`. It is an immutable tag-1 `$AnyValue`
  // global, so `undefined` is a distinct (non-null) reference while `null` stays
  // `ref.null extern`. Reserving it HERE — alongside the type, at first-use of
  // `any` — keeps it a GLOBAL added before any native-string finalize pass, so it
  // never drives the #329 late func-index shift (see `late-imports.ts:581-584`).
  //
  // S1.0 is INERT: nothing emits `global.get $undefined` yet (emitUndefined still
  // falls back to `ref.null.extern` in standalone). The producers + consumers flip
  // in S1.1/S1.2. Gated on standalone/native-strings so host mode (which has a real
  // host `undefined` via `__get_undefined`) is byte-identical and never allocates
  // this global. The tag-1 shape mirrors `__any_from_extern`'s `nullAny`
  // ({tag:1, i32val:0, f64val:NaN, refval:null, externval:null}).
  if ((ctx.standalone || ctx.nativeStrings) && ctx.undefinedGlobalIdx === undefined) {
    const EQ_HEAP_TYPE = -19; // WasmGC `eq` abstract heap type
    const anyTypeIdx = ctx.anyValueTypeIdx;
    const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: "__undefined",
      type: { kind: "ref", typeIdx: anyTypeIdx },
      mutable: false,
      init: [
        { op: "i32.const", value: 1 }, // tag = 1 (Undefined)
        { op: "i32.const", value: 0 }, // i32val
        { op: "f64.const", value: NaN }, // f64val
        { op: "ref.null", typeIdx: EQ_HEAP_TYPE }, // refval
        { op: "ref.null.extern" }, // externval
        { op: "struct.new", typeIdx: anyTypeIdx },
      ],
    });
    ctx.undefinedGlobalIdx = globalIdx;
  }
}

/**
 * Resolve the one physical carrier used by prepared IR `dynamic` values.
 *
 * Program-ABI planning records this exact type symbolically. Legacy allocation
 * sites that reserve a callable before IR preparation must use the same
 * contract rather than re-inferring an implicit `any` parameter from a paired
 * accessor signature (which can narrow it to string, for example).
 */
export function resolveIrDynamicCarrierType(ctx: CodegenContext): ValType {
  if (!ctx.fast) return { kind: "externref" };
  ensureAnyValueType(ctx);
  return { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
}

/**
 * (#2106 S1.0) Push the standalone `$undefined` singleton (a `ref $AnyValue`,
 * tag 1) onto the stack. Returns `false` (emitting nothing) when not in
 * standalone/native-strings mode or the singleton was not reserved — callers
 * then fall back to their existing `ref.null.extern` / host-`__get_undefined`
 * path. INERT until S1.1 routes `emitUndefined` here.
 */
export function emitUndefinedSingleton(ctx: CodegenContext, fctx: FunctionContext): boolean {
  if (!(ctx.standalone || ctx.nativeStrings)) return false;
  if (ctx.undefinedGlobalIdx === undefined) {
    ensureAnyValueType(ctx);
    if (ctx.undefinedGlobalIdx === undefined) return false;
  }
  fctx.body.push({ op: "global.get", index: ctx.undefinedGlobalIdx });
  return true;
}

/**
 * (#2106 S1) Is the `undefinedSingleton` regime ACTIVE for this module?
 * True only when the flag is set AND we are in standalone/native-strings mode
 * (host mode has a real host `undefined` via `__get_undefined` and is never
 * affected). Every producer/consumer flip of the S1 sweep gates on this, so
 * flag-off (default) modules are byte-identical to legacy.
 */
export function undefinedSingletonActive(ctx: CodegenContext): boolean {
  return ctx.undefinedSingleton === true && (ctx.standalone || ctx.nativeStrings);
}

/**
 * (#2106 S1) Push the `$undefined` singleton as an EXTERNREF (the externref-
 * plane representation of `undefined` under the `undefinedSingleton` regime).
 * Returns false (emitting nothing) when the regime is inactive or the
 * singleton cannot be reserved — callers keep their legacy `ref.null.extern`.
 */
export function emitUndefinedExtern(ctx: CodegenContext, fctx: FunctionContext): boolean {
  if (!undefinedSingletonActive(ctx)) return false;
  if (!emitUndefinedSingleton(ctx, fctx)) return false;
  fctx.body.push({ op: "extern.convert_any" });
  return true;
}

/**
 * (#2106 S1) The externref-plane "undefined singleton" INSTRUCTION SEQUENCE for
 * baked native bodies: `global.get $undefined; extern.convert_any`. Returns
 * undefined when the regime is inactive (callers keep `ref.null.extern`).
 * Reserves the singleton (via ensureAnyValueType) on first use.
 */
export function undefinedExternInstrs(ctx: CodegenContext): Instr[] | undefined {
  if (!undefinedSingletonActive(ctx)) return undefined;
  if (ctx.undefinedGlobalIdx === undefined) {
    ensureAnyValueType(ctx);
    if (ctx.undefinedGlobalIdx === undefined) return undefined;
  }
  return [{ op: "global.get", index: ctx.undefinedGlobalIdx }, { op: "extern.convert_any" }];
}

/**
 * (#2864 wave-2 S1) The CANONICAL `undefined` externref for the current lane,
 * NOT gated on the (default-off) #2106 `undefinedSingleton` regime flag.
 *
 * The distinction matters and was measured: `undefinedExternInstrs` above is
 * flag-gated, so with the flag off it returns `undefined` and callers fall back
 * to `ref.null.extern`. But the tag-1 `$undefined` singleton is reserved in
 * EVERY standalone/native-strings module (see `ensureAnyValueType`'s S1.0
 * reservation), and the rest of the standalone value model already
 * distinguishes it from `null` regardless of the flag — measured host-free:
 * `typeof undefined === "undefined"`, `undefined === null` is FALSE,
 * `typeof null === "object"`, and an unpassed argument compares
 * `SameValue`-equal to `undefined`. So a slot that fills itself with
 * `ref.null.extern` produces JS **null**, not `undefined`: the test262 harness
 * reported `SameValue(«null», «undefined»)` for every boxed-any generator's
 * terminal `{value: undefined, done: true}`.
 *
 * Use this where a value IS semantically `undefined`. Do NOT use it where the
 * old `ref.null.extern` meant "absent reference" — that is a different fact.
 */
export function canonicalUndefinedExternInstrs(ctx: CodegenContext): Instr[] {
  // Host lane: the real host `undefined` (a null externref surfaces as JS
  // `null` there). Read-only funcMap lookup — never registers a late import
  // mid-body, which would shift funcidxs under the caller.
  if (!(ctx.standalone || ctx.nativeStrings)) {
    const getUndefIdx = ctx.funcMap.get("__get_undefined");
    return getUndefIdx !== undefined ? [{ op: "call", funcIdx: getUndefIdx }] : [{ op: "ref.null.extern" }];
  }
  if (ctx.undefinedGlobalIdx === undefined) {
    ensureAnyValueType(ctx);
    if (ctx.undefinedGlobalIdx === undefined) return [{ op: "ref.null.extern" }];
  }
  return [{ op: "global.get", index: ctx.undefinedGlobalIdx }, { op: "extern.convert_any" }];
}

/**
 * (#2106 S1) Build the flagged "is this externref `undefined`?" body for a
 * `(externref) -> i32` native (param 0 = the value, `scratchAnyLocal` = an
 * anyref local). Under the singleton regime the predicate is:
 *   tag-1 `$AnyValue` box (the singleton, or any tag-1 box)  ∨
 *   `$BoxedNumber` carrying the UNDEF_F64 sentinel bits (#2979 arm)
 * and — critically — NOT `ref.is_null` (null is DISTINCT from undefined here;
 * a null externref answers 0 through the failing `ref.test`s).
 * Returns undefined when the regime is inactive or `$AnyValue` is unavailable
 * (callers keep their legacy `ref.is_null`-based body).
 */
export function buildIsUndefinedExternBody(
  ctx: CodegenContext,
  scratchAnyLocal: number,
  undefF64Bits: bigint,
): Instr[] | undefined {
  if (!undefinedSingletonActive(ctx)) return undefined;
  if (ctx.anyValueTypeIdx < 0) ensureAnyValueType(ctx);
  if (ctx.anyValueTypeIdx < 0) return undefined;
  const anyTypeIdx = ctx.anyValueTypeIdx;
  const boxedNumArm: Instr[] =
    ctx.nativeBoxNumberTypeIdx >= 0
      ? [
          { op: "local.get", index: scratchAnyLocal },
          { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: scratchAnyLocal },
              { op: "ref.cast", typeIdx: ctx.nativeBoxNumberTypeIdx },
              { op: "struct.get", typeIdx: ctx.nativeBoxNumberTypeIdx, fieldIdx: 0 },
              { op: "i64.reinterpret_f64" },
              { op: "i64.const", value: undefF64Bits },
              { op: "i64.eq" },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ]
      : [{ op: "i32.const", value: 0 }];
  return [
    // any = any.convert_extern(v)  (null externref → null anyref: both
    // ref.tests below answer 0, so null → NOT undefined, as required.)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: scratchAnyLocal },
    { op: "ref.test", typeIdx: anyTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: scratchAnyLocal },
        { op: "ref.cast", typeIdx: anyTypeIdx },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
      ],
      else: boxedNumArm,
    },
  ];
}

/**
 * (#4489) Emit `1` when the ANYREF in `anyLocalIdx` is NULLISH — either a null
 * reference or the tag-1 `$undefined` singleton — leaving an i32 on the stack.
 *
 * This is the `is_null ∨ is-singleton` widening the #2106 S1 sweep applied to
 * every nullish-INTENT consumer, in the shape the guarded-cast backup guard
 * needs (an anyref local, not an externref one — `emitGuardedRefCast` saves its
 * pre-cast value as anyref).
 *
 * Why it exists: once module-scope `var` slots hold the singleton instead of
 * `ref.null.extern` (#4489), a consumer that reads nullness as "unset" sees a
 * NON-null value where it used to see null. `emitNullCheckThrow`'s #789 backup
 * guard is exactly such a consumer, and there the difference is not a wrong
 * answer but an UNCATCHABLE one: it declines to throw, and the caller's
 * `struct.get` on the failed cast traps instead
 * (`language/statements/function/S13_A17_T1.js`, measured).
 *
 * Returns false (emitting nothing) when the singleton regime is inactive, so
 * host/gc-lane modules keep the plain `ref.is_null` and stay byte-identical.
 */
export function emitIsNullishAnyAt(ctx: CodegenContext, fctx: FunctionContext, anyLocalIdx: number): boolean {
  if (!undefinedSingletonActive(ctx)) return false;
  if (ctx.anyValueTypeIdx < 0) ensureAnyValueType(ctx);
  if (ctx.anyValueTypeIdx < 0) return false;
  const t = ctx.anyValueTypeIdx;
  fctx.body.push({ op: "local.get", index: anyLocalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 1 }],
    else: [
      { op: "local.get", index: anyLocalIdx },
      { op: "ref.test", typeIdx: t },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: anyLocalIdx },
          { op: "ref.cast", typeIdx: t },
          { op: "struct.get", typeIdx: t, fieldIdx: 0 },
          { op: "i32.const", value: 1 },
          { op: "i32.eq" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ],
  });
  return true;
}

/**
 * (#2106 S1) Emit a test that the externref in local `externLocalIdx` is a
 * tag-1 `$AnyValue` box (the `$undefined` singleton shape) — leaving an i32.
 * Deliberately does NOT include the #2979 UNDEF_F64 `$BoxedNumber` arm: this
 * is for CONTAINER-position checks (destructure guard) where the boxed
 * sentinel can be a scalarized `[undefined]` array, not undefined itself
 * (the #3010 55-test regression). `scratchAnyIdx` must be an anyref local.
 * Returns false (emitting nothing) when the regime is inactive.
 */
export function emitIsUndefinedSingletonExternAt(
  ctx: CodegenContext,
  fctx: FunctionContext,
  externLocalIdx: number,
  scratchAnyIdx: number,
): boolean {
  if (!undefinedSingletonActive(ctx)) return false;
  if (ctx.anyValueTypeIdx < 0) ensureAnyValueType(ctx);
  if (ctx.anyValueTypeIdx < 0) return false;
  const t = ctx.anyValueTypeIdx;
  fctx.body.push({ op: "local.get", index: externLocalIdx });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.tee", index: scratchAnyIdx });
  fctx.body.push({ op: "ref.test", typeIdx: t });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [
      { op: "local.get", index: scratchAnyIdx },
      { op: "ref.cast", typeIdx: t },
      { op: "struct.get", typeIdx: t, fieldIdx: 0 },
      { op: "i32.const", value: 1 },
      { op: "i32.eq" },
    ],
    else: [{ op: "i32.const", value: 0 }],
  });
  return true;
}

/**
 * Lazily register wrapper struct types for Number, String, Boolean.
 * Each wrapper is a struct with a single `value` field holding the primitive.
 * Also registers WrapperX_valueOf functions that extract the value.
 * Must be called before resolveWasmType is used for wrapper types.
 */
export function ensureWrapperTypes(ctx: CodegenContext): void {
  if (ctx.wrapperNumberTypeIdx >= 0) return; // already registered

  // $WrapperNumber: struct { value: f64 }
  ctx.wrapperNumberTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "WrapperNumber",
    fields: [{ name: "value", type: { kind: "f64" }, mutable: false }],
  } as StructTypeDef);
  ctx.structMap.set("WrapperNumber", ctx.wrapperNumberTypeIdx);
  ctx.typeIdxToStructName.set(ctx.wrapperNumberTypeIdx, "WrapperNumber");
  ctx.structFields.set("WrapperNumber", [{ name: "value", type: { kind: "f64" }, mutable: false }]);

  // $WrapperString: struct { value: externref }
  ctx.wrapperStringTypeIdx = ctx.mod.types.length;
  const strValType: ValType = ctx.nativeStrings ? nativeStringType(ctx) : { kind: "externref" };
  ctx.mod.types.push({
    kind: "struct",
    name: "WrapperString",
    fields: [{ name: "value", type: strValType, mutable: false }],
  } as StructTypeDef);
  ctx.structMap.set("WrapperString", ctx.wrapperStringTypeIdx);
  ctx.typeIdxToStructName.set(ctx.wrapperStringTypeIdx, "WrapperString");
  ctx.structFields.set("WrapperString", [{ name: "value", type: strValType, mutable: false }]);

  // $WrapperBoolean: struct { value: i32 }
  ctx.wrapperBooleanTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "WrapperBoolean",
    fields: [{ name: "value", type: { kind: "i32" }, mutable: false }],
  } as StructTypeDef);
  ctx.structMap.set("WrapperBoolean", ctx.wrapperBooleanTypeIdx);
  ctx.typeIdxToStructName.set(ctx.wrapperBooleanTypeIdx, "WrapperBoolean");
  ctx.structFields.set("WrapperBoolean", [{ name: "value", type: { kind: "i32" }, mutable: false }]);
}

/**
 * Emit valueOf helper functions for wrapper types.
 * Must be called after all imports are registered (so function indices are stable)
 * but before user functions that call valueOf.
 */
export function emitWrapperValueOfFunctions(ctx: CodegenContext): void {
  if (ctx.wrapperNumberTypeIdx < 0) return;
  if (ctx.funcMap.has("WrapperNumber_valueOf")) return; // already emitted

  const strValType: ValType = ctx.nativeStrings ? nativeStringType(ctx) : { kind: "externref" };

  // WrapperNumber_valueOf(self: ref $WrapperNumber) -> f64
  {
    const funcTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "func",
      params: [{ kind: "ref", typeIdx: ctx.wrapperNumberTypeIdx }],
      results: [{ kind: "f64" }],
    });
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "WrapperNumber_valueOf",
      typeIdx: funcTypeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: ctx.wrapperNumberTypeIdx, fieldIdx: 0 },
      ],
      exported: false,
    });
    ctx.funcMap.set("WrapperNumber_valueOf", funcIdx);
  }

  // WrapperString_valueOf(self: ref $WrapperString) -> externref/ref
  {
    const funcTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "func",
      params: [{ kind: "ref", typeIdx: ctx.wrapperStringTypeIdx }],
      results: [strValType],
    });
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "WrapperString_valueOf",
      typeIdx: funcTypeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: ctx.wrapperStringTypeIdx, fieldIdx: 0 },
      ],
      exported: false,
    });
    ctx.funcMap.set("WrapperString_valueOf", funcIdx);
  }

  // WrapperBoolean_valueOf(self: ref $WrapperBoolean) -> i32
  {
    const funcTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "func",
      params: [{ kind: "ref", typeIdx: ctx.wrapperBooleanTypeIdx }],
      results: [{ kind: "i32" }],
    });
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "WrapperBoolean_valueOf",
      typeIdx: funcTypeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: ctx.wrapperBooleanTypeIdx, fieldIdx: 0 },
      ],
      exported: false,
    });
    ctx.funcMap.set("WrapperBoolean_valueOf", funcIdx);
  }
}

/**
 * Check if a ValType represents a boxed `any` value (ref $AnyValue).
 */
export function isAnyValue(type: ValType, ctx: CodegenContext): boolean {
  return (
    (type.kind === "ref" || type.kind === "ref_null") &&
    (type as { typeIdx: number }).typeIdx === ctx.anyValueTypeIdx &&
    ctx.anyValueTypeIdx >= 0
  );
}

export function ensureAnyFromExternHelper(ctx: CodegenContext, opts?: { forceHonest?: boolean }): number | undefined {
  if (ctx.targetProfile.semanticProviders !== "native-first") return undefined;
  if (ctx.nativeBoxNumberTypeIdx < 0 || ctx.nativeBoxBooleanTypeIdx < 0) return undefined;

  // (#3037 CS1b) The reader-carrier consumers need an ALWAYS-honest classifier
  // (`$AnyString`→tag-5, `$BoxedNumber`→tag-3, `$BoxedBoolean`→tag-4,
  // other-eq-castable GC ref→tag-6 identity) irrespective of the module-wide
  // `honestAnyBoxing` flag (default OFF). It is emitted under a DISTINCT name
  // (`__any_from_extern_honest`) so it never collides with, nor mutates, the
  // flag-driven generic instance that the −788 chokepoint depends on. Honest
  // classification requires the `$AnyString` type to be reserved; without it a
  // genuine string would mis-classify tag-6, so refuse (the caller keeps the
  // bare externref — safe, only under-fixes via S3a's cross-tag arm).
  const forceHonest = opts?.forceHonest === true;
  if (forceHonest && ctx.anyStrTypeIdx < 0) return undefined;
  const helperName = forceHonest ? "__any_from_extern_honest" : "__any_from_extern";

  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  ensureAnyValueType(ctx);
  const anyTypeIdx = ctx.anyValueTypeIdx;
  const anyRef: ValType = { kind: "ref", typeIdx: anyTypeIdx };
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [anyRef], helperName);
  const funcIdx = mintDefinedFunc(ctx);
  const EQ_HEAP_TYPE = -19;

  // (#2141 S1) The two regimes share every arm except the null box and the
  // unrecognized-value fallback. Legacy (flag off, byte-identical): fresh
  // tag-1 null box; everything unrecognized → tag 5 "string" (the #1888
  // box-the-externref lie). Honest (ctx.honestAnyBoxing): null → the
  // `$undefined` singleton when reserved; unrecognized → classify —
  // `$AnyString` → honest tag 5, other eq-castable GC ref → tag 6 (identity in
  // refval), non-eq host-opaque → tag 6 with the externref parked (unreachable
  // in standalone/wasi; kept total). Honest additionally requires
  // `anyStrTypeIdx` — without the string test a genuine string would
  // mis-classify as tag-6 object, so fall back to the legacy arms instead.
  const honest = (forceHonest || ctx.honestAnyBoxing === true) && ctx.anyStrTypeIdx >= 0;
  // (#2106 S1) Under the `undefinedSingleton` regime a NULL externref means JS
  // NULL (undefined is the non-null tag-1 singleton, recovered exactly by the
  // `ref.test $AnyValue` arm below) — so the null arm boxes tag-0. This is
  // what makes the tag-0 → tag-1 round-trip lie (see `__any_to_extern`'s tail
  // comment) actually FIXED in the flag regime. Legacy/honest arms unchanged.
  const nullAny: Instr[] = undefinedSingletonActive(ctx)
    ? [
        { op: "i32.const", value: 0 },
        { op: "i32.const", value: 0 },
        { op: "f64.const", value: 0 },
        { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.null.extern" },
        { op: "struct.new", typeIdx: anyTypeIdx },
      ]
    : honest && ctx.undefinedGlobalIdx !== undefined
      ? [{ op: "global.get", index: ctx.undefinedGlobalIdx }]
      : [
          { op: "i32.const", value: 1 },
          { op: "i32.const", value: 0 },
          { op: "f64.const", value: NaN },
          { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
          { op: "ref.null.extern" },
          { op: "struct.new", typeIdx: anyTypeIdx },
        ];
  const fallbackStringAny: Instr[] = honest
    ? [
        // $AnyString → tag 5 (string, externval) — the only honest tag-5.
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 5 },
            { op: "i32.const", value: 0 },
            { op: "f64.const", value: 0 },
            { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
            { op: "local.get", index: 0 },
            { op: "struct.new", typeIdx: anyTypeIdx },
            { op: "return" },
          ],
        },
        // Other GC (eq-castable) reference → tag 6 object, identity in refval.
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 6 },
            { op: "i32.const", value: 0 },
            { op: "f64.const", value: 0 },
            { op: "local.get", index: 1 },
            { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
            { op: "ref.null.extern" },
            { op: "struct.new", typeIdx: anyTypeIdx },
            { op: "return" },
          ],
        },
        // Non-eq host-opaque extern → tag 6 with the externref parked.
        { op: "i32.const", value: 6 },
        { op: "i32.const", value: 0 },
        { op: "f64.const", value: 0 },
        { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
        { op: "local.get", index: 0 },
        { op: "struct.new", typeIdx: anyTypeIdx },
      ]
    : [
        { op: "i32.const", value: 5 },
        { op: "i32.const", value: 0 },
        { op: "f64.const", value: 0 },
        { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
        { op: "local.get", index: 0 },
        { op: "struct.new", typeIdx: anyTypeIdx },
      ];

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...nullAny, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: anyTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 1 }, { op: "ref.cast", typeIdx: anyTypeIdx }, { op: "return" }],
    },
    { op: "local.get", index: 1 },
    { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 3 },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: ctx.nativeBoxNumberTypeIdx },
        { op: "struct.get", typeIdx: ctx.nativeBoxNumberTypeIdx, fieldIdx: 0 },
        { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.null.extern" },
        { op: "struct.new", typeIdx: anyTypeIdx },
        { op: "return" },
      ],
    },
    // (#3673) i31-boxed small int → tag-3 (f64) number classification, so
    // every downstream tag consumer (__any_add / __any_eq / __any_to_f64)
    // sees it as an ordinary number.
    { op: "local.get", index: 1 },
    { op: "ref.test", typeIdx: -20 },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 3 },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: -20 },
        { op: "i31.get_s" },
        { op: "f64.convert_i32_s" },
        { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.null.extern" },
        { op: "struct.new", typeIdx: anyTypeIdx },
        { op: "return" },
      ],
    },
    { op: "local.get", index: 1 },
    { op: "ref.test", typeIdx: ctx.nativeBoxBooleanTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 4 },
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: ctx.nativeBoxBooleanTypeIdx },
        { op: "struct.get", typeIdx: ctx.nativeBoxBooleanTypeIdx, fieldIdx: 0 },
        { op: "f64.const", value: 0 },
        { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.null.extern" },
        { op: "struct.new", typeIdx: anyTypeIdx },
        { op: "return" },
      ],
    },
    ...fallbackStringAny,
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: [{ name: "any", type: { kind: "anyref" } }],
    body,
    exported: false,
  });
  ctx.funcMap.set(helperName, funcIdx);
  ctx.anyHelpers.set(helperName, funcIdx);
  return funcIdx;
}

/**
 * (#1461/#54) Native standalone `(externref, externref) -> i32` strict-equality
 * (`===`, StrictEqualityComparison) over two boxed externref values. The pure-Wasm
 * replacement for the `__host_eq` host import in the array-like search arm
 * (`indexOf`/`lastIndexOf`). Composes the two existing engine-owned helpers:
 * `__any_from_extern` (recovers a boxed externref primitive — number/boolean/
 * string/null/object — into a uniform `(ref $AnyValue)`) then `__any_strict_eq`
 * (===-compares two `$AnyValue`, numeric class unified via `f64.eq` ⇒ NaN≠NaN,
 * strings by content, objects by identity). Standalone-only; returns undefined
 * otherwise (caller keeps the host import).
 */
export function ensureExternStrictEqHelper(ctx: CodegenContext): number | undefined {
  if (ctx.targetProfile.semanticProviders !== "native-first") return undefined;
  const existing = ctx.funcMap.get("__extern_strict_eq");
  if (existing !== undefined) return existing;
  const fromExternIdx = ensureAnyFromExternHelper(ctx);
  ensureAnyHelpers(ctx);
  const strictEqIdx = ctx.funcMap.get("__any_strict_eq");
  if (fromExternIdx === undefined || strictEqIdx === undefined) return undefined;

  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
    "__extern_strict_eq",
  );
  const funcIdx = mintDefinedFunc(ctx);
  const EQ_HEAP_TYPE = -19; // WasmGC `eq` abstract heap type
  // (#4173) Fast tag-pair dispatch for the identity-MISS path — flag-gated
  // (`ctx.fastStrictEq`, default ON), built in extern-eq-fast.ts. `[]` when
  // the fast path cannot be built (flag off / missing box types / strings
  // present without a native `__str_equals`).
  const fastDispatch = buildFastStrictEqDispatch(ctx);
  const body: Instr[] = [
    // (#2734) Object/reference-identity fast path. `__any_from_extern` has no
    // dedicated Object tag — it folds an object externref into the tag-5 (string)
    // fallback, so the `__any_strict_eq` below would string-compare two objects
    // and never match them by identity (`[o].indexOf(o)` → -1). That regressed
    // the `built-ins/Array/prototype/{indexOf,lastIndexOf}/...` object-element
    // cluster (and `includes`, which calls this helper) when #2719 replaced the
    // `__host_eq` import with this native arm. Internalise both externrefs; if
    // both are non-null `eq` refs and `ref.eq` (the SAME reference), they are
    // `===` → return 1. Otherwise fall through to the primitive comparison. This
    // never false-positives a primitive: distinct number/string boxes are
    // distinct refs (→ value comparison); only a genuinely identical reference
    // short-circuits. `null`/non-eq values fail `ref.test (ref eq)` and fall
    // through (so `null === null` etc. stay handled by `__any_strict_eq`).
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 2 },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 3 },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "local.get", index: 3 },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          // (#3174) EXCEPT the `$BoxedNumber` carrier: §7.2.16 IsStrictlyEqual
          // routes both-Number operands to Number::equal (§6.1.6.1.13), whose
          // step 1/2 make `NaN === NaN` FALSE even when both sides are the
          // very same reference. The SAME `__box_number` box reaches both
          // params whenever one `any` local is compared against itself —
          // `a !== a` (the harness `isSameValue` NaN probe, and every
          // `assert.sameValue(x, NaN)` in the standalone lane) — so an
          // unconditional identity return answered `NaN === NaN` → true and
          // silently failed ~50 `built-ins/Date` invalid-date/NaN rows. A
          // same-ref non-NaN number box falls through to the tag-3 `f64.eq`
          // primitive comparison below and stays `===` (true), so the ONLY
          // behavioral flip is the spec-required NaN one. Object identity
          // (#2734) and the $BigInt value arm (#3173) are untouched: neither
          // can hold NaN.
          then:
            ctx.nativeBoxNumberTypeIdx >= 0
              ? [
                  { op: "local.get", index: 2 },
                  { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "i32.const", value: 1 }, { op: "return" }],
                  },
                ]
              : [{ op: "i32.const", value: 1 }, { op: "return" }],
        },
        // (#4173) identity MISSED and both sides are eq-refs — the fast
        // tag-pair dispatch (see canFastDispatch above) decides every
        // non-$AnyValue pairing right here, alloc- and call-free.
        ...fastDispatch,
      ],
    },
    // (#3173) $BigInt-box arm: two DISTINCT bigint boxes with the same i64
    // value are `===` (§7.2.15 step 1: both BigInt → BigInt::equal). The
    // `__any_from_extern` classification below has no bigint tag — it folded
    // bigint boxes into the object fallback, so `dv.getBigInt64(0) === 0n`
    // (each side freshly boxed) compared by REFERENCE and was always false
    // whenever this helper (not the inline `===` cascade, which has a
    // typeof_bigint arm) served the comparison. Mixed bigint/number operands
    // fall through — the classification keeps them unequal, matching
    // `1n === 1` → false.
    ...((ctx.nativeBigIntTypeIdx >= 0
      ? [
          { op: "local.get", index: 2 },
          { op: "ref.test", typeIdx: ctx.nativeBigIntTypeIdx },
          { op: "local.get", index: 3 },
          { op: "ref.test", typeIdx: ctx.nativeBigIntTypeIdx },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 2 },
              { op: "ref.cast", typeIdx: ctx.nativeBigIntTypeIdx },
              { op: "struct.get", typeIdx: ctx.nativeBigIntTypeIdx, fieldIdx: 0 },
              { op: "local.get", index: 3 },
              { op: "ref.cast", typeIdx: ctx.nativeBigIntTypeIdx },
              { op: "struct.get", typeIdx: ctx.nativeBigIntTypeIdx, fieldIdx: 0 },
              { op: "i64.eq" },
              { op: "return" },
            ],
          },
        ]
      : []) satisfies Instr[]),
    // Primitive comparison (numbers unified via f64.eq, strings by content,
    // booleans, null/undefined by tag) for everything the fast path didn't match.
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: fromExternIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: fromExternIdx },
    { op: "call", funcIdx: strictEqIdx },
  ];
  pushDefinedFunc(ctx, funcIdx, {
    name: "__extern_strict_eq",
    typeIdx,
    locals: [
      { name: "a_any", type: { kind: "anyref" } },
      { name: "b_any", type: { kind: "anyref" } },
    ],
    body,
    exported: false,
  });
  ctx.funcMap.set("__extern_strict_eq", funcIdx);
  return funcIdx;
}

/**
 * Native standalone `(externref, externref) -> i32` loose equality. Each
 * carrier is classified by the shared externref-to-AnyValue helper and the
 * existing `__any_eq` body owns the complete IsLooselyEqual dispatch.
 */
export function ensureExternLooseEqHelper(ctx: CodegenContext): number | undefined {
  if (ctx.targetProfile.semanticProviders !== "native-first") return undefined;
  const existing = ctx.funcMap.get("__extern_loose_eq");
  if (existing !== undefined) return existing;
  const fromExternIdx = ensureAnyFromExternHelper(ctx);
  ensureAnyHelpers(ctx);
  const anyEqIdx = ctx.funcMap.get("__any_eq");
  if (fromExternIdx === undefined || anyEqIdx === undefined) return undefined;

  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
    "__extern_loose_eq",
  );
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__extern_loose_eq",
    typeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: fromExternIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: fromExternIdx },
      { op: "call", funcIdx: anyEqIdx },
    ],
    exported: false,
  });
  ctx.funcMap.set("__extern_loose_eq", funcIdx);
  ctx.anyHelpers.set("__extern_loose_eq", funcIdx);
  return funcIdx;
}

/**
 * (#1461/#54) Native standalone `(externref, externref) -> i32` SameValueZero
 * (§7.2.11) over two boxed externref values — the pure-Wasm replacement for the
 * `__same_value_zero` host import in the array-like `includes` search arm.
 * SameValueZero differs from `===` ONLY in `NaN`: SameValueZero(NaN, NaN) is
 * true (and +0/−0 are equal under both, which `f64.eq` already gives). So:
 * `__extern_strict_eq(a, b) || (a and b are both NaN numbers)`. The NaN test
 * recovers both via `__any_from_extern`, checks tag ∈ {2,3} (number) and the
 * f64 self-inequality (`x !== x`).
 */
export function ensureExternSameValueZeroHelper(ctx: CodegenContext): number | undefined {
  if (ctx.targetProfile.semanticProviders !== "native-first") return undefined;
  const existing = ctx.funcMap.get("__extern_same_value_zero");
  if (existing !== undefined) return existing;
  const strictEqExternIdx = ensureExternStrictEqHelper(ctx);
  const fromExternIdx = ensureAnyFromExternHelper(ctx);
  ensureAnyValueType(ctx);
  const anyTypeIdx = ctx.anyValueTypeIdx;
  if (strictEqExternIdx === undefined || fromExternIdx === undefined || anyTypeIdx < 0) return undefined;

  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
    "__extern_same_value_zero",
  );
  const funcIdx = mintDefinedFunc(ctx);
  // locals: 2,3 = the two recovered $AnyValue refs.
  const anyRef: ValType = { kind: "ref", typeIdx: anyTypeIdx };
  // Returns 1 if `local.get idx`'s $AnyValue is a NaN number (tag 2/3 + f64 self-ne).
  const isNanNumber = (idx: number): Instr[] => [
    { op: "local.get", index: idx },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 }, // tag
    { op: "i32.const", value: 3 },
    { op: "i32.eq" }, // f64-number tag (NaN only lives in the f64 field)
    { op: "local.get", index: idx },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 }, // f64 val
    { op: "local.get", index: idx },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
    { op: "f64.ne" }, // x !== x  ⇒ NaN
    { op: "i32.and" },
  ];
  const body: Instr[] = [
    // if (strict_eq) return 1
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: strictEqExternIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        // both-NaN: recover both, test each is a NaN number.
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: fromExternIdx },
        { op: "local.set", index: 2 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: fromExternIdx },
        { op: "local.set", index: 3 },
        ...isNanNumber(2),
        ...isNanNumber(3),
        { op: "i32.and" },
      ],
    },
  ];
  pushDefinedFunc(ctx, funcIdx, {
    name: "__extern_same_value_zero",
    typeIdx,
    locals: [
      { name: "a_any", type: anyRef },
      { name: "b_any", type: anyRef },
    ],
    body,
    exported: false,
  });
  ctx.funcMap.set("__extern_same_value_zero", funcIdx);
  return funcIdx;
}

export function ensureAnyToExternHelper(ctx: CodegenContext): number | undefined {
  if (ctx.targetProfile.semanticProviders !== "native-first") return undefined;
  if (ctx.anyValueTypeIdx < 0) return undefined;

  const existing = ctx.funcMap.get("__any_to_extern");
  if (existing !== undefined) return existing;

  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  if (boxNumberIdx === undefined || boxBooleanIdx === undefined) return undefined;

  const anyTypeIdx = ctx.anyValueTypeIdx;
  const anyRefNull: ValType = { kind: "ref_null", typeIdx: anyTypeIdx };
  const typeIdx = addFuncType(ctx, [anyRefNull], [{ kind: "externref" }], "__any_to_extern");
  const funcIdx = mintDefinedFunc(ctx);

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 1 },
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: boxNumberIdx },
        { op: "return" },
      ],
    },
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 3 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
        { op: "call", funcIdx: boxNumberIdx },
        { op: "return" },
      ],
    },
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 4 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        { op: "call", funcIdx: boxBooleanIdx },
        { op: "return" },
      ],
    },
    // A genuine native string payload is safe to unwrap. Generic externref
    // boxing recreates exactly the same tag-5 string box on the next any-typed
    // operation. Keeping the whole box here instead creates a nested tag-5
    // carrier; a second `+` then classifies the inner `$AnyValue` as an object
    // (`let s = ""; s += "a"; s += "b"` became NaN in the standalone
    // interpreter). The runtime type test is essential because field 4 is also
    // used by legacy tag-5 boxes for numbers, booleans, null, and opaque refs.
    ...((ctx.anyStrTypeIdx >= 0
      ? [
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 5 },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
                  { op: "return" },
                ],
              },
            ],
          },
        ]
      : []) satisfies Instr[]),
    // (#2106 S1) Under the `undefinedSingleton` regime tag 0 (null) unwraps to
    // its canonical externref-plane representation `ref.null.extern` — and the
    // round-trip is SAFE there because `__any_from_extern`'s null arm boxes
    // tag-0 back (not the legacy tag-1). Tag 1 (undefined) stays wrapped: an
    // extern-wrapped tag-1 `$AnyValue` IS the regime's undefined representation
    // (all predicates are tag-keyed, not identity-keyed).
    ...((undefinedSingletonActive(ctx)
      ? [
          { op: "local.get", index: 1 },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "ref.null.extern" }, { op: "return" }],
          },
        ]
      : []) satisfies Instr[]),
    // Tags 0 (null), 1 (undefined), non-string-overloaded 5, and 6 (GC ref):
    // keep the WHOLE $AnyValue box wrapped via extern.convert_any.
    // Standalone/WASI has no host that needs unwrapped values, and
    // __any_from_extern recovers the wrapped box exactly via its `ref.test
    // $AnyValue` arm — preserving the tag and reference identity. Unwrapping
    // these here is NOT round-trip-safe (see the S1 and guarded-string arms):
    //   - tag 0 came back as tag 1 (null → undefined across every boundary),
    //   - tag 6 (raw struct) was mis-tagged as tag 5 (string) by the
    //     __any_from_extern fallback.
    // Numeric/boolean carriers (tags 2/3/4) and proven native strings are the
    // only values unwrapped; every other carrier takes this wrapped tail.
    { op: "local.get", index: 0 },
    { op: "ref.as_non_null" },
    { op: "extern.convert_any" },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__any_to_extern",
    typeIdx,
    locals: [{ name: "tag", type: { kind: "i32" } }],
    body,
    exported: false,
  });
  ctx.funcMap.set("__any_to_extern", funcIdx);
  ctx.anyHelpers.set("__any_to_extern", funcIdx);
  return funcIdx;
}

/**
 * Emit inline wasm helper functions for boxing/unboxing `any` values.
 * Called lazily when any-typed operations are first encountered.
 */
export function ensureAnyHelpers(ctx: CodegenContext): void {
  if (ctx.anyHelpersEmitted) return;
  ctx.anyHelpersEmitted = true;

  // Ensure the $AnyValue struct type is registered before emitting helpers
  ensureAnyValueType(ctx);

  // Ensure wasm:js-string imports are available for string content comparison
  addStringImportsDelegate(ctx);

  const anyTypeIdx = ctx.anyValueTypeIdx;
  const anyRef: ValType = { kind: "ref", typeIdx: anyTypeIdx };
  const anyRefNull: ValType = { kind: "ref_null", typeIdx: anyTypeIdx };

  // String content comparison via wasm:js-string equals (tag 5)
  const strEqualsIdx = ctx.jsStringImports.get("equals") ?? -1;

  // (#2081) StringToNumber scanner (§7.1.4.1) for the cross-tag String⇄Number
  // loose-equality arm in `__any_eq`. Only the standalone/WASI native-string
  // path has it (signature `(externref) -> f64`; converts the externref back to
  // `ref $AnyString` internally — NaN for unparseable, 0 for empty, hex/inf
  // handled). Host mode uses `__host_loose_eq`, so leave this -1 there and the
  // arm stays a conservative `0` (no regression — host never reaches __any_eq).
  // Mirrors the static-type lowering at binary-ops.ts:881-889; deliberately NOT
  // `parseFloat` (Number("0xff")=255 but parseFloat("0xff")=NaN — §7.1.4.1).
  let strToNumIdx = -1;
  if (ctx.targetProfile.semanticProviders === "native-first" && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    if (!ctx.funcMap.has("__str_to_number")) {
      emitNativeParseNumber(ctx, new Set(["__str_to_number"]));
    }
    strToNumIdx = ctx.funcMap.get("__str_to_number") ?? -1;
  }

  // (#1988) Standalone/WASI `+` string-concat support for the `__any_add`
  // helper. §13.15.3 ApplyStringOrNumericBinaryOperator: a string operand — or
  // an object/array operand, whose ToPrimitive(default)→toString yields a
  // string — forces string CONCATENATION, not numeric addition. The base
  // `__any_add` only had i32/f64 arms, so `{} + {}`, `[] + []`, `1 + {}`
  // wrongly hit the f64 arm → NaN. The concat arm below needs four native
  // helpers; register them FIRST (idempotent) so their funcIdx values are
  // stable when `__any_add`'s body bakes them in — mirroring how `strToNumIdx`
  // above is captured for `__any_eq`. Host mode never builds `__any_add` (it
  // routes `+` through the `__host_add` import), so this is standalone-only and
  // cannot regress the host path.
  let externToStringIdx = -1;
  let anyToStringIdx = -1;
  let strConcatIdx = -1;
  if (ctx.targetProfile.semanticProviders === "native-first" && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    ensureNativeStringHelpers(ctx);
    ensureObjectRuntime(ctx); // registers native __extern_toString + __to_primitive
    anyToStringIdx = ensureAnyToStringHelper(ctx); // (anyref AnyValue) → ref $AnyString, tag-dispatched
    externToStringIdx = ctx.funcMap.get("__extern_toString") ?? -1;
    strConcatIdx = ctx.nativeStrHelpers.get("__str_concat") ?? -1;
  }
  // True when the standalone concat arm can be built (all pieces present).
  const anyAddCanConcat = anyToStringIdx >= 0 && externToStringIdx >= 0 && strConcatIdx >= 0 && ctx.anyStrTypeIdx >= 0;

  // (#2583) Native string-CONTENT equality for the tag-5 arms of `__any_eq` /
  // `__any_strict_eq` in standalone/WASI, where the host `wasm:js-string equals`
  // import (`strEqualsIdx`) is ABSENT (-1) — so the tag-5 arm otherwise collapses
  // to a constant `0` and two equal boxed strings compare unequal. This silently
  // broke standalone `__any_strict_eq` on boxed strings, surfaced by #2583's
  // any-array `indexOf`/`includes` (which compares elements via
  // `__extern_strict_eq` → `__any_strict_eq`). Each operand's tag-5 `externval`
  // (fieldIdx 4) holds an `extern.convert_any($AnyString)`; recover it to
  // `$AnyString`, `__str_flatten` to `$NativeString`, then native `__str_equals`.
  // Mirrors the static `===` lowering's native path. Registered under the same
  // gate as the concat arm (helpers idempotent).
  let nativeStrFlattenIdx = -1;
  let nativeStrEqualsIdx = -1;
  if (ctx.targetProfile.semanticProviders === "native-first" && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    ensureNativeStringHelpers(ctx);
    nativeStrFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten") ?? -1;
    nativeStrEqualsIdx = ctx.nativeStrHelpers.get("__str_equals") ?? -1;
  }
  // True when the native (host-import-free) tag-5 string-eq arm can be built.
  const canNativeStrEq = nativeStrFlattenIdx >= 0 && nativeStrEqualsIdx >= 0 && ctx.anyStrTypeIdx >= 0;
  // Build the tag-5 string-content comparison `then` body. Prefers the host
  // `wasm:js-string equals` (gc/host mode) and falls back to the native flatten +
  // `__str_equals` path (standalone/WASI). `0` only when neither is available.
  const tag5StringEqThen = (): Instr[] => {
    if (strEqualsIdx >= 0) {
      return [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
        { op: "call", funcIdx: strEqualsIdx },
      ];
    }
    if (canNativeStrEq) {
      // GUARD the native string-content compare on `ref.test $AnyString` of BOTH
      // field-4 externvals. The tag-5 field-4 is overloaded — under tag 5 it can
      // hold a genuine string OR a non-string GC object/closure (e.g. the boxed
      // generator a destructuring default-parameter `undefined`-check compares).
      // Without this guard the unconditional `ref.cast $AnyString` TRAPS on those
      // non-string carriers ("illegal cast"), which mis-answers
      // `__any_strict_eq(arg, <non-string>)` and corrupts the default-application
      // decision (empty `[]=gen` then wrongly iterates the generator — the −162
      // standalone class/dstr regression that ejected #1888). Both-not-string ⇒
      // legacy `0`, matching main's standalone behaviour. (#1864's original arm
      // carried this guard; #1888's recoverNative refactor dropped it.) Recover
      // each field-4 once into the anyA/anyB scratch locals (4/5).
      const recoverAny = (operandIdx: number, scratchIdx: number): Instr[] => [
        { op: "local.get", index: operandIdx },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
        { op: "any.convert_extern" },
        { op: "local.set", index: scratchIdx },
      ];
      const castFlatten = (scratchIdx: number): Instr[] => [
        { op: "local.get", index: scratchIdx },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        { op: "call", funcIdx: nativeStrFlattenIdx },
      ];
      return [
        ...recoverAny(0, 4),
        ...recoverAny(1, 5),
        { op: "local.get", index: 4 },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        { op: "local.get", index: 5 },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [...castFlatten(4), ...castFlatten(5), { op: "call", funcIdx: nativeStrEqualsIdx }],
          else: [{ op: "i32.const", value: 0 }],
        },
      ];
    }
    return [{ op: "i32.const", value: 0 }];
  };

  // (#2141 S2/S3, #2626 — flag-gated, OFF by default) The three-way tag-5
  // boxed-VALUE true-class classifier for the both-tags-5 arm of
  // `__any_eq`/`__any_strict_eq`: Number×Number → `f64.eq` over
  // `__any_to_f64` recovery (#2040; NaN self-false preserved), String×String
  // → guarded content eq (the landed #1888 arm), Object×Object → `ref.eq`
  // identity (#2585), else legacy `0`. Gated on `ctx.tag5ValueEqClassifier`
  // (CompileOptions; `JS2WASM_TAG5_CLASSIFIER=1` env defaults it on for
  // whole-runner A/B). OFF ⇒ byte-identical legacy: only the guarded string
  // arm, so non-string tag-5 pairs answer `0` — which also makes a lie-boxed
  // value SELF-unequal (fake NaN). The test262 comparator `isSameValue`
  // (`a===b || (a!==a && b!==b)`) therefore answers TRUE for EVERY pair of
  // lie-boxed operands — the vacuous-pass mask that made #1888's classifier
  // eject at −162: the arms don't break dstr, they UNMASK latent failures of
  // the eager-buffer generator fixture (see #2141 S2 root cause + #3032).
  // DEFAULT-ON since the #2040 A1 flip (2026-07-16): the #3032 waves
  // (W3 TDZ threading / #3302 capturing expressions / W4 method generators)
  // landed, removing the eager-buffer vacuity. `JS2WASM_TAG5_CLASSIFIER=0`
  // forces the legacy arm.
  // GATE (pitfall from sd-3's attempt, memory
  // reference_2040_tag5_field4_three_way_classifier: never gate the numeric
  // arm on string availability): the classifier builds whenever the flag is
  // on in standalone/wasi. The STRING arm needs the native content-eq
  // (`canNativeStrEq`); in a module with NO string type at all
  // (`anyStrTypeIdx < 0`, e.g. a pure-numeric program) tag-5 $AnyString
  // payloads cannot exist, so the string arm is safely OMITTED and the
  // numeric/object arms still work. If strings exist but content-eq is
  // unavailable (host-import-only shapes), fall back to legacy entirely —
  // classifying without a string arm would send equal-content distinct
  // strings into the object `ref.eq` arm (wrong false).
  const tag5ValueEqThen = (): Instr[] => {
    if (!ctx.tag5ValueEqClassifier || ctx.targetProfile.semanticProviders !== "native-first") {
      return tag5StringEqThen();
    }
    if (!canNativeStrEq && ctx.anyStrTypeIdx >= 0) return tag5StringEqThen();
    const recoverAny = (operandIdx: number, scratchIdx: number): Instr[] => [
      { op: "local.get", index: operandIdx },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
      { op: "any.convert_extern" },
      { op: "local.set", index: scratchIdx },
    ];
    const castFlatten = (scratchIdx: number): Instr[] => [
      { op: "local.get", index: scratchIdx },
      { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      { op: "call", funcIdx: nativeStrFlattenIdx },
    ];
    const bothTest = (typeIdx: number): Instr[] => [
      { op: "local.get", index: 4 },
      { op: "ref.test", typeIdx },
      { op: "local.get", index: 5 },
      { op: "ref.test", typeIdx },
      { op: "i32.and" },
    ];
    const EQ = -19;
    const objectArm: Instr[] = [
      ...bothTest(EQ),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 4 },
          { op: "ref.cast", typeIdx: EQ },
          { op: "local.get", index: 5 },
          { op: "ref.cast", typeIdx: EQ },
          { op: "ref.eq" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ];
    // String arm only when the module HAS a string type (see gate note above);
    // a string-free module cannot carry $AnyString payloads in tag-5 boxes.
    const stringArm: Instr[] = canNativeStrEq
      ? [
          ...bothTest(ctx.anyStrTypeIdx),
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [...castFlatten(4), ...castFlatten(5), { op: "call", funcIdx: nativeStrEqualsIdx }],
            else: objectArm,
          },
        ]
      : objectArm;
    // Numeric arm requires the native $BoxedNumber type (always registered in
    // standalone/wasi before the eq helpers build — union imports first); the
    // S2 bisect (2026-07-04) confirmed the numeric AND object arms EACH
    // independently unmask the dstr canary, so there is no safe arm subset.
    const numericArm: Instr[] =
      ctx.nativeBoxNumberTypeIdx >= 0
        ? [
            ...bothTest(ctx.nativeBoxNumberTypeIdx),
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: toF64IdxFwd() },
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: toF64IdxFwd() },
                { op: "f64.eq" },
              ],
              else: stringArm,
            },
          ]
        : stringArm;
    return [...recoverAny(0, 4), ...recoverAny(1, 5), ...numericArm];
  };
  // __any_to_f64 is registered later in this function; resolve at build time
  // of the eq helpers (they are added after it, so the map lookup is safe).
  const toF64IdxFwd = (): number => ctx.funcMap.get("__any_to_f64")!;

  // Helper to register a helper function
  function addHelper(
    name: string,
    params: ValType[],
    results: ValType[],
    body: Instr[],
    locals?: { name: string; type: ValType }[],
  ): void {
    const typeIdx = addFuncType(ctx, params, results, name);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: locals ?? [],
      body,
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
    ctx.anyHelpers.set(name, funcIdx);
  }

  // ref.null eq — the eq abstract heap type is encoded as byte 0x6d.
  // In signed LEB128 (used by enc.i32), 0x6d = -19 (7-bit two's complement).
  const EQ_HEAP_TYPE = -19; // signed LEB128 → 0x6d → TYPE.eq

  registerAnyBoxHelpers(ctx, addHelper, anyRef, anyTypeIdx, EQ_HEAP_TYPE);

  registerAnyUnboxHelpers(ctx, addHelper, anyRefNull, anyTypeIdx, canNativeStrEq, nativeStrFlattenIdx);

  // ── Phase 2: Runtime dispatch operators ──────────────────────────

  // Helper: get numeric value as f64 from an AnyValue (assumes tag is 2 or 3)
  // Used internally by arithmetic helpers.
  // params: a(0)  locals: tag(1)
  // Returns f64 per JS ToNumber semantics:
  //   tag 0 (null) → 0, tag 1 (undefined) → NaN, tag 2 (i32) → f64(i32val),
  //   tag 3 (f64) → f64val, tag 4 (bool) → f64(i32val)
  addHelper(
    "__any_to_f64",
    [anyRefNull],
    [{ kind: "f64" }],
    [
      // tag = a.tag
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },
      // if tag == 1 (undefined) → NaN
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 1 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [{ op: "f64.const", value: NaN }],
        else: [
          // if tag == 2 (i32) or tag == 4 (bool) → convert i32val to f64
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 2 },
          { op: "i32.eq" },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 4 },
          { op: "i32.eq" },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: [
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
              { op: "f64.convert_i32_s" },
            ],
            else: [
              // #1888 — $BoxedNumber recovery for tag 5 (standalone/WASI).
              // The generic externref→AnyValue boxing wraps EVERY externref as
              // a tag-5 box (externval = the raw externref) — including native
              // __box_number carriers crossing the open-any closure-dispatch
              // boundary. Reading f64val (0) for those silently turns every
              // dispatched number into 0. Recover the honest value when the
              // externval is a $BoxedNumber struct; everything else (genuine
              // strings, null externval, wrapped $AnyValue) keeps the f64val
              // read, bit-compatible with the host baseline. Comparison
              // helpers stay BoxedNumber-blind on purpose — see the NOTE in
              // type-coercion.ts (#1888 regression −788).
              ...((ctx.nativeBoxNumberTypeIdx >= 0
                ? [
                    { op: "local.get", index: 1 },
                    { op: "i32.const", value: 5 },
                    { op: "i32.eq" },
                    {
                      op: "if",
                      blockType: { kind: "val", type: { kind: "f64" } },
                      then: [
                        { op: "local.get", index: 0 },
                        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 }, // externval
                        { op: "any.convert_extern" },
                        { op: "local.tee", index: 2 },
                        // (#3135) tag-5 with a NULL externval is the generic
                        // boxing (`boxToAny` #1888 tag-5 default) of a null
                        // externref — the standalone carrier of `undefined`
                        // crossing the open-any boundary. §7.1.4
                        // ToNumber(undefined) = NaN. This matches the
                        // plane-wide undefined bias already chosen for the
                        // null externref: `__any_from_extern`'s nullAny is
                        // {tag:1, f64val:NaN} and standalone `typeof` answers
                        // "undefined" for it. (The null-vs-undefined collapse
                        // itself is #2106 S1.) Reading f64val (0) here made
                        // `undefined + 5` answer 5 through the numeric arm.
                        { op: "ref.is_null" },
                        {
                          op: "if",
                          blockType: { kind: "val", type: { kind: "f64" } },
                          then: [{ op: "f64.const", value: NaN }],
                          else: [
                            // (#3673) i31-boxed small int externval → value.
                            { op: "local.get", index: 2 },
                            { op: "ref.test", typeIdx: -20 },
                            {
                              op: "if",
                              blockType: { kind: "val", type: { kind: "f64" } },
                              then: [
                                { op: "local.get", index: 2 },
                                { op: "ref.cast", typeIdx: -20 },
                                { op: "i31.get_s" },
                                { op: "f64.convert_i32_s" },
                              ],
                              else: [
                                { op: "local.get", index: 2 },
                                { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
                                {
                                  op: "if",
                                  blockType: { kind: "val", type: { kind: "f64" } },
                                  then: [
                                    { op: "local.get", index: 2 },
                                    { op: "ref.cast", typeIdx: ctx.nativeBoxNumberTypeIdx },
                                    { op: "struct.get", typeIdx: ctx.nativeBoxNumberTypeIdx, fieldIdx: 0 },
                                  ],
                                  else:
                                    // (#2966) $BoxedBoolean recovery, symmetric with the
                                    // $BoxedNumber arm above. §7.1.4 ToNumber(true)=1 /
                                    // ToNumber(false)=0.
                                    ctx.nativeBoxBooleanTypeIdx >= 0
                                      ? [
                                          { op: "local.get", index: 2 },
                                          { op: "ref.test", typeIdx: ctx.nativeBoxBooleanTypeIdx },
                                          {
                                            op: "if",
                                            blockType: { kind: "val", type: { kind: "f64" } },
                                            then: [
                                              { op: "local.get", index: 2 },
                                              { op: "ref.cast", typeIdx: ctx.nativeBoxBooleanTypeIdx },
                                              { op: "struct.get", typeIdx: ctx.nativeBoxBooleanTypeIdx, fieldIdx: 0 },
                                              { op: "f64.convert_i32_s" },
                                            ],
                                            else: [
                                              { op: "local.get", index: 0 },
                                              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                                            ],
                                          },
                                        ]
                                      : [
                                          { op: "local.get", index: 0 },
                                          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                                        ],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                      else: [
                        // tag 0 (null) → f64val (0.0), tag 3 (f64) → f64val
                        { op: "local.get", index: 0 },
                        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                      ],
                    },
                  ]
                : [
                    // tag 0 (null) → f64val (0.0), tag 3 (f64) → f64val
                    { op: "local.get", index: 0 },
                    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                  ]) satisfies Instr[]),
            ],
          },
        ],
      },
    ],
    [
      { name: "tag", type: { kind: "i32" } },
      { name: "boxAny", type: { kind: "anyref" } },
    ],
  );

  const toF64Idx = ctx.funcMap.get("__any_to_f64")!;
  const boxI32Idx = ctx.funcMap.get("__any_box_i32")!;
  const boxF64Idx = ctx.funcMap.get("__any_box_f64")!;

  // (#2040/#1888) Tag-5 field-4 equality. The tag-5 box's `externval` (field 4) is
  // overloaded — under tag 5 it can hold a genuine string, a `$BoxedNumber`, or a
  // non-string GC object/closure. The tag-5 arm of BOTH `__any_eq` and
  // `__any_strict_eq` routes to `tag5StringEqThen()` — the GUARDED native
  // string-content compare (`ref.test $AnyString` on both operands, `0` for
  // non-strings; see its definition above). That banks #2579 boxed-string `===`
  // and #2583 `Array.prototype.{indexOf,…}.call(arrayLike)` while preserving main's
  // legacy answer (`0`) for non-string tag-5 pairs.
  //
  // A broader CLASSIFIER (a #2040 numeric `f64.eq` arm for two `$BoxedNumber`, and a
  // #2585 proto-identity `ref.eq` arm for two boxed eqref objects) was tried in
  // #1888 but EJECTED from the merge_group on the standalone-highwater floor (−162):
  // changing tag-5 boxed-VALUE equality for numbers/objects flips a comparison the
  // destructuring / generator-iterator lowering implicitly relied on (it counted on
  // the legacy always-false tag-5 non-string eq), regressing the class/dstr cluster.
  // Both arms are therefore DEFERRED to the value-rep substrate (#2580 M2 / #35),
  // which owns the dstr-iterator interaction. Only the string arm is kept here. The
  // `__any_add` cross-tag String⇄Number coercion (`tag5ToNumber`, below) is a
  // separate, dstr-safe #2040 fix and stays.

  // (#2040) ToNumber of a tag-5 operand in the `__any_eq` cross-tag String⇄Number
  // arm. The tag-5 field-4 externval may be a `$BoxedNumber` (not a string), so
  // route those through `__any_to_f64` (its #1888 boxed-number recovery) and only
  // genuine strings through `__str_to_number` (§7.1.4.1 StringToNumber). Leaves a
  // bare f64 on the stack. Only called where `strToNumIdx >= 0`.
  const tag5ToNumber = (opIdx: number): Instr[] => {
    const strToNum: Instr[] = [
      { op: "local.get", index: opIdx },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
      { op: "call", funcIdx: strToNumIdx },
    ];
    if (ctx.nativeBoxNumberTypeIdx < 0) return strToNum;
    return [
      { op: "local.get", index: opIdx },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
      // (#3673) …or an i31-boxed small int.
      { op: "local.get", index: opIdx },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: -20 },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [
          { op: "local.get", index: opIdx },
          { op: "call", funcIdx: toF64Idx },
        ],
        else: strToNum,
      },
    ];
  };

  // __any_add(a: ref $AnyValue, b: ref $AnyValue) -> ref $AnyValue
  //
  // §13.15.3 ApplyStringOrNumericBinaryOperator for `+`:
  //   1. lprim = ToPrimitive(a); rprim = ToPrimitive(b)
  //   2. if lprim or rprim is a String → string concatenation
  //   3. else → numeric addition
  // Tag 5 (string) is already a string. Tag 6 (object/array ref) reduces under
  // ToPrimitive(default)→toString to a string ("[object Object]" / joined array
  // elements), so it also forces concatenation. All other tags (0/1 null/undef,
  // 2 i32, 3 f64, 4 bool) ToPrimitive to non-strings → numeric arm.
  //
  // The numeric arm is the original behaviour: both tag==2 → i32.add+box i32;
  // otherwise __any_to_f64 both + f64.add + box f64.
  //
  // The concat arm only exists in standalone/WASI native-string builds
  // (`anyAddCanConcat`). Host mode never builds `__any_add` (it routes `+`
  // through the `__host_add` import), so this whole helper is standalone-only.
  // When native concat helpers are unavailable the helper degrades to the prior
  // numeric-only behaviour — no regression, just the unimplemented edge.
  //
  // params: a(0), b(1)  locals: tagA(2), tagB(3)
  // (numeric arm built lazily via `buildNumericArm()` below — see the note there
  //  on why each `if` arm must be a distinct array.)

  // ToString(operand: ref $AnyValue) → ref $AnyString, dispatched on the tag:
  //   - tag 6 (object/array ref): pull the actual ref out of `refval`, wrap to
  //     externref and run the §7.1.17 object walker `__extern_toString` (plain
  //     objects → "[object Object]"; arrays / custom toString via the $Object
  //     runtime), casting the string externref back to ref $AnyString.
  //   - all other tags (0/1 null/undef, 2/3 number, 4 bool, 5 string): the
  //     `__any_to_string` tag-dispatcher already returns the right ref
  //     $AnyString directly from the box — and crucially handles number→decimal
  //     and string→identity without the __box_number round-trip that confuses
  //     __extern_toString's tag detection.
  const opToAnyString = (paramIdx: number): Instr[] => [
    { op: "local.get", index: paramIdx },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 }, // tag
    { op: "i32.const", value: 6 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: ctx.anyStrTypeIdx } },
      then: [
        { op: "local.get", index: paramIdx },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 3 }, // refval (eqref)
        { op: "extern.convert_any" },
        { op: "call", funcIdx: externToStringIdx },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      ],
      else: [
        { op: "local.get", index: paramIdx },
        { op: "call", funcIdx: anyToStringIdx },
      ],
    },
  ];

  // Build a fresh copy of the numeric instructions every time this is called.
  // CRITICAL: the `then`/`else` arms of an `if` must be DISTINCT array objects
  // (and contain distinct instruction objects). Several post-codegen passes
  // mutate instruction nodes in place — most notably `shiftFuncIndices` in
  // index.ts, which does `instr.funcIdx += delta` on every `call`. If the same
  // array (or the same `call` instruction object) is reachable from two tree
  // positions, those passes can visit it twice and double-shift the funcIdx,
  // corrupting `__any_box_i32`/`__any_box_f64` call targets. (Before this fix,
  // the non-concat fallback aliased `concatArm` to `numericArm`, then the outer
  // `if` used `then: concatArm, else: numericArm` — the SAME array in both arms
  // — which produced exactly that corruption: "expected (ref null N), got i32"
  // / "call[0] expected type (ref null 5), found i32.add" in fast mode.)
  const buildNumericArm = (): Instr[] => [
    // if tagA == 2 && tagB == 2 → i32 add
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    { op: "local.get", index: 3 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: anyRef },
      then: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        { op: "i32.add" },
        { op: "call", funcIdx: boxI32Idx },
      ],
      else: [
        // f64 path: convert both to f64, add, box as f64
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: toF64Idx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: toF64Idx },
        { op: "f64.add" },
        { op: "call", funcIdx: boxF64Idx },
      ],
    },
  ];

  const concatArm: Instr[] = anyAddCanConcat
    ? [
        // box a tag-5 $AnyValue around __str_concat(ToString(a), ToString(b))
        { op: "i32.const", value: 5 },
        { op: "i32.const", value: 0 },
        { op: "f64.const", value: 0 },
        { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
        ...opToAnyString(0),
        ...opToAnyString(1),
        { op: "call", funcIdx: strConcatIdx },
        { op: "extern.convert_any" },
        { op: "struct.new", typeIdx: anyTypeIdx },
      ]
    : // No concat support (e.g. fast mode): the stringy `then` arm can never be
      // reached at runtime (no tag-5/6 operands without native strings), but it
      // must still be a SEPARATE, well-typed instruction array from the `else`
      // numeric arm so the two arms don't alias. Use a fresh numeric copy.
      buildNumericArm();

  // (#2966) Effective stringiness of one operand for the §13.15.3 `+` dispatch.
  //
  // The tag-5 field-4 externval is OVERLOADED (see the #2040 classifier note
  // above): the generic externref→AnyValue boxing (`value-tags.ts` boxToAny)
  // wraps EVERY externref as a tag-5 "string" box — including the native
  // `$BoxedNumber`/`$BoxedBoolean` carriers a value picks up crossing the
  // open-any closure-call boundary (`f(1) + f(2)` where `f: any`). Treating
  // those as strings sent two dispatched NUMBERS down the concat arm, whose
  // tag-5 result reads back as 0 in an f64 context — silent wrong values
  // (issue #2966; `f(1)+f(2)` → 0, `f(1,2,3)` → NaN).
  //
  // §13.15.3 ApplyStringOrNumericBinaryOperator: ToPrimitive of a number /
  // boolean is NOT a string, so those operands must take the NUMERIC arm —
  // whose `__any_to_f64` already recovers the honest value from a tag-5
  // `$BoxedNumber` (#1888 arm; the `$BoxedBoolean` recovery is added in the
  // same-numbered change below). Genuine strings and objects keep the concat
  // arm unchanged, and the mixed case (boxed number + real string) already
  // stringifies correctly via `__any_to_string`'s boxed-extern recovery.
  //
  // Gated ONLY on `nativeBoxNumberTypeIdx >= 0` (the #2040 lesson — never gate
  // on nativeStrings); when unavailable this reproduces the legacy
  // `tag==5 || tag==6` bytes exactly. Consumer-side only: the boxing site is
  // deliberately untouched (producer-side re-tagging was the −788/−794 trap).
  // Uses scratch anyref local 4; emits fresh Instr arrays per call (never
  // alias `if` arms — the in-place index-shift double-remap hazard).
  const stringyOperand = (opIdx: number, tagLocal: number): Instr[] => {
    const tag6Test = (): Instr[] => [
      { op: "local.get", index: tagLocal },
      { op: "i32.const", value: 6 },
      { op: "i32.eq" },
    ];
    if (ctx.nativeBoxNumberTypeIdx < 0) {
      // Legacy shape: tag==5 || tag==6 (byte-identical when no boxed-number
      // carrier type exists, e.g. host/fast mode builds of this helper).
      return [
        { op: "local.get", index: tagLocal },
        { op: "i32.const", value: 5 },
        { op: "i32.eq" },
        ...tag6Test(),
        { op: "i32.or" },
      ];
    }
    // tag==5 → stringy iff field-4 is NOT a boxed number/boolean carrier AND
    // NOT null. (#3135) The generic externref→AnyValue boxing (`boxToAny`'s
    // deliberate #1888 tag-5 default) also wraps a NULL externref — the
    // standalone carrier of `undefined`/`null` crossing the open-any
    // closure-dispatch boundary — as a tag-5 "string" box with a null
    // externval. Treating that as stringy sent `undefined + 5` down the
    // concat arm: `opToAnyString` stringified the nullish box like a plain
    // object, so the dispatched add answered "[object Object]5" (a silent
    // wrong STRING result; pre-#3055 the broken any-equality masked it as a
    // fake NaN pass — see tests/issue-1888-any-extern-roundtrip.test.ts).
    // §13.15.3: ToPrimitive(undefined/null) is NOT a string, so a nullish
    // carrier must take the NUMERIC arm regardless of the null-vs-undefined
    // collapse (#2106). Genuine tag-5 strings always carry a non-null
    // externval, so the guard is precise.
    const notBoxedPrimitive: Instr[] = [
      { op: "local.get", index: opIdx },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 4 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        // Null externval: a boxed nullish carrier — NOT a string.
        then: [{ op: "i32.const", value: 0 }],
        else: [
          { op: "local.get", index: 4 },
          { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
          // (#3673) …or an i31-boxed small int.
          { op: "local.get", index: 4 },
          { op: "ref.test", typeIdx: -20 },
          { op: "i32.or" },
          ...((ctx.nativeBoxBooleanTypeIdx >= 0
            ? [
                { op: "local.get", index: 4 },
                { op: "ref.test", typeIdx: ctx.nativeBoxBooleanTypeIdx },
                { op: "i32.or" },
              ]
            : []) satisfies Instr[]),
          { op: "i32.eqz" },
        ],
      },
    ];
    return [
      { op: "local.get", index: tagLocal },
      { op: "i32.const", value: 5 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: notBoxedPrimitive,
        else: tag6Test(),
      },
    ];
  };

  addHelper(
    "__any_add",
    [anyRefNull, anyRefNull],
    [anyRef],
    [
      // tagA = a.tag
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },
      // tagB = b.tag
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // stringy = stringyOperand(a) || stringyOperand(b) — tag 6, or tag 5
      // whose payload is a genuine string/object (NOT a boxed number/boolean
      // carrier crossing the open-any boundary — those are numeric, #2966).
      ...stringyOperand(0, 2),
      ...stringyOperand(1, 3),
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: anyRef },
        // string concatenation (§13.15.3 step 2) when either operand is a
        // string or an object/array (whose ToPrimitive→toString is a string).
        then: concatArm,
        // numeric addition (§13.15.3 step 3). A FRESH numeric arm (distinct
        // array + distinct instruction objects) so it never aliases `concatArm`
        // — see the `buildNumericArm` note above on why in-place index-shift
        // passes corrupt shared `if` arms.
        else: buildNumericArm(),
      },
    ],
    [
      { name: "tagA", type: { kind: "i32" } },
      { name: "tagB", type: { kind: "i32" } },
      { name: "recoverAdd", type: { kind: "anyref" } },
    ],
  );

  // Generic numeric binary op helper generator
  function addNumericBinaryHelper(name: string, i32op: "i32.sub" | "i32.mul", f64op: "f64.sub" | "f64.mul"): void {
    addHelper(
      name,
      [anyRefNull, anyRefNull],
      [anyRef],
      [
        // tagA = a.tag
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 2 },
        // tagB = b.tag
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 3 },
        // if tagA == 2 && tagB == 2 → i32 op
        { op: "local.get", index: 2 },
        { op: "i32.const", value: 2 },
        { op: "i32.eq" },
        { op: "local.get", index: 3 },
        { op: "i32.const", value: 2 },
        { op: "i32.eq" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: anyRef },
          then: [
            { op: "local.get", index: 0 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: 1 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
            { op: i32op },
            { op: "call", funcIdx: boxI32Idx },
          ],
          else: [
            // f64 path
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: toF64Idx },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: toF64Idx },
            { op: f64op },
            { op: "call", funcIdx: boxF64Idx },
          ],
        },
      ],
      [
        { name: "tagA", type: { kind: "i32" } },
        { name: "tagB", type: { kind: "i32" } },
      ],
    );
  }

  addNumericBinaryHelper("__any_sub", "i32.sub", "f64.sub");
  addNumericBinaryHelper("__any_mul", "i32.mul", "f64.mul");

  // __any_div: always use f64 (division can produce fractions)
  addHelper(
    "__any_div",
    [anyRefNull, anyRefNull],
    [anyRef],
    [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: toF64Idx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: toF64Idx },
      { op: "f64.div" },
      { op: "call", funcIdx: boxF64Idx },
    ],
  );

  // __any_mod: i32.rem_s for i32, otherwise f64 approximation via floor division
  addHelper(
    "__any_mod",
    [anyRefNull, anyRefNull],
    [anyRef],
    [
      // tagA = a.tag
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },
      // tagB = b.tag
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // if tagA == 2 && tagB == 2 → i32 rem_s
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      { op: "local.get", index: 3 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: anyRef },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: "i32.rem_s" },
          { op: "call", funcIdx: boxI32Idx },
        ],
        else: [
          // f64 path: a - floor(a/b) * b
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: toF64Idx },
          { op: "local.set", index: 4 }, // fA
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: toF64Idx },
          { op: "local.set", index: 5 }, // fB
          // result = fA - floor(fA / fB) * fB
          { op: "local.get", index: 4 },
          { op: "local.get", index: 4 },
          { op: "local.get", index: 5 },
          { op: "f64.div" },
          { op: "f64.floor" },
          { op: "local.get", index: 5 },
          { op: "f64.mul" },
          { op: "f64.sub" },
          { op: "call", funcIdx: boxF64Idx },
        ],
      },
    ],
    [
      { name: "tagA", type: { kind: "i32" } },
      { name: "tagB", type: { kind: "i32" } },
      { name: "fA", type: { kind: "f64" } },
      { name: "fB", type: { kind: "f64" } },
    ],
  );

  // (#3282) __any_eq / __any_strict_eq / __any_lt/gt/le/ge — the equality &
  // relational-comparison family, extracted verbatim to any-eq-helpers.ts to
  // decompose this god-function. Byte-identical: registered in the same order
  // with the same bodies; the tag-5 coercion/equality closures are threaded in
  // so their captured environment is unchanged.
  registerAnyEqHelpers(ctx, addHelper, anyRefNull, anyTypeIdx, toF64Idx, strToNumIdx, tag5ToNumber, tag5ValueEqThen);

  // __any_neg(a) -> ref $AnyValue
  // Negate numeric value: tag 2 → negate i32, tag 3 → negate f64
  addHelper(
    "__any_neg",
    [anyRefNull],
    [anyRef],
    [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: anyRef },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: "i32.sub" },
          { op: "call", funcIdx: boxI32Idx },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
          { op: "f64.neg" },
          { op: "call", funcIdx: boxF64Idx },
        ],
      },
    ],
  );

  // __any_typeof(a) -> ref $AnyString (native string in fast mode)
  // Returns "number", "string", "boolean", "object", "undefined" as native strings
  // Uses the $AnyString type system (WasmGC native strings)
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
    const strTypeIdx = ctx.nativeStrTypeIdx;

    // Helper to build a native string literal inline (returns instructions that leave ref $NativeString on stack)
    function nativeStrConstInstrs(value: string): Instr[] {
      const instrs: Instr[] = [];
      // Push len (i32) — field 0
      instrs.push({ op: "i32.const", value: value.length });
      // Push off (i32) = 0 — field 1
      instrs.push({ op: "i32.const", value: 0 });
      // Push each code unit and create array
      for (let i = 0; i < value.length; i++) {
        instrs.push({ op: "i32.const", value: value.charCodeAt(i) });
      }
      instrs.push({ op: "array.new_fixed", typeIdx: strDataTypeIdx, length: value.length });
      instrs.push({ op: "struct.new", typeIdx: strTypeIdx });
      return instrs;
    }

    const anyStrRef: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };

    addHelper(
      "__any_typeof",
      [anyRefNull],
      [anyStrRef],
      [
        // Check tag and return corresponding string
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 1 }, // tag in local 1

        // tag == 0 (null) → "object"
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 0 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: anyStrRef },
          then: nativeStrConstInstrs("object"),
          else: [
            // tag == 1 (undefined) → "undefined"
            { op: "local.get", index: 1 },
            { op: "i32.const", value: 1 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: anyStrRef },
              then: nativeStrConstInstrs("undefined"),
              else: [
                // tag == 2 or tag == 3 (i32/f64) → "number"
                { op: "local.get", index: 1 },
                { op: "i32.const", value: 2 },
                { op: "i32.eq" },
                { op: "local.get", index: 1 },
                { op: "i32.const", value: 3 },
                { op: "i32.eq" },
                { op: "i32.or" },
                {
                  op: "if",
                  blockType: { kind: "val", type: anyStrRef },
                  then: nativeStrConstInstrs("number"),
                  else: [
                    // tag == 4 (bool) → "boolean"
                    { op: "local.get", index: 1 },
                    { op: "i32.const", value: 4 },
                    { op: "i32.eq" },
                    {
                      op: "if",
                      blockType: { kind: "val", type: anyStrRef },
                      then: nativeStrConstInstrs("boolean"),
                      else: [
                        // (#2107) Canonical JsTag (#2104) tag arms: 5 String,
                        // 7 Function; everything else (6 Object, plus the null
                        // tag-0 which already resolved to "object" above) →
                        // "object". Before this, tag 5 wrongly returned
                        // "object" in the standalone native-string path, so
                        // `typeof (s: any-string)` mis-reported as "object".
                        // tag == 5 (string) → "string"
                        { op: "local.get", index: 1 },
                        { op: "i32.const", value: 5 },
                        { op: "i32.eq" },
                        {
                          op: "if",
                          blockType: { kind: "val", type: anyStrRef },
                          then: nativeStrConstInstrs("string"),
                          else: [
                            // tag == 7 (function) → "function"
                            { op: "local.get", index: 1 },
                            { op: "i32.const", value: 7 },
                            { op: "i32.eq" },
                            {
                              op: "if",
                              blockType: { kind: "val", type: anyStrRef },
                              then: nativeStrConstInstrs("function"),
                              // tag 6 (object) / unknown → "object"
                              else: nativeStrConstInstrs("object"),
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      [{ name: "tag", type: { kind: "i32" } }],
    );
  }

  // (#2141 S1) Honest-boxing regime: pre-register `__any_from_extern` (whose
  // null + fallback arms are honest under the flag — see the regime branch in
  // ensureAnyFromExternHelper) alongside the other box helpers, so `boxToAny`'s
  // flag-gated externref arm (a pure funcMap dispatch — it must not register)
  // finds it. Gated on `ctx.honestAnyBoxing`, so the legacy regime's modules
  // are byte-identical.
  if (ctx.honestAnyBoxing) {
    ensureAnyFromExternHelper(ctx);
  }
}

// Register ensureAnyHelpers delegate so expressions.ts and typeof-delete.ts
// can call it via shared.ts without importing index.ts (which depends on them).
registerEnsureAnyHelpers(ensureAnyHelpers);
