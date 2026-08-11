// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4159 S3/S5) Typed-lane → overlay-aware dynamic-lane routing for plain-array
 * element access under `--target standalone`.
 *
 * ## The incoherence this closes
 * `Object.defineProperty(arr, "1", { get, set })` installs an accessor entry in
 * the #3251 vec-overlay companion. The DYNAMIC lane consults it (measured:
 * `__extern_get_idx` invokes the getter for a numeric key; `__extern_get`
 * invokes it for a string key; `__extern_set` invokes setters and enforces
 * `writable:false` since #3251-S2 / PR #4142). The TYPED lane — a receiver the
 * checker kept statically `number[]`-shaped — reads the raw backing
 * (`struct.get $__vec 1` + `array.get`) and stores with `array.set`, so the
 * same array answers differently depending on the static type of the
 * reference. test262 hits this constantly: a `propertyHelper.js` function whose
 * `obj` parameter only ever receives arrays is monomorphized to the vec type,
 * so the whole verification family (`verifyEqualTo`, `verifyWritable`, …) runs
 * on the typed lane and never sees the descriptor.
 *
 * ## The mechanism (per the #4159 architect spec)
 * Compile-time pre-scan flag, NOT a runtime guard: `ctx.vecAccessorDescriptorDirty`
 * (#4159 Work Item A, landed with #4160 S0) is set by `scanForArrayHoles` when
 * the module contains any defineProperty/defineProperties/Object.create/
 * Reflect.defineProperty whose descriptor is not provably data-only. When the
 * flag is CLEAR — approximately every real program — these helpers are never
 * called and the emitted bytes are identical by construction. When SET, element
 * reads route through `__extern_get_idx` / `__extern_get` (both carry the
 * finalize-spliced overlay read prologues) and element writes through
 * `__extern_set` (overlay write prologue: setter invoke, writable enforcement,
 * OOB grow — all measured healthy before this module was written).
 *
 * Routing goes through the funcMap-name chokepoints — the established
 * cross-module pattern (`hof-native.ts`, `array-prototype-borrow.ts`) — NOT
 * through overlay-core handles, which do not exist until finalize (architect
 * spec verdict 2).
 *
 * ## What the caller must exclude (and why)
 * - typed-array views (`taClass !== "other"`): integer-indexed exotics reject
 *   accessor defines at define time; their OOB/conversion semantics are their
 *   own (#2798/#2593) and must not be widened here.
 * - the `$__regexp_match_vec` exotic: its index/input/groups fields are
 *   property reads with dedicated arms.
 * - `arguments`-rooted receivers: the materialized-arguments state is not
 *   reliably positional (#3169's measured exclusion) and mapped-args reverse
 *   sync (#849) lives on the legacy write path.
 */

import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitRuntimeEvalSharedValueUnwrap } from "./global-environment.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/**
 * Single gate for both directions — standalone, plus any pre-scan flag that
 * says the dense backing alone cannot answer indexed Get / HasProperty:
 * `vecAccessorDescriptorDirty` (#4159, an accessor / non-writable descriptor),
 * `vecIndexDeleteDirty` (#4222, a `delete arr[i]` tombstone), or
 * `protoIndexDirty` (#4160, an inherited numeric property). Any one alone makes
 * the raw `array.get` / `i < length` answer wrong.
 */
export function overlayRouteActive(ctx: CodegenContext): boolean {
  return (
    ctx.standalone === true &&
    (ctx.vecAccessorDescriptorDirty === true || ctx.vecIndexDeleteDirty === true || ctx.protoIndexDirty === true)
  );
}

/**
 * (#4159 S3) Routed element READ. Precondition: the receiver vec ref (an
 * anyref-compatible `(ref[_null] $__vec_<k>)`) is the sole value this
 * expression has on the stack. Returns the produced ValType, or `null` when a
 * required chokepoint could not be registered — in which case NOTHING was
 * emitted and the caller must fall through to its legacy lowering.
 *
 * Key handling mirrors the measured chokepoint health matrix:
 * - provably-numeric key → `__extern_get_idx(recv, f64)` directly;
 * - anything else → compile the key as externref (string identity preserved),
 *   `__extern_get(recv, key)`, and on a miss (null / undefined singleton)
 *   retry positionally via `__unbox_number` + `__extern_get_idx` iff the key
 *   is numeric and NOT a genuine string — the same order + string gate as the
 *   #3169 any-key arm (a numeric-looking string like "1e3" must not be
 *   re-canonicalized; a boxed number reaching `__extern_get` is today a total
 *   miss, which is exactly why the retry exists).
 */
export function emitOverlayRoutedElementGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  keyExpr: ts.Expression,
  keyIsNumeric: boolean,
  numericHint: boolean,
  compileExpr: (e: ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const getIdxFn = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  const unboxFn = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  const getFn = keyIsNumeric
    ? undefined
    : ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  const isUndefFn = keyIsNumeric
    ? undefined
    : ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (getIdxFn === undefined || unboxFn === undefined || (!keyIsNumeric && getFn === undefined)) return null;

  // Receiver → externref local (allocated BEFORE the key compiles, #3007).
  const recvLocal = allocLocal(fctx, `__ovr_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  if (keyIsNumeric) {
    fctx.body.push({ op: "local.get", index: recvLocal });
    compileExpr(keyExpr, { kind: "f64" });
    fctx.body.push({ op: "call", funcIdx: getIdxFn });
  } else {
    compileExpr(keyExpr, { kind: "externref" });
    const keyLocal = allocLocal(fctx, `__ovr_key_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: keyLocal });
    const resLocal = allocLocal(fctx, `__ovr_res_${fctx.locals.length}`, { kind: "externref" });
    const idxF64 = allocLocal(fctx, `__ovr_idxf_${fctx.locals.length}`, { kind: "f64" });
    // res = __extern_get(recv, key)  (getFn checked non-undefined above for this arm)
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "call", funcIdx: getFn as number });
    fctx.body.push({ op: "local.set", index: resLocal });
    // miss = res == null || __extern_is_undefined(res)
    fctx.body.push({ op: "local.get", index: resLocal });
    fctx.body.push({ op: "ref.is_null" });
    if (isUndefFn !== undefined) {
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } as ValType },
        then: [{ op: "i32.const", value: 1 }],
        else: [
          { op: "local.get", index: resLocal },
          { op: "call", funcIdx: isUndefFn },
        ],
      });
    }
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: keyLocal },
        { op: "call", funcIdx: unboxFn },
        { op: "local.tee", index: idxF64 },
        { op: "local.get", index: idxF64 },
        { op: "f64.eq" }, // not-NaN ⇒ numeric key
        // …AND not a genuine string key (see doc comment).
        ...[ctx.anyStrTypeIdx, ctx.nativeStrTypeIdx]
          .filter((t) => t >= 0)
          .flatMap((strTypeIdx): Instr[] => [
            { op: "local.get", index: keyLocal },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: strTypeIdx },
            { op: "i32.eqz" },
            { op: "i32.and" },
          ]),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: recvLocal },
            { op: "local.get", index: idxF64 },
            { op: "call", funcIdx: getIdxFn },
            { op: "local.set", index: resLocal },
          ],
        },
      ],
    });
    fctx.body.push({ op: "local.get", index: resLocal });
  }
  if (ctx.runtimeEvalGlobalFunctionBindings === true) {
    emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
  }
  if (numericHint) {
    // The consumer wants a number: unbox (a getter's boxed return, a boxed
    // element, or undefined → NaN — the JS ToNumber of the read).
    fctx.body.push({ op: "call", funcIdx: unboxFn });
    return { kind: "f64" };
  }
  return { kind: "externref" };
}

/**
 * (#4159 S5) Routed element WRITE. Precondition: the receiver vec ref is the
 * sole value on the stack. Compiles key + value as externref and delegates to
 * `__extern_set`, whose overlay write prologue invokes setters, enforces
 * `writable:false`, seeds companions, and grows the vec on an OOB index
 * (measured before this module was written). Pushes the assigned value back as
 * the expression result. Returns the result ValType, or `null` (nothing
 * emitted) when a chokepoint is unavailable.
 */
export function emitOverlayRoutedElementSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  keyExpr: ts.Expression,
  valueExpr: ts.Expression,
  compileExpr: (e: ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const setFn = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (setFn === undefined) return null;

  const recvLocal = allocLocal(fctx, `__ovw_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.set", index: recvLocal });
  fctx.body.push({ op: "local.get", index: recvLocal });
  compileExpr(keyExpr, { kind: "externref" });
  compileExpr(valueExpr, { kind: "externref" });
  const valLocal = allocLocal(fctx, `__ovw_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: valLocal });
  fctx.body.push({ op: "call", funcIdx: setFn });
  // Assignment is an expression — its result is the assigned value.
  fctx.body.push({ op: "local.get", index: valLocal });
  return { kind: "externref" };
}
