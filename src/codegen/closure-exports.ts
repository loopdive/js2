// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// closure-exports.ts — the `__call_fn_<N>` / `__call_fn_method_<N>` host-dispatch
// exports plus the is-closure / closure-arity / is-data-struct / standalone
// `typeof`-classification exports (#3272, extracted verbatim from index.ts).
// One cohesive subsystem: it lets a JS host invoke and classify WasmGC closures
// via ref.test/ref.cast shape dispatch. Called only by the compile driver
// (generateModule), which imports these back.

import { ts } from "../ts-api.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType, getArrTypeIdxFromVec } from "./registry/types.js";
import { addUnionImports } from "./registry/imports.js";
import { buildClosureRefTestArms, collectClosureBaseWrapperTypeIdxs } from "./closure-classifier.js";
import { CLOSURE_ARITY_FIELD_IDX, getFuncRefWrapperRootTypeIdx } from "./closures/funcref-wrapper-types.js";
import {
  buildTransferredSubstringCallInstrs,
  collectTransferredSubstringReceivers,
  resolveClosureBaseWrapperTypeIdx,
} from "./closures/transferred-native-proto.js";
import { ensureArgcGlobal, ensureCurrentThisGlobal, ensureExtrasArgvGlobal } from "./statements/nested-declarations.js";
import { ensureAnyToExternHelper, isAnyValue } from "./any-helpers.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { isSyntheticStructName } from "./emit-helpers.js";

/**
 * Emit __call_fn_0 export (#851): call a zero-arg WasmGC closure from JS.
 * (#1712) Thin alias over the generic N-arg emitter, which carries the
 * per-shape funcref extraction (capture-struct coverage), the #820l
 * argc/extras plumbing, and the #1896 arg coercion. The historical
 * hand-rolled body tested only one representative base-wrapper struct type,
 * which silently excluded capture-carrying closures from dispatch (their
 * struct types have no Wasm subtype relation to the 1-field base wrapper).
 */
export function emitClosureCallExport(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 0);
}

/**
 * Emit __call_fn_1 export (#1090): call a one-arg WasmGC closure from JS.
 * (#1712) Thin alias over the generic N-arg emitter. Besides the per-shape
 * funcref extraction fix, this widens coverage from exactly-arity-1 to
 * arity <= 1, matching the documented `_maybeWrapCallableUnknownArity`
 * contract ("the __call_fn_N dispatcher iterates closures of arity <= N"):
 * the runtime wraps property-stored closures with the HIGHEST available
 * dispatcher, so __call_fn_1 must be able to invoke a zero-arg closure
 * (extra args dropped, #820l argc/extras plumbing included).
 */
export function emitClosureCallExport1(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 1);
}

/**
 * Emit __call_fn_2 export — wraps the generic N-arg helper at arity 2.
 * Kept as a thin alias so the call-site name in `compile()` stays
 * descriptive when reading the dispatch sequence.
 */
export function emitClosureCallExport2(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 2);
}

/**
 * Emit __call_fn_3 export (#1382 Phase 2): call a three-arg WasmGC closure
 * from JS. Same dispatch as __call_fn_2 but with one extra positional
 * arg, matching Array HOF callbacks `(value, index, array)`.
 */
export function emitClosureCallExport3(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 3);
}

/**
 * Emit __call_fn_4 export (#1382 Phase 2): call a four-arg WasmGC closure
 * from JS. Used for `Array.prototype.reduce(cb, initial)` which invokes
 * `cb(accumulator, currentValue, currentIndex, array)`.
 */
export function emitClosureCallExport4(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 4);
}

/**
 * #1896 — Decide whether a host-supplied `externref` closure-call argument must
 * be lowered out of the extern domain before it feeds the closure's `call_ref`.
 *
 * The `__call_fn_<arity>` / `__call_fn_method_<arity>` exports take all user
 * args as `externref` (the host ABI). The lifted closure funcref, however,
 * declares each user param with the closure's *internal* ValType. Under the
 * native-strings backends a `string` param lowers to `(ref null $AnyString)`
 * (a concrete struct ref), so the raw `externref` arg mismatches `call_ref`
 * and the module fails validation. In `wasm:js-string` (gc) mode the string
 * param ValType *is* `externref`, so no conversion is needed.
 *
 * Returns true for non-extern reference param kinds (`anyref`/`eqref`/`ref`/
 * `ref_null`); false for `externref`/`ref_extern` (already extern-side) and for
 * the numeric/value kinds (handled by the f64/i32 unbox branches at the call
 * site, or simply not reference args).
 */
function needsExternToAnyForClosureParam(paramType: ValType): boolean {
  switch (paramType.kind) {
    case "anyref":
    case "eqref":
    case "ref":
    case "ref_null":
      return true;
    default:
      // externref / ref_extern (already extern), funcref, and value types.
      return false;
  }
}

/**
 * #1896 — Lower an `externref` closure-call arg into the internal ref domain
 * expected by the closure funcref's declared param ValType. `any.convert_extern`
 * moves externref → anyref (engine-level identity); for a *concrete* ref param
 * (`ref`/`ref_null` to a struct type, e.g. `(ref null $AnyString)`) a following
 * `ref.cast` narrows anyref → the exact param type so `call_ref` typechecks.
 * `anyref`/`eqref` params need no cast. Caller must have checked
 * `needsExternToAnyForClosureParam(paramType)` first.
 */
function externToClosureParamRef(paramType: ValType): Instr[] {
  const ops: Instr[] = [{ op: "any.convert_extern" }];
  if (paramType.kind === "ref") {
    ops.push({ op: "ref.cast", typeIdx: paramType.typeIdx });
  } else if (paramType.kind === "ref_null") {
    ops.push({ op: "ref.cast_null", typeIdx: paramType.typeIdx });
  }
  return ops;
}

/** Preserve the structural boolean brand when an i32 crosses the externref ABI. */
function boxI32ClosureResult(
  ctx: CodegenContext,
  returnType: { kind: "i32"; boolean?: true },
  boxNumberIdx: number | undefined,
): Instr[] {
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  if (returnType.boolean === true && boxBooleanIdx !== undefined) {
    return [{ op: "call", funcIdx: boxBooleanIdx }];
  }
  if (boxNumberIdx !== undefined) {
    return [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumberIdx }];
  }
  return [{ op: "drop" }, { op: "ref.null.extern" }];
}

/**
 * Emit __call_fn_<arity> export (#1382): call an N-arg WasmGC closure from
 * JS. Takes (externref closure, externref arg0, ..., externref arg<arity-1>)
 * and returns externref. Used by `__array_from`, `__proto_method_call`, and
 * other host shims that pass Wasm closures as JS callbacks.
 *
 * Dispatch: iterate ALL closure types whose user arity ≤ N. For each
 * matching closure, push only as many args as it declared (matches JS
 * spec's "extra args ignored" semantics for over-arity calls). Funcref-
 * type dispatch is required because V8 isorecursive canonicalization
 * collapses base wrapper struct types — only funcref types remain
 * distinct per signature.
 *
 * Locals layout:
 *   0..arity-1 = positional externref params (closure + user args)
 *   arity      = anyref (__any) — converted closure externref
 *   arity+1    = (ref null $baseWrapper) (__struct)
 *   arity+2    = funcref (__funcref)
 *
 * Returns early when no closures of arity ≤ N exist (no export emitted).
 */
