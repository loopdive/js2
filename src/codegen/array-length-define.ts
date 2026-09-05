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
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildThrowJsErrorInstrs, emitThrowRangeError, emitThrowTypeError } from "./expressions/helpers.js";
import { resolveWasmType } from "./index.js";
import { coerceType, compileExpression } from "./shared.js";
import { getVecInfo } from "./type-coercion.js";

/**
 * A receiver expression is safe to re-compile for the length-growth side
 * effect only when evaluating it has no observable side effects. Identifiers
 * and `this` qualify; calls, indexing, and arbitrary member chains do not.
 */
export function isSideEffectFreeReceiver(objArg: ts.Expression): boolean {
  return ts.isIdentifier(objArg) || objArg.kind === ts.SyntaxKind.ThisKeyword;
}

/**
 * (#2668 Slice C) Is the descriptor `value` expression coercible to a Number
 * with **no object ToPrimitive step** (no valueOf/toString call)? Only then can
 * the inline array-`length` ArraySetLength path compute ToNumber directly. A
 * string- or object-valued descriptor needs the full host ToNumber engine and
 * its spec-mandated field read-order, which is DEFERRED — those fall through to
 * the generic descriptor path unchanged.
 */
function isNumericCoercibleValueType(ctx: CodegenContext, expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  const F = ts.TypeFlags;
  // String is included: StringToNumber (§7.1.4.1) has NO observable side effects
  // (no user valueOf/toString call), so a string-valued length descriptor
  // coerces with the same "no object ToPrimitive" guarantee as a numeric one.
  // Object/symbol/bigint/any values still need the full host ToNumber engine.
  const ALLOWED =
    F.Number |
    F.NumberLiteral |
    F.Boolean |
    F.BooleanLiteral |
    F.Undefined |
    F.Null |
    F.Never |
    F.Enum |
    F.EnumLiteral |
    F.String |
    F.StringLiteral;
  const DISALLOWED =
    F.Object |
    F.Any |
    F.Unknown |
    F.ESSymbol |
    F.UniqueESSymbol |
    F.BigInt |
    F.BigIntLiteral |
    F.TypeParameter |
    F.Void |
    F.NonPrimitive;
  const ok = (t: ts.Type): boolean => {
    if (t.isUnion()) return t.types.every(ok);
    const f = t.flags;
    if (f & DISALLOWED) return false;
    return (f & ALLOWED) !== 0;
  };
  try {
    return ok(ctx.checker.getTypeAtLocation(expr));
  } catch {
    return false;
  }
}

/**
 * (#2668 Slice C) Array exotic `[[DefineOwnProperty]]` for the `length`
 * property — `Object.defineProperty(arr, "length", desc)`, ES §10.4.2.1
 * `ArraySetLength`.
 *
 * Array `length` is an intrinsic data property: `writable:true` (by default),
 * `enumerable:false`, `configurable:false`. This handles the spec-mandated
 * *rejections* plus the simple length set on the valid path:
 *
 *   - get/set accessor descriptor on `length`  → **TypeError** (length is data).
 *   - `configurable:true` / `enumerable:true`   → **TypeError** (illegal change
 *     of a non-configurable property's attributes).
 *   - `value` whose ToUint32 ≠ ToNumber (NaN / ±Infinity / fractional /
 *     negative / > 2^32−1 / non-numeric)         → **RangeError**.
 *   - a valid uint32 `value`                     → set `vec.length` (field 0).
 *
 * SCOPE (host-mode-first, tight per #2668): DEFERRED — per-index
 * configurability on shrink (deleting a non-configurable index → TypeError),
 * non-writable "frozen" length blocking later index adds, and object/string
 * ToPrimitive value coercion (needs the full host ToNumber + read-order). Those
 * shapes return `false` (fall through to the generic path, unchanged behaviour).
 *
 * Returns a {@link ValType} when it fully handled the define (the caller returns
 * immediately, leaving the receiver on the stack as the call result), or
 * `false` when this is not an array-`length` define it should own.
 */
