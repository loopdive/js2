// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Wasm-native generator CONSUMER / call-site subsystem (#3271 — extracted from
 * generators-native.ts).
 *
 * This module owns how the REST of codegen consumes a native generator produced
 * by the planner/register/emit core in `generators-native.ts`:
 *   - `.next()` / `.return()` / `.throw()` method calls
 *     (`tryCompileNativeGeneratorMethodCall`, direct + open runtime dispatch);
 *   - reading the `{value, done}` IteratorResult struct
 *     (`tryCompileNativeGeneratorResultProperty`, the open `ref.test` field
 *     readers, sentinel-aware boxing);
 *   - draining a generator in `for-of` (`tryCompileNativeGeneratorForOf`) and
 *     into a `__vec` for spread / `Array.from` / array-destructuring
 *     (`emitNativeGeneratorToVec`).
 *
 * The cut is a clean unidirectional boundary (0 back-edges into the core): this
 * file imports a handful of core emit helpers back from `generators-native.ts`
 * and the core re-exports the public entry points here so external importers of
 * `./generators-native.js` are unaffected. Behaviour-preserving move — emitted
 * bytes are byte-for-byte identical (proven via scripts/prove-emit-identity.mjs).
 */
import { ts } from "../ts-api.js";
import { mapTsTypeToWasm } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import { popBody, pushBody } from "./context/bodies.js";
import type { CodegenContext, FunctionContext, NativeGeneratorInfo } from "./context/types.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { coerceType, compileExpression, compileStatement } from "./shared.js";
import { UNDEF_F64_BITS } from "./value-tags.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js"; // (#2864 wave-2 S1)
import { addUnionImports } from "./index.js";
import { ensureExnTag } from "./registry/imports.js";
import { ensureGetUndefined, flushLateImportShifts } from "./expressions/late-imports.js";
import {
  STATE_FIELD,
  ERROR_FIELD,
  MODE_THROW,
  RESULT_VALUE_FIELD,
  RESULT_DONE_FIELD,
  setStateFieldFromLocal,
  setStateI32FromConst,
} from "./frame-core.js";
// (#3271) Core emit helpers imported back from the planner/register/emit module.
// Value-level cycle (the core re-exports this module's entry points); safe
// because every use is inside a function body evaluated at codegen time, long
// after module init.
import {
  ensureNativeGeneratorResumeFunction,
  ensureNativeGeneratorResultType,
  emitCarrierValue,
  nativeReturnResultFromLocal,
  carrierIsAny,
  emptyResultForType,
  emitOpenAnyArgValue,
  emitExpressionAsF64,
} from "./generators-native.js";

function nativeInfoForStateType(ctx: CodegenContext, typeIdx: number): NativeGeneratorInfo | undefined {
  for (const info of ctx.nativeGenerators.values()) {
    if (info.stateTypeIdx === typeIdx) return info;
  }
  return undefined;
}

// (#2171) Reverse-lookup a generator info by its result-struct typeIdx (used to
// recover the element ValType of an `it.next()` result whose type is a per-elem
// result struct, not the f64 singleton).
function resultInfoForType(ctx: CodegenContext, typeIdx: number): NativeGeneratorInfo | undefined {
  for (const info of ctx.nativeGenerators.values()) {
    if (info.resultTypeIdx === typeIdx) return info;
  }
  return undefined;
}

function isNativeResultType(ctx: CodegenContext, type: ValType | null): boolean {
  if (!type || (type.kind !== "ref" && type.kind !== "ref_null")) return false;
  const idx = type.typeIdx;
  if (ctx.nativeGeneratorResultTypeIdx >= 0 && idx === ctx.nativeGeneratorResultTypeIdx) return true;
  // (#2171) Result types are per-elem-kind (numeric f64 vs native string), so a
  // string generator's result struct is a distinct typeIdx. Recognize any
  // registered generator's result type.
  for (const info of ctx.nativeGenerators.values()) {
    if (info.resultTypeIdx === idx) return true;
  }
  return false;
}

function compileIgnoredArgs(ctx: CodegenContext, fctx: FunctionContext, args: readonly ts.Expression[]): void {
  for (const arg of args) {
    const argType = compileExpression(ctx, fctx, arg);
    if (argType !== null) fctx.body.push({ op: "drop" });
  }
}

