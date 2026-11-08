// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7108) IR lowering of `Array.prototype.indexOf` / `lastIndexOf` /
 * `includes` / `join` on a vec receiver whose element family the selector
 * proved (`number`, `string` or `boolean`, see `./selection.ts`).
 *
 * Every method is a counted scan over the vec built from existing IR
 * primitives (`vec.len`, `vec.get`, slots, `for.loop`, `if.stmt`,
 * `string.concat`, `string.eq`) plus the mode-neutral `(f64) -> string`
 * provider the template-literal lowering already uses. No new runtime helper
 * and no new IR instruction: the backends lower these like a hand-written loop.
 *
 * Semantics (ECMA-262 §23.1.3.17 indexOf, §23.1.3.20 lastIndexOf, §23.1.3.16
 * includes, §23.1.3.18 join) restricted to the shapes the selector admits:
 *   - indexOf / lastIndexOf / includes take the search value and an optional
 *     proven-number `fromIndex` (#7313). indexOf and lastIndexOf are
 *     IsStrictlyEqual (NaN never matches, -0 === +0); includes is
 *     SameValueZero (NaN matches NaN). lastIndexOf scans down from its start.
 *   - A boolean vec holds 0 / 1 in its i32 carrier, so its match is the
 *     numeric one.
 *   - A legacy-produced f64 vec stores `undefined` and holes as the sNaN
 *     markers `UNDEF_F64_BITS` / `HOLE_F64_BITS` (codegen/value-tags.ts). Both
 *     are NaNs, so indexOf never matches them; includes excludes them from the
 *     NaN match (`undefined` is never SameValueZero to a number); join renders
 *     them as "" — the rules legacy's `compileArrayIndexOf` /
 *     `compileArrayIncludes` / `compileArrayJoin` apply. (A hole that would
 *     inherit an `Array.prototype[k]` value is out of scope: legacy consults
 *     the prototype there, this lowering renders "".)
 *   - A null element of a nullable string carrier (a hole) never matches a
 *     string search value and renders as "" in join.
 */

import { ts } from "../../ts-api.js";
import type { IrFunctionBuilder } from "../builder.js";
import { irBool } from "../boolean-brand.js";
import { emitF64IsUndefined } from "../f64-undefined-marker.js";
import { irIntrinsicFuncRef } from "../callable-bindings.js";
import { asVal, irVal, type IrType, type IrValueId } from "../nodes.js";
import { demoteToLegacy } from "../outcomes.js";
import { IR_NUMBER_TO_STRING_FN } from "../string-runtime.js";
import type { ValType } from "../types.js";

/** Array methods this module lowers on a vec receiver. */
export const IR_VEC_SEARCH_JOIN_METHODS: ReadonlySet<string> = new Set(["indexOf", "lastIndexOf", "includes", "join"]);

const I32: IrType = irVal({ kind: "i32" });
const F64: IrType = irVal({ kind: "f64" });
const STRING: IrType = { kind: "string" };

/** What the caller already resolved about the receiver vec. */
export interface IrVecSearchJoinReceiver {
  readonly recv: IrValueId;
  /** Physical element carrier of the vec (`f64`, `i32`, or the string ref). */
  readonly elementValType: ValType;
  /** Logical element type (`{kind: "string"}` for a string vec). */
  readonly elementType: IrType;
}

export interface IrVecSearchJoinHost {
  readonly builder: IrFunctionBuilder;
  readonly funcName: string;
  /** Backend string carrier — the join accumulator's slot type. */
  readonly stringValType: ValType | undefined;
  lowerExpr(expression: ts.Expression, expected: IrType): IrValueId;
}

type ElementKind = "f64" | "i32" | "string";

function elementKind(receiver: IrVecSearchJoinReceiver): ElementKind | null {
  if (receiver.elementType.kind === "string") return "string";
  const val = asVal(receiver.elementType);
  if (val?.kind === "f64") return "f64";
  if (val?.kind === "i32") return "i32";
  return null;
}

function unsupported(detail: string, host: IrVecSearchJoinHost): never {
  return demoteToLegacy("array-method-unsupported", `ir/from-ast: ${detail} (${host.funcName})`);
}

/**
 * Lower `recv.<method>(...)`, or return `undefined` when `method` is not one of
 * {@link IR_VEC_SEARCH_JOIN_METHODS}. A representation the selector's family
 * proof did not anticipate demotes under the selector's own reason, so the
 * claim/lowering boundary stays reported in one bucket.
 */
export function tryLowerVecSearchOrJoin(
  expr: ts.CallExpression,
  methodName: string,
  receiver: IrVecSearchJoinReceiver | null,
  host: IrVecSearchJoinHost,
): IrValueId | undefined {
  if (!IR_VEC_SEARCH_JOIN_METHODS.has(methodName)) return undefined;
  if (receiver === null) unsupported(`.${methodName} receiver is not a resolvable vec`, host);
  const kind = elementKind(receiver);
  if (kind === null) unsupported(`.${methodName} on a vec of ${receiver.elementValType.kind}`, host);
  if (expr.arguments.some(ts.isSpreadElement)) unsupported(`.${methodName} with a spread argument`, host);
  if (methodName === "join") {
    if (expr.arguments.length > 1) unsupported(`.join with ${expr.arguments.length} arguments`, host);
    return lowerJoin(expr.arguments[0], receiver, kind, host);
  }
  const [value, fromIndex, ...rest] = expr.arguments;
  if (value === undefined || rest.length > 0) {
    unsupported(`.${methodName} with ${expr.arguments.length} arguments`, host);
  }
  const search: SearchMode = { sameValueZero: methodName === "includes", downward: methodName === "lastIndexOf" };
  return lowerSearch(value, fromIndex, search, receiver, kind, host);
}

/** includes: SameValueZero, else IsStrictlyEqual; lastIndexOf scans downward. */
interface SearchMode {
  readonly sameValueZero: boolean;
  readonly downward: boolean;
}

function i32Const(builder: IrFunctionBuilder, value: number): IrValueId {
  return builder.emitConst({ kind: "i32", value }, I32);
}

/** True when the string carrier can hold a null (a hole). */
function stringElementNullable(receiver: IrVecSearchJoinReceiver): boolean {
  return receiver.elementValType.kind !== "ref";
}

/** Read element `index` (in `[0, length)` by construction) as its logical type. */
function readElement(receiver: IrVecSearchJoinReceiver, kind: ElementKind, index: IrValueId, b: IrFunctionBuilder) {
  return b.emitVecGet(receiver.recv, index, kind === "string" ? STRING : irVal(receiver.elementValType));
}

/** Lower the search value to the element family's carrier (f64 or string). */
function lowerNeedle(arg: ts.Expression, kind: ElementKind, host: IrVecSearchJoinHost): IrValueId {
  const b = host.builder;
  if (kind === "string") {
    const value = host.lowerExpr(arg, STRING);
    if (b.typeOf(value).kind !== "string") unsupported("string search value did not lower to a string", host);
    return value;
  }
  return lowerNumber(arg, "numeric search value", host);
}

/** Element `i` compared to the needle under IsStrictlyEqual / SameValueZero. */
function emitMatch(
  receiver: IrVecSearchJoinReceiver,
  kind: ElementKind,
  index: IrValueId,
  needle: IrValueId,
  sameValueZero: boolean,
  b: IrFunctionBuilder,
): IrValueId {
  const raw = readElement(receiver, kind, index, b);
  if (kind === "string") {
    if (!stringElementNullable(receiver)) return b.emitStringEq(raw, needle, false);
    const isNull = b.emitUnary("ref.is_null", raw, I32);
    let eq!: IrValueId;
    const whenPresent = b.collectBodyInstrs(() => {
      eq = b.emitStringEq(raw, needle, false);
    });
    let no!: IrValueId;
    const whenHole = b.collectBodyInstrs(() => {
      no = i32Const(b, 0);
    });
    return b.emitIfElse({
      cond: isNull,
      then: whenHole,
      thenValue: no,
      else: whenPresent,
      elseValue: eq,
      resultType: I32,
    });
  }
  const element = kind === "i32" ? b.emitUnary("f64.convert_i32_s", raw, F64) : raw;
  const eq = b.emitBinary("f64.eq", element, needle, I32);
  if (!sameValueZero || kind === "i32") return eq;
  // SameValueZero: both NaN also matches — except a hole, which reads as
  // `undefined` and is never SameValueZero to a number.
  const elementNaN = b.emitBinary("f64.ne", element, element, I32);
  const needleNaN = b.emitBinary("f64.ne", needle, needle, I32);
  const notHole = b.emitUnary("i32.eqz", emitF64IsUndefined(element, b), I32);
  const bothNaN = b.emitBinary("i32.and", b.emitBinary("i32.and", elementNaN, needleNaN, I32), notHole, I32);
  return b.emitBinary("i32.or", eq, bothNaN, I32);
}

/**
 * Lower a numeric argument to f64 (an i32 converts exactly); the selector
 * proved its family.
 */
function lowerNumber(arg: ts.Expression, what: string, host: IrVecSearchJoinHost): IrValueId {
  const b = host.builder;
  const value = host.lowerExpr(arg, F64);
  const scalar = asVal(b.typeOf(value))?.kind;
  if (scalar === "f64") return value;
  if (scalar === "i32") return b.emitUnary("f64.convert_i32_s", value, F64);
  return unsupported(`${what} did not lower to a number`, host);
}

/**
 * The first index the scan visits: §23.1.3.17 steps 4-9 (upward) and
 * §23.1.3.20 steps 4-7 (downward) over `n = ToIntegerOrInfinity(fromIndex)`,
 * computed in f64 and saturated to i32. An infinite start lands outside
 * `[0, len)`, so the loop runs zero times. Absent `fromIndex`: `0` upward,
 * `len - 1` downward.
 */
function emitSearchStart(
  fromIndex: ts.Expression | undefined,
  downward: boolean,
  len: IrValueId,
  host: IrVecSearchJoinHost,
): IrValueId {
  const b = host.builder;
  if (fromIndex === undefined) return downward ? b.emitBinary("i32.sub", len, i32Const(b, 1), I32) : i32Const(b, 0);
  const raw = lowerNumber(fromIndex, "fromIndex", host);
  const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
  const notANumber = b.emitBinary("f64.ne", raw, raw, I32);
  const n = b.emitSelect(notANumber, zero, b.emitUnary("f64.trunc", raw, F64), F64);
  const length = b.emitUnary("f64.convert_i32_s", len, F64);
  const fromEnd = b.emitBinary("f64.add", length, n, F64);
  const nonNegative = b.emitBinary("f64.ge", n, zero, I32);
  let start: IrValueId;
  if (downward) {
    const last = b.emitBinary("f64.sub", length, b.emitConst({ kind: "f64", value: 1 }, F64), F64);
    const clamped = b.emitSelect(b.emitBinary("f64.lt", n, last, I32), n, last, F64);
    start = b.emitSelect(nonNegative, clamped, fromEnd, F64);
  } else {
    const clamped = b.emitSelect(b.emitBinary("f64.lt", fromEnd, zero, I32), zero, fromEnd, F64);
    start = b.emitSelect(nonNegative, n, clamped, F64);
  }
  return b.emitUnary("i32.trunc_sat_f64_s", start, I32);
}

/**
 * `found = -1; for (i = start; i in [0, len) && found < 0; i += step) if (match(i)) found = i;`
 * then `found` (indexOf / lastIndexOf, as f64) or `found >= 0` (includes,
 * boolean-branded).
 */
function lowerSearch(
  arg: ts.Expression,
  fromIndex: ts.Expression | undefined,
  mode: SearchMode,
  receiver: IrVecSearchJoinReceiver,
  kind: ElementKind,
  host: IrVecSearchJoinHost,
): IrValueId {
  const b = host.builder;
  // §23.1.3.17 step 1-3: the receiver's length is read before the search value
  // is coerced, but neither has an observable side effect for a proven-number
  // / proven-string argument, so the arguments are evaluated first (source order).
  const needle = lowerNeedle(arg, kind, host);
  const len = b.emitVecLenI32(receiver.recv);
  const iSlot = b.declareSlot("__vsearch_i", { kind: "i32" });
  const foundSlot = b.declareSlot("__vsearch_found", { kind: "i32" });
  b.emitSlotWrite(iSlot, emitSearchStart(fromIndex, mode.downward, len, host));
  b.emitSlotWrite(foundSlot, i32Const(b, -1));
  const cond = b.collectBodyInstrs(() => {
    const i = b.emitSlotRead(iSlot);
    const inRange = mode.downward
      ? b.emitBinary("i32.ge_s", i, i32Const(b, 0), I32)
      : b.emitBinary("i32.lt_s", i, len, I32);
    const notFound = b.emitBinary("i32.lt_s", b.emitSlotRead(foundSlot), i32Const(b, 0), I32);
    b.emitBinary("i32.and", inRange, notFound, I32);
  });
  const condValue = cond[cond.length - 1]!.result!;
  const body = b.collectBodyInstrs(() => {
    const i = b.emitSlotRead(iSlot);
    const matched = emitMatch(receiver, kind, i, needle, mode.sameValueZero, b);
    const then = b.collectBodyInstrs(() => b.emitSlotWrite(foundSlot, b.emitSlotRead(iSlot)));
    b.emitIfStmt({ cond: matched, then, else: [] });
  });
  const update = b.collectBodyInstrs(() => {
    const step = mode.downward ? "i32.sub" : "i32.add";
    b.emitSlotWrite(iSlot, b.emitBinary(step, b.emitSlotRead(iSlot), i32Const(b, 1), I32));
  });
  b.emitForLoop({ cond, condValue, body, update });
  const found = b.emitSlotRead(foundSlot);
  if (mode.sameValueZero) return b.emitBinary("i32.ge_s", found, i32Const(b, 0), irBool());
  return b.emitUnary("f64.convert_i32_s", found, F64);
}

/** Lower the separator: absent ⇒ ","; otherwise a proven string. */
function lowerSeparator(arg: ts.Expression | undefined, host: IrVecSearchJoinHost): IrValueId {
  const b = host.builder;
  if (arg === undefined) return b.emitStringConst(",");
  const value = host.lowerExpr(arg, STRING);
  if (b.typeOf(value).kind !== "string") unsupported("join separator did not lower to a string", host);
  return value;
}

/** Element `i` rendered by §23.1.3.18 step 7: hole / undefined ⇒ "", else ToString. */
function emitAppendElement(
  receiver: IrVecSearchJoinReceiver,
  kind: ElementKind,
  index: IrValueId,
  accSlot: number,
  b: IrFunctionBuilder,
): void {
  const raw = readElement(receiver, kind, index, b);
  const append = (piece: () => IrValueId) =>
    b.emitSlotWrite(accSlot, b.emitStringConcat(b.emitSlotReadAs(accSlot, STRING), piece()));
  const numberToString = (value: IrValueId) => {
    const text = b.emitCall(irIntrinsicFuncRef(IR_NUMBER_TO_STRING_FN), [value], STRING);
    // invariant (producer-promise): the number→string provider is declared non-void — #4502.
    if (text === null) throw new Error("ir/array-methods: number-to-string provider returned void");
    return text;
  };
  if (kind === "i32") {
    append(() => numberToString(b.emitUnary("f64.convert_i32_s", raw, F64)));
    return;
  }
  const isHole =
    kind === "f64"
      ? emitF64IsUndefined(raw, b)
      : stringElementNullable(receiver)
        ? b.emitUnary("ref.is_null", raw, I32)
        : null;
  if (isHole === null) {
    append(() => raw);
    return;
  }
  const present = b.collectBodyInstrs(() => append(() => (kind === "f64" ? numberToString(raw) : raw)));
  b.emitIfStmt({ cond: b.emitUnary("i32.eqz", isHole, I32), then: present, else: [] });
}

/**
 * `acc = ""; for (i = 0; i < len; i++) { if (i > 0) acc += sep; acc += str(e[i]); }`
 */
function lowerJoin(
  arg: ts.Expression | undefined,
  receiver: IrVecSearchJoinReceiver,
  kind: ElementKind,
  host: IrVecSearchJoinHost,
): IrValueId {
  const b = host.builder;
  if (host.stringValType === undefined) unsupported("join has no string carrier for its accumulator", host);
  const separator = lowerSeparator(arg, host);
  const len = b.emitVecLenI32(receiver.recv);
  const iSlot = b.declareSlot("__vjoin_i", { kind: "i32" });
  const accSlot = b.declareSlot("__vjoin_acc", host.stringValType);
  b.emitSlotWrite(iSlot, i32Const(b, 0));
  b.emitSlotWrite(accSlot, b.emitStringConst(""));
  const cond = b.collectBodyInstrs(() => {
    b.emitBinary("i32.lt_s", b.emitSlotRead(iSlot), len, I32);
  });
  const condValue = cond[cond.length - 1]!.result!;
  const body = b.collectBodyInstrs(() => {
    const i = b.emitSlotRead(iSlot);
    const notFirst = b.emitBinary("i32.gt_s", i, i32Const(b, 0), I32);
    const then = b.collectBodyInstrs(() =>
      b.emitSlotWrite(accSlot, b.emitStringConcat(b.emitSlotReadAs(accSlot, STRING), separator)),
    );
    b.emitIfStmt({ cond: notFirst, then, else: [] });
    emitAppendElement(receiver, kind, b.emitSlotRead(iSlot), accSlot, b);
  });
  const update = b.collectBodyInstrs(() => {
    b.emitSlotWrite(iSlot, b.emitBinary("i32.add", b.emitSlotRead(iSlot), i32Const(b, 1), I32));
  });
  b.emitForLoop({ cond, condValue, body, update });
  return b.emitSlotReadAs(accSlot, STRING);
}

/** The slice of from-ast's lowering context the adapter reads. */
export interface IrVecSearchJoinLowerCtx {
  readonly builder: IrFunctionBuilder;
  readonly funcName: string;
  readonly resolver?: { resolveString?(): ValType };
}

/** from-ast's own vec resolution (`resolveIrVecType`), passed in to avoid a cycle. */
export type IrVecTypeResolution<C> = (
  type: IrType,
  cx: C,
) => { readonly lowering: { readonly elementValType: ValType }; readonly elementType: IrType } | null;

function sameValType(a: ValType, b: ValType | undefined): boolean {
  if (b === undefined || a.kind !== b.kind) return false;
  const aIdx = (a as { typeIdx?: number }).typeIdx;
  return aIdx === (b as { typeIdx?: number }).typeIdx;
}

/**
 * from-ast entry: the receiver is already lowered. Returns `undefined` for any
 * method this module does not own, before touching the receiver's
 * representation, so every other method call is unaffected.
 */
export function lowerVecSearchOrJoinCall<C extends IrVecSearchJoinLowerCtx>(
  expr: ts.CallExpression,
  methodName: string,
  recv: IrValueId,
  recvType: IrType,
  cx: C,
  resolveVec: IrVecTypeResolution<C>,
  lowerExpr: (expression: ts.Expression, cx: C, expected: IrType) => IrValueId,
): IrValueId | undefined {
  if (!IR_VEC_SEARCH_JOIN_METHODS.has(methodName)) return undefined;
  const recvVal = asVal(recvType);
  if (recvType.kind !== "vec" && recvVal?.kind !== "ref" && recvVal?.kind !== "ref_null") return undefined;
  const resolved = resolveVec(recvType, cx);
  const stringValType = cx.resolver?.resolveString?.();
  const receiver: IrVecSearchJoinReceiver | null = resolved
    ? {
        recv,
        elementValType: resolved.lowering.elementValType,
        // A `string[]` that arrives as a plain vec ref carries its element as
        // the backend string carrier; give it the logical string type.
        elementType:
          resolved.elementType.kind !== "string" && sameValType(resolved.lowering.elementValType, stringValType)
            ? STRING
            : resolved.elementType,
      }
    : null;
  return tryLowerVecSearchOrJoin(expr, methodName, receiver, {
    builder: cx.builder,
    funcName: cx.funcName,
    stringValType,
    lowerExpr: (expression, expected) => lowerExpr(expression, cx, expected),
  });
}
