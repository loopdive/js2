// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6777) `key in arr` for an ARRAY-CARRIER receiver (a `$__vec_*` struct).
 *
 * The arm this replaces in `binary-ops-in.ts` was wrong three ways:
 *
 *  1. It picked the carrier by the receiver's TypeScript type and baked that
 *     struct index into `struct.get`. The compiled receiver can be a different
 *     carrier — `const arr: any[] = [1, 2, 3]` is specialised to the f64 vec —
 *     so the module failed validation (`struct.get[0] expected (ref null 2),
 *     found (ref null 4)`). The struct index now comes from the ValType the
 *     receiver actually compiled to.
 *  2. It answered `index < length`, which is not [[HasProperty]] once an index
 *     can be absent: `delete arr[i]` (#2130/#4222), an elision, a `length`
 *     shrink, an accessor define or an inherited index all leave `length`
 *     alone. Its narrower escape hatch also called the HOST `__extern_has_idx`
 *     on the js-host lane, which has no vec arm and answered 0 for every index.
 *  3. A key that is not a compile-time constant (`i in arr`) fell through to
 *     the "fully dynamic" fallback and folded to `false`.
 *
 * Every array-carrier `in` now goes through {@link compileArrayCarrierIn}:
 *
 *  - The inline `index < length` compare survives only where it IS the answer:
 *    the key is a canonical array index known at compile time, the receiver
 *    compiled to a `$__vec_base` subtype, and the module can never make an
 *    in-bounds index absent ({@link arrayCarriersStaticallyDense}).
 *  - Everything else asks the lane's presence chokepoint, the one that already
 *    knows each carrier's absence representation. Native lanes (standalone /
 *    WASI) use `__extern_has_idx`, whose finalize-time arms cover the #3251
 *    overlay's `FLAG_DELETED_INDEX`, the f64 `HOLE_F64_BITS` marker, the
 *    externref `$Hole`, the #4222 holey carrier and the prototype index store.
 *    The js-host lane uses `__extern_has`, whose `_wasmStructHasOwn` vec arm
 *    reads the host delete tombstone and asks the minting module through
 *    `__vec_has_own_index` (#6482).
 *  - A dynamic key evaluates first (§13.10.1 steps 1-2), then the receiver,
 *    and both go to `__extern_has` on every lane; its vec arm classifies the
 *    key (index / `length` / named) at run time.
 *
 * Every arm returns a BOOLEAN i32 (`{ kind: "i32", boolean: true }`) so a
 * consumer that boxes the result produces `true` / `false`, never `1` / `0`.
 *
 * Out of scope here: an f64 grow-gap (`a[5] = 9` on a length-3 array) in a
 * module with no hole source writes the T8-A `UNDEF_F64_BITS` marker, which is
 * indistinguishable from a stored `undefined` — see the "Demand gate" note in
 * `vec-f64-hole-presence.ts`. Neither the inline compare nor any helper can
 * recover that absence at the `in` site.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import { getArrTypeIdxFromVec, isVecBaseSubtype } from "./registry/types.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, flushLateImportShifts } from "./shared.js";

/** Largest array index (§6.1.7: an integer index below 2^32 − 1). */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/** A fresh boolean-branded i32 result (consumers may annotate the object). */
function booleanResult(): InnerResult {
  return { kind: "i32", boolean: true };
}

/**
 * Is `typeIdx` a plain array carrier: `$__vec_base` itself, or a subtype of it
 * that is exactly `{ length, data: array }`? Structural, not by struct name —
 * subviews, TypedArray views and the RegExp match vector also subtype
 * `$__vec_base` but carry extra fields and keep their own `in` arms.
 */
export function isPlainArrayCarrierType(ctx: CodegenContext, typeIdx: number): boolean {
  if (typeIdx === ctx.vecBaseTypeIdx) return typeIdx >= 0;
  if (!isVecBaseSubtype(ctx, typeIdx)) return false;
  const def = ctx.mod.types[typeIdx];
  return def?.kind === "struct" && def.fields.length === 2 && getArrTypeIdxFromVec(ctx, typeIdx) >= 0;
}

/**
 * True when no in-bounds index of any array carrier in this module can be
 * absent, so `index < length` is exactly [[HasProperty]] for an index key.
 * Each flag is set by the `scanForArrayHoles` pre-pass BEFORE any body is
 * compiled, so the answer is the same at every `in` site:
 *  - `usesArrayHoles` — an elision, a `length` / unresolvable-key write, an
 *    index `delete` or a descriptor define (all of which can create holes);
 *  - `vecIndexDeleteDirty` — a `delete a[i]` tombstone (#4222);
 *  - `vecAccessorDescriptorDirty` — an index accessor, possibly beyond length;
 *  - `protoIndexDirty` — an inherited numeric property (#4160);
 *  - `dynamicCodeDirty` — eval'd code, which defeats the pre-scan.
 */
function arrayCarriersStaticallyDense(ctx: CodegenContext): boolean {
  return (
    ctx.usesArrayHoles !== true &&
    ctx.vecIndexDeleteDirty !== true &&
    ctx.vecAccessorDescriptorDirty !== true &&
    ctx.protoIndexDirty !== true &&
    ctx.dynamicCodeDirty !== true
  );
}

/** The canonical array index a property key names, or `undefined`. */
function canonicalArrayIndex(key: string): number | undefined {
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n <= MAX_ARRAY_INDEX && String(n) === key ? n : undefined;
}

/**
 * Compile `expr` (`key in arr`) whose receiver's static type is a plain array
 * carrier. `constantKey` is the key's ToPropertyKey string when it is known at
 * compile time (a literal, the last operand of a comma key, or a literal TS
 * type), else `null`.
 *
 * Returns `undefined` — with NOTHING emitted — for a constant key that is
 * neither an array index nor `length`; the caller's named-property path owns
 * those (`"push" in arr`, a #3537 bag expando, …).
 */
export function compileArrayCarrierIn(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  constantKey: string | null,
): InnerResult | undefined {
  if (constantKey === null) {
    return emitKeyFirstExternHas(ctx, fctx, expr.left, expr.right, true) === undefined ? undefined : booleanResult();
  }
  if (constantKey === "length") {
    // Every array has an own `length` (§10.4.2): evaluate both operands, true.
    if (compileExpression(ctx, fctx, expr.left)) fctx.body.push({ op: "drop" });
    if (compileExpression(ctx, fctx, expr.right)) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 1 });
    return booleanResult();
  }
  const index = canonicalArrayIndex(constantKey);
  if (index === undefined) return undefined;
  return emitConstantIndexIn(ctx, fctx, expr, index);
}

