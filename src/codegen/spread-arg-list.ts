// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared spread-expanding argument-list builder (#5361).
 *
 * ## The defect this exists to remove
 *
 * A call-site argument list is a SYNTACTIC list of AST nodes, but its VALUE
 * list is a runtime one: `f(a, ...src, b)` contributes `2 + src.length`
 * values, and `src.length` is not known at compile time. Every lowering that
 * counts `callExpr.arguments.length` and emits one slot per node therefore
 * stores the spread SOURCE as a single element — the array shows up nested
 * inside the destination instead of expanded. `Array.prototype.splice` had
 * exactly that shape (`insertCount = arguments.length - 2`), which is how
 * hono's `expandIPv6` produced `["7f00,0001"]` where it wanted
 * `["7f00", "0001"]`.
 *
 * ## What this module provides
 *
 * `buildSpreadArgList` evaluates an argument list ONCE, left to right, into
 * per-argument slots, and computes the total element count into an i32 local.
 * The caller then drives `emitStores` with a SINK — a `pre`/`post`
 * instruction pair wrapped around each element value — so the same builder
 * serves destinations with completely different storage:
 *
 *   - a WasmGC backing array (`array.set` at a running write index) —
 *     `Array.prototype.splice`'s rebuild;
 *   - a host JS array (`__js_array_push`) — the generic
 *     `__extern_method_call` bridge;
 *   - no storage at all (a fold accumulator) — `Math.min`/`Math.max`.
 *
 * Values are coerced to the caller's element type, so a native vec of native
 * strings does not have to round-trip through externref.
 *
 * ## Why the two phases are separate
 *
 * `splice` needs the COUNT before it can allocate the new backing array, and
 * the values only after. Evaluation (which may have side effects and must
 * happen in source order, before the receiver is mutated) is therefore split
 * from the stores. `emitStores` emits no `compileExpression`, so it is safe to
 * call after an intervening allocation, a species-create, or a late-import
 * flush.
 *
 * ## Spread sources
 *
 * Three representations reach a spread argument, and each needs its own read:
 *
 *   - a TUPLE struct (`_0`, `_1`, …) — how an inline array literal `[x, y]`
 *     lowers in a value context. Static arity, `struct.get` per field. Without
 *     this arm `...["x", "y"]` is one opaque object (`[object Object]`).
 *   - a native vec struct (`__vec_*`) — read `length` (field 0) and index the
 *     backing array (field 1).
 *   - anything else (an opaque host value: a JS array from `.split()`, a Set,
 *     a generator) — materialize through the iterator protocol and index it
 *     with the host/native readers.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { noJsHost } from "./js-errors.js";
import { ensureNativeArrayFromIterN } from "./iterator-native.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { compileExpression, elemGetOp, ensureLateImport, flushLateImportShifts, unpackedElemType } from "./shared.js";
import {
  buildVecFromExternMaterializer,
  coerceType,
  coercionInstrs,
  defaultValueInstrs,
  getVecInfo,
} from "./type-coercion.js";

/** Where one built argument value goes. `pre` … value … `post`. */
export interface SpreadArgSink {
  /** Emitted before each element value (destination ref, write index, …). */
  pre: Instr[];
  /** Emitted after each element value (the store itself, index bump, …). */
  post: Instr[];
}

export interface SpreadArgList {
  /** i32 local holding the RUNTIME element count of the whole argument list. */
  countLocal: number;
  /** Emit `pre` + value + `post` for every element, in argument order. */
  emitStores(sink: SpreadArgSink): void;
}

/** True when any argument at or after `startIdx` is a spread element. */
export function hasSpreadArgument(args: readonly ts.Expression[], startIdx = 0): boolean {
  for (let i = startIdx; i < args.length; i++) if (ts.isSpreadElement(args[i]!)) return true;
  return false;
}