function emitClosureCallExportN(ctx: CodegenContext, arity: number): void {
  const mod = ctx.mod;
  const exportName = `__call_fn_${arity}`;

  // Local index conventions for the dispatcher body. `arity` positional
  // params (closure + user args 0..arity-1) come first; auxiliary locals
  // are appended after the params.
  //
  //   0           = closure externref
  //   1..arity-1  = user arg externrefs
  //   anyLocal    = anyref (closure-as-anyref after extern.convert_any)
  //   structLocal = (ref null $baseWrapper) for the cast struct
  //   funcLocal   = funcref extracted from struct field 0
  const anyLocal = arity + 1;
  // arity + 2 is the declared-but-now-unused `__struct` slot (kept so the
  // local layout and funcLocal index stay stable after the #1712 per-shape
  // extraction removed the single representative struct cast).
  const funcLocal = arity + 3;

  let baseWrapperIdx: number | undefined;
  const seenFuncTypeIdx = new Set<number>();
  // Each entry tracks how many user args the closure declared
  // (closureArity ≤ arity). The host always invokes the dispatcher with
  // `arity` user args; when a closure declared fewer, the dispatch arm
  // drops the extra args. Matches JS spec's "extra args ignored at call
  // time" semantics.
  const entries: {
    funcTypeIdx: number;
    returnType: ValType | null;
    selfTypeIdx: number;
    closureArity: number;
  }[] = [];

  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length > arity) continue;

    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;

    if (typeDef.superTypeIdx === -1 && baseWrapperIdx === undefined) {
      baseWrapperIdx = typeIdx;
    }

    if (!seenFuncTypeIdx.has(info.funcTypeIdx)) {
      seenFuncTypeIdx.add(info.funcTypeIdx);
      const funcTypeDef = mod.types[info.funcTypeIdx];
      const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
      const selfTypeIdx =
        selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
          ? (selfParam as { typeIdx: number }).typeIdx
          : typeIdx;
      entries.push({
        funcTypeIdx: info.funcTypeIdx,
        returnType: info.returnType,
        selfTypeIdx,
        closureArity: info.paramTypes.length,
      });
    }
  }

  if (entries.length === 0) return;

  // Fall back to the module's canonical wrapper root if no target-arity entry
  // selected it. Shared signature wrappers are distinct children, not
  // canonicalized peers; only the permanently-open root admits every shared
  // signature wrapper for the initial ref.test + struct.get.
  baseWrapperIdx = resolveClosureBaseWrapperTypeIdx(ctx, arity, baseWrapperIdx);
  if (baseWrapperIdx === undefined) return;

  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");

  // #820l — globals for argc + extras-argv plumbing into the callee's
  // `arguments` object. Both globals are mode-agnostic; ensureExtrasArgvGlobal
  // also returns the vec struct typeIdx whose `data` field is an externref
  // array (the same shape used by emitArgumentsVecBody on the receive side).
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const { globalIdx: extrasArgvGlobalIdx, vecTypeIdx: extrasVecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const extrasArrTypeIdx = getArrTypeIdxFromVec(ctx, extrasVecTypeIdx);

  // __call_fn_<arity>(closure: externref, arg0: externref, ..., arg<arity-1>: externref) → externref
  const params: ValType[] = [];
  for (let i = 0; i < arity + 1; i++) params.push({ kind: "externref" });
  const exportFuncTypeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `$${exportName}_type`);
  const funcIdx = ctx.numImportFuncs + mod.functions.length;
  const bwIdx = baseWrapperIdx;

  const body: Instr[] = [];
  body.push({ op: "local.get", index: 0 });
  body.push({ op: "any.convert_extern" });
  body.push({ op: "local.set", index: anyLocal });

  let funcrefDispatch: Instr[] = [{ op: "ref.null.extern" }];

  for (const entry of entries) {
    const funcTypeDef = mod.types[entry.funcTypeIdx];

    const buildArgConversion = (argLocalIdx: number, paramType: ValType | undefined): Instr[] => {
      const ops: Instr[] = [{ op: "local.get", index: argLocalIdx }];
      if (paramType) {
        if (paramType.kind === "f64") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            ops.push({ op: "call", funcIdx: unboxIdx });
          }
        } else if (paramType.kind === "i32") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            ops.push({ op: "call", funcIdx: unboxIdx });
            ops.push({ op: "i32.trunc_f64_s" });
          }
        } else if (needsExternToAnyForClosureParam(paramType)) {
          // The host-facing param is `externref`, but the closure funcref
          // declares this reference param as a non-extern ref type (anyref or
          // a WasmGC struct ref — e.g. a native-strings `string` lowers to
          // `(ref null $AnyString)`). Lower the host externref to the internal
          // ref domain so the subsequent `call_ref` typechecks. In
          // `wasm:js-string` (gc) mode string params ARE externref, so this
          // branch is skipped and the arg passes raw.
          ops.push(...externToClosureParamRef(paramType));
        }
        // externref param: no conversion
      }
      return ops;
    };

    // Push self + user args 0..closureArity-1. Args beyond the closure's
    // declared arity are dropped (no `local.get` emitted for them).
    const argInstrs: Instr[] = [];
    for (let i = 0; i < entry.closureArity; i++) {
      const paramType =
        funcTypeDef?.kind === "func" && funcTypeDef.params.length >= i + 2 ? funcTypeDef.params[i + 1] : undefined;
      argInstrs.push(...buildArgConversion(i + 1, paramType));
    }

    // #820l — argc/extras-argv plumbing so the callee's `arguments` object
    // observes the *actual* host-passed arg count, not just `closureArity`.
    // The host invokes the dispatcher with `arity` user args at locals
    // [1..arity]; the closure declares `closureArity ≤ arity` formals. The
    // receive-side (emitArgumentsVecBody) reads __argc + __extras_argv to
    // build `arguments` with all `arity` slots populated.
    //
    // (#2745) `__argc` follows the CLAMPED-to-formals convention that
    // `emitArgumentsVecBody` (`totalLen = argc + extrasLen`),
    // `maybeSetArgcForKnownCall` (`min(actual, paramCount)`) and the inline
    // array-method plumbing all use: it is the count of FORMAL params filled
    // (`closureArity`), NOT the raw dispatcher arity. The overflow args go to
    // `__extras_argv`, so `arguments.length = argc + extrasLen = arity`. Setting
    // `__argc = arity` here instead double-counted the extras (e.g. an arity-0
    // closure called via `__call_fn_3` reported `arguments.length === 6`), which
    // broke bound-function over-arity forwarding (the bound `[[Call]]` prepends
    // partial args, so the target sees more args than its declared formals).
    const setupInstrs: Instr[] = [
      { op: "i32.const", value: entry.closureArity },
      { op: "global.set", index: argcGlobalIdx },
    ];
    if (arity > entry.closureArity) {
      // vec struct field order: (length: i32, data: arrRef). Push len first.
      const extrasCount = arity - entry.closureArity;
      setupInstrs.push({ op: "i32.const", value: extrasCount });
      for (let i = entry.closureArity; i < arity; i++) {
        setupInstrs.push({ op: "local.get", index: i + 1 });
      }
      setupInstrs.push({ op: "array.new_fixed", typeIdx: extrasArrTypeIdx, length: extrasCount });
      setupInstrs.push({ op: "struct.new", typeIdx: extrasVecTypeIdx });
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx });
    } else {
      // No extras for this arm — reset to avoid stale data from a prior call.
      setupInstrs.push({ op: "ref.null", typeIdx: extrasVecTypeIdx });
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx });
    }

    const callBody: Instr[] = [
      ...setupInstrs,
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: entry.selfTypeIdx },
      ...argInstrs,
      { op: "local.get", index: funcLocal },
      { op: "ref.cast", typeIdx: entry.funcTypeIdx },
      { op: "call_ref", typeIdx: entry.funcTypeIdx },
    ];

    // Coerce result to externref.
    if (entry.returnType) {
      if ((ctx.standalone || ctx.wasi) && isAnyValue(entry.returnType, ctx)) {
        const anyToExternIdx = ensureAnyToExternHelper(ctx);
        if (anyToExternIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: anyToExternIdx });
        } else {
          callBody.push({ op: "extern.convert_any" });
        }
      } else if (entry.returnType.kind === "ref" || entry.returnType.kind === "ref_null") {
        callBody.push({ op: "extern.convert_any" });
      } else if (entry.returnType.kind === "f64") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: boxNumberIdx });
        } else {
          callBody.push({ op: "drop" });
          callBody.push({ op: "ref.null.extern" });
        }
      } else if (entry.returnType.kind === "i32") {
        callBody.push(...boxI32ClosureResult(ctx, entry.returnType, boxNumberIdx));
      } else if (entry.returnType.kind === "i64") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "f64.convert_i64_s" });
          callBody.push({ op: "call", funcIdx: boxNumberIdx });
        } else {
          callBody.push({ op: "drop" });
          callBody.push({ op: "ref.null.extern" });
        }
      }
    } else {
      callBody.push({ op: "ref.null.extern" });
    }

    funcrefDispatch = [
      { op: "local.get", index: funcLocal },
      { op: "ref.test", typeIdx: entry.funcTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callBody,
        else: funcrefDispatch,
      },
    ];
  }

  // (#1712) Funcref extraction must succeed for EVERY self-carrier shape in the
  // dispatch entries. Shared capture structs now subtype their signature
  // wrapper and canonical root, but private/named function-expression structs
  // retain unrelated concrete self types. Mirror `__is_closure`
  // (collectClosureBaseWrapperTypeIdxs): chain a `ref.test` per distinct self
  // shape, extracting field 0 from whichever matches. `funcLocal` stays null
  // when nothing matches and the dispatch falls through as before.
  body.push(...buildFuncrefExtraction(ctx, entries, anyLocal, funcLocal));
  body.push(...funcrefDispatch);

  mod.functions.push({
    name: exportName,
    typeIdx: exportFuncTypeIdx,
    locals: [
      { name: "__any", type: { kind: "anyref" } },
      { name: "__struct", type: { kind: "ref_null", typeIdx: bwIdx } },
      { name: "__funcref", type: { kind: "funcref" } },
    ],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: exportName,
    desc: { kind: "func", index: funcIdx },
  });
}