/** `<constant index> in <array carrier>` — see the module header. */
function emitConstantIndexIn(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  index: number,
): InnerResult {
  const dense = arrayCarriersStaticallyDense(ctx);
  const native = ctx.standalone || ctx.wasi;
  // Register the helper BEFORE either operand is emitted when it is certainly
  // needed, so no instruction already in the body has to be index-shifted.
  if (!dense) ensurePresenceHelper(ctx, fctx, native);
  // §13.10.1 steps 1-2: the key is evaluated for its side effects (a comma
  // key); its value is the compile-time constant `index`.
  if (compileExpression(ctx, fctx, expr.left)) fctx.body.push({ op: "drop" });
  const recv = compileExpression(ctx, fctx, expr.right);
  if (recv === null) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return booleanResult();
  }
  if (dense && (recv.kind === "ref" || recv.kind === "ref_null") && isVecBaseSubtype(ctx, recv.typeIdx)) {
    if (index > 0x7fffffff) {
      // `length` is a non-negative i32, so it can never exceed this index.
      fctx.body.push({ op: "drop" }, { op: "i32.const", value: 0 });
    } else {
      // `length` is field 0 of every `$__vec_base` subtype — of the type the
      // receiver COMPILED to, never the one its TypeScript type resolved to.
      fctx.body.push(
        { op: "struct.get", typeIdx: recv.typeIdx, fieldIdx: 0 },
        { op: "i32.const", value: index },
        { op: "i32.gt_s" }, // length > index  <==>  index < length
      );
    }
    return booleanResult();
  }
  const helper = ensurePresenceHelper(ctx, fctx, native);
  emitRawReceiverExternref(ctx, fctx, recv);
  fctx.body.push({ op: "f64.const", value: index });
  // The host `__extern_has` takes the key as a JS value; the native
  // `__extern_has_idx` takes the raw f64 (`index` is integral, so its
  // truncating bounds test is exact).
  if (!native) coerceType(ctx, fctx, { kind: "f64" }, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: helper });
  return booleanResult();
}

