// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 TA1) `toLocaleString`'s ELEMENT step on a NUMBER — §23.1.3.32 step
 * 6.c.i, `ToString(? Invoke(element, "toLocaleString"))` — for the two lowerings
 * that render a numeric element, plus the `%TypedArray%` (§23.2.3.29) receiver
 * they are reached through.
 *
 * ## The measured defect
 *
 * #4655 built the element Invoke and deliberately installed it only on the arms
 * whose element can carry an OWN `toLocaleString` — the boxed-any and GC-ref
 * element arms — leaving the primitive NUMERIC arms rendering through
 * `number_toString`. Its header records why: host-free there is no `Intl` and
 * `Number.prototype.toLocaleString` degrades to `ToString`, so a reflective
 * dispatch per numeric element would buy nothing.
 *
 * That holds only while nobody REPLACES the member, and test262 does exactly
 * that. Measured on `0631fa543e`, `--target standalone`, isolating the element
 * TYPE rather than the lowering (`.tmp/ta1/p3.js`, `p9.js`):
 *
 * ```js
 * Number.prototype.toLocaleString = function () { return "P" + this; };
 * [42, "x"].toLocaleString();                              // "42,x"   ✗ spec: "P42,x"
 * var o = { toLocaleString: function () { return "OBJ"; } };
 * [o, "x"].toLocaleString();                               // "OBJ,x"  ✓ (#4655's arm)
 * new Int8Array(2).toLocaleString();                       // "0,0"    ✗ spec: "P0,P0"
 * ```
 *
 * ## TWO lowerings, measured — not one
 *
 * Instrumenting every candidate dispatch point showed the receiver's static
 * shape decides which one runs, and the two are disjoint:
 *
 * | receiver spelling | lowering | element on the stack |
 * | --- | --- | --- |
 * | `new Int8Array(2)` / a locally-resolvable view | `array-methods.ts::compileArrayJoinNative`, `elemType.kind === "i8"` | raw `i8`/`i32`/`f64` |
 * | `function (TA) { new TA(…).toLocaleString() }` — test262's `testWithTypedArrayConstructors` shape | `call-receiver-method.ts`'s `toLocaleString` arm → bare `__extern_toString(recv)` | (no per-element step at all) |
 *
 * The first cut of this slice served only the numeric join arm, and its probe
 * passed while all 10 test262 rows stayed red — because every one of them goes
 * through the harness callback, i.e. the second row of that table. Both are
 * fixed here: {@link reserveNumberToLocaleString} for the join arm and
 * {@link reserveTaToLocaleString} for the dynamic receiver.
 *
 * ## Why the resolution is the brand COMPANION, not `__extern_get`
 *
 * Because `__extern_get` does not answer for a number. In the control above the
 * object's OWN slot resolves through it and the number's PROTOTYPE member does
 * not — same boxed-element arm, same tail. The member lands on the #4176 brand
 * COMPANION for `Number.prototype` (`isProtoNamedWrite` → `ctx.protoNamedDirty`),
 * and `protoIndexBrandCompanionHasInstrs` (#4663) is the probe written for
 * reading exactly that: ONE brand, no `Object.prototype` fallthrough — right
 * here, because `Number.prototype.toLocaleString` (§21.1.3.4) SHADOWS
 * `Object.prototype`'s (§20.1.3.5).
 *
 * ## Why reserve/fill rather than inline arms
 *
 * Under `protoNamedDirty` alone the companion is seeded with nothing, so a hit
 * can only be a user value — but `nativeProtoSeedersByBrandOffset` invalidates
 * that: a brand whose `$NativeProto` is materialized has its companion seeded
 * with the GLUE's own members, and in standalone the glue's `toLocaleString` is
 * the #2984 refusal closure. A module that renders `"42,0"` today would then
 * THROW "not yet implemented" — the failure mode the stranded #6651 E8 slice
 * recorded, and the same trap #4663 guarded against on the Array side. That
 * registry is only complete after `flushPendingNativeProtoSeeders` at the end of
 * `ensureObjectRuntime`, which is not before every call site. Deciding at FILL
 * time removes the ordering question instead of reasoning about it. Same
 * reserve/fill funcIdx discipline as `reserveArrayToPrimitiveString`.
 *
 * Declining at fill time is free: each helper's degenerate body is exactly the
 * chain its caller would have emitted.
 *
 * ## Gating, and what compiles byte-identically
 *
 * A RESERVE is refused unless the module is standalone, `protoNamedDirty`, and
 * the pre-scan saw a `<Ctor>.prototype.toLocaleString` write
 * (`ctx.protoNamedWrittenMembers`) — all pre-scan facts, so a module that never
 * overrides the member never mints either helper and emits the same bytes as
 * before. The third gate is COARSE (bare member name, no constructor), which is
 * safe only because the runtime probe is NUMBER-companion-only: a module that
 * writes `Object.prototype.toLocaleString` mints the helpers, MISSES at runtime,
 * and renders natively.
 *
 * {@link reserveTaToLocaleString} additionally refuses outside
 * `ctx.moduleUsesDynTaView`, and its body `ref.test`s the dynamic-view brand:
 * every OTHER externref receiver of `x.toLocaleString()` — a plain object, a JS
 * array, a string — reaches the unchanged `__extern_toString(recv)`, so the
 * per-element fold cannot change what they answer.
 *
 * ## Absent-not-wrong
 *
 * A companion miss, and a hit whose value is not a non-null callable, both fall
 * back to today's rendering rather than §23.1.3.32's TypeError. An UNPATCHED
 * `Number.prototype.toLocaleString` is a miss (measured: the reflective read
 * answers `undefined`), so no real standalone `Number.prototype.toLocaleString`
 * VALUE body is a prerequisite for any of this — the E8 record's claim that it
 * was is not what the companion probe observes.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { sourceOverridesBuiltinPrototypeMember } from "./builtin-proto-member-override.js";
import { builtinBrandOffsetOf } from "./builtin-brands.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { protoIndexBrandCompanionHasInstrs, protoIndexRecvGetMissInstrs } from "./proto-index-store.js";
import { addFuncType, getOrRegisterTaDynViewType } from "./registry/types.js";
import { taDynDetachedGuardPrologue } from "./ta-dyn-method-call.js";

export const NUM_TO_LOCALE_STRING = "__num_to_locale_string";
export const TA_TO_LOCALE_STRING = "__ta_to_locale_string";

/** The member §23.1.3.32 step 6.c.i invokes on every non-nullish element. */
const ELEMENT_METHOD = "toLocaleString";

/** §7.1.17 ToString, the native every arm of every element tail ends in. */
const TO_STRING = "__extern_toString";

/**
 * The gates shared by both reserves.
 *
 * `anchor` makes the third one PRECISE, and that is load-bearing rather than
 * tidy. The coarse `ctx.protoNamedWrittenMembers.has("toLocaleString")` — a bare
 * member name with no constructor — was the first cut, paired with a
 * `nativeProtoSeedersByBrandOffset` decline at fill time to keep a SEEDED
 * companion (whose entry is the brand glue's #2984 refusal closure, not a user
 * value) from being called. Measured on the real test262 row, harness includes
 * and all (`.tmp/ta1/probe262.mts`): the `Number` companion IS seeded there, so
 * the decline fired and all 10 rows stayed exactly as they were — the guard
 * blocked precisely the modules the fix is for.
 *
 * Asking whether the source writes `Number.prototype.toLocaleString`
 * specifically removes the need for that decline instead of weakening it: a
 * user write lands on the SAME companion slot under the same key, so it
 * overwrites any seeded entry. A companion hit in such a module is the user's
 * value whether or not the brand was seeded.
 *
 * The residual this leaves is narrow and stated rather than hidden: a module
 * that writes `Number.prototype.toLocaleString` but calls `.toLocaleString()`
 * on a view BEFORE that write executes, in a module whose `Number` brand is
 * seeded, would resolve the refusal closure and throw instead of rendering. All
 * ten test262 rows install the member at top level, before the call.
 */
function overrideScanArms(ctx: CodegenContext, anchor: ts.Node): boolean {
  return (
    ctx.standalone &&
    ctx.protoNamedDirty === true &&
    builtinBrandOffsetOf("Number") !== undefined &&
    sourceOverridesBuiltinPrototypeMember(anchor, "Number", ELEMENT_METHOD)
  );
}

/** Register the natives both fills read, and settle their index shifts. */
function ensureSharedNatives(ctx: CodegenContext, callerFctx: FunctionContext): void {
  const externref: ValType = { kind: "externref" };
  const f64: ValType = { kind: "f64" };
  ensureLateImport(ctx, "__box_number", [f64], [externref]);
  ensureLateImport(ctx, "__apply_closure", [externref, externref, externref], [externref]);
  ensureLateImport(ctx, TO_STRING, [externref], [externref]);
  ensureLateImport(ctx, "__typeof_number", [externref], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__extern_length", [externref], [f64]);
  ensureLateImport(ctx, "__extern_get_idx", [externref, f64], [externref]);
  flushLateImportShifts(ctx, callerFctx);
}

/**
 * Reserve `__num_to_locale_string(f64) -> externref` for the numeric join arm,
 * or `undefined` when the caller must keep its `number_toString` chain.
 *
 * The result ABI is `number_toString`'s — a native string boxed as `externref` —
 * so the caller's `any.convert_extern` + `ref.cast $AnyString` tail is reused
 * verbatim.
 */
export function reserveNumberToLocaleString(
  ctx: CodegenContext,
  callerFctx: FunctionContext,
  anchor: ts.Node,
): number | undefined {
  if (!overrideScanArms(ctx, anchor)) return undefined;
  const existing = ctx.funcMap.get(NUM_TO_LOCALE_STRING);
  if (existing !== undefined) return existing;
  ensureSharedNatives(ctx, callerFctx);
  // `number_toString` is the fallback body; without it there is nothing to mint.
  if (ctx.funcMap.get("number_toString") === undefined) return undefined;
  const funcIdx = reservePlaceholder(ctx, NUM_TO_LOCALE_STRING, [{ kind: "f64" }], "$num_to_locale_string_type");
  ctx.numToLocaleStringReserved = true;
  return funcIdx;
}

/** Does an `any`-receiver `.toLocaleString()` in this module need the TA helper? */
export function taToLocaleStringApplies(ctx: CodegenContext, anchor: ts.Node): boolean {
  return overrideScanArms(ctx, anchor) && ctx.nativeStrings && ctx.moduleUsesDynTaView === true;
}

/**
 * Reserve `__ta_to_locale_string(recv) -> externref` for the `any`-receiver
 * `.toLocaleString()` call site, or `undefined` when it must keep its unchanged
 * `__extern_toString(recv)` call.
 */
export function reserveTaToLocaleString(
  ctx: CodegenContext,
  callerFctx: FunctionContext,
  anchor: ts.Node,
): number | undefined {
  if (!taToLocaleStringApplies(ctx, anchor)) return undefined;
  const existing = ctx.funcMap.get(TA_TO_LOCALE_STRING);
  if (existing !== undefined) return existing;
  ensureSharedNatives(ctx, callerFctx);
  if (ctx.funcMap.get(TO_STRING) === undefined) return undefined;
  getOrRegisterTaDynViewType(ctx);
  const funcIdx = reservePlaceholder(ctx, TA_TO_LOCALE_STRING, [{ kind: "externref" }], "$ta_to_locale_string_type");
  ctx.taToLocaleStringReserved = true;
  return funcIdx;
}

/**
 * Mint a `(param) -> externref` placeholder whose body is a bare `unreachable`.
 * Both fills ALWAYS write a valid body, so this is a construction placeholder
 * and never a reachable trap.
 */
function reservePlaceholder(ctx: CodegenContext, name: string, params: ValType[], typeName: string): number {
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }], typeName);
  const funcIdx = mintDefinedFunc(ctx);
  const placeholder: WasmFunction = {
    name,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, placeholder);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/** A minimal FunctionContext: these bodies are BUILT, never compiled. */
