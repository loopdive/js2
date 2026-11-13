// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Array exotic `[[DefineOwnProperty]]` for the `length` property —
 * ES §10.4.2.4 `ArraySetLength` over the WasmGC vec representation.
 *
 * Extracted from `object-ops.ts` (#3984). This is a self-contained subsystem
 * with **two** callers — `compileObjectDefineProperty` and the static
 * object-literal expansion inside `compileObjectDefineProperties` — and it
 * predates the second one. While it lived as a private function in the
 * object-ops god-file it had exactly one call site, which is precisely how the
 * plural form came to silently skip ArraySetLength entirely (see #3984): the
 * machinery was correct, but unreachable from half the surface that needed it.
 * Giving it its own module makes the shared-subsystem status explicit and keeps
 * the god-file shrinking rather than growing.
 */
import { ts } from "../ts-api.js";
import { buildOverlayArrayLengthSet } from "./array-filter-length-set.js"; // (#7164)
import { getArrTypeIdxFromVec, getOrRegisterVecBaseType } from "./registry/types.js"; // (#7164)
import { rollbackSpeculative, snapshotSpeculative } from "./context/speculative.js"; // (#7164)
import { isGrowthSwitchedReceiver, lengthUpdateMayMeetFrozenArray } from "./statements/array-share-group.js"; // (#7164)
import { emitVecLengthHoleFill } from "./vec-length-hole-fill.js"; // (#6482 r4)
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import { reportError } from "./context/errors.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildThrowJsErrorInstrs } from "./expressions/helpers.js";
import { compileExpression } from "./shared.js";

/**
 * A receiver expression is safe to re-compile for the length-growth side
 * effect only when evaluating it has no observable side effects. Identifiers
 * and `this` qualify; calls, indexing, and arbitrary member chains do not.
 */
export function isSideEffectFreeReceiver(objArg: ts.Expression): boolean {
  return ts.isIdentifier(objArg) || objArg.kind === ts.SyntaxKind.ThisKeyword;
}

/**
 * (#3984) Delegate an `Object.defineProperties` descriptor entry to
 * {@link maybeEmitVecLengthDefine}.
 *
 * `compileObjectDefineProperties`' static object-literal expansion re-parses
 * each descriptor inline rather than routing through
 * `compileObjectDefineProperty`, so it never reached ArraySetLength. On the
 * standalone target that made
 * `Object.defineProperties(arr, {length: {value: n}})` a **silent no-op** — the
 * length simply stayed put. A wrong value, not a refusal, so nothing downstream
 * (root-cause classifier, standalone floor) could observe it.
 *
 * Returns `true` when the define was fully handled and the caller should skip
 * its inline descriptor handling for this key.
 *
 * Stack contract: {@link maybeEmitVecLengthDefine} is written for the singular
 * form, whose call result *is* the receiver, so it leaves one value on the
 * stack. The `defineProperties` loop must leave the stack empty per key (the
 * receiver is pushed once at the end from its own local), so the value is
 * dropped here. Throw branches emit `unreachable` first, which makes the
 * trailing `drop` validate as unreachable code.
 */
export function tryEmitVecLengthDefineForDefineProperties(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propName: string | undefined,
  descExpr: ts.Expression,
  compileSingularDefine?: (ctx: CodegenContext, fctx: FunctionContext, call: ts.CallExpression) => ValType | null,
): boolean {
  if (propName !== "length" || !ts.isObjectLiteralExpression(descExpr)) return false;
  // (#4227) STANDALONE hands the key to the SINGULAR compiler instead of the
  // inline path, because on that lane the singular compiler is precisely where
  // the correct implementation lives: it is standalone-gated off this module
  // (the "#3251 S3" note in `compileObjectDefineProperty`) so the key reaches
  // the native `__vec_dp_value` length arm, which implements the FULL
  // ArraySetLength — the step-15 non-configurable shrink stop and the
  // non-writable length bit — against the #3251 overlay companion that this
  // compile-time path cannot see. Racing in front of it made
  // `Object.defineProperties(arr, {length: {…}})` shrink straight past
  // non-configurable indices and ignore a frozen length.
  //
  // ROUTING rather than merely DECLINING is what keeps it clean: the plural
  // loop's own inline expansion reaches the same native, but it also flips
  // `arr.hasOwnProperty(<hole index>)` to `true` on an array with holes — a
  // PRE-EXISTING plural-path defect, reproducible with any non-`length` key
  // (`Object.defineProperties([0, , 2], {foo: {value: 1}})`) and therefore not
  // this change's to fix. Declining here would newly expose it on `length` and
  // cost 15.2.3.7-6-a-155/-156/-161/-162; the singular compiler does not have
  // it, so routing takes the ArraySetLength gains without the collateral.
  //
  // A side-effecting receiver is left alone (the synthetic call re-evaluates
  // `objArg`), as is a caller that passes no compiler — both keep the previous
  // behaviour rather than acquiring a new one.
  if (compileSingularDefine === undefined || !isSideEffectFreeReceiver(objArg)) return false;
  const call = ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("Object"), "defineProperty"),
    undefined,
    [objArg, ts.factory.createStringLiteral("length"), descExpr],
  );
  ts.setTextRange(call, descExpr);
  (call as ts.CallExpression & { parent: ts.Node }).parent = descExpr.parent;
  const result = compileSingularDefine(ctx, fctx, call);
  if (result) fctx.body.push({ op: "drop" });
  return true;
}

