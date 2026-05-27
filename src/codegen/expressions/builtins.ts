// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host built-in compilation: console, Date, Math, and WASI output.
 */
import { ts } from "../../ts-api.js";
import { isBooleanType, isNumberType, isStringType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureLateImport, flushLateImportShifts } from "../expressions/late-imports.js";
import { addFuncType, ensureWasiWriteAnyStringHelper } from "../index.js";
import { ensureNativeStringExternBridge } from "../native-strings.js";
import type { InnerResult } from "../shared.js";
import { compileExpression, VOID_RESULT } from "../shared.js";
import { compileStringLiteral } from "../string-ops.js";
import { isStaticNaN, tryStaticToNumber } from "./misc.js";

// ── Builtins ─────────────────────────────────────────────────────────

function compileConsoleCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: string,
): InnerResult {
  // WASI mode: emit fd_write to stdout instead of JS host imports
  if (ctx.wasi) {
    return compileConsoleCallWasi(ctx, fctx, expr, method);
  }

  for (const arg of expr.arguments) {
    const argType = ctx.checker.getTypeAtLocation(arg);
    compileExpression(ctx, fctx, arg);

    if (isStringType(argType)) {
      // Fast mode: flatten + marshal native string to externref before passing to host
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        ensureNativeStringExternBridge(ctx);
        flushLateImportShifts(ctx, fctx);
        const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
        if (strFlattenIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: strFlattenIdx });
        }
        const toExternIdx = ctx.nativeStrHelpers.get("__str_to_extern");
        if (toExternIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toExternIdx });
        }
      }
      const funcIdx = ctx.funcMap.get(`console_${method}_string`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else if (isBooleanType(argType)) {
      const funcIdx = ctx.funcMap.get(`console_${method}_bool`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else if (isNumberType(argType)) {
      const funcIdx = ctx.funcMap.get(`console_${method}_number`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else {
      // externref: DOM objects, class instances, anything else
      const funcIdx = ctx.funcMap.get(`console_${method}_externref`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    }
  }
  return VOID_RESULT;
}

// ─── Date support ───────────────────────────────────────────────────────────
// Date is represented as a WasmGC struct with a single mutable i64 field
// (milliseconds since Unix epoch, UTC).  All getters decompose the timestamp
// using Howard Hinnant's civil_from_days algorithm, implemented purely in
// i64 arithmetic — no host imports needed.

/** Ensure the $__Date struct type exists, return its type index. */
export function ensureDateStruct(ctx: CodegenContext): number {
  const existing = ctx.structMap.get("__Date");
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__Date",
    fields: [{ name: "timestamp", type: { kind: "i64" }, mutable: true }],
  });
  ctx.structMap.set("__Date", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "__Date");
  ctx.structFields.set("__Date", [{ name: "timestamp", type: { kind: "i64" }, mutable: true }]);
  return typeIdx;
}

/**
 * Ensure the __date_civil_from_days helper function exists.
 * Signature: (i64 days_since_epoch) -> (i64 packed)
 *   packed = year * 10000 + month * 100 + day
 *   (month 1-12, day 1-31)
 *
 * Uses Hinnant's algorithm: http://howardhinnant.github.io/date_algorithms.html#civil_from_days
 */
function ensureDateCivilHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__date_civil_from_days");
  if (existing !== undefined) return existing;

  // func (param $z i64) (result i64)
  // locals: $z(0), $era(1), $doe(2), $yoe(3), $doy(4), $mp(5), $y(6), $m(7), $d(8)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i64" }], [{ kind: "i64" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__date_civil_from_days", funcIdx);

  const body: Instr[] = [];

  // z += 719468  (shift epoch from 1970-01-01 to 0000-03-01)
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 719468n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 0 } as Instr,
  );

  // era = (z >= 0 ? z : z - 146096) / 146097
  // We use i64.div_s which floors toward zero, so we need the adjustment
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 0n } as Instr,
    { op: "i64.ge_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 0 } as Instr],
      else: [
        { op: "local.get", index: 0 } as Instr,
        { op: "i64.const", value: 146096n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    },
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 1 } as Instr, // era
  );

  // doe = z - era * 146097  (day of era, [0, 146096])
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 2 } as Instr, // doe
  );

  // yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365
  body.push(
    { op: "local.get", index: 2 } as Instr, // doe
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 1460n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 36524n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 2 } as Instr,
    { op: "i64.const", value: 146096n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.const", value: 365n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 3 } as Instr, // yoe
  );

  // y = yoe + era * 400
  body.push(
    { op: "local.get", index: 3 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr, // y (still March-based)
  );

  // doy = doe - (365*yoe + yoe/4 - yoe/100)
  body.push(
    { op: "local.get", index: 2 } as Instr, // doe
    { op: "i64.const", value: 365n } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 4n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 4 } as Instr, // doy
  );

  // mp = (5*doy + 2) / 153
  body.push(
    { op: "i64.const", value: 5n } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 153n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 5 } as Instr, // mp
  );

  // d = doy - (153*mp + 2)/5 + 1
  body.push(
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 153n } as Instr,
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 5n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "i64.const", value: 1n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 8 } as Instr, // d
  );

  // m = mp < 10 ? mp + 3 : mp - 9
  body.push(
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.const", value: 10n } as Instr,
    { op: "i64.lt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [
        { op: "local.get", index: 5 } as Instr,
        { op: "i64.const", value: 3n } as Instr,
        { op: "i64.add" } as Instr,
      ],
      else: [
        { op: "local.get", index: 5 } as Instr,
        { op: "i64.const", value: 9n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    },
    { op: "local.set", index: 7 } as Instr, // m (1-12)
  );

  // y += (m <= 2) ? 1 : 0
  body.push(
    { op: "local.get", index: 6 } as Instr,
    { op: "local.get", index: 7 } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.le_s" } as Instr,
    { op: "i64.extend_i32_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr, // y (adjusted)
  );

  // return y * 10000 + m * 100 + d
  body.push(
    { op: "local.get", index: 6 } as Instr,
    { op: "i64.const", value: 10000n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 7 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 8 } as Instr,
    { op: "i64.add" } as Instr,
  );

  ctx.mod.functions.push({
    name: "__date_civil_from_days",
    typeIdx: funcTypeIdx,
    locals: [
      // 0: z (param), 1: era, 2: doe, 3: yoe, 4: doy, 5: mp, 6: y, 7: m, 8: d
      { name: "$era", type: { kind: "i64" } },
      { name: "$doe", type: { kind: "i64" } },
      { name: "$yoe", type: { kind: "i64" } },
      { name: "$doy", type: { kind: "i64" } },
      { name: "$mp", type: { kind: "i64" } },
      { name: "$y", type: { kind: "i64" } },
      { name: "$m", type: { kind: "i64" } },
      { name: "$d", type: { kind: "i64" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * Ensure the __date_days_from_civil helper function exists.
 * Signature: (i64 year, i64 month, i64 day) -> i64 days_since_epoch
 *
 * Implements Hinnant's days_from_civil algorithm (inverse of civil_from_days).
 */
export function ensureDateDaysFromCivilHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__date_days_from_civil");
  if (existing !== undefined) return existing;

  // func (param $y i64) (param $m i64) (param $d i64) (result i64)
  // locals: $y(0), $m(1), $d(2), $era(3), $yoe(4), $doy(5), $doe(6)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i64" }, { kind: "i64" }, { kind: "i64" }], [{ kind: "i64" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__date_days_from_civil", funcIdx);

  const body: Instr[] = [];

  // y -= (m <= 2) ? 1 : 0
  body.push(
    { op: "local.get", index: 0 } as Instr, // y
    { op: "local.get", index: 1 } as Instr, // m
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.le_s" } as Instr,
    { op: "i64.extend_i32_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 0 } as Instr, // y adjusted
  );

  // era = (y >= 0 ? y : y - 399) / 400
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.const", value: 0n } as Instr,
    { op: "i64.ge_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 0 } as Instr],
      else: [
        { op: "local.get", index: 0 } as Instr,
        { op: "i64.const", value: 399n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
    },
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.set", index: 3 } as Instr, // era
  );

  // yoe = y - era * 400
  body.push(
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 3 } as Instr,
    { op: "i64.const", value: 400n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 4 } as Instr, // yoe
  );

  // doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1
  body.push(
    { op: "i64.const", value: 153n } as Instr,
    { op: "local.get", index: 1 } as Instr, // m
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.gt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [
        { op: "local.get", index: 1 } as Instr,
        { op: "i64.const", value: 3n } as Instr,
        { op: "i64.sub" } as Instr,
      ],
      else: [
        { op: "local.get", index: 1 } as Instr,
        { op: "i64.const", value: 9n } as Instr,
        { op: "i64.add" } as Instr,
      ],
    },
    { op: "i64.mul" } as Instr,
    { op: "i64.const", value: 2n } as Instr,
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 5n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "local.get", index: 2 } as Instr, // d
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 1n } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.set", index: 5 } as Instr, // doy
  );

  // doe = yoe * 365 + yoe/4 - yoe/100 + doy
  body.push(
    { op: "local.get", index: 4 } as Instr, // yoe
    { op: "i64.const", value: 365n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 4n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.get", index: 4 } as Instr,
    { op: "i64.const", value: 100n } as Instr,
    { op: "i64.div_s" } as Instr,
    { op: "i64.sub" } as Instr,
    { op: "local.get", index: 5 } as Instr,
    { op: "i64.add" } as Instr,
    { op: "local.set", index: 6 } as Instr, // doe
  );

  // return era * 146097 + doe - 719468
  body.push(
    { op: "local.get", index: 3 } as Instr, // era
    { op: "i64.const", value: 146097n } as Instr,
    { op: "i64.mul" } as Instr,
    { op: "local.get", index: 6 } as Instr, // doe
    { op: "i64.add" } as Instr,
    { op: "i64.const", value: 719468n } as Instr,
    { op: "i64.sub" } as Instr,
  );

  ctx.mod.functions.push({
    name: "__date_days_from_civil",
    typeIdx: funcTypeIdx,
    locals: [
      // 3: era, 4: yoe, 5: doy, 6: doe
      { name: "$era", type: { kind: "i64" } },
      { name: "$yoe", type: { kind: "i64" } },
      { name: "$doy", type: { kind: "i64" } },
      { name: "$doe", type: { kind: "i64" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * Compile a Date method call on a Date struct receiver.
 * Returns undefined if this is not a Date method (caller should continue).
 */
function compileDateMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
): InnerResult | undefined {
  const methodName = propAccess.name.text;
  const symName = receiverType.getSymbol()?.name;
  if (symName !== "Date") return undefined;

  const DATE_METHODS = new Set([
    "getTime",
    "valueOf",
    "getFullYear",
    "getMonth",
    "getDate",
    "getHours",
    "getMinutes",
    "getSeconds",
    "getMilliseconds",
    "getDay",
    "setTime",
    "setMilliseconds",
    "setSeconds",
    "setMinutes",
    "setHours",
    "setUTCMilliseconds",
    "setUTCSeconds",
    "setUTCMinutes",
    "setUTCHours",
    // #1440 — calendar setters (Slice 3)
    "setDate",
    "setUTCDate",
    "setMonth",
    "setUTCMonth",
    "setFullYear",
    "setUTCFullYear",
    "setYear",
    "getTimezoneOffset",
    "getUTCFullYear",
    "getUTCMonth",
    "getUTCDate",
    "getUTCHours",
    "getUTCMinutes",
    "getUTCSeconds",
    "getUTCMilliseconds",
    "getUTCDay",
    "toISOString",
    "toJSON",
    "toString",
    "toDateString",
    "toTimeString",
    "toLocaleDateString",
    "toLocaleTimeString",
    "toLocaleString",
    "toUTCString",
    "toGMTString",
  ]);
  if (!DATE_METHODS.has(methodName)) return undefined;

  const dateTypeIdx = ensureDateStruct(ctx);
  const dateRefType: ValType = { kind: "ref", typeIdx: dateTypeIdx };

  // Compile receiver — the Date struct
  const recvResult = compileExpression(ctx, fctx, propAccess.expression, dateRefType);
  if (!recvResult) return null;

  // getTime / valueOf: read i64 timestamp, convert to f64.
  // (#1344) Invalid Date (sentinel timestamp) → NaN per spec.
  if (methodName === "getTime" || methodName === "valueOf") {
    fctx.body.push({
      op: "struct.get",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    });
    const tsLocal = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.tee", index: tsLocal } as Instr);
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
    fctx.body.push({ op: "i64.eq" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN } as Instr],
      else: [{ op: "local.get", index: tsLocal } as Instr, { op: "f64.convert_i64_s" } as Instr],
    });
    releaseTempLocal(fctx, tsLocal);
    return { kind: "f64" };
  }

  // getTimezoneOffset: always 0 for valid Date (we operate in UTC), NaN for invalid.
  // (#1344) ECMA-262 §21.4.4.7 — NaN propagation through `LocalTime` requires
  // returning NaN when the timestamp is invalid.
  if (methodName === "getTimezoneOffset") {
    // Receiver Date ref already on stack from line ~497.
    fctx.body.push({
      op: "struct.get",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    });
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
    fctx.body.push({ op: "i64.eq" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN } as Instr],
      else: [{ op: "f64.const", value: 0 } as Instr],
    });
    return { kind: "f64" };
  }

  // setTime(ms): update the timestamp field — with NaN / Invalid Date / TimeClip
  // propagation per §21.4.4.27. (#1440 Slice 1)
  if (methodName === "setTime") {
    // Stack: [dateRef]
    const tempRef = allocTempLocal(fctx, dateRefType);
    fctx.body.push({ op: "local.set", index: tempRef } as Instr);

    if (callExpr.arguments.length >= 1) {
      // Evaluate arg to f64 (ToNumber; may throw on Symbol per §7.1.4).
      const tempArg = allocTempLocal(fctx, { kind: "f64" });
      compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tempArg } as Instr);

      // isInvalid = (arg != arg)  // NaN
      //          OR (f64.abs(arg) > 8.64e15)  // TimeClip out-of-range / ±Inf
      fctx.body.push({ op: "local.get", index: tempArg } as Instr);
      fctx.body.push({ op: "local.get", index: tempArg } as Instr);
      fctx.body.push({ op: "f64.ne" } as unknown as Instr);
      fctx.body.push({ op: "local.get", index: tempArg } as Instr);
      fctx.body.push({ op: "f64.abs" } as unknown as Instr);
      fctx.body.push({ op: "f64.const", value: 8.64e15 } as Instr);
      fctx.body.push({ op: "f64.gt" } as Instr);
      fctx.body.push({ op: "i32.or" } as Instr);

      // then: write sentinel, push NaN
      const savedThen = pushBody(fctx);
      fctx.body.push({ op: "local.get", index: tempRef } as Instr);
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
      fctx.body.push({
        op: "struct.set",
        typeIdx: dateTypeIdx,
        fieldIdx: 0,
      });
      fctx.body.push({ op: "f64.const", value: NaN } as Instr);
      const thenInstrs = fctx.body;
      popBody(fctx, savedThen);

      // else: trunc to i64, write, return as f64
      const savedElse = pushBody(fctx);
      fctx.body.push({ op: "local.get", index: tempRef } as Instr);
      fctx.body.push({ op: "local.get", index: tempArg } as Instr);
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      const tempNewTs = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.tee", index: tempNewTs } as Instr);
      fctx.body.push({
        op: "struct.set",
        typeIdx: dateTypeIdx,
        fieldIdx: 0,
      });
      fctx.body.push({ op: "local.get", index: tempNewTs } as Instr);
      fctx.body.push({ op: "f64.convert_i64_s" } as Instr);
      releaseTempLocal(fctx, tempNewTs);
      const elseInstrs = fctx.body;
      popBody(fctx, savedElse);

      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: thenInstrs,
        else: elseInstrs,
      } as unknown as Instr);

      releaseTempLocal(fctx, tempArg);
    } else {
      // setTime() with no arg → NaN (Invalid Date)
      fctx.body.push({ op: "local.get", index: tempRef } as Instr);
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
      fctx.body.push({
        op: "struct.set",
        typeIdx: dateTypeIdx,
        fieldIdx: 0,
      } as unknown as Instr);
      fctx.body.push({ op: "f64.const", value: NaN } as Instr);
    }
    releaseTempLocal(fctx, tempRef);
    return { kind: "f64" };
  }

  // Constants used by both setters and getters below.
  const MS_PER_DAY = 86400000n;
  const MS_PER_HOUR = 3600000n;
  const MS_PER_MINUTE = 60000n;
  const MS_PER_SECOND = 1000n;

  // ── Time-of-day setters (#1343 Slice 2) ──────────────────────────────
  // setMilliseconds(ms), setSeconds(s, ms?), setMinutes(m, s?, ms?),
  // setHours(h, m?, s?, ms?), and UTC variants. We're already in UTC so
  // there's no DST adjustment — UTC variants share implementations.
  //
  // Strategy: keep day-of-epoch portion fixed, rebuild ms_of_day from
  // either the user-supplied arg or the current component value.
  //   ms_of_day = ((ts mod 86400000) + 86400000) mod 86400000   (floor-mod)
  //   day_ms    = ts - ms_of_day                                (whole days)
  //   curMs     = ms_of_day mod 1000
  //   curS      = (ms_of_day / 1000) mod 60
  //   curM      = (ms_of_day / 60000) mod 60
  //   curH      = ms_of_day / 3600000
  //   newMsOfDay = newH*3600000 + newM*60000 + newS*1000 + newMs
  //   newTs     = day_ms + newMsOfDay
  // Components larger than the leftmost setter argument are kept as-is;
  // missing trailing args fall through to the current value (per §21.4.4
  // SetSeconds/SetMinutes/SetHours partial-arg rules).
  //
  // NaN propagation (#1440 Slice 1): each arg is coerced via ToNumber; if any
  // is NaN (or ±Inf or |value|>8.64e15), or if the receiver is already an
  // Invalid Date, the result is the Invalid-Date sentinel and the setter
  // returns NaN. Otherwise the existing i64 arithmetic applies.
  const TIME_OF_DAY_SETTERS: Record<string, "ms" | "s" | "m" | "h"> = {
    setMilliseconds: "ms",
    setUTCMilliseconds: "ms",
    setSeconds: "s",
    setUTCSeconds: "s",
    setMinutes: "m",
    setUTCMinutes: "m",
    setHours: "h",
    setUTCHours: "h",
  };
  // Use hasOwn, not the `in` operator: `in` walks the prototype chain, so
  // method names that happen to be Object.prototype members (toString,
  // toLocaleString) would falsely match and be mis-compiled as setters (#1638).
  if (Object.prototype.hasOwnProperty.call(TIME_OF_DAY_SETTERS, methodName)) {
    const startUnit = TIME_OF_DAY_SETTERS[methodName]!;
    const args = callExpr.arguments;
    // Stack: [dateRef]
    const tempRef = allocTempLocal(fctx, dateRefType);
    fctx.body.push({ op: "local.set", index: tempRef } as Instr);

    // Read curTs FIRST — observable ordering: the receiver's [[DateValue]]
    // is sampled before any user code in arg ToNumber callbacks runs
    // (test262 `date-value-read-before-tonumber-when-date-is-valid.js`).
    const tempCurTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempRef } as Instr);
    fctx.body.push({
      op: "struct.get",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    });
    fctx.body.push({ op: "local.set", index: tempCurTs } as Instr);

    // Identify which positional arg maps to each component.
    // setMilliseconds(ms)        → unitsForArgs = [ms]
    // setSeconds(s, ms?)         → unitsForArgs = [s, ms]
    // setMinutes(m, s?, ms?)     → unitsForArgs = [m, s, ms]
    // setHours(h, m?, s?, ms?)   → unitsForArgs = [h, m, s, ms]
    const allUnits: ("h" | "m" | "s" | "ms")[] = ["h", "m", "s", "ms"];
    const startIdx = allUnits.indexOf(startUnit);
    const unitsForArgs = allUnits.slice(startIdx);

    // Coerce each present arg to f64 LEFT-TO-RIGHT (may throw on Symbol per
    // §7.1.4) and accumulate the NaN/non-finite flag. If the START arg is
    // missing entirely (`d.setHours()`), the receiver's first parameter is
    // `undefined` and ToNumber(undefined) = NaN, so seed the flag.
    const tempAnyInvalid = allocTempLocal(fctx, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: args.length === 0 ? 1 : 0 } as Instr);
    fctx.body.push({ op: "local.set", index: tempAnyInvalid } as Instr);

    const argLocals: Partial<Record<"h" | "m" | "s" | "ms", number>> = {};
    for (let i = 0; i < unitsForArgs.length && i < args.length; i++) {
      const unit = unitsForArgs[i]!;
      const local = allocTempLocal(fctx, { kind: "f64" });
      argLocals[unit] = local;
      // Coerce: compileExpression w/ expectedType:f64 invokes ToNumber for
      // externref / struct refs / strings; the centralized __unbox_number
      // funnel handles valueOf / @@toPrimitive / Symbol-throw (#1434).
      compileExpression(ctx, fctx, args[i]!, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: local } as Instr);
      // invalid_i = (x != x) | (f64.abs(x) > 8.64e15)
      fctx.body.push({ op: "local.get", index: local } as Instr);
      fctx.body.push({ op: "local.get", index: local } as Instr);
      fctx.body.push({ op: "f64.ne" } as unknown as Instr);
      fctx.body.push({ op: "local.get", index: local } as Instr);
      fctx.body.push({ op: "f64.abs" } as unknown as Instr);
      fctx.body.push({ op: "f64.const", value: 8.64e15 } as Instr);
      fctx.body.push({ op: "f64.gt" } as Instr);
      fctx.body.push({ op: "i32.or" } as Instr);
      fctx.body.push({ op: "local.get", index: tempAnyInvalid } as Instr);
      fctx.body.push({ op: "i32.or" } as Instr);
      fctx.body.push({ op: "local.set", index: tempAnyInvalid } as Instr);
    }

    // isInvalid = (curTs == sentinel) | anyInvalid
    fctx.body.push({ op: "local.get", index: tempCurTs } as Instr);
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
    fctx.body.push({ op: "i64.eq" } as Instr);
    fctx.body.push({ op: "local.get", index: tempAnyInvalid } as Instr);
    fctx.body.push({ op: "i32.or" } as Instr);

    // then-branch: write sentinel and push NaN.
    const savedThen = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempRef } as Instr);
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
    fctx.body.push({
      op: "struct.set",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    } as unknown as Instr);
    fctx.body.push({ op: "f64.const", value: NaN } as Instr);
    const thenInstrs = fctx.body;
    popBody(fctx, savedThen);

    // else-branch: valid arithmetic.
    const savedElse = pushBody(fctx);

    // ms_of_day = ((curTs mod MS_PER_DAY) + MS_PER_DAY) mod MS_PER_DAY
    const tempMsOfDay = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push(
      { op: "local.get", index: tempCurTs } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "local.set", index: tempMsOfDay } as Instr,
    );

    // day_ms = curTs - ms_of_day
    const tempDayMs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push(
      { op: "local.get", index: tempCurTs } as Instr,
      { op: "local.get", index: tempMsOfDay } as Instr,
      { op: "i64.sub" } as Instr,
      { op: "local.set", index: tempDayMs } as Instr,
    );

    // Push i64 component value: from arg (already coerced) or from current ms_of_day.
    const pushComponent = (unit: "h" | "m" | "s" | "ms") => {
      const argLocal = argLocals[unit];
      if (argLocal !== undefined) {
        fctx.body.push({ op: "local.get", index: argLocal } as Instr);
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        return;
      }
      // Extract from tempMsOfDay.
      fctx.body.push({ op: "local.get", index: tempMsOfDay } as Instr);
      if (unit === "ms") {
        fctx.body.push({ op: "i64.const", value: MS_PER_SECOND } as Instr, { op: "i64.rem_s" } as Instr);
      } else if (unit === "s") {
        fctx.body.push(
          { op: "i64.const", value: MS_PER_SECOND } as Instr,
          { op: "i64.div_s" } as Instr,
          { op: "i64.const", value: 60n } as Instr,
          { op: "i64.rem_s" } as Instr,
        );
      } else if (unit === "m") {
        fctx.body.push(
          { op: "i64.const", value: MS_PER_MINUTE } as Instr,
          { op: "i64.div_s" } as Instr,
          { op: "i64.const", value: 60n } as Instr,
          { op: "i64.rem_s" } as Instr,
        );
      } else {
        fctx.body.push({ op: "i64.const", value: MS_PER_HOUR } as Instr, { op: "i64.div_s" } as Instr);
      }
    };

    // newTs = day_ms + h*MS_PER_HOUR + m*MS_PER_MINUTE + s*MS_PER_SECOND + ms
    fctx.body.push({ op: "local.get", index: tempDayMs } as Instr);
    pushComponent("h");
    fctx.body.push({ op: "i64.const", value: MS_PER_HOUR } as Instr);
    fctx.body.push({ op: "i64.mul" } as Instr);
    fctx.body.push({ op: "i64.add" } as Instr);
    pushComponent("m");
    fctx.body.push({ op: "i64.const", value: MS_PER_MINUTE } as Instr);
    fctx.body.push({ op: "i64.mul" } as Instr);
    fctx.body.push({ op: "i64.add" } as Instr);
    pushComponent("s");
    fctx.body.push({ op: "i64.const", value: MS_PER_SECOND } as Instr);
    fctx.body.push({ op: "i64.mul" } as Instr);
    fctx.body.push({ op: "i64.add" } as Instr);
    pushComponent("ms");
    fctx.body.push({ op: "i64.add" } as Instr);

    const tempNewTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: tempNewTs } as Instr);

    // TimeClip (§21.4.1.31): if |newTs| > 8.64e15 ms → sentinel + NaN
    fctx.body.push({ op: "local.get", index: tempNewTs } as Instr);
    fctx.body.push({ op: "i64.const", value: 8640000000000000n } as Instr);
    fctx.body.push({ op: "i64.gt_s" } as Instr);
    fctx.body.push({ op: "local.get", index: tempNewTs } as Instr);
    fctx.body.push({ op: "i64.const", value: -8640000000000000n } as Instr);
    fctx.body.push({ op: "i64.lt_s" } as Instr);
    fctx.body.push({ op: "i32.or" } as Instr);

    const savedClipThen = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempRef } as Instr);
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
    fctx.body.push({
      op: "struct.set",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    } as unknown as Instr);
    fctx.body.push({ op: "f64.const", value: NaN } as Instr);
    const clipThenInstrs = fctx.body;
    popBody(fctx, savedClipThen);

    const savedClipElse = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempRef } as Instr);
    fctx.body.push({ op: "local.get", index: tempNewTs } as Instr);
    fctx.body.push({
      op: "struct.set",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    } as unknown as Instr);
    fctx.body.push({ op: "local.get", index: tempNewTs } as Instr);
    fctx.body.push({ op: "f64.convert_i64_s" } as Instr);
    const clipElseInstrs = fctx.body;
    popBody(fctx, savedClipElse);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: clipThenInstrs,
      else: clipElseInstrs,
    } as unknown as Instr);

    releaseTempLocal(fctx, tempMsOfDay);
    releaseTempLocal(fctx, tempDayMs);
    releaseTempLocal(fctx, tempNewTs);

    const elseInstrs = fctx.body;
    popBody(fctx, savedElse);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: thenInstrs,
      else: elseInstrs,
    } as unknown as Instr);

    releaseTempLocal(fctx, tempRef);
    releaseTempLocal(fctx, tempCurTs);
    releaseTempLocal(fctx, tempAnyInvalid);
    for (const local of Object.values(argLocals)) {
      if (local !== undefined) releaseTempLocal(fctx, local);
    }
    return { kind: "f64" };
  }

  // ── Calendar setters (#1440 Slice 3) ───────────────────────────────────
  // setDate(date), setMonth(month, date?), setFullYear(year, month?, date?)
  // and UTC variants, plus legacy setYear. Same NaN-propagation/TimeClip
  // pattern as the time-of-day setters. setFullYear is special: per
  // §21.4.4.21, an Invalid-Date receiver is re-validated as t=+0.
  const CALENDAR_SETTERS: Record<string, "d" | "mo" | "y"> = {
    setDate: "d",
    setUTCDate: "d",
    setMonth: "mo",
    setUTCMonth: "mo",
    setFullYear: "y",
    setUTCFullYear: "y",
    setYear: "y", // legacy: §B.2.3.5 — year < 100 maps to 1900+year
  };
  // hasOwn, not `in` — see TIME_OF_DAY_SETTERS above (#1638).
  if (Object.prototype.hasOwnProperty.call(CALENDAR_SETTERS, methodName)) {
    const startUnit = CALENDAR_SETTERS[methodName]!;
    const args = callExpr.arguments;
    const isSetFullYear = methodName === "setFullYear" || methodName === "setUTCFullYear" || methodName === "setYear";
    const isLegacySetYear = methodName === "setYear";

    // Stack: [dateRef]
    const tempRef = allocTempLocal(fctx, dateRefType);
    fctx.body.push({ op: "local.set", index: tempRef } as Instr);

    // Read curTs FIRST.
    const tempCurTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempRef } as Instr);
    fctx.body.push({
      op: "struct.get",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    } as unknown as Instr);
    fctx.body.push({ op: "local.set", index: tempCurTs } as Instr);

    // Mapping: setDate(d) → [d], setMonth(mo, d?) → [mo, d],
    // setFullYear(y, mo?, d?) → [y, mo, d], setYear(y) → [y]
    const calUnits: ("y" | "mo" | "d")[] = ["y", "mo", "d"];
    const startCalIdx = calUnits.indexOf(startUnit);
    const unitsForArgs = isLegacySetYear ? (["y"] as ("y" | "mo" | "d")[]) : calUnits.slice(startCalIdx);

    // Coerce all args left-to-right. If START arg is missing, ToNumber(undefined)=NaN.
    const tempAnyInvalid = allocTempLocal(fctx, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: args.length === 0 ? 1 : 0 } as Instr);
    fctx.body.push({ op: "local.set", index: tempAnyInvalid } as Instr);

    const argLocals: Partial<Record<"y" | "mo" | "d", number>> = {};
    for (let i = 0; i < unitsForArgs.length && i < args.length; i++) {
      const unit = unitsForArgs[i]!;
      const local = allocTempLocal(fctx, { kind: "f64" });
      argLocals[unit] = local;
      compileExpression(ctx, fctx, args[i]!, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: local } as Instr);
      // invalid_i = (x != x) | (f64.abs(x) > 8.64e15)
      fctx.body.push({ op: "local.get", index: local } as Instr);
      fctx.body.push({ op: "local.get", index: local } as Instr);
      fctx.body.push({ op: "f64.ne" } as unknown as Instr);
      fctx.body.push({ op: "local.get", index: local } as Instr);
      fctx.body.push({ op: "f64.abs" } as unknown as Instr);
      fctx.body.push({ op: "f64.const", value: 8.64e15 } as Instr);
      fctx.body.push({ op: "f64.gt" } as Instr);
      fctx.body.push({ op: "i32.or" } as Instr);
      fctx.body.push({ op: "local.get", index: tempAnyInvalid } as Instr);
      fctx.body.push({ op: "i32.or" } as Instr);
      fctx.body.push({ op: "local.set", index: tempAnyInvalid } as Instr);
    }

    // Legacy setYear: if 0 <= y <= 99, y += 1900 (§B.2.3.5).
    if (isLegacySetYear && argLocals.y !== undefined) {
      const yLocal = argLocals.y;
      fctx.body.push({ op: "local.get", index: yLocal } as Instr);
      fctx.body.push({ op: "f64.const", value: 0 } as Instr);
      fctx.body.push({ op: "f64.ge" } as Instr);
      fctx.body.push({ op: "local.get", index: yLocal } as Instr);
      fctx.body.push({ op: "f64.const", value: 99 } as Instr);
      fctx.body.push({ op: "f64.le" } as Instr);
      fctx.body.push({ op: "i32.and" } as Instr);
      const savedY = pushBody(fctx);
      fctx.body.push({ op: "local.get", index: yLocal } as Instr);
      fctx.body.push({ op: "f64.const", value: 1900 } as Instr);
      fctx.body.push({ op: "f64.add" } as Instr);
      const yThenInstrs = fctx.body;
      popBody(fctx, savedY);
      const savedYElse = pushBody(fctx);
      fctx.body.push({ op: "local.get", index: yLocal } as Instr);
      const yElseInstrs = fctx.body;
      popBody(fctx, savedYElse);
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: yThenInstrs,
        else: yElseInstrs,
      } as unknown as Instr);
      fctx.body.push({ op: "local.set", index: yLocal } as Instr);
    }

    // For setFullYear: an Invalid Date receiver is re-validated by setting
    // t to +0. So sentinelCurTs no longer poisons the result.
    // For other calendar setters: sentinel curTs → return NaN.
    fctx.body.push({ op: "local.get", index: tempAnyInvalid } as Instr);
    if (!isSetFullYear) {
      fctx.body.push({ op: "local.get", index: tempCurTs } as Instr);
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
      fctx.body.push({ op: "i64.eq" } as Instr);
      fctx.body.push({ op: "i32.or" } as Instr);
    }

    // then-branch: invalid → sentinel + NaN.
    const savedThen = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempRef } as Instr);
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
    fctx.body.push({
      op: "struct.set",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    } as unknown as Instr);
    fctx.body.push({ op: "f64.const", value: NaN } as Instr);
    const thenInstrs = fctx.body;
    popBody(fctx, savedThen);

    // else-branch: valid calendar arithmetic.
    const savedElse = pushBody(fctx);

    // For setFullYear with Invalid Date, treat curTs as 0 (re-validate).
    const tempEffTs = allocTempLocal(fctx, { kind: "i64" });
    if (isSetFullYear) {
      fctx.body.push({ op: "local.get", index: tempCurTs } as Instr);
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
      fctx.body.push({ op: "i64.eq" } as Instr);
      const savedReval = pushBody(fctx);
      fctx.body.push({ op: "i64.const", value: 0n } as Instr);
      const revalThen = fctx.body;
      popBody(fctx, savedReval);
      const savedRevalElse = pushBody(fctx);
      fctx.body.push({ op: "local.get", index: tempCurTs } as Instr);
      const revalElse = fctx.body;
      popBody(fctx, savedRevalElse);
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: revalThen,
        else: revalElse,
      } as unknown as Instr);
      fctx.body.push({ op: "local.set", index: tempEffTs } as Instr);
    } else {
      fctx.body.push({ op: "local.get", index: tempCurTs } as Instr);
      fctx.body.push({ op: "local.set", index: tempEffTs } as Instr);
    }

    // ms_of_day from tempEffTs (preserved into the new date).
    const tempMsOfDay = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push(
      { op: "local.get", index: tempEffTs } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.const", value: MS_PER_DAY } as Instr,
      { op: "i64.rem_s" } as Instr,
      { op: "local.set", index: tempMsOfDay } as Instr,
    );

    // curDays = floor(tempEffTs / MS_PER_DAY), then civil_from_days.
    const civilIdx = ensureDateCivilHelper(ctx);
    const tempCurDays = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempEffTs } as Instr);
    fctx.body.push({ op: "i64.const", value: 0n } as Instr);
    fctx.body.push({ op: "i64.ge_s" } as Instr);
    const savedFlrThen = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempEffTs } as Instr);
    fctx.body.push({ op: "i64.const", value: MS_PER_DAY } as Instr);
    fctx.body.push({ op: "i64.div_s" } as Instr);
    const flrThenInstrs = fctx.body;
    popBody(fctx, savedFlrThen);
    const savedFlrElse = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempEffTs } as Instr);
    fctx.body.push({ op: "i64.const", value: MS_PER_DAY - 1n } as Instr);
    fctx.body.push({ op: "i64.sub" } as Instr);
    fctx.body.push({ op: "i64.const", value: MS_PER_DAY } as Instr);
    fctx.body.push({ op: "i64.div_s" } as Instr);
    const flrElseInstrs = fctx.body;
    popBody(fctx, savedFlrElse);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: flrThenInstrs,
      else: flrElseInstrs,
    } as unknown as Instr);
    fctx.body.push({ op: "local.set", index: tempCurDays } as Instr);

    // packed = civil_from_days(curDays)  (year*10000 + month*100 + day, month 1-12)
    const tempPacked = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempCurDays } as Instr);
    fctx.body.push({ op: "call", funcIdx: civilIdx } as Instr);
    fctx.body.push({ op: "local.set", index: tempPacked } as Instr);

    // Extract curY, curMo (1-based), curD from packed.
    // curY = packed / 10000
    // curMo = (packed / 100) % 100
    // curD = packed % 100
    const tempCurY = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempPacked } as Instr);
    fctx.body.push({ op: "i64.const", value: 10000n } as Instr);
    fctx.body.push({ op: "i64.div_s" } as Instr);
    fctx.body.push({ op: "local.set", index: tempCurY } as Instr);

    const tempCurMo = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempPacked } as Instr);
    fctx.body.push({ op: "i64.const", value: 100n } as Instr);
    fctx.body.push({ op: "i64.div_s" } as Instr);
    fctx.body.push({ op: "i64.const", value: 100n } as Instr);
    fctx.body.push({ op: "i64.rem_s" } as Instr);
    fctx.body.push({ op: "local.set", index: tempCurMo } as Instr);

    const tempCurD = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempPacked } as Instr);
    fctx.body.push({ op: "i64.const", value: 100n } as Instr);
    fctx.body.push({ op: "i64.rem_s" } as Instr);
    fctx.body.push({ op: "local.set", index: tempCurD } as Instr);

    // Push new component value (i64): from arg or from current.
    // Note: JS month is 0-based, but our helper uses 1-based. So when the
    // user supplies a month arg we add 1 here.
    const pushNewY = () => {
      if (argLocals.y !== undefined) {
        fctx.body.push({ op: "local.get", index: argLocals.y } as Instr);
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "local.get", index: tempCurY } as Instr);
      }
    };
    const pushNewMo1Based = () => {
      if (argLocals.mo !== undefined) {
        fctx.body.push({ op: "local.get", index: argLocals.mo } as Instr);
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        fctx.body.push({ op: "i64.const", value: 1n } as Instr);
        fctx.body.push({ op: "i64.add" } as Instr);
      } else {
        fctx.body.push({ op: "local.get", index: tempCurMo } as Instr);
      }
    };
    const pushNewD = () => {
      if (argLocals.d !== undefined) {
        fctx.body.push({ op: "local.get", index: argLocals.d } as Instr);
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "local.get", index: tempCurD } as Instr);
      }
    };

    // newDays = days_from_civil(newY, newMo1Based, newD)
    const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);
    pushNewY();
    pushNewMo1Based();
    pushNewD();
    fctx.body.push({ op: "call", funcIdx: daysFromCivilIdx } as Instr);
    // newTs = newDays * MS_PER_DAY + msOfDay
    fctx.body.push({ op: "i64.const", value: MS_PER_DAY } as Instr);
    fctx.body.push({ op: "i64.mul" } as Instr);
    fctx.body.push({ op: "local.get", index: tempMsOfDay } as Instr);
    fctx.body.push({ op: "i64.add" } as Instr);

    const tempNewTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: tempNewTs } as Instr);

    // TimeClip: |newTs| > 8.64e15 → sentinel + NaN
    fctx.body.push({ op: "local.get", index: tempNewTs } as Instr);
    fctx.body.push({ op: "i64.const", value: 8640000000000000n } as Instr);
    fctx.body.push({ op: "i64.gt_s" } as Instr);
    fctx.body.push({ op: "local.get", index: tempNewTs } as Instr);
    fctx.body.push({ op: "i64.const", value: -8640000000000000n } as Instr);
    fctx.body.push({ op: "i64.lt_s" } as Instr);
    fctx.body.push({ op: "i32.or" } as Instr);

    const savedClipThen = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempRef } as Instr);
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
    fctx.body.push({
      op: "struct.set",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    } as unknown as Instr);
    fctx.body.push({ op: "f64.const", value: NaN } as Instr);
    const clipThenInstrs = fctx.body;
    popBody(fctx, savedClipThen);

    const savedClipElse = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempRef } as Instr);
    fctx.body.push({ op: "local.get", index: tempNewTs } as Instr);
    fctx.body.push({
      op: "struct.set",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    } as unknown as Instr);
    fctx.body.push({ op: "local.get", index: tempNewTs } as Instr);
    fctx.body.push({ op: "f64.convert_i64_s" } as Instr);
    const clipElseInstrs = fctx.body;
    popBody(fctx, savedClipElse);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: clipThenInstrs,
      else: clipElseInstrs,
    } as unknown as Instr);

    releaseTempLocal(fctx, tempEffTs);
    releaseTempLocal(fctx, tempMsOfDay);
    releaseTempLocal(fctx, tempCurDays);
    releaseTempLocal(fctx, tempPacked);
    releaseTempLocal(fctx, tempCurY);
    releaseTempLocal(fctx, tempCurMo);
    releaseTempLocal(fctx, tempCurD);
    releaseTempLocal(fctx, tempNewTs);

    const elseInstrs = fctx.body;
    popBody(fctx, savedElse);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: thenInstrs,
      else: elseInstrs,
    } as unknown as Instr);

    releaseTempLocal(fctx, tempRef);
    releaseTempLocal(fctx, tempCurTs);
    releaseTempLocal(fctx, tempAnyInvalid);
    for (const local of Object.values(argLocals)) {
      if (local !== undefined) releaseTempLocal(fctx, local);
    }
    return { kind: "f64" };
  }

  // For all time-component getters, we need the i64 timestamp.
  // Stack: [dateRef]
  fctx.body.push({
    op: "struct.get",
    typeIdx: dateTypeIdx,
    fieldIdx: 0,
  });
  // Stack: [i64 timestamp]

  // (#1344) Save the timestamp to a local so each branch can wrap its
  // arithmetic in an `if (timestamp === INVALID_SENTINEL) NaN else <arith>`
  // check. Without this, `new Date(NaN).getDay()` etc. return arithmetic
  // results from a saturated 0 timestamp instead of the spec-mandated NaN.
  // The sentinel value is `i64.const -9223372036854775808` (min i64), set
  // by `new Date(NaN)` in `new-super.ts`. No legitimate JS timestamp can
  // reach this magnitude (valid range is ±8.64e15 ms).
  const tsLocalShared = allocTempLocal(fctx, { kind: "i64" });
  fctx.body.push({ op: "local.set", index: tsLocalShared } as Instr);
  // Stack: []

  /** Wrap a getter's arithmetic in the invalid-Date NaN guard. The
   *  callback should emit instructions that consume the i64 timestamp
   *  on the stack and produce an f64 result. */
  const wrapWithInvalidDateGuard = (emitArithmetic: () => void): ValType => {
    fctx.body.push({ op: "local.get", index: tsLocalShared } as Instr);
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
    fctx.body.push({ op: "i64.eq" } as Instr);
    const savedBody = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tsLocalShared } as Instr);
    emitArithmetic();
    const elseInstrs = fctx.body;
    popBody(fctx, savedBody);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN } as Instr],
      else: elseInstrs,
    });
    return { kind: "f64" };
  };

  if (methodName === "getHours" || methodName === "getUTCHours") {
    // hours = ((timestamp % 86400000) + 86400000) % 86400000 / 3600000
    return wrapWithInvalidDateGuard(() =>
      fctx.body.push(
        { op: "i64.const", value: MS_PER_DAY } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "i64.const", value: MS_PER_DAY } as Instr,
        { op: "i64.add" } as Instr,
        { op: "i64.const", value: MS_PER_DAY } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "i64.const", value: MS_PER_HOUR } as Instr,
        { op: "i64.div_s" } as Instr,
        { op: "f64.convert_i64_s" } as Instr,
      ),
    );
  }

  if (methodName === "getMinutes" || methodName === "getUTCMinutes") {
    // minutes = ((timestamp % 3600000) + 3600000) % 3600000 / 60000
    return wrapWithInvalidDateGuard(() =>
      fctx.body.push(
        { op: "i64.const", value: MS_PER_HOUR } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "i64.const", value: MS_PER_HOUR } as Instr,
        { op: "i64.add" } as Instr,
        { op: "i64.const", value: MS_PER_HOUR } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "i64.const", value: MS_PER_MINUTE } as Instr,
        { op: "i64.div_s" } as Instr,
        { op: "f64.convert_i64_s" } as Instr,
      ),
    );
  }

  if (methodName === "getSeconds" || methodName === "getUTCSeconds") {
    // seconds = ((timestamp % 60000) + 60000) % 60000 / 1000
    return wrapWithInvalidDateGuard(() =>
      fctx.body.push(
        { op: "i64.const", value: MS_PER_MINUTE } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "i64.const", value: MS_PER_MINUTE } as Instr,
        { op: "i64.add" } as Instr,
        { op: "i64.const", value: MS_PER_MINUTE } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "i64.const", value: MS_PER_SECOND } as Instr,
        { op: "i64.div_s" } as Instr,
        { op: "f64.convert_i64_s" } as Instr,
      ),
    );
  }

  if (methodName === "getMilliseconds" || methodName === "getUTCMilliseconds") {
    // ms = ((timestamp % 1000) + 1000) % 1000
    return wrapWithInvalidDateGuard(() =>
      fctx.body.push(
        { op: "i64.const", value: MS_PER_SECOND } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "i64.const", value: MS_PER_SECOND } as Instr,
        { op: "i64.add" } as Instr,
        { op: "i64.const", value: MS_PER_SECOND } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "f64.convert_i64_s" } as Instr,
      ),
    );
  }

  // getDay / getUTCDay: day of week (0=Sunday)
  // (floor(timestamp / 86400000) + 4) % 7  (1970-01-01 was Thursday = 4)
  if (methodName === "getDay" || methodName === "getUTCDay") {
    return wrapWithInvalidDateGuard(() =>
      fctx.body.push(
        { op: "i64.const", value: MS_PER_DAY } as Instr,
        { op: "i64.div_s" } as Instr,
        { op: "i64.const", value: 4n } as Instr,
        { op: "i64.add" } as Instr,
        { op: "i64.const", value: 7n } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "i64.const", value: 7n } as Instr,
        { op: "i64.add" } as Instr,
        { op: "i64.const", value: 7n } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "f64.convert_i64_s" } as Instr,
      ),
    );
  }

  // Calendar getters need civil_from_days.
  // (#1344) Each branch is wrapped with the invalid-Date guard. The guard
  // re-pushes the saved timestamp so the floor-div + civil_from_days
  // sequence below sees it on the stack.
  const civilIdx = ensureDateCivilHelper(ctx);

  /** Emit floor-div(ts, MS_PER_DAY) -> days, then civil_from_days(days). */
  const emitDaysToCivil = (): void => {
    const tempTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: tempTs } as Instr);
    fctx.body.push(
      { op: "local.get", index: tempTs } as Instr,
      { op: "i64.const", value: 0n } as Instr,
      { op: "i64.ge_s" } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: [
          { op: "local.get", index: tempTs } as Instr,
          { op: "i64.const", value: MS_PER_DAY } as Instr,
          { op: "i64.div_s" } as Instr,
        ],
        else: [
          { op: "local.get", index: tempTs } as Instr,
          { op: "i64.const", value: MS_PER_DAY - 1n } as Instr,
          { op: "i64.sub" } as Instr,
          { op: "i64.const", value: MS_PER_DAY } as Instr,
          { op: "i64.div_s" } as Instr,
        ],
      },
    );
    releaseTempLocal(fctx, tempTs);
    fctx.body.push({ op: "call", funcIdx: civilIdx } as Instr);
  };

  if (methodName === "getFullYear" || methodName === "getUTCFullYear") {
    return wrapWithInvalidDateGuard(() => {
      emitDaysToCivil();
      fctx.body.push(
        { op: "i64.const", value: 10000n } as Instr,
        { op: "i64.div_s" } as Instr,
        { op: "f64.convert_i64_s" } as Instr,
      );
    });
  }

  if (methodName === "getMonth" || methodName === "getUTCMonth") {
    return wrapWithInvalidDateGuard(() => {
      emitDaysToCivil();
      fctx.body.push(
        { op: "i64.const", value: 100n } as Instr,
        { op: "i64.div_s" } as Instr,
        { op: "i64.const", value: 100n } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "i64.const", value: 1n } as Instr,
        { op: "i64.sub" } as Instr,
        { op: "f64.convert_i64_s" } as Instr,
      );
    });
  }

  if (methodName === "getDate" || methodName === "getUTCDate") {
    return wrapWithInvalidDateGuard(() => {
      emitDaysToCivil();
      fctx.body.push(
        { op: "i64.const", value: 100n } as Instr,
        { op: "i64.rem_s" } as Instr,
        { op: "f64.convert_i64_s" } as Instr,
      );
    });
  }

  // (#1638) String formatters. The timestamp lives in `tsLocalShared` (i64).
  // We delegate to the `__date_format(ts, mode)` host import which builds the
  // spec-correct string (ECMA-262 §21.4.4) from a UTC Date and returns it as
  // an externref. This matches the externref representation of string literals
  // in the default (non-nativeStrings) string backend.
  //
  // In nativeStrings mode (WASI / --nativeStrings) strings are WasmGC i16
  // arrays, not externref, so the host-string bridge does not apply; we keep
  // the placeholder there (Date string formatting in fully-standalone Wasm is
  // tracked separately — the host fast path covers the test262 / JS-host case).
  if (DATE_FORMAT_MODE.has(methodName)) {
    const mode = DATE_FORMAT_MODE.get(methodName)!;

    if (ctx.nativeStrings) {
      releaseTempLocal(fctx, tsLocalShared);
      if (methodName === "toISOString" || methodName === "toJSON") {
        return compileStringLiteral(ctx, fctx, "1970-01-01T00:00:00.000Z");
      }
      return compileStringLiteral(ctx, fctx, "Thu Jan 01 1970 00:00:00 GMT+0000");
    }

    const fmtIdx = ensureLateImport(ctx, "__date_format", [{ kind: "i64" }, { kind: "i32" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);

    // toJSON returns `null` (not "Invalid Date", not a throw) for an Invalid
    // Date receiver (§21.4.4.45 → toISOString is skipped when ToNumber is not
    // finite). Branch on the sentinel and return ref.null externref.
    if (methodName === "toJSON") {
      fctx.body.push({ op: "local.get", index: tsLocalShared } as Instr);
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n } as Instr);
      fctx.body.push({ op: "i64.eq" } as Instr);
      const thenInstrs: Instr[] = [{ op: "ref.null.extern" } as Instr];
      const elseInstrs: Instr[] = [
        { op: "local.get", index: tsLocalShared } as Instr,
        { op: "i32.const", value: mode } as Instr,
        { op: "call", funcIdx: fmtIdx } as Instr,
      ];
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: thenInstrs,
        else: elseInstrs,
      } as unknown as Instr);
      releaseTempLocal(fctx, tsLocalShared);
      return { kind: "externref" };
    }

    fctx.body.push({ op: "local.get", index: tsLocalShared } as Instr);
    fctx.body.push({ op: "i32.const", value: mode } as Instr);
    fctx.body.push({ op: "call", funcIdx: fmtIdx } as Instr);
    releaseTempLocal(fctx, tsLocalShared);
    return { kind: "externref" };
  }

  // Shouldn't reach here. Timestamp was saved to a local; nothing to drop.
  releaseTempLocal(fctx, tsLocalShared);
  fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  return { kind: "f64" };
}