/**
 * (#1712) Build the funcref-extraction preamble shared by the
 * `__call_fn_<arity>` / `__call_fn_method_<arity>` dispatchers: for each
 * distinct closure self-struct shape among the dispatch entries, test the
 * anyref against the shape and, on match, store its field-0 funcref into
 * `funcLocal`. Every lifted closure struct has field 0 = funcref by
 * construction, so a value matching several canonically-equal shapes just
 * re-extracts the same funcref. Non-closure inputs match nothing and leave
 * `funcLocal` as null funcref (the dispatch chain's `ref.test`s all fail on
 * null and yield the `ref.null.extern` fallthrough).
 */
function buildFuncrefExtraction(
  ctx: CodegenContext,
  entries: { selfTypeIdx: number }[],
  anyLocal: number,
  funcLocal: number,
): Instr[] {
  // (#3673) Root-collapse: every shared-signature wrapper AND every
  // capture-carrying closure struct subtypes the canonical root wrapper
  // (mintClosureStructTypes / getOrCreateFuncRefWrapperTypes), and field 0 is
  // funcref on the root itself — so ONE `ref.test <root>` arm extracts the
  // funcref for all of them. Only shapes with no path to the root (named
  // function expressions, wrapper-less fallbacks) keep per-shape arms. The
  // old one-arm-per-shape ladder ran per dynamic call/arity-probe and scaled
  // with the number of closures in the program (hundreds for acorn).
  const rootIdx = getFuncRefWrapperRootTypeIdx(ctx);
  const isRootDescendant = (typeIdx: number): boolean => {
    if (rootIdx === undefined) return false;
    let cur: number | undefined = typeIdx;
    let guard = 0;
    while (cur !== undefined && cur >= 0 && guard++ < 64) {
      if (cur === rootIdx) return true;
      const t: { kind: string; superTypeIdx?: number } | undefined = ctx.mod.types[cur];
      cur = t && t.kind === "struct" ? t.superTypeIdx : undefined;
    }
    return false;
  };
  const out: Instr[] = [];
  const seenShape = new Set<number>();
  let needRootArm = false;
  const ladderShapes: number[] = [];
  for (const entry of entries) {
    if (seenShape.has(entry.selfTypeIdx)) continue;
    seenShape.add(entry.selfTypeIdx);
    if (isRootDescendant(entry.selfTypeIdx)) needRootArm = true;
    else ladderShapes.push(entry.selfTypeIdx);
  }
  if (needRootArm) {
    out.push({ op: "local.get", index: anyLocal });
    out.push({ op: "ref.test", typeIdx: rootIdx! });
    out.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: rootIdx! },
        { op: "struct.get", typeIdx: rootIdx!, fieldIdx: 0 },
        { op: "local.set", index: funcLocal },
      ],
    });
  }
  for (const selfTypeIdx of ladderShapes) {
    out.push({ op: "local.get", index: anyLocal });
    out.push({ op: "ref.test", typeIdx: selfTypeIdx });
    out.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: selfTypeIdx },
        { op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: funcLocal },
      ],
    });
  }
  return out;
}

/**
 * Emit `__call_fn_method_<arity>` export (#1636-S1): call an N-arg WasmGC
 * closure from JS with a host-supplied `this`-value. Signature is
 * `(thisVal: externref, closure: externref, arg0..arg<arity-1>) -> externref`.
 *
 * Dispatch shape mirrors `emitClosureCallExportN` (same funcref-type
 * iteration, same arg-coercion + return-boxing). The only difference is
 * that `thisVal` is stored in the `__current_this` module global before the
 * inner `call_ref` and restored after, so `ThisKeyword` resolution in the
 * closure body observes the host's receiver instead of the previous null
 * fallback (see `ensureCurrentThisGlobal`).
 *
 * Returns early when no closures of arity ≤ N exist (no export emitted).
 */