type Slot =
  /** One already-coerced value held in a local of the destination element type. */
  | { kind: "value"; local: number }
  /** A native vec spread: `lenLocal` elements read out of `dataLocal`. */
  | {
      kind: "vec";
      dataLocal: number;
      arrTypeIdx: number;
      storageElem: ValType;
      lenLocal: number;
    }
  /** An opaque (host / iterable) spread: `lenLocal` elements read by index. */
  | { kind: "extern"; srcLocal: number; lenLocal: number };

/**
 * True for a TUPLE struct value (`_0`, `_1`, …) — how an inline array literal
 * lowers in a value context. Such a source needs the static-arity expansion
 * arm; the vec readers cannot see its elements at all.
 */
export function isTupleStructType(ctx: CodegenContext, type: ValType | undefined): boolean {
  if (!type || (type.kind !== "ref" && type.kind !== "ref_null")) return false;
  return tupleFieldTypes(ctx, type.typeIdx) !== null;
}

/** Field types of a tuple struct (`_0`, `_1`, …), or null when not a tuple. */
function tupleFieldTypes(ctx: CodegenContext, typeIdx: number): ValType[] | null {
  const def = ctx.mod.types[typeIdx];
  if (!def || def.kind !== "struct") return null;
  const fields = (def as { fields: { name?: string; type: ValType }[] }).fields;
  if (fields.length === 0) return null;
  if (!fields.every((f, idx) => f.name === `_${idx}`)) return null;
  return fields.map((f) => f.type);
}

/**
 * Register the runtime substrate a spread expansion needs and settle the index
 * space, returning the materializer's name (or `undefined` when this target
 * cannot expand a spread at all).
 *
 * Everything is registered BEFORE any argument is evaluated, then flushed: an
 * argument expression may itself add a late import, and the flush rewrites
 * already-emitted references — but only those already in `fctx.body`. Funcidxs
 * are therefore re-read from `ctx.funcMap` at each use, so a flush between the
 * evaluation and the store phase cannot staleify them.
 *
 * Emits NOTHING into `fctx.body`, and is idempotent — a caller that must decide
 * whether to take a spread-expanding path before it emits its receiver can call
 * {@link canBuildSpreadArgList} first and rely on the later build not declining.
 */