/**
 * (#1638) Mode selectors for `__date_format`. Kept in sync with the
 * `_DATE_FMT_*` constants in src/runtime.ts.
 */
const DATE_FORMAT_MODE = new Map<string, number>([
  ["toISOString", 0],
  ["toUTCString", 1],
  ["toGMTString", 1],
  ["toString", 2],
  ["toDateString", 3],
  ["toTimeString", 4],
  ["toJSON", 5],
  ["toLocaleString", 6],
  ["toLocaleDateString", 7],
  ["toLocaleTimeString", 8],
]);

/**
 * WASI mode: compile console.log/warn/error by writing UTF-8 via fd_write.
 *
 * #1493: warn/error route to fd=2 (stderr) via __wasi_write_string_stderr.
 * log/info/debug stay on fd=1 (stdout) via __wasi_write_string. This makes
 * `command > out.txt 2> err.txt` and `2>&1` work for js2wasm-compiled binaries
 * (Unix tooling expectation, matches Node/V8 semantics).
 */
function compileConsoleCallWasi(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: string,
): InnerResult {
  const useStderr = method === "warn" || method === "error";
  const helperName = useStderr ? "__wasi_write_string_stderr" : "__wasi_write_string";
  const writeStringIdx = ctx.funcMap.get(helperName);
  if (writeStringIdx === undefined) return VOID_RESULT;

  let first = true;
  for (const arg of expr.arguments) {
    // Add space separator between arguments (like console.log does)
    if (!first) {
      const spaceData = wasiAllocStringData(ctx, " ");
      fctx.body.push({ op: "i32.const", value: spaceData.offset } as Instr);
      fctx.body.push({ op: "i32.const", value: spaceData.length } as Instr);
      fctx.body.push({ op: "call", funcIdx: writeStringIdx });
    }
    first = false;

    // Check if this is a string literal we can embed directly
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      const strValue = arg.text;
      const data = wasiAllocStringData(ctx, strValue);
      fctx.body.push({ op: "i32.const", value: data.offset } as Instr);
      fctx.body.push({ op: "i32.const", value: data.length } as Instr);
      fctx.body.push({ op: "call", funcIdx: writeStringIdx });
    } else if (ts.isTemplateExpression(arg)) {
      // Template literal: handle head + spans
      if (arg.head.text) {
        const headData = wasiAllocStringData(ctx, arg.head.text);
        fctx.body.push({ op: "i32.const", value: headData.offset } as Instr);
        fctx.body.push({ op: "i32.const", value: headData.length } as Instr);
        fctx.body.push({ op: "call", funcIdx: writeStringIdx });
      }
      for (const span of arg.templateSpans) {
        // Compile the expression and convert to string output
        const exprType = compileExpression(ctx, fctx, span.expression);
        emitWasiValueToStdout(ctx, fctx, exprType, span.expression, useStderr);
        if (span.literal.text) {
          const litData = wasiAllocStringData(ctx, span.literal.text);
          fctx.body.push({ op: "i32.const", value: litData.offset } as Instr);
          fctx.body.push({ op: "i32.const", value: litData.length } as Instr);
          fctx.body.push({ op: "call", funcIdx: writeStringIdx });
        }
      }
    } else {
      // For non-literal arguments, compile the expression and handle by type
      const argType = ctx.checker.getTypeAtLocation(arg);
      const exprType = compileExpression(ctx, fctx, arg);
      emitWasiValueToStdout(ctx, fctx, exprType, arg, useStderr);
    }
  }

  // Emit newline at the end
  const newlineData = wasiAllocStringData(ctx, "\n");
  fctx.body.push({ op: "i32.const", value: newlineData.offset } as Instr);
  fctx.body.push({ op: "i32.const", value: newlineData.length } as Instr);
  fctx.body.push({ op: "call", funcIdx: writeStringIdx });

  return VOID_RESULT;
}