/**
 * (#4222) §10.4.2.4 `ArraySetLength` step 3 for the plain `arr.length = v`
 * ASSIGNMENT form: `ToUint32(v) !== ToNumber(v)` is a **RangeError**.
 *
 * The assignment path lowered its value with `i32.trunc_sat_f64_s` and a
 * comment saying NaN / Infinity / out-of-range lengths "clamp instead of
 * trapping" (#1834). A saturating truncation is total by construction, so it
 * cannot distinguish "too big" from "fine" — `[].length = 4294967296`, `= -1`,
 * `= 1.5`, `= NaN` and `= Infinity` all silently succeeded. The
 * `Object.defineProperty(arr, "length", …)` forms in this module always
 * validated; only the assignment form did not.
 *
 * #1834's real requirement is preserved: the failure must not be a wasm TRAP,
 * which kills the module unrecoverably. A RangeError is a catchable JS
 * exception, so it serves that goal strictly better than clamping did.
 *
 * Stack: `[f64] → [i32]`. Consumes the value, throws on an invalid one, and
 * leaves the saturating truncation of a valid one.
 *
 * The validity test runs on the f64 directly rather than materialising
 * `ToUint32(v)` and comparing back, because `ToUint32(v) === ToNumber(v)` is
 * exactly "v is an integer in [0, 2^32-1]":
 *   - `NaN`       → `v == floor(v)` is false (NaN compares unequal to itself)
 *   - `±Infinity` → floor is the identity, but the upper-bound test rejects it
 *   - `-0`        → passes, and it must: `ToUint32(-0)` is `0`, and the spec
 *                   compares with Number `!==`, under which `-0 !== 0` is false
 *
 * (#4491, 2026-08-21) The truncation is UNSIGNED. It was signed, which clamped
 * every validated length above 2^31-1 to i32 max
 * (`built-ins/Array/length/15.4.5.1-3.d-3` wanted 4294967295 and got
 * 2147483647). The old comment diagnosed that as needing genuinely sparse
 * arrays; that is false in the direction that matters. STORING elements at such
 * an index needs sparse arrays — CARRYING the uint32 length VALUE does not: the
 * `$__vec_base` length field round-trips the whole u32 domain as a bit pattern,
 * and every reader that can observe a length >= 2^31 widens it back with
 * `f64.convert_i32_u` (the `__extern_get` "length" arm in `object-runtime.ts`,
 * the dynamic store in `vec-length-set.ts`, the `__vec_dp_value` sparse-length
 * arm in `vec-overlay.ts`, and — since this slice — the STATIC vec `.length`
 * read in `property-access-dispatch.ts`). Lengths below 2^31 encode identically
 * under either signedness, so this is inert outside the boundary band.
 *
 * The two halves are a PAIR and must move together: an unsigned store with a
 * signed read answers −1 where it used to answer 2147483647 (measured; see the
 * "BLOCKED sub-item" table in `plan/issues/4491-…md`, which is now closed).
 */