export function maybeEmitVecLengthDefine(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
  descArg: ts.Expression,
): ValType | false {
  // Gate: `"length"` string-literal key, object-literal descriptor, and a
  // side-effect-free receiver that resolves to a WasmGC vec struct.
  if (!ts.isStringLiteral(propArg) || propArg.text !== "length") return false;
  if (!ts.isObjectLiteralExpression(descArg)) return false;
  if (!isSideEffectFreeReceiver(objArg)) return false;
  const objTsType = ctx.checker.getTypeAtLocation(objArg);
  const wasmType = resolveWasmType(ctx, objTsType);
  if (wasmType.kind !== "ref" && wasmType.kind !== "ref_null") return false;
  const vecTypeIdx = (wasmType as { typeIdx?: number }).typeIdx;
  if (vecTypeIdx === undefined) return false;
  const vecInfo = getVecInfo(ctx, vecTypeIdx);
  if (vecInfo === null) return false;
  const arrTypeIdx = vecInfo.arrTypeIdx;

  // Parse the descriptor literal's fields. Any computed / spread / non-identifier
  // member → defer (we can't statically classify it).
  let hasGet = false;
  let hasSet = false;
  let hasValue = false;
  let valueExpr: ts.Expression | undefined;
  let configPresent = false;
  let configLiteral: boolean | undefined;
  let enumPresent = false;
  let enumLiteral: boolean | undefined;
  const boolLiteral = (e: ts.Expression | undefined): boolean | undefined =>
    e?.kind === ts.SyntaxKind.TrueKeyword ? true : e?.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
  for (const p of descArg.properties) {
    if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p))) {
      return false; // spread / accessor-shorthand / unknown member
    }
    if (!ts.isIdentifier(p.name)) return false; // computed / string key
    const name = p.name.text;
    const init = ts.isPropertyAssignment(p) ? p.initializer : undefined;
    switch (name) {
      case "get":
        hasGet = true;
        break;
      case "set":
        hasSet = true;
        break;
      case "value":
        hasValue = true;
        valueExpr = init;
        break;
      case "configurable":
        configPresent = true;
        configLiteral = boolLiteral(init);
        break;
      case "enumerable":
        enumPresent = true;
        enumLiteral = boolLiteral(init);
        break;
      default:
        break; // `writable` (freeze deferred) and unknown names ignored
    }
  }

  // A `configurable`/`enumerable` attribute we can't statically read as a
  // boolean literal → defer (can't decide whether it's an illegal change).
  if ((configPresent && configLiteral === undefined) || (enumPresent && enumLiteral === undefined)) {
    return false;
  }
  const illegalAttr = configLiteral === true || enumLiteral === true;

  const emitThrowResult = (emit: () => void): ValType => {
    // Receiver is side-effect-free, but compile+drop it to mirror the spec's
    // "evaluate O" step and keep the call expression well-formed.
    const t = compileExpression(ctx, fctx, objArg);
    if (t) fctx.body.push({ op: "drop" });
    emit();
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  };

  // length is a DATA property — an accessor descriptor is rejected first.
  if (hasGet || hasSet) {
    return emitThrowResult(() => emitThrowTypeError(ctx, fctx, "Cannot redefine property: length"));
  }

  if (hasValue) {
    // Only the no-ToPrimitive value shapes are handled inline.
    if (!valueExpr || !isNumericCoercibleValueType(ctx, valueExpr)) return false;

    const vecLocal = allocLocal(fctx, `__deflen_vec_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: vecTypeIdx,
    });
    const nlLocal = allocLocal(fctx, `__deflen_nl_${fctx.locals.length}`, { kind: "f64" });

    // Receiver → vec ref local (side-effect-free recompile is safe).
    const recvType = compileExpression(ctx, fctx, objArg);
    if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) {
      if (recvType) fctx.body.push({ op: "drop" });
      return false;
    }
    fctx.body.push({ op: "local.set", index: vecLocal });

    // numberLen = ToNumber(value).
    const vt = compileExpression(ctx, fctx, valueExpr, { kind: "f64" });
    if (vt === null) {
      fctx.body.push({ op: "f64.const", value: NaN });
    } else if (vt.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (vt.kind !== "f64") {
      coerceType(ctx, fctx, vt, { kind: "f64" });
    }
    fctx.body.push({ op: "local.set", index: nlLocal });

    // valid = nl >= 0 && nl <= 4294967295 && floor(nl) === nl  (NaN ⇒ false).
    fctx.body.push({ op: "local.get", index: nlLocal });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.ge" });
    fctx.body.push({ op: "local.get", index: nlLocal });
    fctx.body.push({ op: "f64.const", value: 4294967295 });
    fctx.body.push({ op: "f64.le" });
    fctx.body.push({ op: "i32.and" });
    fctx.body.push({ op: "local.get", index: nlLocal });
    fctx.body.push({ op: "f64.floor" });
    fctx.body.push({ op: "local.get", index: nlLocal });
    fctx.body.push({ op: "f64.eq" });
    fctx.body.push({ op: "i32.and" });
    // if (!valid) throw RangeError
    fctx.body.push({ op: "i32.eqz" });
    const throwRangeInstrs = ((): Instr[] => {
      const saved = fctx.body;
      const out: Instr[] = [];
      fctx.body = out;
      try {
        emitThrowRangeError(ctx, fctx, "RangeError: Invalid array length");
      } finally {
        fctx.body = saved;
      }
      return out;
    })();
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwRangeInstrs });

    // A valid value combined with an illegal attribute change (configurable:true
    // / enumerable:true) is still a TypeError — but only AFTER the RangeError
    // value check (spec order). The throw is unconditional (attrs are literals).
    if (illegalAttr) {
      emitThrowTypeError(ctx, fctx, "Cannot redefine property: length");
      fctx.body.push({ op: "unreachable" });
      return { kind: "externref" };
    }

    // newLen = ToUint32(value)  (value is a validated non-negative integer).
    const newLenLocal = allocLocal(fctx, `__deflen_new_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: nlLocal });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    fctx.body.push({ op: "local.set", index: newLenLocal });

    // GROW: when newLen exceeds the backing `$data` capacity, reallocate so the
    // logical length never exceeds the physical array (mirrors
    // `maybeEmitVecLengthGrowth` + the indexed-assignment grow path — the vec
    // invariant length <= array.len(data) must hold). Guarded against absurd
    // allocations (`nl <= 16M`): a valid-but-huge uint32 length (sparse arrays,
    // out of Slice C scope) only updates the length field. Shrinks keep the
    // backing capacity untouched (reads are length-bounded).
    const dataLocal = allocLocal(fctx, `__deflen_data_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    });
    const oldCapLocal = allocLocal(fctx, `__deflen_ocap_${fctx.locals.length}`, { kind: "i32" });
    const newDataLocal = allocLocal(fctx, `__deflen_ndata_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "local.set", index: dataLocal });
    fctx.body.push({ op: "local.get", index: dataLocal });
    fctx.body.push({ op: "array.len" });
    fctx.body.push({ op: "local.tee", index: oldCapLocal });
    fctx.body.push({ op: "local.get", index: newLenLocal });
    fctx.body.push({ op: "i32.lt_s" }); // oldCap < newLen?
    fctx.body.push({ op: "local.get", index: nlLocal });
    fctx.body.push({ op: "f64.const", value: 16777216 });
    fctx.body.push({ op: "f64.le" }); // nl <= 16M (allocation guard)
    fctx.body.push({ op: "i32.and" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: newLenLocal },
        { op: "array.new_default", typeIdx: arrTypeIdx },
        { op: "local.set", index: newDataLocal },
        { op: "local.get", index: newDataLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: dataLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: oldCapLocal },
        { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
        { op: "local.get", index: vecLocal },
        { op: "local.get", index: newDataLocal },
        { op: "ref.as_non_null" },
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 },
      ],
    });

    // vec.length = newLen
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "local.get", index: newLenLocal });
    fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });

    // defineProperty returns O.
    fctx.body.push({ op: "local.get", index: vecLocal });
    coerceType(ctx, fctx, { kind: "ref_null", typeIdx: vecTypeIdx }, { kind: "externref" });
    return { kind: "externref" };
  }

  // No value: only the illegal attribute-change rejection is handled inline.
  if (illegalAttr) {
    return emitThrowResult(() => emitThrowTypeError(ctx, fctx, "Cannot redefine property: length"));
  }

  // Nothing actionable (e.g. `{configurable:false}` / `{writable:false}`) —
  // defer to the generic descriptor path (unchanged behaviour).
  return false;
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
  if (ctx.standalone) {
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
  if (exceedsSafeGrowCeiling(descExpr)) return false;
  const handled = maybeEmitVecLengthDefine(ctx, fctx, objArg, ts.factory.createStringLiteral("length"), descExpr);
  if (!handled) return false;
  fctx.body.push({ op: "drop" });
  return true;
}