/** Allocate a UTF-8 string in a data segment and return its offset/length */
function wasiAllocStringData(ctx: CodegenContext, str: string): { offset: number; length: number } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);

  // Find the next available offset in data segments
  // Data segments start after the scratch area (offset 1024)
  let offset = 1024;
  for (const seg of ctx.mod.dataSegments) {
    const segEnd = seg.offset + seg.bytes.length;
    if (segEnd > offset) offset = segEnd;
  }

  ctx.mod.dataSegments.push({ offset, bytes });
  return { offset, length: bytes.length };
}

/** Emit code to write a compiled value to stdout in WASI mode */
function emitWasiValueToStdout(
  ctx: CodegenContext,
  fctx: FunctionContext,
  exprType: InnerResult,
  node: ts.Node,
  useStderr: boolean = false,
): void {
  // #1493: pick stdout (fd=1) or stderr (fd=2) helper based on call site.
  const writeStringName = useStderr ? "__wasi_write_string_stderr" : "__wasi_write_string";
  const writeStringIdx = ctx.funcMap.get(writeStringName);
  if (writeStringIdx === undefined) return;

  if (exprType === VOID_RESULT || exprType === null) {
    // void expression, nothing to write — drop already handled
    return;
  }

  if (exprType.kind === "f64") {
    // Number: use __wasi_write_f64 helper (emit inline if not yet registered)
    const writeF64Idx = ensureWasiWriteF64Helper(ctx, useStderr);
    if (writeF64Idx >= 0) {
      fctx.body.push({ op: "call", funcIdx: writeF64Idx });
    } else {
      fctx.body.push({ op: "drop" } as Instr);
    }
  } else if (exprType.kind === "i32") {
    // Boolean or i32: write "true"/"false" or the integer
    const writeI32Idx = ensureWasiWriteI32Helper(ctx, useStderr);
    if (writeI32Idx >= 0) {
      fctx.body.push({ op: "call", funcIdx: writeI32Idx });
    } else {
      fctx.body.push({ op: "drop" } as Instr);
    }
  } else if (
    (exprType.kind === "ref" || exprType.kind === "ref_null") &&
    isStringType(ctx.checker.getTypeAtLocation(node)) &&
    ctx.nativeStrTypeIdx >= 0
  ) {
    // #1618: runtime string value (variable / concatenation / template span).
    // The compiled value is a NativeString ref (or its AnyString supertype).
    // Flatten + write its bytes to fd=1/fd=2 instead of dropping it and
    // emitting the "[object]" placeholder. The value on the stack may be typed
    // as the AnyString supertype after a concat; cast to NativeString so it
    // matches the helper's param type (__str_flatten accepts the supertype, so
    // any non-flat tree is handled there — but the static cast is required for
    // the call to typecheck against the helper signature).
    const refKind = exprType.kind;
    if (
      refKind === "ref" &&
      "typeIdx" in exprType &&
      (exprType as { typeIdx: number }).typeIdx !== ctx.nativeStrTypeIdx
    ) {
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.nativeStrTypeIdx } as Instr);
    } else if (refKind === "ref_null") {
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.nativeStrTypeIdx } as Instr);
    }
    const writeAnyIdx = ensureWasiWriteAnyStringHelper(ctx, useStderr);
    if (writeAnyIdx >= 0) {
      fctx.body.push({ op: "call", funcIdx: writeAnyIdx } as Instr);
    } else {
      // Helper unavailable (no native strings) — fall back to placeholder.
      fctx.body.push({ op: "drop" } as Instr);
      const placeholder = wasiAllocStringData(ctx, "[object]");
      fctx.body.push({ op: "i32.const", value: placeholder.offset } as Instr);
      fctx.body.push({ op: "i32.const", value: placeholder.length } as Instr);
      fctx.body.push({ op: "call", funcIdx: writeStringIdx });
    }
  } else {
    // For other types (externref, etc.), just drop and write a placeholder
    fctx.body.push({ op: "drop" } as Instr);
    const placeholder = wasiAllocStringData(ctx, "[object]");
    fctx.body.push({ op: "i32.const", value: placeholder.offset } as Instr);
    fctx.body.push({ op: "i32.const", value: placeholder.length } as Instr);
    fctx.body.push({ op: "call", funcIdx: writeStringIdx });
  }
}