export function emitArraySetLengthValidation(ctx: CodegenContext, fctx: FunctionContext): void {
  const lenValTmp = allocLocal(fctx, `__arr_len_set_v_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: lenValTmp });
  fctx.body.push({ op: "f64.floor" });
  fctx.body.push({ op: "local.get", index: lenValTmp });
  fctx.body.push({ op: "f64.eq" }); // integral
  fctx.body.push({ op: "local.get", index: lenValTmp });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.ge" });
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({ op: "local.get", index: lenValTmp });
  fctx.body.push({ op: "f64.const", value: 4294967295 });
  fctx.body.push({ op: "f64.le" });
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: buildThrowJsErrorInstrs(ctx, "RangeError", "Invalid array length", { flush: fctx }),
  });
  fctx.body.push({ op: "local.get", index: lenValTmp });
  fctx.body.push({ op: "i32.trunc_sat_f64_u" });
}

// ── (#7164) The static Array `length` store, shared by every form that writes it ──
//
// `arr.length = n`, `arr.length++` / `--`, `++arr.length` / `--arr.length` and
// `arr.length += k` / `-= k`. The plain assignment used to be the only form
// that ran the length-store fill (`vec-length-hole-fill.ts`); `++` / `--` went
// through the dynamic `__extern_set` arm (a grow filled with `$Hole`) and
// `+=` / `-=` stored field 0 alone (no fill), so a shrink's `$Hole` could be
// exposed to every dense copy by a later `length++`. On the externref carrier
// all of them now share one store whose grow fills `undefined`.

/**
 * Store `newLenTmp` (i32) into the vec parked in `vecTmp` (`$__vec_base`),
 * with the length-store fill (or the descriptor-overlay route when active).
 * `literalClear` marks a store of the literal `0`, which cannot grow: it keeps
 * the shrink-only fill and emits no grow code. When the receiver was not
 * proven a vec, `vecTmp` may be null and the store is skipped.
 */
export function emitArrayLengthStore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecTmp: number,
  newLenTmp: number,
  target: ts.Node,
  receiverProvenVec: boolean,
  literalClear = false,
  receiverType?: ValType,
): void {
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  const lengthStore: Instr[] = [
    { op: "local.get", index: vecTmp },
    { op: "local.get", index: newLenTmp },
    { op: "struct.set", typeIdx: vecBaseIdx, fieldIdx: 0 },
  ];
  // (#6482 r4) This store touches ONLY field 0, so the fill marks the region
  // the length change orphans (shrink) or exposes (grow) before it moves.
  // Overlay validation owns deletion when present: filling before it could
  // erase elements even when a non-writable length rejects the shrink.
  let selectedStore = buildOverlayArrayLengthSet(ctx, fctx, vecTmp, newLenTmp, target);
  if (selectedStore === null) {
    const savedBody = fctx.body;
    fctx.body = [];
    try {
      // (#7164) A shrink marks the dropped slots `$Hole`; a grow reallocates
      // when needed and fills the new slots with the canonical `undefined`.
      emitVecLengthHoleFill(
        ctx,
        fctx,
        vecTmp,
        newLenTmp,
        lengthStoreMode(ctx, target, literalClear, receiverType),
        true,
      );
      selectedStore = [...fctx.body, ...lengthStore];
    } finally {
      fctx.body = savedBody;
    }
  }
  if (receiverProvenVec) {
    for (const instr of selectedStore) fctx.body.push(instr);
  } else {
    // The guarded cast parks `null` when the receiver was not a vec.
    fctx.body.push({ op: "local.get", index: vecTmp });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: selectedStore });
  }
}

/**
 * Only the externref carrier gets grow code. A receiver compiled as a typed vec
 * of another element kind skips it (the same bytes as before #7164); an
 * unknown or externref receiver keeps it.
 */
function receiverMayHoldExternref(ctx: CodegenContext, receiverType: ValType | undefined): boolean {
  if (!receiverType || (receiverType.kind !== "ref" && receiverType.kind !== "ref_null")) return true;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, receiverType.typeIdx);
  const arrDef = arrTypeIdx < 0 ? undefined : ctx.mod.types[arrTypeIdx];
  return arrDef?.kind !== "array" || arrDef.element.kind === "externref";
}

/**
 * The fill a static length store gets. A literal `0` or a typed (non-externref)
 * receiver: the shrink fill only, as before #7164. A binding #7164 moved onto
 * the externref carrier: a grow fills every new slot with `undefined`. Any
 * other receiver gets the shrink fill only, byte-identical to origin/main.
 */
function lengthStoreMode(
  ctx: CodegenContext,
  target: ts.Node,
  literalClear: boolean,
  receiverType: ValType | undefined,
): "shrink-only" | "length-store" {
  if (literalClear || !receiverMayHoldExternref(ctx, receiverType)) return "shrink-only";
  // Only a binding #7164 moved onto the externref carrier grows; every other vec is origin/main's store.
  const receiver = ts.isPropertyAccessExpression(target) ? target.expression : undefined;
  return receiver && isGrowthSwitchedReceiver(ctx, receiver) ? "length-store" : "shrink-only";
}

/** The forms {@link tryCompileArrayLengthUpdate} lowers. */
export type ArrayLengthUpdate =
  | { kind: "step"; delta: 1 | -1; postfix: boolean }
  | { kind: "compound"; op: "+" | "-"; value: ts.Expression };

/**
 * `arr.length++` / `--` / `+= k` / `-= k` on the externref carrier: read the
 * length, compute the ToUint32-validated new length, and store it through
 * {@link emitArrayLengthStore}, so a grow fills its new slots with `undefined`
 * (the old routes filled with `$Hole` or not at all). Returns `undefined`
 * (nothing emitted) whenever {@link emitArrayLengthStore}'s grow path does not
 * apply, and the update keeps its existing lowering.
 */
export function tryCompileArrayLengthUpdate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
  update: ArrayLengthUpdate,
): ValType | undefined {
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== "length") return undefined;
  // Everything the plain `x.length = n` grow path relies on, or the old route:
  // the pre-scan armed the hole-aware reads, and nothing in the program can make
  // a length non-writable or an element non-configurable (base throws there).
  if (!ctx.usesArrayHoles || lengthUpdateMayMeetFrozenArray(ctx)) return undefined;
  // Only a binding #7164 moved onto the externref carrier: on `origin/main` it
  // was a typed vec, so the dynamic route's `$Hole` fill would be new to it.
  if (!isGrowthSwitchedReceiver(ctx, target.expression)) return undefined;
  if (ctx.oracle.typeFactOf(target.expression).kind !== "array") return undefined;
  if (update.kind === "compound" && ctx.oracle.staticJsTypeOf(update.value) !== "number") return undefined;
  const snap = snapshotSpeculative(ctx, fctx);
  const receiver = compileExpression(ctx, fctx, target.expression);
  // Only a receiver compiled as the externref carrier: every other one keeps
  // its existing route, byte for byte.
  if (
    !receiver ||
    (receiver.kind !== "ref" && receiver.kind !== "ref_null") ||
    getArrTypeIdxFromVec(ctx, receiver.typeIdx) < 0 ||
    !receiverMayHoldExternref(ctx, receiver)
  ) {
    rollbackSpeculative(ctx, fctx, snap);
    return undefined;
  }
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  const vecTmp = allocLocal(fctx, `__arr_len_upd_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecBaseIdx });
  const oldTmp = allocLocal(fctx, `__arr_len_upd_old_${fctx.locals.length}`, { kind: "f64" });
  const newLenTmp = allocLocal(fctx, `__arr_len_upd_new_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.tee", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 });
  fctx.body.push({ op: "f64.convert_i32_u" });
  fctx.body.push({ op: "local.tee", index: oldTmp });
  if (update.kind === "step") {
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: update.delta === 1 ? "f64.add" : "f64.sub" });
  } else {
    const valueType = compileExpression(ctx, fctx, update.value, { kind: "f64" });
    if (valueType?.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
    else if (valueType?.kind !== "f64") {
      rollbackSpeculative(ctx, fctx, snap);
      return undefined;
    }
    fctx.body.push({ op: update.op === "+" ? "f64.add" : "f64.sub" });
  }
  // §10.4.2.4 step 3: RangeError unless the new length is a uint32.
  emitArraySetLengthValidation(ctx, fctx);
  fctx.body.push({ op: "local.set", index: newLenTmp });
  emitArrayLengthStore(ctx, fctx, vecTmp, newLenTmp, target, true, false, receiver);
  // Result: the old value for a postfix update, the new length otherwise.
  if (update.kind === "step" && update.postfix) {
    fctx.body.push({ op: "local.get", index: oldTmp });
  } else {
    fctx.body.push({ op: "local.get", index: newLenTmp });
    fctx.body.push({ op: "f64.convert_i32_u" });
  }
  return { kind: "f64" };
}

/**
 * `x.p op= v` whose receiver compiled to a vec carrier other than the declared
 * vec type (`const g: any[]` holding only strings is a string vec).
 * {@link tryCompileArrayLengthUpdate} declines that carrier, and the two vec
 * types are siblings, so a struct access of the declared layout is invalid Wasm.
 * Consumes the receiver and reports a sticky refusal: the expression wrapper's
 * rollback must not turn it into a module that stores a default (#3725).
 */
export function refuseForeignVecCarrierCompound(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  carrier: ValType,
  declaredTypeIdx: number,
): boolean {
  if (
    (carrier.kind !== "ref" && carrier.kind !== "ref_null") ||
    carrier.typeIdx === declaredTypeIdx ||
    getArrTypeIdxFromVec(ctx, carrier.typeIdx) < 0 ||
    getArrTypeIdxFromVec(ctx, declaredTypeIdx) < 0
  ) {
    return false;
  }
  fctx.body.push({ op: "drop" });
  reportError(
    ctx,
    target,
    `Cannot compound-assign '${target.name.text}': the receiver's array carrier is not the declared array type`,
    "error",
    { sticky: true },
  );
  return true;
}