function compileDirectNativeGeneratorMethod(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  receiverType: ValType,
  methodName: string,
  args: readonly ts.Expression[],
): ValType | null | undefined {
  if (receiverType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  const selfLocal = allocLocal(fctx, `__native_gen_self_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: info.stateTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: selfLocal });

  if (methodName === "throw") {
    // (#2864 F2) `gen.throw(e)` — §27.5.3.4 GeneratorResumeAbrupt(throw).
    // Compile the error to externref into the dedicated error slot, then:
    //   • SUSPENDED (state != start && state != done): set mode=2 and resume —
    //     the resume function runs enclosing finalizers and re-throws (this slice
    //     has no try/catch-across-yield, so it always propagates).
    //   • NOT-STARTED / DONE: complete the generator and throw the error directly.
    const errorTmp = allocLocal(fctx, `__native_gen_err_${fctx.locals.length}`, { kind: "externref" });
    if (args[0]) {
      const t = compileExpression(ctx, fctx, args[0], { kind: "externref" });
      if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
      else if (!t) fctx.body.push({ op: "ref.null.extern" });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    fctx.body.push({ op: "local.set", index: errorTmp });
    compileIgnoredArgs(ctx, fctx, args.slice(1));

    const tagIdx = ensureExnTag(ctx);
    // suspended = (state != START) && (state != doneState)
    fctx.body.push({ op: "local.get", index: selfLocal });
    fctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.ne" });
    fctx.body.push({ op: "local.get", index: selfLocal });
    fctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD });
    fctx.body.push({ op: "i32.const", value: info.doneState });
    fctx.body.push({ op: "i32.ne" });
    fctx.body.push({ op: "i32.and" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: info.resultTypeIdx } },
      then: [
        { op: "local.get", index: selfLocal },
        { op: "local.get", index: errorTmp },
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD },
        ...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, MODE_THROW),
        { op: "local.get", index: selfLocal },
        { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
      ],
      else: [
        // Not-started / completed: mark done and throw the error to the caller.
        ...setStateI32FromConst(info, selfLocal, STATE_FIELD, info.doneState),
        { op: "local.get", index: errorTmp },
        { op: "throw", tagIdx },
      ],
    });
    return { kind: "ref", typeIdx: info.resultTypeIdx };
  }

  if (methodName === "next") {
    const sentTmp = emitCarrierValue(ctx, fctx, args[0], info);
    compileIgnoredArgs(ctx, fctx, args.slice(1));
    fctx.body.push(...setStateFieldFromLocal(info, selfLocal, info.sentFieldIdx, sentTmp));
    fctx.body.push(...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 0));
    fctx.body.push({ op: "local.get", index: selfLocal });
    fctx.body.push({ op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) });
    return { kind: "ref", typeIdx: info.resultTypeIdx };
  }

  if (methodName === "return") {
    const valueTmp = emitCarrierValue(ctx, fctx, args[0], info);
    compileIgnoredArgs(ctx, fctx, args.slice(1));
    fctx.body.push({ op: "local.get", index: selfLocal });
    fctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: info.resultTypeIdx } },
      then: [
        ...setStateI32FromConst(info, selfLocal, STATE_FIELD, info.doneState),
        ...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 0),
        ...nativeReturnResultFromLocal(info, valueTmp),
      ],
      else: [
        { op: "local.get", index: selfLocal },
        { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
        { op: "i32.const", value: info.doneState },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref", typeIdx: info.resultTypeIdx } },
          then: [
            ...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 0),
            ...nativeReturnResultFromLocal(info, valueTmp),
          ],
          else: [
            ...setStateFieldFromLocal(info, selfLocal, info.abruptFieldIdx, valueTmp),
            ...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 1),
            { op: "local.get", index: selfLocal },
            { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
          ],
        },
      ],
    });
    return { kind: "ref", typeIdx: info.resultTypeIdx };
  }

  return undefined;
}

/**
 * (#3164) Host-generator mix fallback deps for the open dispatch. Present when
 * the host `__gen_*` machinery is registered in this module (some generator
 * bailed to the eager-buffer path) — the dispatch then gains a host arm for
 * receivers that are HOST generator objects. All funcIdx values are funcMap
 * lookups made at emit time by the caller; no new imports are added.
 */
interface HostGenMixDeps {
  /** `__gen_next` / `__gen_return` / `__gen_throw` (per method). */
  callIdx: number;
  /** `__gen_result_value(res) -> externref`. */
  resultValueIdx: number;
  /** `__gen_result_done(res) -> i32`. */
  resultDoneIdx: number;
  /** Caller-allocated externref scratch for the host result. */
  hostResLocal: number;
  /** `__NativeGeneratorResult_externref` struct typeIdx (the wrap target). */
  extResultTypeIdx: number;
}

/**
 * (#3164) Abstract heap-type codes for the host-external `ref.test`
 * classification (same trick as iterator-native.ts's HOSTGEN arm): an
 * internalized host external is neither struct nor array nor i31. Negative
 * values are abstract heap-type codes (one signed-LEB byte at emit) and are
 * never present in any DCE type-remap map.
 */
const HEAP_TYPE_STRUCT = -21; // 0x6B
const HEAP_TYPE_ARRAY = -22; // 0x6A
const HEAP_TYPE_I31 = -20; // 0x6C

/**
 * (#3271) Load the open-dispatch receiver (`anyref`) and cast it to a generator
 * state struct — the `local.get` + `ref.cast` pair the dispatch arms emit
 * before every state-field access. Spread at each site
 * (`...loadCastState(anyLocal, info.stateTypeIdx)`) so the emitted instruction
 * sequence is byte-identical to the inlined pair.
 */
function loadCastState(anyLocal: number, stateTypeIdx: number): Instr[] {
  return [
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: stateTypeIdx },
  ];
}

/**
 * (#3271) Read one field off a generator's `{value, done}` IteratorResult struct
 * held in `local`: the `local.get` + `struct.get` pair the for-of / toVec
 * drivers emit to pull `.done` / `.value`. Spread at each site so the emitted
 * instruction sequence is byte-identical to the inlined pair.
 */
function readResultField(local: number, resultTypeIdx: number, fieldIdx: number): Instr[] {
  return [
    { op: "local.get", index: local },
    { op: "struct.get", typeIdx: resultTypeIdx, fieldIdx },
  ];
}

function buildNativeGeneratorDispatch(
  ctx: CodegenContext,
  anyLocal: number,
  methodName: string,
  valueLocal?: number,
  // (#2864 F1) The boxed-`any` carrier's `sent`/`abrupt`/result are externref.
  // When the dispatch chain includes an any-carrier generator the caller emits
  // the `.next(v)`/`.return(v)` argument BOTH as f64 (`valueLocal`, for numeric /
  // string branches, unchanged) AND as externref (`valueAnyLocal`, for any
  // branches). When no any-carrier generator participates this is undefined and
  // the dispatch is byte-identical to pre-#2864.
  valueAnyLocal?: number,
  // (#2864 F2) externref error local for `.throw(e)`.
  errorLocal?: number,
  // (#3164) Host-generator mix fallback deps — see tryCompileNativeGeneratorMethodCall.
  hostMix?: HostGenMixDeps,
): { instrs: Instr[]; resultType: ValType } {
  const infos = Array.from(ctx.nativeGenerators.values());
  // (#2864 F1 / #2892) The enclosing dispatch block must accept every branch's
  // produced result struct. Each branch for generator `info` produces a value of
  // type `ref info.resultTypeIdx`, so the block type must be a supertype of all
  // of them:
  //   - ANY boxed-any carrier present → `eqref` (the common eq supertype), as in
  //     #2864 F1.
  //   - all generators share ONE result-struct typeIdx → `ref <that idx>`. This
  //     covers the dominant numeric-only case (every numeric generator shares the
  //     f64 IteratorResult singleton, byte-identical to before) AND the #2892
  //     single-string-elem case (the string carrier's per-elem result struct).
  //     Previously this branch hard-coded the f64 singleton even for a string
  //     generator, so the branches' `ref <stringResult>` mismatched the block's
  //     `ref <f64Result>` and the module failed wasm validation.
  //   - generators with DISTINCT result structs (e.g. a numeric AND a string
  //     generator in one module) have no shared nominal supertype → `eqref`.
  const hasAny = infos.some((i) => carrierIsAny(i.elemValType));
  const distinctResultIdxs = new Set(infos.map((i) => i.resultTypeIdx));
  let resultType: ValType;
  if (hasAny || distinctResultIdxs.size > 1) {
    resultType = { kind: "eqref" };
  } else if (distinctResultIdxs.size === 1) {
    resultType = { kind: "ref", typeIdx: infos[0]!.resultTypeIdx };
  } else {
    // No generators registered (defensive) — fall back to the f64 singleton.
    resultType = { kind: "ref", typeIdx: ensureNativeGeneratorResultType(ctx) };
  }
  // (#3164) The host-mix arm produces `ref __NativeGeneratorResult_externref`
  // — force the eqref supertype unless every branch already produces exactly
  // that struct.
  if (hostMix && !(distinctResultIdxs.size === 1 && infos[0]!.resultTypeIdx === hostMix.extResultTypeIdx)) {
    resultType = { kind: "eqref" };
  }
  // The per-branch `.next(v)`/`.return(v)` value local: an any-carrier branch
  // consumes the externref `valueAnyLocal`; numeric / string branches consume the
  // f64 `valueLocal` (unchanged). `valueLocal` is always present when valueAnyLocal
  // is (the caller derives one from the other).
  const branchValueLocal = (info: NativeGeneratorInfo): number =>
    carrierIsAny(info.elemValType) ? valueAnyLocal! : valueLocal!;
  // #1344 — the receiver matched NONE of the native generator state types, i.e.
  // `[[GeneratorState]]` is absent (e.g. `GeneratorPrototype.next.call({})`).
  // Per §27.5.3.2 GeneratorValidate step 2 / §27.5.1.2-4, throw a *catchable*
  // TypeError (a real `__new_TypeError` instance + `throw $exc`), never the old
  // silent `{value: 0, done: true}` sentinel. `throw` is stack-polymorphic, so
  // it satisfies the enclosing block's `resultType` without leaving a value.
  const typeErrArm: Instr[] = [];
  emitBrandCheckTypeError(ctx, typeErrArm, `Generator.prototype.${methodName} requires that 'this' be a Generator`);
  // (#3164) With the host machinery registered, a HOST generator object — an
  // internalized external, so neither struct nor array nor i31 — routes to the
  // host `__gen_*` arm; internal non-generators keep the #1344 TypeError.
  let fallback: Instr[] = typeErrArm;
  if (hostMix) {
    const hostCall: Instr[] = [{ op: "local.get", index: anyLocal }, { op: "extern.convert_any" }];
    if (methodName === "return") {
      // `gen.return(v)` — the host import takes (gen, value externref). Prefer
      // the already-externref `valueAnyLocal`; otherwise box the f64 value
      // (best-effort: `__box_number` is registered whenever union imports are —
      // which any generator module has; a missing boxer degrades to undefined).
      if (valueAnyLocal !== undefined) {
        hostCall.push({ op: "local.get", index: valueAnyLocal });
      } else {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined && valueLocal !== undefined) {
          hostCall.push({ op: "local.get", index: valueLocal }, { op: "call", funcIdx: boxIdx });
        } else {
          hostCall.push({ op: "ref.null.extern" });
        }
      }
    } else if (methodName === "throw") {
      hostCall.push(errorLocal !== undefined ? { op: "local.get", index: errorLocal } : { op: "ref.null.extern" });
    }
    hostCall.push(
      { op: "call", funcIdx: hostMix.callIdx },
      { op: "local.set", index: hostMix.hostResLocal },
      // Wrap {value, done} into the externref-elem native result struct so the
      // arm satisfies the dispatch block type and downstream `.value`/`.done`
      // reads dispatch on it like any native result.
      { op: "local.get", index: hostMix.hostResLocal },
      { op: "call", funcIdx: hostMix.resultValueIdx },
      { op: "local.get", index: hostMix.hostResLocal },
      { op: "call", funcIdx: hostMix.resultDoneIdx },
      { op: "struct.new", typeIdx: hostMix.extResultTypeIdx },
    );
    fallback = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: HEAP_TYPE_STRUCT },
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: HEAP_TYPE_ARRAY },
      { op: "i32.or" },
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: HEAP_TYPE_I31 },
      { op: "i32.or" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: hostCall,
        else: typeErrArm,
      },
    ];
  }

  function branch(index: number): Instr[] {
    if (index >= infos.length) return fallback;
    const info = infos[index]!;
    const vLocal = branchValueLocal(info);
    let thenBody: Instr[];
    if (methodName === "throw") {
      // (#2864 F2) `gen.throw(e)` — suspended: write the error, set mode=2, and
      // resume (the resume function runs enclosing finalizers then re-throws);
      // not-started / done: complete and throw the error directly. Mirrors the
      // direct-path throw. `throw` is stack-polymorphic so the not-started/done
      // arm satisfies the block's `resultType` without leaving a value.
      const tagIdx = ensureExnTag(ctx);
      thenBody = [
        ...loadCastState(anyLocal, info.stateTypeIdx),
        { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
        { op: "i32.const", value: 0 },
        { op: "i32.ne" },
        ...loadCastState(anyLocal, info.stateTypeIdx),
        { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
        { op: "i32.const", value: info.doneState },
        { op: "i32.ne" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: resultType },
          then: [
            ...loadCastState(anyLocal, info.stateTypeIdx),
            { op: "local.get", index: errorLocal! },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD },
            ...loadCastState(anyLocal, info.stateTypeIdx),
            { op: "i32.const", value: MODE_THROW },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
            ...loadCastState(anyLocal, info.stateTypeIdx),
            { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
          ],
          else: [
            ...loadCastState(anyLocal, info.stateTypeIdx),
            { op: "i32.const", value: info.doneState },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
            { op: "local.get", index: errorLocal! },
            { op: "throw", tagIdx },
          ],
        },
      ];
    } else if (methodName === "next") {
      thenBody = [
        ...loadCastState(anyLocal, info.stateTypeIdx),
        { op: "local.get", index: vLocal },
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.sentFieldIdx },
        ...loadCastState(anyLocal, info.stateTypeIdx),
        { op: "i32.const", value: 0 },
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
        ...loadCastState(anyLocal, info.stateTypeIdx),
        { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
      ];
    } else {
      thenBody = [
        ...loadCastState(anyLocal, info.stateTypeIdx),
        { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
        { op: "i32.const", value: 0 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: resultType },
          then: [
            ...loadCastState(anyLocal, info.stateTypeIdx),
            { op: "i32.const", value: info.doneState },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
            ...loadCastState(anyLocal, info.stateTypeIdx),
            { op: "i32.const", value: 0 },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
            { op: "local.get", index: vLocal },
            { op: "i32.const", value: 1 },
            { op: "struct.new", typeIdx: info.resultTypeIdx },
          ],
          else: [
            ...loadCastState(anyLocal, info.stateTypeIdx),
            { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
            { op: "i32.const", value: info.doneState },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: resultType },
              then: [
                ...loadCastState(anyLocal, info.stateTypeIdx),
                { op: "i32.const", value: 0 },
                { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
                { op: "local.get", index: vLocal },
                { op: "i32.const", value: 1 },
                { op: "struct.new", typeIdx: info.resultTypeIdx },
              ],
              else: [
                ...loadCastState(anyLocal, info.stateTypeIdx),
                { op: "local.get", index: vLocal },
                { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.abruptFieldIdx },
                ...loadCastState(anyLocal, info.stateTypeIdx),
                { op: "i32.const", value: 1 },
                { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
                ...loadCastState(anyLocal, info.stateTypeIdx),
                { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
              ],
            },
          ],
        },
      ];
    }
    return [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: info.stateTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: thenBody,
        else: branch(index + 1),
      },
    ];
  }
  return { instrs: branch(0), resultType };
}

export function tryCompileNativeGeneratorMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  methodName: string,
  args: readonly ts.Expression[],
): ValType | null | undefined {
  if (methodName !== "next" && methodName !== "return" && methodName !== "throw") return undefined;
  if (ctx.nativeGenerators.size === 0) return undefined;

  const receiverType = compileExpression(ctx, fctx, receiverExpr);
  if (receiverType && (receiverType.kind === "ref" || receiverType.kind === "ref_null")) {
    const info = nativeInfoForStateType(ctx, receiverType.typeIdx);
    if (info) {
      return compileDirectNativeGeneratorMethod(ctx, fctx, info, receiverType, methodName, args);
    }
  }

  if (receiverType?.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (!receiverType || (receiverType.kind !== "anyref" && receiverType.kind !== "eqref")) {
    if (receiverType !== null) fctx.body.push({ op: "drop" });
    compileIgnoredArgs(ctx, fctx, args);
    fctx.body.push(...emptyResultForType(ctx, ensureNativeGeneratorResultType(ctx)));
    return { kind: "ref", typeIdx: ctx.nativeGeneratorResultTypeIdx };
  }

  const anyLocal = allocLocal(fctx, `__native_gen_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  // (#2864 F1) When the open dispatch must service an any-carrier generator, the
  // `.next(v)`/`.return(v)` argument is needed BOTH as externref (any branches)
  // and as f64 (numeric / string branches). Compile it ONCE to externref (its
  // natural representation when `it` is statically opaque), then derive the f64
  // by unboxing — so a side-effecting argument is evaluated exactly once. For
  // numeric/string-only modules (no any carrier) keep the historical f64-only
  // emission, byte-identical to before.
  const dispatchHasAny = Array.from(ctx.nativeGenerators.values()).some((i) => carrierIsAny(i.elemValType));
  let valueLocal: number | undefined;
  let valueAnyLocal: number | undefined;
  let errorLocal: number | undefined;
  if (methodName === "throw") {
    // (#2864 F2) The thrown value is an externref error, independent of any
    // generator's carrier — store it in a dedicated local for the dispatch's
    // throw branch (which writes it to the state struct's `error` field).
    errorLocal = allocLocal(fctx, `__gen_throw_err_${fctx.locals.length}`, { kind: "externref" });
    if (args[0]) {
      const t = compileExpression(ctx, fctx, args[0], { kind: "externref" });
      if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
      else if (!t) fctx.body.push({ op: "ref.null.extern" });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    fctx.body.push({ op: "local.set", index: errorLocal });
    compileIgnoredArgs(ctx, fctx, args.slice(1));
  } else if (methodName === "return" || methodName === "next") {
    if (dispatchHasAny) {
      valueAnyLocal = emitOpenAnyArgValue(ctx, fctx, args[0]);
      compileIgnoredArgs(ctx, fctx, args.slice(1));
      valueLocal = allocLocal(fctx, `__gen_sent_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.get", index: valueAnyLocal });
      coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: valueLocal });
    } else {
      valueLocal = emitExpressionAsF64(ctx, fctx, args[0]);
      compileIgnoredArgs(ctx, fctx, args.slice(1));
    }
  }

  // (#3164) HOST-generator mix fallback. A module can carry BOTH native
  // generators (fn-expr closures, native methods) AND host eager-buffer
  // generators (bailed shapes) — the open dispatch's receiver can then be a
  // HOST generator object, which matches none of the native state types. The
  // old miss arm threw the #1344 GeneratorValidate TypeError unconditionally,
  // which broke every mixed module (`Generator.prototype.next requires that
  // 'this' be a Generator` on a REAL host generator). When the host `__gen_*`
  // machinery is registered (i.e. some generator in this module DID bail —
  // presence in funcMap; this never adds imports), give the dispatch a host
  // arm keyed on the HOSTGEN classification (an internalized host external is
  // neither struct nor array nor i31): call the host `__gen_next/return/throw`
  // and wrap its result into the externref-elem native result struct. Internal
  // non-generators (a plain `$Object`, an i31) keep the #1344 TypeError.
  let hostMix: HostGenMixDeps | undefined;
  const hostCallIdx = ctx.funcMap.get(
    methodName === "next" ? "__gen_next" : methodName === "return" ? "__gen_return" : "__gen_throw",
  );
  const hostResValueIdx = ctx.funcMap.get("__gen_result_value");
  const hostResDoneIdx = ctx.funcMap.get("__gen_result_done");
  if (hostCallIdx !== undefined && hostResValueIdx !== undefined && hostResDoneIdx !== undefined) {
    hostMix = {
      callIdx: hostCallIdx,
      resultValueIdx: hostResValueIdx,
      resultDoneIdx: hostResDoneIdx,
      hostResLocal: allocLocal(fctx, `__gen_host_res_${fctx.locals.length}`, { kind: "externref" }),
      extResultTypeIdx: ensureNativeGeneratorResultType(ctx, { kind: "externref" }),
    };
  }

  const { instrs, resultType } = buildNativeGeneratorDispatch(
    ctx,
    anyLocal,
    methodName,
    valueLocal,
    valueAnyLocal,
    errorLocal,
    hostMix,
  );
  fctx.body.push(...instrs);
  return resultType;
}

export function tryCompileNativeGeneratorResultProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  resultExpr: ts.Expression,
  propName: string,
): ValType | null | undefined {
  if (propName !== "value" && propName !== "done") return undefined;
  // (#2171) Proceed if either the f64 singleton or any per-elem native
  // generator result type exists (a string-only module never sets the singleton).
  if (ctx.nativeGeneratorResultTypeIdx < 0 && ctx.nativeGenerators.size === 0) return undefined;

  const resultType = compileExpression(ctx, fctx, resultExpr);
  if (isNativeResultType(ctx, resultType)) {
    // (#2171) The result type may be the f64 singleton OR a per-elem-kind result
    // struct (e.g. native string). Read the value field at the matched result
    // type's typeIdx and report its element ValType, not the f64 singleton.
    const rtIdx = (resultType as { typeIdx: number }).typeIdx;
    const matchInfo = resultInfoForType(ctx, rtIdx);
    const valVT: ValType = matchInfo ? matchInfo.elemValType : { kind: "f64" };
    if (resultType?.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({
      op: "struct.get",
      typeIdx: rtIdx,
      fieldIdx: propName === "value" ? RESULT_VALUE_FIELD : RESULT_DONE_FIELD,
    });
    // (#2938) `.done` carries the #2030 boolean BRAND, exactly like the host
    // path's `__gen_result_done` read (property-access.ts). Without it, the
    // i32→externref arg coercion boxes the value kind-keyed as a NUMBER
    // ($BoxedNumber(1)), while a `boolean`-typed comparand boxes as
    // $BoxedBoolean — the any `!==` typeof-partition chain then falls to
    // ref-identity and answers UNEQUAL, so the test262 harness shape
    // `assert_sameValue_bool(g.next().done, true)` failed on every native
    // generator (the residual "returned 2" of the #2938 no-yield relax).
    return propName === "value" ? valVT : { kind: "i32", boolean: true };
  }

  if (resultType?.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (!resultType || (resultType.kind !== "anyref" && resultType.kind !== "eqref")) {
    if (resultType !== null) fctx.body.push({ op: "drop" });
    fctx.body.push(propName === "value" ? { op: "f64.const", value: 0 } : { op: "i32.const", value: 1 });
    return propName === "value" ? { kind: "f64" } : { kind: "i32" };
  }

  const anyLocal = allocLocal(fctx, `__native_gen_result_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  // (#2864 F1) Distinct IteratorResult struct types in this module: the f64
  // singleton (when present) plus each registered generator's per-elem result
  // type (native string, boxed-any externref). The open reader must runtime-test
  // every one, not just the f64 singleton — otherwise a `.done`/`.value` read off
  // an any-carrier result (which is NOT the singleton) fell through to the
  // default (`done:true` / `0`).
  const resultEntries: { typeIdx: number; elemValType: ValType }[] = [];
  const seenResult = new Set<number>();
  const pushEntry = (typeIdx: number, elem: ValType): void => {
    if (typeIdx >= 0 && !seenResult.has(typeIdx)) {
      seenResult.add(typeIdx);
      resultEntries.push({ typeIdx, elemValType: elem });
    }
  };
  if (ctx.nativeGeneratorResultTypeIdx >= 0) pushEntry(ctx.nativeGeneratorResultTypeIdx, { kind: "f64" });
  for (const info of ctx.nativeGenerators.values()) pushEntry(info.resultTypeIdx, info.elemValType);
  // (#3164) The host-mix dispatch arm wraps a HOST generator's result into the
  // externref-elem result struct, which may not belong to any REGISTERED
  // native generator — include it whenever it exists so `.done`/`.value` reads
  // on a host-wrapped result dispatch like any native result.
  const extResIdx = ctx.structMap.get("__NativeGeneratorResult_externref");
  if (extResIdx !== undefined) pushEntry(extResIdx, { kind: "externref" });

  if (propName === "done") {
    // `done` is i32 for every carrier — test each result type, read field 1.
    fctx.body.push(buildOpenResultRead(anyLocal, resultEntries, RESULT_DONE_FIELD, { kind: "i32" }));
    // (#2938) boolean brand — see the typed arm above.
    return { kind: "i32", boolean: true };
  }

  // `value`: choose the return ValType from the STATIC type of the result's
  // `value` property. A STATICALLY-NUMERIC `.value` keeps the f64 fast path
  // (byte-identical to before, and — with the #2979 sentinel producer — an
  // exhausted read yields NaN, which is the spec ToNumber(undefined)).
  // Everything else (ref-typed OR no static info — the `g: any` harness shape)
  // now takes the externref path below.
  let valueStaticNumeric = false;
  const itType = ctx.checker.getTypeAtLocation(resultExpr);
  const valSym = itType.getProperty?.("value");
  if (valSym) {
    const mapped = mapTsTypeToWasm(ctx.checker.getTypeOfSymbolAtLocation(valSym, resultExpr), ctx.checker);
    valueStaticNumeric = mapped.kind === "f64" || mapped.kind === "i32";
  }

  if (valueStaticNumeric) {
    // Statically-numeric `.value`: the historical f64-singleton fast path.
    // (#2864 wave-2 S1) The read itself is byte-identical — but the RESULT now
    // carries the `undefSentinel` brand. The pre-existing rationale here ("an
    // exhausted read yields NaN, which is the spec ToNumber(undefined)") holds
    // only in a NUMERIC consuming context; this reader cannot see the context,
    // and the dominant test262 consumer is `assert.sameValue(result.value,
    // undefined)`, an `any` context, where the sentinel boxed as the NUMBER NaN
    // and every terminal-result assertion failed. Numeric consumers still see a
    // plain `f64` (the brand is inert to `.kind` checks); only the f64→externref
    // BOX site consults it, resurrecting the sentinel to canonical `undefined`.
    const fieldType: ValType = { kind: "f64", undefSentinel: true };
    const f64Entries = resultEntries.filter((e) => e.elemValType.kind === "f64");
    fctx.body.push(buildOpenResultRead(anyLocal, f64Entries, RESULT_VALUE_FIELD, { kind: "f64" }));
    return fieldType;
  }

  // (#2979) Dynamic / ref-typed `.value` read → externref, covering EVERY
  // registered result carrier (the old split covered only externref-elem
  // carriers here and sent the no-static-info shape — exactly the test262
  // harness path `assert.sameValue(g.next().value, undefined)` — down the f64
  // fast path, where an f64-elem done result read back as a plain number and
  // `undefined` was unrepresentable). Each arm canonicalizes:
  //   - externref elem: field as-is (done default is null externref already);
  //   - f64/i32 elem: UNDEF_F64 sentinel → null externref (canonical
  //     undefined, `__extern_is_undefined` = ref.is_null), else __box_number;
  //   - ref elem (native string): extern.convert_any (null ref → null extern).
  fctx.body.push(buildOpenResultValueReadExtern(ctx, fctx, anyLocal, resultEntries));
  return { kind: "externref" };
}

/**
 * (#2979) True when `typeIdx` is one of the native generator IteratorResult
 * structs (`__NativeGeneratorResult_<kind>`), whose f64 `value` field uses the
 * UNDEF_F64 sentinel as the absent/done marker. Generic struct-field readers
 * (member-get dispatch) use this to apply sentinel-aware boxing for exactly
 * these structs and no others.
 */
export function isNativeGeneratorResultStruct(ctx: CodegenContext, typeIdx: number): boolean {
  const name = ctx.typeIdxToStructName.get(typeIdx);
  return name !== undefined && name.startsWith("__NativeGeneratorResult_");
}

/**
 * (#2979) Instruction tail that converts an f64 already on the stack into an
 * externref with sentinel canonicalization: the UNDEF_F64 bit pattern becomes
 * canonical `undefined`, anything else is boxed via `__box_number`. Needs a
 * caller-provided f64 scratch local.
 *
 * (#3032 W6) `undefinedInstrs` is the canonical-`undefined` producer for the
 * sentinel arm. Default: null externref (the STANDALONE canonical undefined —
 * `__extern_is_undefined` is `ref.is_null`). On the JS-HOST lane the null
 * externref surfaces as JS `null`, which is `!== undefined`
 * (`assert.sameValue(result.value, undefined)` failed on every done-result
 * read once host-lane generators routed native) — host callers pass
 * `[call __get_undefined]` instead.
 */
export function sentinelAwareF64BoxInstrs(
  f64ScratchIdx: number,
  boxNumberIdx: number,
  undefinedInstrs: Instr[] = [{ op: "ref.null.extern" }],
): Instr[] {
  return [
    { op: "local.tee", index: f64ScratchIdx },
    { op: "i64.reinterpret_f64" },
    { op: "i64.const", value: UNDEF_F64_BITS },
    { op: "i64.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [...undefinedInstrs],
      else: [
        { op: "local.get", index: f64ScratchIdx },
        { op: "call", funcIdx: boxNumberIdx },
      ],
    },
  ];
}

/**
 * (#2979) Build the externref-producing `.value` read chain over ALL candidate
 * result carriers, canonicalizing the absent/done value to the null externref
 * (the standalone canonical `undefined`). Mirrors `buildOpenResultRead`'s
 * nested ref.test chain; the no-match default is the null externref.
 */
function buildOpenResultValueReadExtern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anyLocal: number,
  entries: { typeIdx: number; elemValType: ValType }[],
): Instr {
  // __box_number is a union native (standalone/wasi) registered via
  // addUnionImports; in-body `call` instrs are repaired by the late-import
  // shifter body walks, so funcMap resolution at emit time is safe (the #2941
  // hazard is CACHED indices in side-channel registries, not body instrs).
  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const externVT: ValType = { kind: "externref" };
  // Scratch for the sentinel bit-test (allocated once; arms are alternatives).
  const f64Scratch = allocLocal(fctx, `__gen_val_f64_${fctx.locals.length}`, { kind: "f64" });
  // (#3032 W6) Canonical `undefined` for the sentinel/done arms: the REAL host
  // `undefined` under a JS host (null externref reads back as JS `null`, which
  // fails `assert.sameValue(result.value, undefined)`); the null externref in
  // standalone/native-strings (ensureGetUndefined returns undefined there —
  // byte-identical to the pre-W6 lowering). In-body `call` instrs are repaired
  // by the late-import shifter body walks, same as `__box_number` above.
  // (#2864 wave-2 S1) …and in standalone/native-strings that fallback is the
  // tag-1 `$undefined` singleton, NOT `ref.null.extern`. The parenthetical above
  // ("byte-identical to the pre-W6 lowering") was describing the null externref,
  // which the current standalone value model reads back as JS **null** —
  // `result.value === null` measured TRUE with `typeof` `"object"` on the
  // boxed-any carrier. `canonicalUndefinedExternInstrs` is the one lane-correct
  // producer for both lanes.
  const getUndefIdx = ensureGetUndefined(ctx);
  if (getUndefIdx !== undefined) flushLateImportShifts(ctx, fctx);
  const undefInstrs: Instr[] =
    getUndefIdx !== undefined ? [{ op: "call", funcIdx: getUndefIdx }] : canonicalUndefinedExternInstrs(ctx);

  const armFor = (e: { typeIdx: number; elemValType: ValType }): Instr[] => {
    const read: Instr[] = [
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: e.typeIdx },
      { op: "struct.get", typeIdx: e.typeIdx, fieldIdx: RESULT_VALUE_FIELD },
    ];
    if (e.elemValType.kind === "externref") return read;
    if (e.elemValType.kind === "f64" || e.elemValType.kind === "i32") {
      if (boxNumberIdx === undefined) {
        // No boxing available (defensive): undefined is the only safe answer.
        return [...read, { op: "drop" }, ...undefInstrs];
      }
      const toF64: Instr[] = e.elemValType.kind === "i32" ? [{ op: "f64.convert_i32_s" }] : [];
      return [...read, ...toF64, ...sentinelAwareF64BoxInstrs(f64Scratch, boxNumberIdx, undefInstrs)];
    }
    // ref/ref_null elem (native string / struct): wrap to externref. A null
    // ref (the done default) converts to the null externref = canonical
    // undefined.
    return [...read, { op: "extern.convert_any" }];
  };

  const wrap = (i: number): Instr[] => {
    // No-match tail. Deliberately left as the null externref rather than
    // routed through `undefInstrs` (#2864 wave-2 S1): this arm is reached only
    // when the receiver is not ANY known result struct — a defensive path, not
    // the absent-value path — and changing it would move JS-HOST bytes (where
    // `undefInstrs` is a `__get_undefined` call) for no measured gain. The
    // #3032 contract is host bytes identical unless deliberately widening W6.
    if (i >= entries.length) return [{ op: "ref.null.extern" }];
    const e = entries[i]!;
    return [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: e.typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: externVT },
        then: armFor(e),
        else: wrap(i + 1),
      },
    ];
  };
  return { op: "block", blockType: { kind: "val", type: externVT }, body: wrap(0) };
}

/**
 * (#2864 F1) Build a runtime ref.test chain over candidate IteratorResult struct
 * types, reading `fieldIdx` off the first match and leaving a `returnVT`. The
 * default (no match) is the inert value for the field: `i32.const 1` (done) /
 * `f64.const 0` / null externref. The matched struct's field type already equals
 * `returnVT` for both the f64 singleton (value f64 / done i32) and the boxed-any
 * result (value externref / done i32), so no per-entry coercion is needed.
 */
function buildOpenResultRead(
  anyLocal: number,
  entries: { typeIdx: number; elemValType: ValType }[],
  fieldIdx: number,
  returnVT: ValType,
): Instr {
  const def: Instr =
    fieldIdx === RESULT_DONE_FIELD
      ? { op: "i32.const", value: 1 }
      : returnVT.kind === "externref"
        ? { op: "ref.null.extern" }
        : { op: "f64.const", value: 0 };
  // Each level emits its own `ref.test` condition then the `if`; the tail (no
  // match) yields the inert default.
  const wrap = (i: number): Instr[] => {
    if (i >= entries.length) return [def];
    const e = entries[i]!;
    return [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: e.typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: returnVT },
        then: [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: e.typeIdx },
          { op: "struct.get", typeIdx: e.typeIdx, fieldIdx },
        ],
        else: wrap(i + 1),
      },
    ];
  };
  // Wrap the chain in a single block so the caller pushes exactly one Instr.
  return { op: "block", blockType: { kind: "val", type: returnVT }, body: wrap(0) };
}

/**
 * Look up a native-generator info by the **TS type** of a for-of subject
 * expression, mapping the resolved wasm state struct typeIdx back to its
 * NativeGeneratorInfo. Returns undefined when the subject is not a native
 * generator value.
 */
export function nativeGeneratorInfoForForOfSubject(
  ctx: CodegenContext,
  subjectType: ValType,
): NativeGeneratorInfo | undefined {
  if (subjectType.kind !== "ref" && subjectType.kind !== "ref_null") return undefined;
  return nativeInfoForStateType(ctx, subjectType.typeIdx);
}

/**
 * #1665 — drive a `for (… of gen())` loop over a Wasm-native generator state
 * machine WITHOUT the JS-host iterator protocol. The generator state ref is
 * expected to already be on the stack (the caller compiled the iterable
 * expression); `subjectType` is its ValType.
 *
 * Emits, structurally identical to the host iterator loop but calling the
 * generator's resume function directly:
 *
 *   iter = <subject>
 *   block:
 *     loop:
 *       res = __gen_resume_<g>(iter)        ;; ref $result {value:f64, done:i32}
 *       if (res.done) br block
 *       elem = res.value                    ;; f64 (or coerced to elem decl type)
 *       <body>
 *       br loop
 *
 * Only numeric (f64) yields are supported by the existing native generator
 * (`isNativeGeneratorCandidate`), so the loop variable is f64. Returns true on
 * success; false (with the stack untouched-by-contract: caller resets) when the
 * shape is unsupported so the caller can fall back.
 */
export function tryCompileNativeGeneratorForOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  subjectType: ValType,
  info: NativeGeneratorInfo,
): boolean {
  // for-await-of over a sync generator is not supported here.
  if (stmt.awaitModifier) return false;
  // Only plain identifier / simple binding loop variables in this slice;
  // destructuring over a numeric generator value is meaningless (f64 isn't
  // destructurable) and array/object patterns fall back.
  let loopVarName: string | undefined;
  let isConst = false;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) return false;
    loopVarName = decl.name.text;
    isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
  } else if (ts.isIdentifier(stmt.initializer)) {
    loopVarName = stmt.initializer.text;
  } else {
    return false;
  }

  // The caller only reaches here when nativeGeneratorInfoForForOfSubject
  // matched, i.e. subjectType is a ref/ref_null to the generator state struct.
  if (subjectType.kind !== "ref" && subjectType.kind !== "ref_null") return false;
  const subjectTypeIdx = subjectType.typeIdx;

  const resumeIdx = ensureNativeGeneratorResumeFunction(ctx, info);
  const resultRef: ValType = { kind: "ref", typeIdx: info.resultTypeIdx };

  // Stash the generator state ref (currently on stack) into a local typed as
  // the exact state struct (it always is; the static type may be ref_null).
  const iterLocal = allocLocal(fctx, `__nativegen_iter_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: info.stateTypeIdx,
  } as ValType);
  if (subjectType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  if (subjectTypeIdx !== info.stateTypeIdx) {
    fctx.body.push({ op: "ref.cast", typeIdx: info.stateTypeIdx });
  }
  fctx.body.push({ op: "local.set", index: iterLocal });

  const resultLocal = allocLocal(fctx, `__nativegen_res_${fctx.locals.length}`, resultRef);

  // Loop variable: the generator's element ValType (f64 numeric, or the native
  // string ref for a string generator — #2171). const-ness recorded so
  // shadowing/TDZ logic downstream stays consistent.
  const elemLocal = allocLocal(fctx, loopVarName, info.elemValType);
  if (isConst) {
    if (!fctx.constBindings) fctx.constBindings = new Set();
    fctx.constBindings.add(loopVarName);
  }

  // block { loop { … } } — break = depth 1 (exit block), continue = depth 0.
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue/return/rethrow depths: block + loop add 2.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;

  fctx.breakStack.push(1);
  fctx.continueStack.push(0);

  // res = resume(iter)
  fctx.body.push({ op: "local.get", index: iterLocal });
  if (subjectType.typeIdx !== info.stateTypeIdx) {
    fctx.body.push({ op: "ref.cast", typeIdx: info.stateTypeIdx });
  }
  fctx.body.push({ op: "call", funcIdx: resumeIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // if (res.done) br block (depth 1: exit loop+block ⇒ depth to block is 1)
  fctx.body.push(...readResultField(resultLocal, info.resultTypeIdx, RESULT_DONE_FIELD));
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "br", depth: 2 }], // if + loop = depth 2 to exit block
    else: [],
  });

  // elem = res.value
  fctx.body.push(...readResultField(resultLocal, info.resultTypeIdx, RESULT_VALUE_FIELD));
  fctx.body.push({ op: "local.set", index: elemLocal });

  // body
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore depths.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
  return true;
}

/**
 * #2169 — materialize a Wasm-native generator into a `__vec` of f64 by driving
 * its resume function to completion, WITHOUT the JS-host iterator protocol.
 *
 * The non-`for-of` iterator consumers (array spread `[...g()]`, `Array.from(g())`,
 * array-destructuring `[a,b]=g()`) previously treated the generator's state
 * struct as if it were a `__vec` (reading field 0 as a `$length`), producing a
 * garbage-length array of defaults / leaking host imports. This helper gives
 * them the same `next()`-until-`done` drain the for-of driver uses, but
 * collects the values into a growable backing array and leaves a freshly
 * constructed `ref $vec_f64` on the stack (so the caller can treat it as a
 * normal materialized vec).
 *
 * Contract: the generator state ref (`subjectType`, a ref/ref_null to the
 * `info.stateTypeIdx` struct) MUST already be on the stack. On return the stack
 * top is `(ref <vecTypeIdx>)` of element type f64. Numeric yields only (native
 * generators are numeric today; non-numeric is #2171 / SF-4).
 *
 * The vec struct layout matches `getVecInfo`: field 0 = `$length` (i32),
 * field 1 = `$data` (ref $arr). `vecTypeIdx`/`arrTypeIdx` are supplied by the
 * caller (an f64 vec from `getOrRegisterVecType`).
 *
 * `trimToLength` (#2169 destructure consumer): when true, the backing array is
 * resized to EXACTLY `len` before the final `struct.new`, so `array.len(data)`
 * equals the logical `$length`. The default (false) leaves the capacity-padded
 * array in place — fine for consumers that read the `$length` field (spread,
 * Array.from), but the array-destructuring path bounds-checks against
 * `array.len(data)` (`emitBoundsCheckedArrayGet`), so a capacity-padded array
 * would make an out-of-length index read a default-initialized `0.0` slot
 * instead of being OOB, silently skipping binding defaults (`const [a,b=9]=g()`
 * with one yield). Trimming restores the literal-array invariant the destructure
 * machinery relies on (backing-array length == logical length).
 */
export function emitNativeGeneratorToVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  subjectType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  trimToLength = false,
): void {
  const resumeIdx = ensureNativeGeneratorResumeFunction(ctx, info);
  const resultRef: ValType = { kind: "ref", typeIdx: info.resultTypeIdx };

  // Stash the generator state ref (currently on stack) into a local typed as
  // the exact state struct.
  const iterLocal = allocLocal(fctx, `__gen2vec_iter_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: info.stateTypeIdx,
  } as ValType);
  if (subjectType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  if ((subjectType as { typeIdx?: number }).typeIdx !== info.stateTypeIdx) {
    fctx.body.push({ op: "ref.cast", typeIdx: info.stateTypeIdx });
  }
  fctx.body.push({ op: "local.set", index: iterLocal });

  const resultLocal = allocLocal(fctx, `__gen2vec_res_${fctx.locals.length}`, resultRef);
  const capLocal = allocLocal(fctx, `__gen2vec_cap_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__gen2vec_len_${fctx.locals.length}`, { kind: "i32" });
  const dataLocal = allocLocal(fctx, `__gen2vec_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const growLocal = allocLocal(fctx, `__gen2vec_grow_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });

  // cap = 4; data = new f64[cap]; len = 0.
  fctx.body.push({ op: "i32.const", value: 4 });
  fctx.body.push({ op: "local.set", index: capLocal });
  fctx.body.push({ op: "local.get", index: capLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Grow when len == cap: cap *= 2; grow = new f64[cap];
  // array.copy grow[0..len] = data[0..len]; data = grow.
  const growInstrs: Instr[] = [
    { op: "local.get", index: capLocal },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.set", index: capLocal },
    { op: "local.get", index: capLocal },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: growLocal },
    { op: "local.get", index: growLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: dataLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: lenLocal },
    { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
    { op: "local.get", index: growLocal },
    { op: "local.set", index: dataLocal },
  ];

  // block { loop {
  //   res = resume(iter); if (res.done) br block;
  //   if (len == cap) grow; data[len] = res.value; len++; br loop;
  // } }
  const loopBody: Instr[] = [
    { op: "local.get", index: iterLocal },
    { op: "call", funcIdx: resumeIdx },
    { op: "local.set", index: resultLocal },
    ...readResultField(resultLocal, info.resultTypeIdx, RESULT_DONE_FIELD),
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "br", depth: 2 }], else: [] },
    // grow if full
    { op: "local.get", index: lenLocal },
    { op: "local.get", index: capLocal },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then: growInstrs, else: [] },
    // data[len] = res.value
    { op: "local.get", index: dataLocal },
    { op: "local.get", index: lenLocal },
    ...readResultField(resultLocal, info.resultTypeIdx, RESULT_VALUE_FIELD),
    { op: "array.set", typeIdx: arrTypeIdx },
    // len++
    { op: "local.get", index: lenLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: lenLocal },
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // (#2169) Trim the backing array to exactly `len` when the consumer
  // bounds-checks against `array.len(data)` rather than the `$length` field
  // (array-destructuring). trimmed = new f64[len]; array.copy trimmed = data[0..len];
  // data = trimmed.
  if (trimToLength) {
    const trimLocal = allocLocal(fctx, `__gen2vec_trim_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: trimLocal });
    fctx.body.push({ op: "local.get", index: trimLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.get", index: dataLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.get", index: trimLocal });
    fctx.body.push({ op: "local.set", index: dataLocal });
  }

  // Construct ref $vec { length: len, data }. When `trimToLength` is false the
  // backing array may be larger than len (capacity); the vec's $length field is
  // the authoritative element count, matching every other materialized vec in
  // the codebase. When true, array.len(data) == len as well.
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: dataLocal });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
}