function prepareSpreadExpansion(ctx: CodegenContext, fctx: FunctionContext, storeType: ValType): string | undefined {
  let materializerName: string | undefined;
  if (ctx.standalone === true) {
    ensureObjectRuntime(ctx);
    ensureNativeArrayFromIterN(ctx);
    materializerName = "__array_from_iter_n";
  } else if (!noJsHost(ctx)) {
    ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
    ensureLateImport(ctx, "__extern_get_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
    // ArgumentListEvaluation uses GetIterator, so a non-callable or missing
    // @@iterator is a TypeError rather than Array.from's array-like fallback.
    ensureLateImport(ctx, "__array_from_iter_strict", [{ kind: "externref" }], [{ kind: "externref" }]);
    materializerName = "__array_from_iter_strict";
  }
  if (materializerName === undefined) return undefined;
  // A ref/ref_null destination element (a nested vec) cannot be produced by the
  // generic externref coercion — it guarded-casts and silently stores null.
  // Reserve the shared materializer up front, before the index space settles.
  if (storeType.kind === "ref" || storeType.kind === "ref_null") {
    buildVecFromExternMaterializer(ctx, storeType.typeIdx);
  }
  flushLateImportShifts(ctx, fctx);
  if (
    ctx.funcMap.get("__extern_length") === undefined ||
    ctx.funcMap.get("__extern_get_idx") === undefined ||
    ctx.funcMap.get(materializerName) === undefined
  ) {
    return undefined;
  }
  return materializerName;
}

/**
 * Whether {@link buildSpreadArgList} can expand a spread on this target.
 *
 * Emits nothing, so a call site may consult it before committing to a
 * spread-expanding lowering (e.g. before it has emitted its receiver).
 */
export function canBuildSpreadArgList(ctx: CodegenContext, fctx: FunctionContext, elemType: ValType): boolean {
  return prepareSpreadExpansion(ctx, fctx, unpackedElemType(elemType)) !== undefined;
}

/**
 * Evaluate `args[startIdx..]` once and describe the resulting element list.
 *
 * Returns `undefined` when the argument list contains a spread whose runtime
 * expansion cannot be lowered on this target (no reader substrate) — the
 * caller must then keep its existing behaviour rather than emit a wrong count.
 * Nothing is emitted before that decision when it can be made statically; the
 * substrate check happens first, for exactly that reason.
 */
export function buildSpreadArgList(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  startIdx: number,
  elemType: ValType,
  tag: string,
  opts?: {
    /**
     * Called with the value of a NON-spread argument on the stack, already
     * coerced to the destination element type, immediately before it is
     * captured. Must be stack-neutral. Lets a call site keep a per-argument
     * side effect it had in its own unrolled loop (the `.name` stamp on a
     * compiled function argument, #3429).
     */
    afterValue?: (arg: ts.Expression) => void;
  },
): SpreadArgList | undefined {
  const storeType = unpackedElemType(elemType);
  const spreadPresent = hasSpreadArgument(args, startIdx);
  const materializerName = spreadPresent ? prepareSpreadExpansion(ctx, fctx, storeType) : "";
  if (materializerName === undefined) return undefined;

  const slots: Slot[] = [];
  const countLocal = allocLocal(fctx, `__${tag}_n_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: countLocal });

  /** count += n (a static contribution: one positional arg, one tuple field). */
  const addCount = (n: number): void => {
    fctx.body.push({ op: "local.get", index: countLocal });
    fctx.body.push({ op: "i32.const", value: n });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: countLocal });
  };

  /** Stack: [value of `from`] → stored in a fresh `storeType` local (a "value" slot). */
  const captureValue = (from: ValType | null, arg?: ts.Expression): void => {
    if (from === null) fctx.body.push(...defaultValueInstrs(storeType));
    else coerceType(ctx, fctx, from, storeType);
    if (arg !== undefined) opts?.afterValue?.(arg);
    const local = allocLocal(fctx, `__${tag}_v_${fctx.locals.length}`, storeType);
    fctx.body.push({ op: "local.set", index: local });
    slots.push({ kind: "value", local });
    addCount(1);
  };

  for (let i = startIdx; i < args.length; i++) {
    const arg = args[i]!;
    if (!ts.isSpreadElement(arg)) {
      captureValue(compileExpression(ctx, fctx, arg, storeType), arg);
      continue;
    }

    // Compile the source with its NATURAL type (no externref hint) so a typed
    // vec or an inline tuple literal stays readable in place.
    const srcType = compileExpression(ctx, fctx, arg.expression);
    const srcTypeIdx = srcType && (srcType.kind === "ref" || srcType.kind === "ref_null") ? srcType.typeIdx : -1;
    const vecInfo = srcTypeIdx >= 0 ? getVecInfo(ctx, srcTypeIdx) : null;
    const tupleFields = vecInfo || srcTypeIdx < 0 ? null : tupleFieldTypes(ctx, srcTypeIdx);

    if (srcType && tupleFields) {
      // Inline tuple-literal spread (`...[x, y]`): static arity, one
      // `struct.get` per field.
      const tupLocal = allocLocal(fctx, `__${tag}_tup_${fctx.locals.length}`, srcType);
      fctx.body.push({ op: "local.set", index: tupLocal });
      for (let f = 0; f < tupleFields.length; f++) {
        fctx.body.push({ op: "local.get", index: tupLocal });
        if (srcType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: f });
        captureValue(unpackedElemType(tupleFields[f]!));
      }
      continue;
    }

    if (srcType && vecInfo) {
      const vecLocal = allocLocal(fctx, `__${tag}_vec_${fctx.locals.length}`, srcType);
      fctx.body.push({ op: "local.set", index: vecLocal });
      const lenLocal = allocLocal(fctx, `__${tag}_vlen_${fctx.locals.length}`, { kind: "i32" });
      const dataLocal = allocLocal(fctx, `__${tag}_vdata_${fctx.locals.length}`, {
        kind: "ref_null",
        typeIdx: vecInfo.arrTypeIdx,
      });
      // A null source contributes nothing; reading either field would trap.
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: lenLocal });
      fctx.body.push({ op: "ref.null", typeIdx: vecInfo.arrTypeIdx });
      fctx.body.push({ op: "local.set", index: dataLocal });
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [],
        else: [
          { op: "local.get", index: vecLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: lenLocal },
          { op: "local.get", index: vecLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: 1 },
          { op: "local.set", index: dataLocal },
        ],
      });
      fctx.body.push({ op: "local.get", index: countLocal });
      fctx.body.push({ op: "local.get", index: lenLocal });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.set", index: countLocal });
      slots.push({
        kind: "vec",
        dataLocal,
        arrTypeIdx: vecInfo.arrTypeIdx,
        storageElem: vecInfo.elemType,
        lenLocal,
      });
      continue;
    }

    // Opaque source: materialize through the iterator protocol, then index it.
    if (srcType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (srcType.kind !== "externref") coerceType(ctx, fctx, srcType, { kind: "externref" });
    // The native materializer also takes a step bound; a spread is unbounded.
    if (materializerName === "__array_from_iter_n") fctx.body.push({ op: "f64.const", value: -1 });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(materializerName)! });
    const srcLocal = allocLocal(fctx, `__${tag}_src_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: srcLocal });
    const lenLocal = allocLocal(fctx, `__${tag}_slen_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_length")! });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    fctx.body.push({ op: "local.tee", index: lenLocal });
    fctx.body.push({ op: "local.get", index: countLocal });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: countLocal });
    slots.push({ kind: "extern", srcLocal, lenLocal });
  }

  /** externref → destination element, via the vec materializer when needed. */
  const externToStore = (): Instr[] => {
    if (storeType.kind === "externref") return [];
    if (storeType.kind === "ref" || storeType.kind === "ref_null") {
      const name = `__vec_from_extern_${storeType.typeIdx}`;
      const idx = ctx.funcMap.get(name);
      if (idx !== undefined) {
        return storeType.kind === "ref"
          ? [{ op: "call", funcIdx: idx }, { op: "ref.as_non_null" }]
          : [{ op: "call", funcIdx: idx }];
      }
    }
    return coercionInstrs(ctx, { kind: "externref" }, storeType, fctx);
  };

  const emitStores = (sink: SpreadArgSink): void => {
    for (const slot of slots) {
      if (slot.kind === "value") {
        fctx.body.push(...sink.pre);
        fctx.body.push({ op: "local.get", index: slot.local });
        fctx.body.push(...sink.post);
        continue;
      }
      const idxLocal = allocLocal(fctx, `__${tag}_i_${fctx.locals.length}`, { kind: "i32" });
      const read: Instr[] =
        slot.kind === "vec"
          ? [
              { op: "local.get", index: slot.dataLocal },
              { op: "local.get", index: idxLocal },
              { op: elemGetOp(slot.storageElem, undefined), typeIdx: slot.arrTypeIdx },
              ...coercionInstrs(ctx, unpackedElemType(slot.storageElem), storeType, fctx),
            ]
          : [
              { op: "local.get", index: slot.srcLocal },
              { op: "local.get", index: idxLocal },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: ctx.funcMap.get("__extern_get_idx")! },
              ...externToStore(),
            ];
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: idxLocal });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: idxLocal },
              { op: "local.get", index: slot.lenLocal },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              ...sink.pre,
              ...read,
              ...sink.post,
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: idxLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      });
    }
  };

  return { countLocal, emitStores };
}