export function emitClosureMethodCallExportN(ctx: CodegenContext, arity: number): void {
  const mod = ctx.mod;
  const exportName = `__call_fn_method_${arity}`;

  // Local index conventions for the dispatcher body:
  //   0           = thisVal externref
  //   1           = closure externref
  //   2..arity+1  = user arg externrefs (arity slots)
  //   anyLocal    = anyref (closure-as-anyref after extern.convert_any)
  //   structLocal = (ref null $baseWrapper) for the cast struct
  //   funcLocal   = funcref extracted from struct field 0
  //   prevThis    = externref save slot for nested invocations
  const totalParams = arity + 2; // thisVal + closure + N user args
  const anyLocal = totalParams;
  // totalParams + 1 is the declared-but-now-unused `__struct` slot (see the
  // #1712 per-shape extraction note in emitClosureCallExportN).
  const funcLocal = totalParams + 2;
  const prevThisLocal = totalParams + 3;
  const resultSaveLocal = prevThisLocal + 1;

  let baseWrapperIdx: number | undefined;
  const seenFuncTypeIdx = new Set<number>();
  const entries: {
    funcTypeIdx: number;
    returnType: ValType | null;
    selfTypeIdx: number;
    closureArity: number;
  }[] = [];
  const substringReceiverEntries = collectTransferredSubstringReceivers(ctx, arity);

  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length > arity) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    if (typeDef.superTypeIdx === -1 && baseWrapperIdx === undefined) {
      baseWrapperIdx = typeIdx;
    }
    if (!seenFuncTypeIdx.has(info.funcTypeIdx)) {
      seenFuncTypeIdx.add(info.funcTypeIdx);
      const funcTypeDef = mod.types[info.funcTypeIdx];
      const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
      const selfTypeIdx =
        selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
          ? (selfParam as { typeIdx: number }).typeIdx
          : typeIdx;
      entries.push({
        funcTypeIdx: info.funcTypeIdx,
        returnType: info.returnType,
        selfTypeIdx,
        closureArity: info.paramTypes.length,
      });
    }
  }
  if (entries.length === 0 && substringReceiverEntries.length === 0) return;

  baseWrapperIdx = resolveClosureBaseWrapperTypeIdx(ctx, arity, baseWrapperIdx);
  if (baseWrapperIdx === undefined) return;

  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const currentThisGlobalIdx = ensureCurrentThisGlobal(ctx);
  // (#2745) Same #820l argc/extras plumbing as `emitClosureCallExportN`, so a
  // method-dispatched closure's `arguments` object observes over-arity args
  // (the receiver-bound bound-function `[[Call]]` / `[[Construct]]` path, and
  // any `o.m(...extra)` method call). Without this the method dispatch left
  // `__argc`/`__extras_argv` untouched, so a bound target reading
  // `arguments[i]` past its formals (e.g. `func.bind(obj)` then `newFunc(1)`)
  // never saw the extra args.
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const { globalIdx: extrasArgvGlobalIdx, vecTypeIdx: extrasVecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const extrasArrTypeIdx = getArrTypeIdxFromVec(ctx, extrasVecTypeIdx);

  const params: ValType[] = [];
  for (let i = 0; i < totalParams; i++) params.push({ kind: "externref" });
  const exportFuncTypeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `$${exportName}_type`);
  const funcIdx = ctx.numImportFuncs + mod.functions.length;
  const bwIdx = baseWrapperIdx;

  // Convert closure externref → anyref (closure is at local index 1).
  const body: Instr[] = [];
  body.push({ op: "local.get", index: 1 });
  body.push({ op: "any.convert_extern" });
  body.push({ op: "local.set", index: anyLocal });

  // Save previous __current_this for nesting safety, then install thisVal.
  body.push({ op: "global.get", index: currentThisGlobalIdx });
  body.push({ op: "local.set", index: prevThisLocal });
  body.push({ op: "local.get", index: 0 });
  body.push({ op: "global.set", index: currentThisGlobalIdx });

  body.push(
    ...buildTransferredSubstringCallInstrs(
      substringReceiverEntries,
      anyLocal,
      resultSaveLocal,
      prevThisLocal,
      currentThisGlobalIdx,
    ),
  );

  let funcrefDispatch: Instr[] = [{ op: "ref.null.extern" }];
  // (#3673 round 10) per-entry callBody capture for the arity-bucketed
  // dispatch built after the loop.
  const callBodyByEntry: { entry: (typeof entries)[number]; callBody: Instr[] }[] = [];

  for (const entry of entries) {
    const funcTypeDef = mod.types[entry.funcTypeIdx];

    const buildArgConversion = (argLocalIdx: number, paramType: ValType | undefined): Instr[] => {
      const ops: Instr[] = [{ op: "local.get", index: argLocalIdx }];
      if (paramType) {
        if (paramType.kind === "f64") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            ops.push({ op: "call", funcIdx: unboxIdx });
          }
        } else if (paramType.kind === "i32") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            ops.push({ op: "call", funcIdx: unboxIdx });
            ops.push({ op: "i32.trunc_f64_s" });
          }
        } else if (needsExternToAnyForClosureParam(paramType)) {
          // See emitClosureCallExportN: a non-extern reference param (anyref /
          // WasmGC struct ref, e.g. a native-strings `string`) needs the host
          // externref lowered into the internal ref domain before `call_ref`.
          // Skipped in gc mode where string params are already externref.
          ops.push(...externToClosureParamRef(paramType));
        }
      }
      return ops;
    };

    // User args occupy locals [2..arity+1]. Push only as many as the
    // closure declared.
    const argInstrs: Instr[] = [];
    for (let i = 0; i < entry.closureArity; i++) {
      const paramType =
        funcTypeDef?.kind === "func" && funcTypeDef.params.length >= i + 2 ? funcTypeDef.params[i + 1] : undefined;
      argInstrs.push(...buildArgConversion(i + 2, paramType));
    }

    // (#2745) #820l argc/extras plumbing (clamped-to-formals convention; see
    // emitClosureCallExportN). User args are at locals [2..arity+1]; formal i is
    // at local i+2, extras are args[closureArity..arity) at locals
    // [closureArity+2 .. arity+2).
    const setupInstrs: Instr[] =
      ctx.standalone || ctx.wasi
        ? [
            // `__apply_closure` presets the ACTUAL count before choosing a padded
            // dispatcher. Preserve min(actual, formals); ordinary direct/host calls
            // enter with the -1 sentinel and retain the historical formal count.
            { op: "global.get", index: argcGlobalIdx },
            { op: "i32.const", value: 0 },
            { op: "i32.ge_s" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "global.get", index: argcGlobalIdx },
                { op: "i32.const", value: entry.closureArity },
                { op: "i32.lt_s" },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [{ op: "global.get", index: argcGlobalIdx }],
                  else: [{ op: "i32.const", value: entry.closureArity }],
                },
              ],
              else: [{ op: "i32.const", value: entry.closureArity }],
            },
            { op: "global.set", index: argcGlobalIdx },
          ]
        : [
            { op: "i32.const", value: entry.closureArity },
            { op: "global.set", index: argcGlobalIdx },
          ];
    if (arity > entry.closureArity) {
      const extrasCount = arity - entry.closureArity;
      setupInstrs.push({ op: "i32.const", value: extrasCount });
      for (let i = entry.closureArity; i < arity; i++) {
        setupInstrs.push({ op: "local.get", index: i + 2 });
      }
      setupInstrs.push({ op: "array.new_fixed", typeIdx: extrasArrTypeIdx, length: extrasCount });
      setupInstrs.push({ op: "struct.new", typeIdx: extrasVecTypeIdx });
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx });
    } else {
      setupInstrs.push({ op: "ref.null", typeIdx: extrasVecTypeIdx });
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx });
    }

    const callBody: Instr[] = [
      ...setupInstrs,
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: entry.selfTypeIdx },
      ...argInstrs,
      { op: "local.get", index: funcLocal },
      { op: "ref.cast", typeIdx: entry.funcTypeIdx },
      { op: "call_ref", typeIdx: entry.funcTypeIdx },
    ];

    if (entry.returnType) {
      if ((ctx.standalone || ctx.wasi) && isAnyValue(entry.returnType, ctx)) {
        const anyToExternIdx = ensureAnyToExternHelper(ctx);
        if (anyToExternIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: anyToExternIdx });
        } else {
          callBody.push({ op: "extern.convert_any" });
        }
      } else if (entry.returnType.kind === "ref" || entry.returnType.kind === "ref_null") {
        callBody.push({ op: "extern.convert_any" });
      } else if (entry.returnType.kind === "f64") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: boxNumberIdx });
        } else {
          callBody.push({ op: "drop" });
          callBody.push({ op: "ref.null.extern" });
        }
      } else if (entry.returnType.kind === "i32") {
        callBody.push(...boxI32ClosureResult(ctx, entry.returnType, boxNumberIdx));
      } else if (entry.returnType.kind === "i64") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "f64.convert_i64_s" });
          callBody.push({ op: "call", funcIdx: boxNumberIdx });
        } else {
          callBody.push({ op: "drop" });
          callBody.push({ op: "ref.null.extern" });
        }
      }
    } else {
      callBody.push({ op: "ref.null.extern" });
    }

    funcrefDispatch = [
      { op: "local.get", index: funcLocal },
      { op: "ref.test", typeIdx: entry.funcTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callBody,
        else: funcrefDispatch,
      },
    ];
    callBodyByEntry.push({ entry, callBody });
  }

  // (#1712) Per-shape funcref extraction — same rationale as
  // `emitClosureCallExportN` / `buildFuncrefExtraction`: shared captures pass
  // the canonical-root test, while private/named closure self structs still
  // require their own shape arms. The funcref dispatch below leaves its
  // externref result on the stack (null fallthrough when `funcLocal` stayed
  // null because no shape matched).
  body.push(...buildFuncrefExtraction(ctx, entries, anyLocal, funcLocal));

  // (#3673 round 10) Arity-bucketed signature dispatch. The full ladder below
  // is one funcref `ref.test` per DISTINCT closure func type (≈48 in compiled
  // acorn) per dynamic call. The closure's `$arity` field (round 6, root
  // wrapper field 1) equals its func type's declared param count at every
  // compiler allocation site, so an i32 compare narrows the ladder to the
  // (small) same-arity bucket first. The arity field is NOT trusted for
  // correctness: builtin-fn metas stamp the SPEC length (e.g. a variadic
  // `JSON.stringify` value closure declares 1 vec param but `.length` 3), so
  // a bucket MISS — or a receiver with no root-readable arity — falls through
  // to the unchanged full ladder. `br 2` exits the wrapping externref block
  // from inside (entry-if ⊂ bucket-if ⊂ block) carrying the call result.
  const rootIdxForArity = getFuncRefWrapperRootTypeIdx(ctx);
  if (rootIdxForArity !== undefined && callBodyByEntry.length > 4) {
    const declaredLocal = prevThisLocal + 2; // extra i32 local appended below
    body.push({ op: "i32.const", value: -1 });
    body.push({ op: "local.set", index: declaredLocal });
    body.push({ op: "local.get", index: anyLocal });
    body.push({ op: "ref.test", typeIdx: rootIdxForArity });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: rootIdxForArity },
        { op: "struct.get", typeIdx: rootIdxForArity, fieldIdx: CLOSURE_ARITY_FIELD_IDX },
        { op: "local.set", index: declaredLocal },
      ],
    });
    const buckets = new Map<number, { entry: (typeof callBodyByEntry)[number]["entry"]; callBody: Instr[] }[]>();
    for (const item of callBodyByEntry) {
      let bucket = buckets.get(item.entry.closureArity);
      if (!bucket) {
        bucket = [];
        buckets.set(item.entry.closureArity, bucket);
      }
      bucket.push(item);
    }
    const bucketArms: Instr[] = [];
    for (const [closureArity, items] of buckets) {
      bucketArms.push(
        { op: "local.get", index: declaredLocal },
        { op: "i32.const", value: closureArity },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: items.flatMap(({ entry, callBody }): Instr[] => [
            { op: "local.get", index: funcLocal },
            { op: "ref.test", typeIdx: entry.funcTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              // Deep-clone: the same Instr OBJECTS also live in the full
              // ladder below, and shared instr identities get double-remapped
              // by finalize walks (see
              // `reference_shared_instr_object_dce_double_remap`).
              then: [...(structuredClone(callBody) as Instr[]), { op: "br", depth: 2 }],
            },
          ]),
        },
      );
    }
    body.push({
      op: "block",
      blockType: { kind: "val", type: { kind: "externref" } },
      body: [...bucketArms, ...funcrefDispatch],
    });
  } else {
    body.push(...funcrefDispatch);
  }

  // Restore __current_this. The result value remains on the stack as the
  // function's return value — we tee it through a local so we can restore
  // the global without disturbing the return value.
  // Stack at this point: [result : externref]
  // Strategy: store result in a local, restore global, reload result.
  // Reuse `prevThisLocal` is not safe since we still need its contents;
  // use `anyLocal` is also not safe (externref vs anyref). Add a dedicated
  // result-save slot at index `prevThisLocal + 1`.
  body.push({ op: "local.set", index: resultSaveLocal });
  body.push({ op: "local.get", index: prevThisLocal });
  body.push({ op: "global.set", index: currentThisGlobalIdx });
  body.push({ op: "local.get", index: resultSaveLocal });

  mod.functions.push({
    name: exportName,
    typeIdx: exportFuncTypeIdx,
    locals: [
      { name: "__any", type: { kind: "anyref" } },
      { name: "__struct", type: { kind: "ref_null", typeIdx: bwIdx } },
      { name: "__funcref", type: { kind: "funcref" } },
      { name: "__prev_this", type: { kind: "externref" } },
      { name: "__result", type: { kind: "externref" } },
      // (#3673 round 10) declared arity read off the root wrapper for the
      // arity-bucketed signature dispatch (-1 = not root-readable).
      { name: "__declared_arity", type: { kind: "i32" } },
    ],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: exportName,
    desc: { kind: "func", index: funcIdx },
  });

  // (#1719 CPR) Register in funcMap so the in-Wasm `__drive_proto_iterator`
  // driver (filled in post-processing) can resolve `__call_fn_method_0` by name
  // and `call` it to drive a captured `Array.prototype[@@iterator]` override.
  // No-op for existing JS-host callers (they dispatch by export name).
  ctx.funcMap.set(exportName, funcIdx);
}