/**
 * The largest new length {@link maybeEmitVecLengthDefine} will actually grow the
 * backing `$data` array to. Must match its inline `f64.const 16777216` guard.
 */
const SAFE_GROW_CEILING = 16777216;

/**
 * (#3984) Does this descriptor set `length` to a literal ABOVE the helper's
 * allocation guard?
 *
 * Above `SAFE_GROW_CEILING` the helper deliberately updates `vec.length` WITHOUT
 * growing `$data` (sparse arrays are out of #2668 Slice C scope). That breaks the
 * vec invariant `length <= array.len(data)` which the same function documents,
 * and converts a clean assertion failure into an **uncatchable oob trap** — which
 * is what the #3189 trap ratchet exists to stop. Routing
 * `Object.defineProperties(arr, {length: {value: 2**32-1}})` into the helper grew
 * the `oob` category 50 → 52 (`15.2.3.7-6-a-150` / `-151`) and parked the PR.
 *
 * **This hazard is PRE-EXISTING on the singular path and is deliberately NOT
 * fixed in the shared helper here.** The singular boundary twins
 * `15.2.3.6-4-160` / `-161` cover exactly these two values and currently **pass**,
 * so changing the helper would risk regressing them and needs its own
 * measurement. At *this* call site the prior behaviour was a clean `fail`, so
 * declining preserves it and adds no trap. The 34 files this routing fix flips
 * all use small lengths and are unaffected.
 *
 * Only a literal is inspected: a non-literal length cannot be classified
 * statically, and that case keeps the singular path's long-standing behaviour
 * rather than acquiring a new one.
 *
 * **The predicate is deliberately narrow: only a VALID uint32 above the ceiling
 * declines.** An out-of-range literal such as `2**32` or `2**32+1` is an invalid
 * array length whose required outcome is a **RangeError**, and the helper emits
 * that correctly and safely — it throws without ever touching the backing array,
 * so there is no invariant to break. A first attempt at this guard declined on
 * magnitude alone and silently cost two of the 34 flips
 * (`15.2.3.7-6-a-152` / `-153`, both `Expected a RangeError to be thrown`) by
 * suppressing the throw. Only the *valid-but-unbackable* band is unsafe.
 */
function exceedsSafeGrowCeiling(descExpr: ts.ObjectLiteralExpression): boolean {
  for (const p of descExpr.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || p.name.text !== "value") continue;
    const init = p.initializer;
    if (!ts.isNumericLiteral(init)) return false;
    const n = Number(init.text);
    // Valid uint32 lengths only (anything else must reach the helper's RangeError).
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return false;
    return n > SAFE_GROW_CEILING;
  }
  return false;
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