function makeHelperFctx(name: string, paramName: string, paramType: ValType): FunctionContext {
  return {
    name,
    params: [{ name: paramName, type: paramType }],
    locals: [],
    localMap: new Map(),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}

/**
 * Fill `__num_to_locale_string`. Armed:
 *
 *   if (NumberCompanionHas("toLocaleString")):
 *     box = __box_number(x)
 *     m   = __protoidx_get_r(box, "toLocaleString")
 *     if (m is not nullish): return ToString(__apply_closure(m, box, null))
 *   return number_toString(x)
 */
export function fillNumberToLocaleString(ctx: CodegenContext): void {
  if (!ctx.numToLocaleStringReserved) return;
  const fn = reservedFunc(ctx, NUM_TO_LOCALE_STRING);
  const numToStrIdx = ctx.funcMap.get("number_toString");
  if (fn === undefined || numToStrIdx === undefined) return;
  const fctx = makeHelperFctx(NUM_TO_LOCALE_STRING, "x", { kind: "f64" });
  const probe = buildNumberCompanionProbe(ctx, fctx);
  const arm: Instr[] =
    probe === undefined
      ? []
      : [
          ...probe.has,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: probe.boxNumberIdx },
              { op: "local.set", index: probe.boxLocal },
              ...probe.resolveMethod,
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                // Absent-not-wrong: fall out of both `if`s into the native tail.
                then: [],
                else: [...probe.invokeToString, { op: "return" }],
              },
            ],
            else: [],
          },
        ];
  fn.locals = fctx.locals;
  fn.body = [...arm, { op: "local.get", index: 0 }, { op: "call", funcIdx: numToStrIdx }];
}