/**
 * Emit __is_closure(externref) -> i32 (#1504). Returns 1 if the value is a
 * registered Wasm closure struct, 0 otherwise. Used by the JS-side
 * `wrapExports` to discriminate closures from named structs / vecs so it can
 * choose between callable-wrapping (#1308) and `_wasmToPlain` marshaling
 * (#1504). No-op when the module has no closures.
 */
/* (#2175 V2-S1) `collectClosureBaseWrapperTypeIdxs` moved to the leaf module
 * `closure-classifier.ts` so `index.ts` and `dyn-read.ts` share ONE list (see
 * that file). Imported at the top of this module. */

export function emitIsClosureExport(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Collect base wrapper struct types (deduped). Concrete closure subtypes
  // share their funcref signature with the base wrapper post-V8 canonicalisation,
  // so ref.test against the base catches all of them.
  const baseTypeIdxs = collectClosureBaseWrapperTypeIdxs(ctx);
  if (baseTypeIdxs.length === 0) return;

  const isClosureTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$is_closure_type");
  const funcIdx = ctx.numImportFuncs + mod.functions.length;

  // body: convert extern→any, then chained ref.test → return 1 on first match.
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  for (const closureType of baseTypeIdxs) {
    body.push({ op: "local.get", index: 1 });
    body.push({ op: "ref.test", typeIdx: closureType });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    });
  }
  body.push({ op: "i32.const", value: 0 });

  mod.functions.push({
    name: "__is_closure",
    typeIdx: isClosureTypeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: "__is_closure",
    desc: { kind: "func", index: funcIdx },
  });
}