/**
 * The lane's index-presence chokepoint: native `__extern_has_idx(obj, f64)`,
 * host `__extern_has(obj, key)` (the host `__extern_has_idx` has no vec arm).
 */
function ensurePresenceHelper(ctx: CodegenContext, fctx: FunctionContext, native: boolean): number {
  const funcIdx = native
    ? ensureLateImport(ctx, "__extern_has_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "i32" }])
    : ensureLateImport(ctx, "__extern_has", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  if (funcIdx === undefined) {
    throw new Error(`#6777: \`in\` presence helper ${native ? "__extern_has_idx" : "__extern_has"} unavailable`);
  }
  flushLateImportShifts(ctx, fctx);
  return funcIdx;
}

/**
 * Leave the compiled array receiver on the stack as an externref that IS the
 * vec. A bare `extern.convert_any`, not `coerceType`: on the js-host lane the
 * latter hands a vec to `__make_iterable`, whose detached JS mirror knows
 * nothing about the delete tombstone or the hole markers — `delete a[2]` on an
 * array of objects then still answered `2 in a` true from the mirror.
 */
function emitRawReceiverExternref(ctx: CodegenContext, fctx: FunctionContext, recv: ValType): void {
  if (recv.kind === "ref" || recv.kind === "ref_null" || recv.kind === "anyref") {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (recv.kind !== "externref") {
    coerceType(ctx, fctx, recv, { kind: "externref" });
  }
}

/**
 * `key in obj` through `__extern_has(obj, key)` with §13.10.1's evaluation
 * order (#2741): the key (steps 1-2) BEFORE the object (steps 3-4) — `x() in
 * y()` must throw from `x()` first, and an unresolvable key reference
 * (`undef in obj`) must throw before the object is evaluated. The key is parked
 * in a temp and re-pushed so the call arguments stay `(obj, key)`.
 * `coerceType`, not a bare `extern.convert_any`, so a value-typed key (an f64
 * index) is boxed. `rawReceiver` hands an array receiver over as the vec itself
 * (see {@link emitRawReceiverExternref}). Returns `undefined`, with nothing
 * emitted, when the helper cannot be registered.
 */
export function emitKeyFirstExternHas(
  ctx: CodegenContext,
  fctx: FunctionContext,
  keyExpr: ts.Expression,
  objExpr: ts.Expression,
  rawReceiver = false,
): InnerResult | undefined {
  const hasIdx = ensureLateImport(
    ctx,
    "__extern_has",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  if (hasIdx === undefined) return undefined;
  flushLateImportShifts(ctx, fctx);
  const keyResult = compileExpression(ctx, fctx, keyExpr, { kind: "externref" });
  if (keyResult === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (keyResult.kind !== "externref") {
    coerceType(ctx, fctx, keyResult, { kind: "externref" });
  }
  const keyTmp = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: keyTmp });
  // No externref hint for a raw receiver: the hint alone makes an identifier
  // read coerce (and so materialize) the vec before this function sees it.
  const objResult = compileExpression(ctx, fctx, objExpr, rawReceiver ? undefined : { kind: "externref" });
  if (objResult === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (rawReceiver) {
    emitRawReceiverExternref(ctx, fctx, objResult);
  } else if (objResult.kind !== "externref") {
    coerceType(ctx, fctx, objResult, { kind: "externref" });
  }
  fctx.body.push({ op: "local.get", index: keyTmp });
  releaseTempLocal(fctx, keyTmp);
  fctx.body.push({ op: "call", funcIdx: hasIdx });
  return { kind: "i32" };
}