/**
 * Fill `__ta_to_locale_string`. §23.2.3.29 over a `$__ta_dyn_view` receiver:
 *
 *   ValidateTypedArray(recv)                   // a detached view throws
 *   if (recv is a dyn view):
 *     R = ""; len = i32(__extern_length(recv))
 *     for (i = 0; i < len; i++):
 *       if (i > 0) R = R + ","                 // §23.2.3.29 takes no separator
 *       R = R + <element toLocaleString>
 *     return R
 *   return __extern_toString(recv)             // every other receiver, unchanged
 */
export function fillTaToLocaleString(ctx: CodegenContext): void {
  if (!ctx.taToLocaleStringReserved) return;
  const fn = reservedFunc(ctx, TA_TO_LOCALE_STRING);
  const toStrIdx = ctx.funcMap.get(TO_STRING);
  if (fn === undefined || toStrIdx === undefined) return;
  const fctx = makeHelperFctx(TA_TO_LOCALE_STRING, "recv", { kind: "externref" });
  // §23.2.4.4 step 5 first — the guard `ref.test`s the brand itself, so it is a
  // no-op for every non-view receiver.
  const guard = taDynDetachedGuardPrologue(ctx, fctx, ELEMENT_METHOD, 0);
  const nativeTail: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: toStrIdx },
  ];

  const dynIdx = ctx.taDynViewTypeIdx;
  const externLenIdx = ctx.funcMap.get("__extern_length");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (
    dynIdx === undefined ||
    dynIdx < 0 ||
    externLenIdx === undefined ||
    externGetIdxIdx === undefined ||
    strConcatIdx === undefined ||
    anyStrTypeIdx < 0
  ) {
    // Degenerate but correct: §23.2.4.4's validation still runs and the render
    // is the unchanged native one.
    fn.locals = fctx.locals;
    fn.body = [...guard, ...nativeTail];
    return;
  }

  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const resultLocal = allocLocal(fctx, "__tatls_res", strRef);
  const lenLocal = allocLocal(fctx, "__tatls_len", { kind: "i32" });
  const iLocal = allocLocal(fctx, "__tatls_i", { kind: "i32" });
  const elemLocal = allocLocal(fctx, "__tatls_elem", { kind: "externref" });
  const plainElement: Instr[] = [
    { op: "local.get", index: elemLocal },
    { op: "call", funcIdx: toStrIdx },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
  ];
  const probe = buildNumberCompanionProbe(ctx, fctx);
  const elementToString: Instr[] =
    probe === undefined
      ? plainElement
      : [
          // The element of a dyn view is a number for every kind but the two
          // BigInt ones, whose element must NOT take `Number.prototype`'s member.
          ...probe.has,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: elemLocal },
              { op: "call", funcIdx: probe.typeofNumberIdx },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [
              { op: "local.get", index: elemLocal },
              { op: "local.set", index: probe.boxLocal },
              ...probe.resolveMethod,
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: plainElement,
                else: [
                  ...probe.invokeToString,
                  { op: "any.convert_extern" },
                  { op: "ref.cast", typeIdx: anyStrTypeIdx },
                ],
              },
            ],
            else: plainElement,
          },
        ];

  fn.body = [
    ...guard,
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: dynIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...nativeStringLiteralInstrs(ctx, ""),
        { op: "local.set", index: resultLocal },
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: externLenIdx },
        { op: "i32.trunc_sat_f64_s" },
        { op: "local.set", index: lenLocal },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal },
                { op: "local.get", index: lenLocal },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 0 },
                { op: "i32.gt_s" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: resultLocal },
                    ...nativeStringLiteralInstrs(ctx, ","),
                    { op: "call", funcIdx: strConcatIdx },
                    { op: "local.set", index: resultLocal },
                  ],
                },
                { op: "local.get", index: 0 },
                { op: "local.get", index: iLocal },
                { op: "f64.convert_i32_s" },
                { op: "call", funcIdx: externGetIdxIdx },
                { op: "local.set", index: elemLocal },
                { op: "local.get", index: resultLocal },
                ...elementToString,
                { op: "call", funcIdx: strConcatIdx },
                { op: "local.set", index: resultLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: resultLocal },
        { op: "extern.convert_any" },
        { op: "return" },
      ],
      else: [],
    },
    ...nativeTail,
  ];
  fn.locals = fctx.locals;
}