/**
 * Emit `__closure_arity(externref) -> i32` (#2623 P-7 / B-1). Returns the
 * DECLARED formal-parameter count of a registered Wasm closure struct, or -1
 * when the value is not a closure. Used by the JS-side dynamic bridge
 * (`_wrapWasmClosureUnknownArity`) to dispatch a host→wasm method callback at
 * `max(args.length, realArity)` instead of always the HIGHEST emitted
 * `__call_fn_method_N`: dispatching at max-N padded the arg vector with
 * undefineds that the #820l argc/extras plumbing cannot distinguish from real
 * arguments, so the callee's `arguments.length` reported the dispatcher arity
 * (V8's native `.finally` invokes a patched `then` with exactly 2 args; the
 * wasm-side `then` observed `arguments.length === 5` — the test262
 * `Promise/prototype/finally/invokes-then-with-*` assert-#3 failure and the
 * #2614 assert-#2 finding).
 *
 * Dispatch shape mirrors `__call_fn_N` (per-shape funcref extraction via
 * {@link buildFuncrefExtraction}, then a `ref.test` chain over the distinct
 * closure FUNC types — the func type determines the formal count). No-op when
 * the module has no closures, exactly like `__is_closure`.
 */
function collectClosureArityEntries(
  ctx: CodegenContext,
): { funcTypeIdx: number; selfTypeIdx: number; closureArity: number }[] {
  const mod = ctx.mod;
  const seenFuncTypeIdx = new Set<number>();
  const entries: { funcTypeIdx: number; selfTypeIdx: number; closureArity: number }[] = [];
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    if (seenFuncTypeIdx.has(info.funcTypeIdx)) continue;
    seenFuncTypeIdx.add(info.funcTypeIdx);
    const funcTypeDef = mod.types[info.funcTypeIdx];
    const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
    const selfTypeIdx =
      selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
        ? (selfParam as { typeIdx: number }).typeIdx
        : typeIdx;
    entries.push({ funcTypeIdx: info.funcTypeIdx, selfTypeIdx, closureArity: info.paramTypes.length });
  }
  return entries;
}

/**
 * (#3592) INLINE twin of {@link emitClosureArityExport} for the IN-WASM dynamic
 * call bridge `__apply_closure`. Leaves an `i32` on the stack: the DECLARED
 * formal count of the closure in `valueLocal`, or `-1` when it is not a
 * registered closure. Returns `undefined` when the module has no closures (the
 * caller then keeps its arg-count-only dispatch, byte-identical).
 *
 * Emitted inline rather than as a `call` to the `__closure_arity` EXPORT because
 * that export is minted at index.ts:3975 — AFTER `fillApplyClosure` runs at
 * :3817 — and minting a function inside that finalize window is the
 * #1839/#117/#1886 late-registration index-shift hazard the whole "S1 pulls no
 * new machinery" carve-out in `fillApplyClosure` exists to avoid. Inlining
 * costs a duplicated `ref.test` chain and shifts nothing.
 *
 * `anyLocal` must be an `anyref` slot and `funcLocal` a `funcref` slot; both are
 * clobbered.
 */
function buildClosureArityProbe(
  ctx: CodegenContext,
  valueLocal: number,
  anyLocal: number,
  funcLocal: number,
): Instr[] | undefined {
  const entries = collectClosureArityEntries(ctx);
  if (entries.length === 0) return undefined;
  // (#3673) Root fast path: every closure struct in the wrapper hierarchy
  // carries its declared arity as field CLOSURE_ARITY_FIELD_IDX, so ONE
  // `ref.test <root>` + `struct.get` answers the probe — the per-func-type
  // `ref.test` chain (90 arms on compiled acorn) survives only for closure
  // shapes OUTSIDE the hierarchy (e.g. fnctor ctor closures).
  const rootIdx = getFuncRefWrapperRootTypeIdx(ctx);
  const isRootDescendant = (typeIdx: number): boolean => {
    if (rootIdx === undefined) return false;
    let cur: number | undefined = typeIdx;
    let guard = 0;
    while (cur !== undefined && cur >= 0 && guard++ < 64) {
      if (cur === rootIdx) return true;
      const t: { kind: string; superTypeIdx?: number } | undefined = ctx.mod.types[cur];
      cur = t && t.kind === "struct" ? t.superTypeIdx : undefined;
    }
    return false;
  };
  const ladderEntries = entries.filter((e) => !isRootDescendant(e.selfTypeIdx));
  // Nested if/else so exactly ONE arm wins (the export twin uses early `return`,
  // which is unavailable mid-body).
  let chain: Instr[] = [{ op: "i32.const", value: -1 }];
  for (let i = ladderEntries.length - 1; i >= 0; i--) {
    chain = [
      { op: "local.get", index: funcLocal },
      { op: "ref.test", typeIdx: ladderEntries[i]!.funcTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: ladderEntries[i]!.closureArity }],
        else: chain,
      },
    ];
  }
  const slowPath: Instr[] = [
    { op: "ref.null.func" },
    { op: "local.set", index: funcLocal },
    ...buildFuncrefExtraction(ctx, ladderEntries, anyLocal, funcLocal),
    ...chain,
  ];
  if (rootIdx === undefined) {
    return [
      { op: "local.get", index: valueLocal },
      { op: "any.convert_extern" },
      { op: "local.set", index: anyLocal },
      ...slowPath,
    ];
  }
  return [
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyLocal },
    { op: "ref.test", typeIdx: rootIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: rootIdx },
        { op: "struct.get", typeIdx: rootIdx, fieldIdx: CLOSURE_ARITY_FIELD_IDX },
      ],
      else: slowPath,
    },
  ];
}