/**
 * Ensure the __wasi_write_i32 helper exists and return its function index.
 *
 * #1493: when `useStderr` is true, registers/uses a `__wasi_write_i32_stderr`
 * variant that routes the formatted digits through __wasi_write_string_stderr
 * (fd=2) instead of __wasi_write_string (fd=1).
 */
function ensureWasiWriteI32Helper(ctx: CodegenContext, useStderr: boolean = false): number {
  const helperName = useStderr ? "__wasi_write_i32_stderr" : "__wasi_write_i32";
  const writeStringHelperName = useStderr ? "__wasi_write_string_stderr" : "__wasi_write_string";

  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const writeStringIdx = ctx.funcMap.get(writeStringHelperName);
  if (writeStringIdx === undefined) return -1;

  // Simple i32 to decimal string conversion
  // Uses bump allocator to write digits to linear memory
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  // Algorithm: handle negative, then extract digits in reverse, then write forward
  // Locals: 0=value, 1=buf_start, 2=buf_pos, 3=is_neg, 4=digit
  const body: Instr[] = [];

  // For simplicity, handle 0 specially, negatives, and positive integers
  // We allocate a 12-byte buffer on the bump allocator for the digit string
  const bufStartLocal = 1; // local index
  const bufPosLocal = 2;
  const isNegLocal = 3;
  const absValLocal = 4;
  const tmpLocal = 5;

  body.push(
    // buf_start = bump_ptr
    { op: "global.get", index: ctx.wasiBumpPtrGlobalIdx } as Instr,
    { op: "local.set", index: bufStartLocal } as Instr,
    // buf_pos = buf_start + 11 (write digits right-to-left, max 11 digits + sign)
    { op: "local.get", index: bufStartLocal } as Instr,
    { op: "i32.const", value: 11 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: bufPosLocal } as Instr,

    // Check if value == 0
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.eqz" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // Write "0" directly
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 48 } as Instr, // '0'
        { op: "i32.store8", align: 0, offset: 0 } as Instr,
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check if negative
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.lt_s" } as Instr,
    { op: "local.set", index: isNegLocal } as Instr,

    // absVal = is_neg ? -value : value
    { op: "local.get", index: isNegLocal } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: 0 } as Instr,
        { op: "i32.sub" } as Instr,
      ],
      else: [{ op: "local.get", index: 0 } as Instr],
    },
    { op: "local.set", index: absValLocal } as Instr,

    // Loop: extract digits right to left
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if absVal == 0, break
            { op: "local.get", index: absValLocal } as Instr,
            { op: "i32.eqz" } as Instr,
            { op: "br_if", depth: 1 } as Instr,

            // digit = absVal % 10
            { op: "local.get", index: absValLocal } as Instr,
            { op: "i32.const", value: 10 } as Instr,
            { op: "i32.rem_u" } as Instr,
            { op: "local.set", index: tmpLocal } as Instr,

            // absVal = absVal / 10
            { op: "local.get", index: absValLocal } as Instr,
            { op: "i32.const", value: 10 } as Instr,
            { op: "i32.div_u" } as Instr,
            { op: "local.set", index: absValLocal } as Instr,

            // buf_pos--
            { op: "local.get", index: bufPosLocal } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.sub" } as Instr,
            { op: "local.set", index: bufPosLocal } as Instr,

            // memory[buf_pos] = digit + '0'
            { op: "local.get", index: bufPosLocal } as Instr,
            { op: "local.get", index: tmpLocal } as Instr,
            { op: "i32.const", value: 48 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "i32.store8", align: 0, offset: 0 } as Instr,

            // continue loop
            { op: "br", depth: 0 } as Instr,
          ],
        },
      ],
    },

    // If negative, prepend '-'
    { op: "local.get", index: isNegLocal } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "local.set", index: bufPosLocal } as Instr,
        { op: "local.get", index: bufPosLocal } as Instr,
        { op: "i32.const", value: 45 } as Instr, // '-'
        { op: "i32.store8", align: 0, offset: 0 } as Instr,
      ],
    },

    // Call __wasi_write_string(buf_pos, (buf_start + 11) - buf_pos)
    //
    // Off-by-one fix (pre-existing, surfaced by real-wasmtime testing of the
    // #1530 Native Messaging host's stderr debug line): the digit buffer is
    // bytes [buf_start .. buf_start+11]. buf_pos starts at buf_start+11 and each
    // digit is written with a PRE-decrement, so the rightmost digit lands at
    // buf_start+10 and the byte one-past-the-last-written is buf_start+11. The
    // length must therefore be (buf_start + 11) - buf_pos, NOT +12 — using +12
    // appended the uninitialized byte at buf_start+11 (observed as a stray 'i'
    // after the number, e.g. "17i" instead of "17"). The 0 special-case writes
    // its single byte at +11 via an early return and is unaffected; negatives
    // are also correct (e.g. -17 → buf_pos at the '-', length = 3).
    { op: "local.get", index: bufPosLocal } as Instr,
    { op: "local.get", index: bufStartLocal } as Instr,
    { op: "i32.const", value: 11 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.get", index: bufPosLocal } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "call", funcIdx: writeStringIdx } as Instr,
  );

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [
      { name: "buf_start", type: { kind: "i32" } },
      { name: "buf_pos", type: { kind: "i32" } },
      { name: "is_neg", type: { kind: "i32" } },
      { name: "abs_val", type: { kind: "i32" } },
      { name: "tmp", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * Ensure the __wasi_write_f64 helper exists and return its function index.
 *
 * #1493: when `useStderr` is true, registers/uses a `__wasi_write_f64_stderr`
 * variant that routes through the stderr i32/string helpers (fd=2).
 */
function ensureWasiWriteF64Helper(ctx: CodegenContext, useStderr: boolean = false): number {
  const helperName = useStderr ? "__wasi_write_f64_stderr" : "__wasi_write_f64";
  const writeStringHelperName = useStderr ? "__wasi_write_string_stderr" : "__wasi_write_string";

  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const writeI32Idx = ensureWasiWriteI32Helper(ctx, useStderr);
  const writeStringIdx = ctx.funcMap.get(writeStringHelperName);
  if (writeStringIdx === undefined || writeI32Idx < 0) return -1;

  // Simple f64 output: truncate to i32 and print as integer
  // For NaN, Infinity, -Infinity, handle specially
  const funcTypeIdx = addFuncType(ctx, [{ kind: "f64" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  // Allocate data segments for special values
  const nanData = wasiAllocStringData(ctx, "NaN");
  const infData = wasiAllocStringData(ctx, "Infinity");
  const negInfData = wasiAllocStringData(ctx, "-Infinity");

  const body: Instr[] = [
    // Check NaN: value != value
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.ne" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: nanData.offset } as Instr,
        { op: "i32.const", value: nanData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check positive infinity
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.const", value: Infinity } as Instr,
    { op: "f64.eq" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: infData.offset } as Instr,
        { op: "i32.const", value: infData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Check negative infinity
    { op: "local.get", index: 0 } as Instr,
    { op: "f64.const", value: -Infinity } as Instr,
    { op: "f64.eq" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: negInfData.offset } as Instr,
        { op: "i32.const", value: negInfData.length } as Instr,
        { op: "call", funcIdx: writeStringIdx } as Instr,
        { op: "return" } as Instr,
      ],
    },

    // Normal number: truncate to i32 and print
    { op: "local.get", index: 0 } as Instr,
    { op: "i32.trunc_sat_f64_s" } as Instr,
    { op: "call", funcIdx: writeI32Idx } as Instr,
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });

  return funcIdx;
}

function compileMathCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: string,
  expr: ts.CallExpression,
): ValType | null | undefined {
  // Native Wasm unary opcodes
  const nativeUnary: Record<string, string> = {
    sqrt: "f64.sqrt",
    abs: "f64.abs",
    floor: "f64.floor",
    ceil: "f64.ceil",
    trunc: "f64.trunc",
    nearest: "f64.nearest",
  };

  const f64Hint: ValType = { kind: "f64" };

  if (method === "round" && expr.arguments.length >= 1) {
    // JS Math.round: compare frac = x - floor(x) to 0.5.
    // If frac >= 0.5 use ceil(x), else floor(x). Preserves -0 via copysign.
    // This avoids precision loss from floor(x + 0.5) with large odd integers near 2^52.
    const xLocal = allocLocal(fctx, `__round_x_${fctx.locals.length}`, {
      kind: "f64",
    });
    const floorLocal = allocLocal(fctx, `__round_fl_${fctx.locals.length}`, {
      kind: "f64",
    });
    const rLocal = allocLocal(fctx, `__round_r_${fctx.locals.length}`, {
      kind: "f64",
    });
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: "local.tee", index: xLocal } as Instr);
    fctx.body.push({ op: "f64.floor" } as Instr);
    fctx.body.push({ op: "local.set", index: floorLocal } as Instr);
    // frac = x - floor(x)
    fctx.body.push({ op: "local.get", index: xLocal } as Instr);
    fctx.body.push({ op: "local.get", index: floorLocal } as Instr);
    fctx.body.push({ op: "f64.sub" } as Instr);
    // frac >= 0.5 ? ceil(x) : floor(x)
    fctx.body.push({ op: "f64.const", value: 0.5 } as Instr);
    fctx.body.push({ op: "f64.ge" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "local.get", index: xLocal } as Instr, { op: "f64.ceil" } as Instr],
      else: [{ op: "local.get", index: floorLocal } as Instr],
    } as Instr);
    fctx.body.push({ op: "local.tee", index: rLocal } as Instr);
    // If result == 0, use copysign(0, x) to preserve -0
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    fctx.body.push({ op: "f64.eq" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "f64.const", value: 0 } as Instr,
        { op: "local.get", index: xLocal } as Instr,
        { op: "f64.copysign" },
      ],
      else: [{ op: "local.get", index: rLocal } as Instr],
    } as Instr);
    return { kind: "f64" };
  }

  if (method in nativeUnary && expr.arguments.length >= 1) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: nativeUnary[method]! } as Instr);
    return { kind: "f64" };
  }

  // Math.clz32(n) → ToUint32(n) then i32.clz
  // ToUint32: NaN/±Infinity → 0; otherwise truncate then modulo 2^32.
  // We use the host-imported __toUint32 for correct edge-case handling.
  if (method === "clz32" && expr.arguments.length >= 1) {
    const toU32Idx = ctx.funcMap.get("__toUint32");
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    fctx.body.push({ op: "i32.clz" } as Instr);
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return { kind: "f64" };
  }

  // Math.imul(a, b) → ToUint32(a) * ToUint32(b), result as signed i32
  if (method === "imul" && expr.arguments.length >= 2) {
    const toU32Idx = ctx.funcMap.get("__toUint32");
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    compileExpression(ctx, fctx, expr.arguments[1]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    }
    fctx.body.push({ op: "i32.mul" } as Instr);
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    return { kind: "f64" };
  }

  if (method === "sign" && expr.arguments.length >= 1) {
    // sign(x): NaN→NaN, -0→-0, 0→0, x>0→1, x<0→-1
    // Use f64.copysign to preserve -0 and NaN passthrough:
    //   if (x !== x) return NaN  (NaN check)
    //   if (x == 0) return x     (preserves -0/+0)
    //   return x > 0 ? 1 : -1
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    const tmp = allocLocal(fctx, `__sign_${fctx.locals.length}`, {
      kind: "f64",
    });
    fctx.body.push({ op: "local.tee", index: tmp });
    // NaN check: x !== x
    fctx.body.push({ op: "local.get", index: tmp });
    fctx.body.push({ op: "f64.ne" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        // return NaN
        { op: "f64.const", value: NaN },
      ],
      else: [
        // x == 0 check (true for both +0 and -0)
        { op: "local.get", index: tmp },
        { op: "f64.abs" } as Instr,
        { op: "f64.const", value: 0 },
        { op: "f64.eq" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [
            // return x (preserves -0)
            { op: "local.get", index: tmp },
          ],
          else: [
            // return copysign(1.0, x) — gives 1 or -1 based on sign of x
            { op: "f64.const", value: 1 },
            { op: "local.get", index: tmp },
            { op: "f64.copysign" },
          ],
        },
      ],
    });
    return { kind: "f64" };
  }

  // Math.fround(x) → f64.promote_f32(f32.demote_f64(x))
  if (method === "fround" && expr.arguments.length >= 1) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: "f32.demote_f64" } as Instr);
    fctx.body.push({ op: "f64.promote_f32" } as Instr);
    return { kind: "f64" };
  }

  // Math.hypot(a, b) → sqrt(a*a + b*b) — inline for the common 2-arg case
  if (method === "hypot") {
    if (expr.arguments.length === 0) {
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }
    if (expr.arguments.length === 1) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      fctx.body.push({ op: "f64.abs" } as Instr);
      return { kind: "f64" };
    }
    // 2+ args: spec says if any arg is +-Infinity → +Infinity, else sqrt(sum of squares)
    const hypotLocals: number[] = [];
    for (let ai = 0; ai < expr.arguments.length; ai++) {
      const loc = allocLocal(fctx, `__hypot_${fctx.locals.length}`, {
        kind: "f64",
      });
      compileExpression(ctx, fctx, expr.arguments[ai]!, f64Hint);
      fctx.body.push({ op: "local.set", index: loc });
      hypotLocals.push(loc);
    }
    // Check if any arg is +-Infinity: abs(x) == +Inf
    // Build: abs(a0)==Inf || abs(a1)==Inf || ...
    for (let i = 0; i < hypotLocals.length; i++) {
      fctx.body.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      fctx.body.push({ op: "f64.abs" } as Instr);
      fctx.body.push({ op: "f64.const", value: Infinity });
      fctx.body.push({ op: "f64.eq" } as Instr);
      if (i > 0) {
        fctx.body.push({ op: "i32.or" } as Instr);
      }
    }
    // if any is Inf, return +Infinity, else sqrt(sum of squares)
    const thenBlock: Instr[] = [{ op: "f64.const", value: Infinity }];
    const elseBlock: Instr[] = [];
    for (let i = 0; i < hypotLocals.length; i++) {
      elseBlock.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      elseBlock.push({ op: "local.get", index: hypotLocals[i]! } as Instr);
      elseBlock.push({ op: "f64.mul" } as Instr);
    }
    for (let i = 1; i < hypotLocals.length; i++) {
      elseBlock.push({ op: "f64.add" } as Instr);
    }
    elseBlock.push({ op: "f64.sqrt" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: thenBlock,
      else: elseBlock,
    });
    return { kind: "f64" };
  }

  // Host-imported Math methods (1-arg): sin, cos, tan, exp, log, etc.
  const hostUnary = new Set([
    "exp",
    "log",
    "log2",
    "log10",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "acosh",
    "asinh",
    "atanh",
    "cosh",
    "sinh",
    "tanh",
    "cbrt",
    "expm1",
    "log1p",
  ]);
  if (hostUnary.has(method) && expr.arguments.length >= 1) {
    const funcIdx = ctx.funcMap.get(`Math_${method}`);
    if (funcIdx !== undefined) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Host-imported Math methods (2-arg): pow, atan2
  if ((method === "pow" || method === "atan2") && expr.arguments.length >= 2) {
    const funcIdx = ctx.funcMap.get(`Math_${method}`);
    if (funcIdx !== undefined) {
      compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      compileExpression(ctx, fctx, expr.arguments[1]!, f64Hint);
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Math.random() — 0-arg host import
  if (method === "random") {
    const funcIdx = ctx.funcMap.get("Math_random");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }

  // Math.min(...args) / Math.max(...args) — variadic with NaN propagation
  // Wasm f64.min/f64.max don't propagate NaN from the first operand in all
  // engines, so we guard each argument: if any arg is NaN, return NaN.
  // Compile-time optimization: if an arg is statically NaN, emit NaN directly.
  if ((method === "min" || method === "max") && expr.arguments) {
    const wasmOp = method === "min" ? "f64.min" : "f64.max";
    if (expr.arguments.length === 0) {
      fctx.body.push({
        op: "f64.const",
        value: method === "min" ? Infinity : -Infinity,
      } as Instr);
      return { kind: "f64" };
    }

    // Check if any argument is statically NaN → evaluate all args for side effects, then return NaN
    if (expr.arguments.some((a) => isStaticNaN(ctx, a))) {
      // Must still evaluate all arguments (ToNumber coercion / side effects)
      for (const arg of expr.arguments) {
        if (!isStaticNaN(ctx, arg)) {
          compileExpression(ctx, fctx, arg, f64Hint);
          fctx.body.push({ op: "drop" } as Instr);
        }
      }
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    // Try static valueOf resolution for each argument.
    // For object-typed arguments, tryStaticToNumber resolves {} → NaN,
    // { valueOf: () => 42 } → 42, { valueOf: () => void } → NaN, etc.
    const staticValues: (number | undefined)[] = expr.arguments.map((a) => {
      const tsType = ctx.checker.getTypeAtLocation(a);
      // Only apply static valueOf to non-number types (objects)
      if (tsType.flags & ts.TypeFlags.Object) {
        return tryStaticToNumber(ctx, a);
      }
      return undefined;
    });

    // If ALL arguments resolved statically, compute the result at compile time
    if (staticValues.every((v) => v !== undefined)) {
      const nums = staticValues as number[];
      const result = method === "min" ? nums.reduce((a, b) => Math.min(a, b)) : nums.reduce((a, b) => Math.max(a, b));
      fctx.body.push({ op: "f64.const", value: result });
      return { kind: "f64" };
    }

    // 1 arg: no f64.min needed, just return the value (or its static resolution)
    if (expr.arguments.length === 1) {
      if (staticValues[0] !== undefined) {
        fctx.body.push({ op: "f64.const", value: staticValues[0] });
      } else {
        compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
      }
      return { kind: "f64" };
    }

    // 2+ args: compile into locals, check each for NaN at runtime, then chain f64.min/max
    const argLocals: number[] = [];
    for (let ai = 0; ai < expr.arguments.length; ai++) {
      const local = allocLocal(fctx, `__minmax_${fctx.locals.length}`, {
        kind: "f64",
      });
      if (staticValues[ai] !== undefined) {
        fctx.body.push({ op: "f64.const", value: staticValues[ai]! });
      } else {
        compileExpression(ctx, fctx, expr.arguments[ai]!, f64Hint);
      }
      fctx.body.push({ op: "local.set", index: local });
      argLocals.push(local);
    }

    // Build nested if chain: for each arg, check isNaN → return it, else continue
    // Result type is f64 for each if block
    const f64Block = { kind: "val" as const, type: { kind: "f64" as const } };

    // Build from inside out: innermost is the actual f64.min/max chain
    let innerBody: Instr[] = [{ op: "local.get", index: argLocals[0]! }];
    for (let i = 1; i < argLocals.length; i++) {
      innerBody.push({ op: "local.get", index: argLocals[i]! });
      innerBody.push({ op: wasmOp });
    }

    // Wrap with NaN checks from last arg to first
    for (let i = argLocals.length - 1; i >= 0; i--) {
      innerBody = [
        // isNaN check: local.get, local.get, f64.ne (x !== x)
        { op: "local.get", index: argLocals[i]! },
        { op: "local.get", index: argLocals[i]! },
        { op: "f64.ne" } as Instr,
        {
          op: "if",
          blockType: f64Block,
          then: [{ op: "local.get", index: argLocals[i]! }],
          else: innerBody,
        } as Instr,
      ];
    }

    for (const instr of innerBody) {
      fctx.body.push(instr);
    }
    return { kind: "f64" };
  }

  // Unknown method — return undefined to let the caller fall through
  // to generic call handling. This avoids false positives when e.g.
  // Array.prototype.every.call(Math, ...) gets rewritten to Math.every(...).
  return undefined;
}

export { compileConsoleCall, compileDateMethodCall, compileMathCall, wasiAllocStringData };