/** The reserved function record, or `undefined` when it is not there to fill. */
function reservedFunc(ctx: CodegenContext, name: string): WasmFunction | undefined {
  const funcIdx = ctx.funcMap.get(name);
  if (funcIdx === undefined) return undefined;
  return definedFuncAt(ctx, funcIdx) ?? undefined;
}

/** The three reusable instruction runs of the `Number.prototype` consult. */
interface NumberCompanionProbe {
  /** `[] -> i32` — did user code install `Number.prototype.toLocaleString`? */
  readonly has: Instr[];
  /** externref scratch holding the BOXED element; the caller fills it. */
  readonly boxLocal: number;
  /** `[] -> externref|null` — the resolved method, also left in a local. */
  readonly resolveMethod: Instr[];
  /** `[] -> externref` — `ToString(Invoke(box, "toLocaleString"))`. */
  readonly invokeToString: Instr[];
  readonly boxNumberIdx: number;
  readonly typeofNumberIdx: number;
}

/**
 * Build the pieces of the `Number.prototype` companion consult, or `undefined`
 * when the module must render natively.
 */
function buildNumberCompanionProbe(ctx: CodegenContext, fctx: FunctionContext): NumberCompanionProbe | undefined {
  const brandOff = builtinBrandOffsetOf("Number");
  if (brandOff === undefined) return undefined;
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const typeofNumberIdx = ctx.funcMap.get("__typeof_number");
  const applyIdx = ctx.funcMap.get("__apply_closure");
  const toStrIdx = ctx.funcMap.get(TO_STRING);
  if (boxNumberIdx === undefined || typeofNumberIdx === undefined || applyIdx === undefined || toStrIdx === undefined) {
    return undefined;
  }
  const externref: ValType = { kind: "externref" };
  const companionLocal = allocLocal(fctx, "__tls_comp", externref);
  const has = protoIndexBrandCompanionHasInstrs(ctx, brandOff, ELEMENT_METHOD, companionLocal);
  if (has === undefined) return undefined;
  const boxLocal = allocLocal(fctx, "__tls_box", externref);
  const keyLocal = allocLocal(fctx, "__tls_key", externref);
  const methodLocal = allocLocal(fctx, "__tls_m", externref);
  // Receiver-aware companion [[Get]]. The presence probe already proved the
  // NUMBER companion carries a user entry, so this resolves that one rather than
  // reaching `Object.prototype`'s.
  const get = protoIndexRecvGetMissInstrs(ctx, boxLocal, keyLocal);
  if (get === undefined) return undefined;
  const nullishToNull = ctx.funcMap.get("__nullish_to_null");
  return {
    has,
    boxLocal,
    boxNumberIdx,
    typeofNumberIdx,
    resolveMethod: [
      // Finalize-safe key material (a native literal, not an import global) —
      // the same construction `protoIndexBrandCompanionHasInstrs` uses.
      ...nativeStringLiteralInstrs(ctx, ELEMENT_METHOD),
      { op: "extern.convert_any" },
      { op: "local.set", index: keyLocal },
      ...get,
      // `undefined` and `null` are the same miss here; the #2106 singleton would
      // otherwise sail past `ref.is_null` into `__apply_closure` as a value.
      ...(nullishToNull !== undefined
        ? ([{ op: "call", funcIdx: nullishToNull }] satisfies Instr[])
        : ([] satisfies Instr[])),
      { op: "local.tee", index: methodLocal },
    ],
    invokeToString: [
      { op: "local.get", index: methodLocal },
      { op: "local.get", index: boxLocal },
      // A null args carrier IS the zero-argument call
      // (`guardNullableApplyArguments`); §23.1.3.32 forwards neither `locales`
      // nor `options` to the element.
      { op: "ref.null.extern" },
      { op: "call", funcIdx: applyIdx },
      { op: "call", funcIdx: toStrIdx },
    ],
  };
}