/**
 * (#3592) Build `__apply_closure`'s UNDER-APPLICATION widening: replace the
 * bridge's dispatch index `n` (the raw argument count) with
 * `max(n, declaredArity(fn))`, appending the three probe locals to `locals`.
 * Returns `[]` — and appends nothing — when the module has no closures, so such
 * modules stay byte-identical.
 *
 * WHY: `__call_fn_method_N` carries only closures with `formals <= N`, so an
 * arity-3 closure dispatched at `n = 2` matched no arm and fell through to the
 * bridge's undefined sentinel — the call SILENTLY DID NOT HAPPEN. That is the
 * shape of the entire test262 assert harness (`assert.sameValue(found, expected,
 * message)` invoked with two args), so every under-applied `assert.*` scored a
 * VACUOUS PASS in the standalone/WASI lanes. The JS-host lane fixed the same bug
 * in JS at #2623 P-7 (`max(args.length, __closure_arity(fn))`); the in-Wasm
 * bridge never did.
 *
 * WHY `max` AND NOT PADDING: widening only to the callee's OWN declared count
 * keeps `N === closureArity`, where the #820l plumbing sets `__argc =
 * closureArity` with a null `__extras_argv` — byte-for-byte what an arity-matched
 * call sets, so `arguments.length` reflection is untouched. Padding the arg
 * vector to the highest emitted dispatcher instead fills `__extras_argv` with
 * synthetic `undefined`s, which is precisely the regression #2623 P-7 removed.
 *
 * Non-closures probe as `-1`, so over-application, exact-arity and
 * not-a-function all keep their existing dispatch index.
 *
 * Lives here rather than in `fillApplyClosure` so the widening sits next to the
 * `__call_fn_method_N` emitter whose arity filter it compensates for (and so the
 * `object-runtime.ts` god-file does not grow).
 */
export function buildApplyClosureArityWidening(
  ctx: CodegenContext,
  locals: { name: string; type: ValType }[],
  fnLocal: number,
  nLocal: number,
  paramCount: number,
): Instr[] {
  const declLocal = paramCount + locals.length;
  const probe = buildClosureArityProbe(ctx, fnLocal, declLocal + 1, declLocal + 2);
  if (!probe) return [];
  locals.push(
    { name: "__decl_arity", type: { kind: "i32" } },
    { name: "__arity_any", type: { kind: "anyref" } },
    { name: "__arity_func", type: { kind: "funcref" } },
  );
  return [
    ...probe,
    { op: "local.set", index: declLocal },
    { op: "local.get", index: declLocal },
    { op: "local.get", index: nLocal },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: declLocal },
        { op: "local.set", index: nLocal },
      ],
    },
  ];
}

export function emitClosureArityExport(ctx: CodegenContext): void {
  const mod = ctx.mod;

  const entries = collectClosureArityEntries(ctx);
  if (entries.length === 0) return;

  const arityTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$closure_arity_type");
  const funcIdx = ctx.numImportFuncs + mod.functions.length;

  // Locals: 0 = value externref (param), 1 = anyref, 2 = funcref.
  const anyLocal = 1;
  const funcLocal = 2;
  // (#3673) Root fast path — mirror of buildClosureArityProbe: one
  // struct.get on the wrapper root answers every in-hierarchy closure; the
  // per-func-type chain survives only for shapes outside the hierarchy.
  const rootIdxForExport = getFuncRefWrapperRootTypeIdx(ctx);
  const isRootDescendantExport = (typeIdx: number): boolean => {
    if (rootIdxForExport === undefined) return false;
    let cur: number | undefined = typeIdx;
    let guard = 0;
    while (cur !== undefined && cur >= 0 && guard++ < 64) {
      if (cur === rootIdxForExport) return true;
      const t: { kind: string; superTypeIdx?: number } | undefined = ctx.mod.types[cur];
      cur = t && t.kind === "struct" ? t.superTypeIdx : undefined;
    }
    return false;
  };
  const ladderEntriesExport = entries.filter((e) => !isRootDescendantExport(e.selfTypeIdx));
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocal },
  ];
  if (rootIdxForExport !== undefined) {
    body.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: rootIdxForExport },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: rootIdxForExport },
          { op: "struct.get", typeIdx: rootIdxForExport, fieldIdx: CLOSURE_ARITY_FIELD_IDX },
          { op: "return" },
        ],
      },
    );
  }
  body.push(...buildFuncrefExtraction(ctx, ladderEntriesExport, anyLocal, funcLocal));
  for (const entry of ladderEntriesExport) {
    body.push({ op: "local.get", index: funcLocal });
    body.push({ op: "ref.test", typeIdx: entry.funcTypeIdx });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: entry.closureArity }, { op: "return" }],
    });
  }
  body.push({ op: "i32.const", value: -1 });

  mod.functions.push({
    name: "__closure_arity",
    typeIdx: arityTypeIdx,
    locals: [
      { name: "__any", type: { kind: "anyref" } },
      { name: "__funcref", type: { kind: "funcref" } },
    ],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: "__closure_arity",
    desc: { kind: "func", index: funcIdx },
  });
  // Native in-module callers (notably `__apply_closure`) need the same
  // classifier the JS wrapper uses. Register the canonical function index so
  // reserve-then-fill runtimes can call it without introducing another ABI.
  ctx.funcMap.set("__closure_arity", funcIdx);
}

/**
 * Emit `__closure_has_rest(externref) -> i32` for the narrow host-accessor
 * bridge. A returned rest closure cannot be exposed through the generic
 * host-call dispatcher: its single Wasm formal is the materialized rest vec,
 * while V8 supplies the call's positional host arguments. Treating the first
 * host argument as that vec causes an uncatchable concrete-struct `ref.cast`.
 *
 * The source-shape bit lives on `ClosureInfo`; captured rest closures retain a
 * concrete subtype, while no-capture closures can reuse a signature-keyed
 * wrapper. The latter means an identical vec-signature non-rest closure is
 * conservatively left raw too. Modules without rest closures emit nothing.
 */
export function emitClosureHasRestExport(ctx: CodegenContext): void {
  const restTypes = [...ctx.closureInfoByTypeIdx]
    .filter(([, info]) => info.hasRestParam === true)
    .map(([typeIdx]) => typeIdx);
  if (restTypes.length === 0) return;

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$closure_has_rest_type");
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  for (const restType of new Set(restTypes)) {
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: restType },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
    );
  }
  body.push({ op: "i32.const", value: 0 });

  ctx.mod.functions.push({
    name: "__closure_has_rest",
    typeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);
  ctx.mod.exports.push({
    name: "__closure_has_rest",
    desc: { kind: "func", index: funcIdx },
  });
}

/**
 * Emit `__is_data_struct(externref) -> i32` (#2794). Returns 1 when the value is
 * a registered **named DATA struct** (a class instance, an object literal, an AST
 * Node — anything the host can read fields off via `__sget_<field>`), 0 otherwise.
 *
 * This is the POSITIVE data-vs-closure discriminator the `_wrapForHost` proxy
 * needs (mirrors the proven `__is_vec`): its `get` trap masks ANY non-vec wasm
 * struct field value as a callable `closureBridge` whenever generic `__call_fn_N`
 * dispatchers exist, which wrongly presented acorn's `decl.id` (an Identifier
 * Node) as a function — `expr.type` read `undefined` and var-declaration parses
 * threw "Binding rvalue". `__is_closure` cannot gate the bridge because it
 * FALSE-NEGATIVES on some genuine closures (a capture-less arrow read 0 → would
 * be wrongly diverted to an object proxy → "not a function"). A POSITIVE
 * data-struct marker has no such failure mode: closure wrapper structs are NOT
 * registered in `structFields` (they live only in `closureInfoByTypeIdx`), so a
 * `ref.test` against the data-struct set returns 0 for every closure and 1 only
 * for genuine data. The set mirrors `_emitStructFieldGettersInner` exactly (the
 * same skip-list), so a struct presents as an object iff the host already has
 * field getters for it. No-op when the module has no eligible data structs.
 */
export function emitIsDataStructExport(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Collect data-struct type indices (deduped), mirroring the getter emitter's
  // skip-list so the marker and the `__sget_<field>` getters cover one set.
  const dataTypeIdxs: number[] = [];
  const seen = new Set<number>();
  for (const [structName] of ctx.structFields) {
    if (isSyntheticStructName(structName)) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined || seen.has(typeIdx)) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    seen.add(typeIdx);
    dataTypeIdxs.push(typeIdx);
  }
  if (dataTypeIdxs.length === 0) return;

  const isDataTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$is_data_struct_type");
  const funcIdx = ctx.numImportFuncs + mod.functions.length;

  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  for (const dataType of dataTypeIdxs) {
    body.push({ op: "local.get", index: 1 });
    body.push({ op: "ref.test", typeIdx: dataType });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    });
  }
  body.push({ op: "i32.const", value: 0 });

  mod.functions.push({
    name: "__is_data_struct",
    typeIdx: isDataTypeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: "__is_data_struct",
    desc: { kind: "func", index: funcIdx },
  });
}

/**
 * #1896 — teach the standalone/WASI native `__typeof_function` and
 * `__typeof_object` helpers to recognise closure wrapper structs.
 *
 * Those helpers are synthesised by `addUnionImportsAsNativeFuncs`, which runs
 * once on the first `addUnionImports` call — frequently *mid-compile*, before
 * every closure type has been registered in `ctx.closureInfoByTypeIdx`. Baking
 * the base-wrapper set at registration time would therefore miss later-registered
 * closures. Instead we rewrite the two helper bodies HERE, at finalize, after all
 * closures are registered (same late timing as `emitIsClosureExport`). We locate
 * the functions by name in `ctx.mod.functions` and splice in `ref.test` arms over
 * the closure base wrappers — no funcIdx churn (we edit existing bodies in place).
 *
 * - `__typeof_function`: was `i32.const 0` (wrong — a stored standalone closure
 *   is callable). Now: `any.convert_extern` then chained `ref.test` over each
 *   closure base wrapper; return 1 on first match, else 0.
 * - `__typeof_object`: add a closure-base-wrapper `ref.test` guard that returns 0
 *   (a callable is `"function"`, never `"object"`) BEFORE the final non-null
 *   `i32.const 1`, so a wrapper read back from an open-object slot is not
 *   mis-classified as `"object"`.
 * - (#2175 V2-S1) `__typeof`: the MATERIALIZED typeof-result native (the tag as
 *   a NativeString VALUE, used by `const t = typeof x`). It classified
 *   null/number/boolean/bigint/string and fell through to `"object"` — with NO
 *   function arm, so a closure read back dynamically produced `"object"` while
 *   the INLINE `typeof x === "function"` compare (via the `__typeof_function`
 *   predicate above) produced `"function"`. That path-dependence is the #2984
 *   `typeof` instability and contradicts `JsTag.Function` (#2949 V1 tag
 *   fidelity). We splice a closure `ref.test` arm returning the `"function"`
 *   NativeString before the terminal `"object"` sequence, using the SAME
 *   closure base-wrapper list — one predicate, all three natives in lockstep.
 *
 * All three natives now share the single closure classifier
 * (`buildClosureRefTestArms` / `collectClosureBaseWrapperTypeIdxs`,
 * `closure-classifier.ts`) — never two divergent arm lists.
 *
 * No-op unless native-strings (the helpers only exist then) and at least one
 * closure base wrapper was registered.
 */
export function fillStandaloneTypeofClosureArms(ctx: CodegenContext): void {
  if (!ctx.nativeStrings) return;
  const baseTypeIdxs = collectClosureBaseWrapperTypeIdxs(ctx);
  if (baseTypeIdxs.length === 0) return;

  const fnByName = (name: string): WasmFunction | undefined =>
    ctx.mod.functions.find((f) => (f as { name?: string }).name === name) as WasmFunction | undefined;

  // Chained `ref.test` arms over the anyref-converted param in local 0/1. Each
  // i32-predicate arm returns `matchValue` on hit. Builds from the ONE shared
  // closure-base-wrapper list (`closure-classifier.ts`).
  const closureI32Arms = (anyLocalIdx: number, matchValue: number): Instr[] =>
    buildClosureRefTestArms(ctx, anyLocalIdx, [{ op: "i32.const", value: matchValue }, { op: "return" }]);

  // --- __typeof_function: param(0) externref → 1 if closure wrapper else 0.
  const tf = fnByName("__typeof_function");
  if (tf) {
    // Ensure an anyref local exists for the converted param (local index 1).
    if (tf.locals.length === 0) {
      tf.locals.push({ name: "$any_temp", type: { kind: "anyref" } });
    }
    tf.body = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 },
      ...closureI32Arms(1, 1),
      { op: "i32.const", value: 0 },
    ];
  }

  // --- __typeof_object: insert closure-exclusion (return 0) before the trailing
  // non-null `i32.const 1`. The existing body already converts the param to
  // anyref into local 1 (`$any_temp`) for its boxed-primitive guards, so reuse it.
  const to = fnByName("__typeof_object");
  if (to) {
    const b = to.body;
    // The body ends with `{ i32.const 1 }` (the "non-null → object" fallthrough).
    // Splice the closure-exclusion arms immediately before that terminal const.
    const lastIdx = b.length - 1;
    const last = b[lastIdx] as { op?: string; value?: number } | undefined;
    if (last && last.op === "i32.const" && last.value === 1) {
      b.splice(lastIdx, 0, ...closureI32Arms(1, 0));
    }
  }

  // --- (#2175 V2-S1) __typeof (materialized result): splice a closure arm that
  // returns the `"function"` NativeString before the terminal `"object"`
  // sequence. The body converts param → anyref into local 1 (`$any_temp`)
  // before its boxed-primitive guards, and local 1 still holds it at the
  // terminal, so the arm reads local 1 exactly like the primitive guards.
  //
  // Robust splice point: the terminal is the last N instrs, where N is the
  // length of `stringConstantExternrefInstrs(ctx, "object")` (deterministic —
  // "object" was already registered when the body was built, so re-deriving it
  // yields the same length). We verify the tail's op-shape matches before
  // splicing; if `__typeof` is the `ref.null.extern` stub (no native-string
  // type) the shape check fails and we skip — self-guarding.
  const tt = fnByName("__typeof");
  if (tt && ctx.nativeStrTypeIdx >= 0) {
    const b = tt.body;
    const objTerminal = stringConstantExternrefInstrs(ctx, "object");
    const spliceAt = b.length - objTerminal.length;
    const tailMatches =
      spliceAt >= 0 &&
      objTerminal.every(
        (inst, i) => (b[spliceAt + i] as { op?: string } | undefined)?.op === (inst as { op?: string }).op,
      );
    if (tailMatches) {
      const fnArm = buildClosureRefTestArms(ctx, 1, [
        ...stringConstantExternrefInstrs(ctx, "function"),
        { op: "return" },
      ]);
      b.splice(spliceAt, 0, ...fnArm);
    }
  }
}
