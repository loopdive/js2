// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host built-in compilation: console, Date, Math, and WASI output.
 */
import { ts } from "../../ts-api.js";
import { isBooleanType, isNumberType, isStringType } from "../../checker/type-mapper.js";
import type { Instr, ValType, WasmFunction } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import { resolveArrayInfo } from "../array-methods.js";
import { definedFuncHandleOf, mintDefinedFunc, pushDefinedFunc } from "../func-space.js"; // (#1916 S3b) stable-regime minting
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureLateImport, flushLateImportShifts } from "../expressions/late-imports.js";
import { addFuncType, ensureWasiWriteAnyStringHelper } from "../index.js";
import { emitStandaloneStdoutAppendValue, ensureNativeStringExternBridge } from "../native-strings.js";
import {
  planProgramAbiEntrySourceSupportCallable,
  PROGRAM_ABI_CALLABLE_ROLE,
  resolveProgramAbiSupportCallableHandle,
} from "../program-abi-planning.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, VOID_RESULT } from "../shared.js";
import { compileStringLiteral } from "../string-ops.js";
import { emitSymbolArgToNumberThrow } from "../tonumber-symbol-throw.js"; // (#4556)
import { emitThrowRangeError, emitThrowTypeError } from "./helpers.js";
import { isStaticNaN, tryStaticToNumber } from "./misc.js";
import { sourceOverridesMethodOnReceiver } from "./member-override-scan.js";

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

  // (#3436/#3469) Standalone mode: no JS host to receive console output, and the
  // `env.console_*` imports are deliberately NOT registered (keeps #2961's
  // import-leak gate green); there is also no `fd_write` sink (unlike WASI).
  // Instead of the original pure no-op (#3436), render each argument to a native
  // string and append it to the in-module `__stdout_acc` rope (space-separated,
  // trailing newline). The runner reads that back host-free via
  // `__stdout_prepare`/`__stdout_char`, so the test262 async completion marker
  // (`$DONE → print → console.log("Test262:AsyncTestComplete")`) is observable.
  if (ctx.standalone) {
    const appendName = "__stdout_append";
    // Append a native-string literal (arg separator / trailing newline) to the
    // sink. `__stdout_append` is re-read by name because the per-arg render
    // (`emitStandaloneStdoutAppendValue`) can insert a late import that shifts
    // every function index (#2642).
    const appendLiteral = (s: string): void => {
      compileStringLiteral(ctx, fctx, s);
      const idx = ctx.funcMap.get(appendName);
      if (idx !== undefined) fctx.body.push({ op: "call", funcIdx: idx });
    };
    if (ctx.funcMap.get(appendName) === undefined) {
      // The sink helper was not minted (native strings unavailable, or the
      // pre-body flag was not set) — fall back to the original no-op drop.
      for (const arg of expr.arguments) {
        const res = compileExpression(ctx, fctx, arg);
        if (res !== null) fctx.body.push({ op: "drop" });
      }
      return VOID_RESULT;
    }
    let first = true;
    for (const arg of expr.arguments) {
      if (!first) appendLiteral(" ");
      first = false;
      // The per-arg render (ValType dispatch + `__any_to_string`) lives in
      // native-strings.ts, the coercion-engine-sanctioned owner of that helper,
      // so this call site holds no hand-rolled coercion vocabulary (#2108 gate).
      emitStandaloneStdoutAppendValue(ctx, fctx, compileExpression(ctx, fctx, arg));
    }
    appendLiteral("\n");
    return VOID_RESULT;
  }

  for (const arg of expr.arguments) {
    const argType = ctx.checker.getTypeAtLocation(arg);

    if (isStringType(argType)) {
      compileExpression(ctx, fctx, arg);
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
      // (#2788) Coerce the argument to the console import's param ValType (i32).
      // The static-type-selected variant fixes the import signature; passing the
      // expected ValType makes compileExpression reconcile any mismatch (e.g. a
      // boxed value) to i32 rather than leaving an invalid-typed operand.
      compileExpression(ctx, fctx, arg, { kind: "i32" });
      const funcIdx = ctx.funcMap.get(`console_${method}_bool`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else if (isNumberType(argType)) {
      // (#2788) Coerce to f64 — fixes `console.log(a[i])` where the bounds-checked
      // element read (#2760) widened a `number[]` element to an `externref`
      // (OOB→undefined) but the `console_${method}_number` import expects f64.
      compileExpression(ctx, fctx, arg, { kind: "f64" });
      const funcIdx = ctx.funcMap.get(`console_${method}_number`);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
    } else {
      // externref: DOM objects, class instances, anything else.
      const res = compileExpression(ctx, fctx, arg);
      // (#2788) When `f`'s TS return type is `any` this externref variant is
      // selected, but the compiled function may return a primitive scalar
      // (f64/i32/i64) — e.g. a recursive boolean/numeric kernel whose return TS
      // can't resolve (mutual recursion → implicit any). A raw scalar operand to
      // `console_${method}_externref` (externref param) is invalid wasm, so box
      // it to externref here. Ref/externref results already match the param and
      // must NOT be re-coerced via an `expectedType` hint: that would route an
      // array through the iterable adapter (`__make_iterable`) and change the
      // printed output. Only scalars need bridging.
      if (res && typeof res === "object" && "kind" in res) {
        const k = (res as ValType).kind;
        if (k === "f64" || k === "i32" || k === "i64") {
          coerceType(ctx, fctx, res as ValType, { kind: "externref" });
        }
      }
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

const DATE_CIVIL_SUPPORT_ROLE = "date-civil-support";
const DATE_CIVIL_SUPPORT_ORDINAL = 0;
const dateCivilHelperByContext = new WeakMap<CodegenContext, WasmFunction>();

/**
 * Give the civil-date helper one structural owner and resolve its exact
 * allocator object back to the current function handle.
 *
 * The helper's stable handle is byte-compatible with untracked compilation.
 * Program ABI tracking only prevents the final retained-callable sweep from
 * assigning a second generic owner.
 */
function ownDateCivilHelper(ctx: CodegenContext, func: WasmFunction): number {
  const ref = planProgramAbiEntrySourceSupportCallable(ctx, {
    role: DATE_CIVIL_SUPPORT_ROLE,
    roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.dateCivilSupport,
    derivedOrdinal: DATE_CIVIL_SUPPORT_ORDINAL,
    displayName: func.name,
    func,
  });
  const funcIdx = resolveProgramAbiSupportCallableHandle(ctx, ref, func);
  if (funcIdx === undefined) {
    throw new Error(`${func.name} lost its exact allocator object`);
  }
  const stableHandle = definedFuncHandleOf(ctx, func);
  if (stableHandle === undefined) {
    throw new Error(`${func.name} is not present in the defined function registry`);
  }
  return stableHandle;
}

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

// ─── Packed civil-date decode (negative-year safe) ──────────────────────────
//
// `__date_civil_from_days` returns `packed = year*10000 + month*100 + day`
// with month ∈ [1,12], day ∈ [1,31] (so the low four digits `month*100+day`
// are always in [101, 1231], i.e. strictly positive). For years < 0 the whole
// packed value is negative, and Wasm's `i64.div_s` / `i64.rem_s` truncate
// toward zero — which corrupts the low digits (e.g. packed=-9899 for year -1
// gives `-9899/10000 = 0` and `-9899%100 = -99`). Spec years run from about
// -271821 to 275760 (§21.4.1.1), so negative years are reachable.
//
// The fix is floor semantics: `year = floor(packed/10000)` and
// `mmdd = packed - year*10000` (guaranteed in [101, 1231]); `month = mmdd/100`,
// `day = mmdd%100`. These emitters produce that decode given `packed` already
// on the stack (consumed) and write the requested field. They assume the value
// is `__date_civil_from_days`'s output so `mmdd` is non-negative.

/**
 * Emit `floor(packed / 10000)` (the calendar year) from a packed civil value
 * on the stack. `tmpLocal` is a scratch i64 local. Leaves the year i64 on the
 * stack.
 */
export function emitPackedYear(out: Instr[], tmpLocal: number): void {
  // tmp = packed
  out.push({ op: "local.tee", index: tmpLocal });
  // q = packed / 10000  (trunc toward zero)
  out.push({ op: "i64.const", value: 10000n }, { op: "i64.div_s" });
  // if packed < 0 and packed % 10000 != 0, subtract 1 to floor.
  // correction = (packed % 10000 != 0) && (packed < 0) ? 1 : 0
  out.push(
    // q is on the stack; compute the correction and subtract it.
    { op: "local.get", index: tmpLocal }, // packed
    { op: "i64.const", value: 10000n },
    { op: "i64.rem_s" }, // packed % 10000
    { op: "i64.const", value: 0n },
    { op: "i64.ne" }, // hasRem (i32)
    { op: "local.get", index: tmpLocal },
    { op: "i64.const", value: 0n },
    { op: "i64.lt_s" }, // isNeg (i32)
    { op: "i32.and" }, // correction (i32: 0/1)
    { op: "i64.extend_i32_s" },
    { op: "i64.sub" }, // q - correction = floor(packed/10000)
  );
}

/**
 * Emit `packed - floor(packed/10000)*10000` (the `month*100+day` low part,
 * always in [101, 1231]) from a packed civil value on the stack. `tmpLocal`
 * holds the packed value; `yearTmp` is a scratch i64 local for the floored
 * year. Leaves the `mmdd` i64 on the stack.
 */
function emitPackedMmdd(out: Instr[], tmpLocal: number, yearTmp: number): void {
  emitPackedYear(out, tmpLocal); // floor year on stack; packed in tmpLocal
  out.push({ op: "local.set", index: yearTmp });
  // mmdd = packed - year*10000
  out.push(
    { op: "local.get", index: tmpLocal },
    { op: "local.get", index: yearTmp },
    { op: "i64.const", value: 10000n },
    { op: "i64.mul" },
    { op: "i64.sub" },
  );
}

/**
 * Ensure the __date_civil_from_days helper function exists.
 * Signature: (i64 days_since_epoch) -> (i64 packed)
 *   packed = year * 10000 + month * 100 + day
 *   (month 1-12, day 1-31)
 *
 * Uses Hinnant's algorithm: http://howardhinnant.github.io/date_algorithms.html#civil_from_days
 */
export function ensureDateCivilHelper(ctx: CodegenContext): number {
  const owned = dateCivilHelperByContext.get(ctx);
  if (owned) {
    if (definedFuncHandleOf(ctx, owned) === undefined) {
      throw new Error("__date_civil_from_days lost its exact allocator object");
    }
    return ownDateCivilHelper(ctx, owned);
  }
  const installCompatibilityAlias = !ctx.funcMap.has("__date_civil_from_days");

  // func (param $z i64) (result i64)
  // locals: $z(0), $era(1), $doe(2), $yoe(3), $doy(4), $mp(5), $y(6), $m(7), $d(8)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i64" }], [{ kind: "i64" }]);
  const funcIdx = mintDefinedFunc(ctx);
  if (installCompatibilityAlias) {
    ctx.funcMap.set("__date_civil_from_days", funcIdx);
  }

  const body: Instr[] = [];

  // z += 719468  (shift epoch from 1970-01-01 to 0000-03-01)
  body.push(
    { op: "local.get", index: 0 },
    { op: "i64.const", value: 719468n },
    { op: "i64.add" },
    { op: "local.set", index: 0 },
  );

  // era = (z >= 0 ? z : z - 146096) / 146097
  // We use i64.div_s which floors toward zero, so we need the adjustment
  body.push(
    { op: "local.get", index: 0 },
    { op: "i64.const", value: 0n },
    { op: "i64.ge_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 0 }],
      else: [{ op: "local.get", index: 0 }, { op: "i64.const", value: 146096n }, { op: "i64.sub" }],
    },
    { op: "i64.const", value: 146097n },
    { op: "i64.div_s" },
    { op: "local.set", index: 1 }, // era
  );

  // doe = z - era * 146097  (day of era, [0, 146096])
  body.push(
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "i64.const", value: 146097n },
    { op: "i64.mul" },
    { op: "i64.sub" },
    { op: "local.set", index: 2 }, // doe
  );

  // yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365
  body.push(
    { op: "local.get", index: 2 }, // doe
    { op: "local.get", index: 2 },
    { op: "i64.const", value: 1460n },
    { op: "i64.div_s" },
    { op: "i64.sub" },
    { op: "local.get", index: 2 },
    { op: "i64.const", value: 36524n },
    { op: "i64.div_s" },
    { op: "i64.add" },
    { op: "local.get", index: 2 },
    { op: "i64.const", value: 146096n },
    { op: "i64.div_s" },
    { op: "i64.sub" },
    { op: "i64.const", value: 365n },
    { op: "i64.div_s" },
    { op: "local.set", index: 3 }, // yoe
  );

  // y = yoe + era * 400
  body.push(
    { op: "local.get", index: 3 },
    { op: "local.get", index: 1 },
    { op: "i64.const", value: 400n },
    { op: "i64.mul" },
    { op: "i64.add" },
    { op: "local.set", index: 6 }, // y (still March-based)
  );

  // doy = doe - (365*yoe + yoe/4 - yoe/100)
  body.push(
    { op: "local.get", index: 2 }, // doe
    { op: "i64.const", value: 365n },
    { op: "local.get", index: 3 },
    { op: "i64.mul" },
    { op: "local.get", index: 3 },
    { op: "i64.const", value: 4n },
    { op: "i64.div_s" },
    { op: "i64.add" },
    { op: "local.get", index: 3 },
    { op: "i64.const", value: 100n },
    { op: "i64.div_s" },
    { op: "i64.sub" },
    { op: "i64.sub" },
    { op: "local.set", index: 4 }, // doy
  );

  // mp = (5*doy + 2) / 153
  body.push(
    { op: "i64.const", value: 5n },
    { op: "local.get", index: 4 },
    { op: "i64.mul" },
    { op: "i64.const", value: 2n },
    { op: "i64.add" },
    { op: "i64.const", value: 153n },
    { op: "i64.div_s" },
    { op: "local.set", index: 5 }, // mp
  );

  // d = doy - (153*mp + 2)/5 + 1
  body.push(
    { op: "local.get", index: 4 },
    { op: "i64.const", value: 153n },
    { op: "local.get", index: 5 },
    { op: "i64.mul" },
    { op: "i64.const", value: 2n },
    { op: "i64.add" },
    { op: "i64.const", value: 5n },
    { op: "i64.div_s" },
    { op: "i64.sub" },
    { op: "i64.const", value: 1n },
    { op: "i64.add" },
    { op: "local.set", index: 8 }, // d
  );

  // m = mp < 10 ? mp + 3 : mp - 9
  body.push(
    { op: "local.get", index: 5 },
    { op: "i64.const", value: 10n },
    { op: "i64.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 5 }, { op: "i64.const", value: 3n }, { op: "i64.add" }],
      else: [{ op: "local.get", index: 5 }, { op: "i64.const", value: 9n }, { op: "i64.sub" }],
    },
    { op: "local.set", index: 7 }, // m (1-12)
  );

  // y += (m <= 2) ? 1 : 0
  body.push(
    { op: "local.get", index: 6 },
    { op: "local.get", index: 7 },
    { op: "i64.const", value: 2n },
    { op: "i64.le_s" },
    { op: "i64.extend_i32_s" },
    { op: "i64.add" },
    { op: "local.set", index: 6 }, // y (adjusted)
  );

  // return y * 10000 + m * 100 + d
  body.push(
    { op: "local.get", index: 6 },
    { op: "i64.const", value: 10000n },
    { op: "i64.mul" },
    { op: "local.get", index: 7 },
    { op: "i64.const", value: 100n },
    { op: "i64.mul" },
    { op: "i64.add" },
    { op: "local.get", index: 8 },
    { op: "i64.add" },
  );

  const func: WasmFunction = {
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
  };
  pushDefinedFunc(ctx, funcIdx, func);
  dateCivilHelperByContext.set(ctx, func);

  return ownDateCivilHelper(ctx, func);
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
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__date_days_from_civil", funcIdx);

  const body: Instr[] = [];

  // y -= (m <= 2) ? 1 : 0
  body.push(
    { op: "local.get", index: 0 }, // y
    { op: "local.get", index: 1 }, // m
    { op: "i64.const", value: 2n },
    { op: "i64.le_s" },
    { op: "i64.extend_i32_s" },
    { op: "i64.sub" },
    { op: "local.set", index: 0 }, // y adjusted
  );

  // era = (y >= 0 ? y : y - 399) / 400
  body.push(
    { op: "local.get", index: 0 },
    { op: "i64.const", value: 0n },
    { op: "i64.ge_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 0 }],
      else: [{ op: "local.get", index: 0 }, { op: "i64.const", value: 399n }, { op: "i64.sub" }],
    },
    { op: "i64.const", value: 400n },
    { op: "i64.div_s" },
    { op: "local.set", index: 3 }, // era
  );

  // yoe = y - era * 400
  body.push(
    { op: "local.get", index: 0 },
    { op: "local.get", index: 3 },
    { op: "i64.const", value: 400n },
    { op: "i64.mul" },
    { op: "i64.sub" },
    { op: "local.set", index: 4 }, // yoe
  );

  // doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1
  body.push(
    { op: "i64.const", value: 153n },
    { op: "local.get", index: 1 }, // m
    { op: "i64.const", value: 2n },
    { op: "i64.gt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 1 }, { op: "i64.const", value: 3n }, { op: "i64.sub" }],
      else: [{ op: "local.get", index: 1 }, { op: "i64.const", value: 9n }, { op: "i64.add" }],
    },
    { op: "i64.mul" },
    { op: "i64.const", value: 2n },
    { op: "i64.add" },
    { op: "i64.const", value: 5n },
    { op: "i64.div_s" },
    { op: "local.get", index: 2 }, // d
    { op: "i64.add" },
    { op: "i64.const", value: 1n },
    { op: "i64.sub" },
    { op: "local.set", index: 5 }, // doy
  );

  // doe = yoe * 365 + yoe/4 - yoe/100 + doy
  body.push(
    { op: "local.get", index: 4 }, // yoe
    { op: "i64.const", value: 365n },
    { op: "i64.mul" },
    { op: "local.get", index: 4 },
    { op: "i64.const", value: 4n },
    { op: "i64.div_s" },
    { op: "i64.add" },
    { op: "local.get", index: 4 },
    { op: "i64.const", value: 100n },
    { op: "i64.div_s" },
    { op: "i64.sub" },
    { op: "local.get", index: 5 },
    { op: "i64.add" },
    { op: "local.set", index: 6 }, // doe
  );

  // return era * 146097 + doe - 719468
  body.push(
    { op: "local.get", index: 3 }, // era
    { op: "i64.const", value: 146097n },
    { op: "i64.mul" },
    { op: "local.get", index: 6 }, // doe
    { op: "i64.add" },
    { op: "i64.const", value: 719468n },
    { op: "i64.sub" },
  );

  pushDefinedFunc(ctx, funcIdx, {
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
 * Ensure the `__date_iso_string(ts: i64) -> ref $NativeString` helper exists.
 *
 * Builds the ECMA-262 §21.4.4.36 Date Time String Format
 *   `YYYY-MM-DDTHH:mm:ss.sssZ`   (years 0..9999)
 *   `±YYYYYY-MM-DDTHH:mm:ss.sssZ` (extended years <0 or >9999, §21.4.1.18)
 * purely in Wasm from a millisecond timestamp, so standalone / nativeStrings
 * modes (no JS host, no `__date_format` import) can produce a correct
 * `toISOString()` / `toJSON()` result (#2164). The caller is responsible for
 * guarding an Invalid-Date receiver before invoking this helper.
 *
 * The buffer is a fixed 27-element i16 array; the helper writes into it with a
 * moving cursor and returns a `$NativeString(len, off=0, data)` whose `len` is
 * the actual number of code units written (24 for the common 4-digit year, 27
 * for the extended ±6-digit form). Trailing slots past `len` are never read.
 */
export function ensureDateIsoStringHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__date_iso_string");
  if (existing !== undefined) return existing;

  const MS_PER_DAY = 86400000n;
  const civilIdx = ensureDateCivilHelper(ctx);
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const dataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  // func (param $ts i64) (result ref $NativeString)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i64" }], [{ kind: "ref", typeIdx: strTypeIdx }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__date_iso_string", funcIdx);

  // Locals (param $ts = 0):
  //  1 $buf  (ref $strData)   target i16 array
  //  2 $pos  (i32)            write cursor
  //  3 $packed (i64)          year*10000 + month*100 + day
  //  4 $year (i64)
  //  5 $msOfDay (i64)         [0, 86399999]
  //  6 $days (i64)            floor(ts / MS_PER_DAY)
  //  7 $tmp  (i64)            scratch for digit extraction
  const L_BUF = 1,
    L_POS = 2,
    L_PACKED = 3,
    L_YEAR = 4,
    L_MSDAY = 5,
    L_DAYS = 6,
    L_TMP = 7;
  const body: Instr[] = [];

  // buf = array.new_default(27)
  body.push(
    { op: "i32.const", value: 27 },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_BUF },
  );
  // pos = 0
  body.push({ op: "i32.const", value: 0 }, { op: "local.set", index: L_POS });

  // days = floor(ts / MS_PER_DAY)  (floor division, ts may be negative)
  body.push(
    { op: "local.get", index: 0 },
    { op: "i64.const", value: 0n },
    { op: "i64.ge_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 0 }, { op: "i64.const", value: MS_PER_DAY }, { op: "i64.div_s" }],
      else: [
        { op: "local.get", index: 0 },
        { op: "i64.const", value: MS_PER_DAY - 1n },
        { op: "i64.sub" },
        { op: "i64.const", value: MS_PER_DAY },
        { op: "i64.div_s" },
      ],
    },
    { op: "local.set", index: L_DAYS },
  );

  // msOfDay = ts - days * MS_PER_DAY   (always in [0, MS_PER_DAY) given floored days)
  body.push(
    { op: "local.get", index: 0 },
    { op: "local.get", index: L_DAYS },
    { op: "i64.const", value: MS_PER_DAY },
    { op: "i64.mul" },
    { op: "i64.sub" },
    { op: "local.set", index: L_MSDAY },
  );

  // packed = civil_from_days(days); year = floor(packed / 10000). Negative-year
  // safe: replace $packed with the always-positive low part (month*100+day)
  // so the month/day extraction below works with plain truncating div/rem.
  body.push(
    { op: "local.get", index: L_DAYS },
    { op: "call", funcIdx: civilIdx },
    { op: "local.set", index: L_PACKED },
  );
  // year = floor(packed / 10000)  (uses L_TMP as scratch)
  body.push({ op: "local.get", index: L_PACKED });
  emitPackedYear(body, L_TMP);
  body.push({ op: "local.set", index: L_YEAR });
  // packed = packed - year*10000  (month*100+day, always positive)
  body.push(
    { op: "local.get", index: L_PACKED },
    { op: "local.get", index: L_YEAR },
    { op: "i64.const", value: 10000n },
    { op: "i64.mul" },
    { op: "i64.sub" },
    { op: "local.set", index: L_PACKED },
  );

  /**
   * Emit `buf[pos] = ch; pos += 1` for a literal ASCII code unit.
   */
  const writeChar = (ch: number): void => {
    body.push(
      { op: "local.get", index: L_BUF },
      { op: "local.get", index: L_POS },
      { op: "i32.const", value: ch },
      { op: "array.set", typeIdx: strDataTypeIdx },
      { op: "local.get", index: L_POS },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: L_POS },
    );
  };

  /**
   * Write `width` decimal digits of the absolute value held in i64 local
   * `srcLocal`, right-aligned with leading zeros, starting at `pos`. Uses
   * `L_TMP` as scratch and advances `pos` by `width`. The value is assumed
   * non-negative (callers pass abs()).
   */
  const writeDigits = (srcLocal: number, width: number): void => {
    // For each digit position d from most- to least-significant, compute
    // (value / 10^(width-1-d)) % 10 and store '0' + digit.
    for (let d = 0; d < width; d++) {
      const div = 10n ** BigInt(width - 1 - d);
      body.push({ op: "local.get", index: L_BUF }, { op: "local.get", index: L_POS });
      // digit = (src / div) % 10
      body.push({ op: "local.get", index: srcLocal });
      if (div !== 1n) {
        body.push({ op: "i64.const", value: div }, { op: "i64.div_s" });
      }
      body.push(
        { op: "i64.const", value: 10n },
        { op: "i64.rem_s" },
        { op: "i32.wrap_i64" },
        { op: "i32.const", value: 0x30 }, // '0'
        { op: "i32.add" },
        { op: "array.set", typeIdx: strDataTypeIdx },
      );
      // pos += 1
      body.push(
        { op: "local.get", index: L_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: L_POS },
      );
    }
  };

  // --- Year field ---
  // If 0 <= year <= 9999: 4 digits. Else: sign + 6 digits (extended form).
  body.push(
    { op: "local.get", index: L_YEAR },
    { op: "i64.const", value: 0n },
    { op: "i64.ge_s" },
    { op: "local.get", index: L_YEAR },
    { op: "i64.const", value: 9999n },
    { op: "i64.le_s" },
    { op: "i32.and" },
  );
  // The year width depends on a runtime branch, so the two digit-writing
  // sequences are precomputed into separate arrays and emitted as the then/else
  // arms of an `if`.
  const buf4: Instr[] = [];
  const buf4Push = (...is: Instr[]) => buf4.push(...is);
  // 4-digit: writeDigits(year, 4) replicated inline into buf4.
  for (let d = 0; d < 4; d++) {
    const div = 10n ** BigInt(3 - d);
    buf4Push({ op: "local.get", index: L_BUF }, { op: "local.get", index: L_POS }, { op: "local.get", index: L_YEAR });
    if (div !== 1n) buf4Push({ op: "i64.const", value: div }, { op: "i64.div_s" });
    buf4Push(
      { op: "i64.const", value: 10n },
      { op: "i64.rem_s" },
      { op: "i32.wrap_i64" },
      { op: "i32.const", value: 0x30 },
      { op: "i32.add" },
      { op: "array.set", typeIdx: strDataTypeIdx },
      { op: "local.get", index: L_POS },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: L_POS },
    );
  }
  // extended: sign char + abs(year) into L_TMP, 6 digits
  const buf6: Instr[] = [];
  // sign = year < 0 ? '-' : '+'
  buf6.push(
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "local.get", index: L_YEAR },
    { op: "i64.const", value: 0n },
    { op: "i64.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0x2d }], // '-'
      else: [{ op: "i32.const", value: 0x2b }], // '+'
    },
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: L_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: L_POS },
  );
  // tmp = abs(year) = (year < 0) ? -year : year
  // select(a, b, cond) returns `a` when cond != 0, else `b`. So a = -year
  // (used when year < 0), b = year (used when year >= 0).
  buf6.push(
    { op: "i64.const", value: 0n }, // a: 0 - year ...
    { op: "local.get", index: L_YEAR },
    { op: "i64.sub" }, //                  ... = -year
    { op: "local.get", index: L_YEAR }, // b: year
    { op: "local.get", index: L_YEAR }, // cond: year < 0
    { op: "i64.const", value: 0n },
    { op: "i64.lt_s" },
    { op: "select" },
    { op: "local.set", index: L_TMP },
  );
  for (let d = 0; d < 6; d++) {
    const div = 10n ** BigInt(5 - d);
    buf6.push({ op: "local.get", index: L_BUF }, { op: "local.get", index: L_POS }, { op: "local.get", index: L_TMP });
    if (div !== 1n) buf6.push({ op: "i64.const", value: div }, { op: "i64.div_s" });
    buf6.push(
      { op: "i64.const", value: 10n },
      { op: "i64.rem_s" },
      { op: "i32.wrap_i64" },
      { op: "i32.const", value: 0x30 },
      { op: "i32.add" },
      { op: "array.set", typeIdx: strDataTypeIdx },
      { op: "local.get", index: L_POS },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: L_POS },
    );
  }
  body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: buf4,
    else: buf6,
  });

  // month (1-12): packed/100 % 100 -> tmp, 2 digits
  body.push(
    { op: "local.get", index: L_PACKED },
    { op: "i64.const", value: 100n },
    { op: "i64.div_s" },
    { op: "i64.const", value: 100n },
    { op: "i64.rem_s" },
    { op: "local.set", index: L_TMP },
  );
  writeChar(0x2d); // '-'
  writeDigits(L_TMP, 2);

  // day: packed % 100 -> tmp, 2 digits
  body.push(
    { op: "local.get", index: L_PACKED },
    { op: "i64.const", value: 100n },
    { op: "i64.rem_s" },
    { op: "local.set", index: L_TMP },
  );
  writeChar(0x2d); // '-'
  writeDigits(L_TMP, 2);

  writeChar(0x54); // 'T'

  // hours = msOfDay / 3600000
  body.push(
    { op: "local.get", index: L_MSDAY },
    { op: "i64.const", value: 3600000n },
    { op: "i64.div_s" },
    { op: "local.set", index: L_TMP },
  );
  writeDigits(L_TMP, 2);
  writeChar(0x3a); // ':'

  // minutes = (msOfDay / 60000) % 60
  body.push(
    { op: "local.get", index: L_MSDAY },
    { op: "i64.const", value: 60000n },
    { op: "i64.div_s" },
    { op: "i64.const", value: 60n },
    { op: "i64.rem_s" },
    { op: "local.set", index: L_TMP },
  );
  writeDigits(L_TMP, 2);
  writeChar(0x3a); // ':'

  // seconds = (msOfDay / 1000) % 60
  body.push(
    { op: "local.get", index: L_MSDAY },
    { op: "i64.const", value: 1000n },
    { op: "i64.div_s" },
    { op: "i64.const", value: 60n },
    { op: "i64.rem_s" },
    { op: "local.set", index: L_TMP },
  );
  writeDigits(L_TMP, 2);
  writeChar(0x2e); // '.'

  // milliseconds = msOfDay % 1000
  body.push(
    { op: "local.get", index: L_MSDAY },
    { op: "i64.const", value: 1000n },
    { op: "i64.rem_s" },
    { op: "local.set", index: L_TMP },
  );
  writeDigits(L_TMP, 3);
  writeChar(0x5a); // 'Z'

  // return struct.new $NativeString(len = pos, off = 0, data = buf)
  body.push(
    { op: "local.get", index: L_POS },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: L_BUF },
    { op: "struct.new", typeIdx: strTypeIdx },
  );

  pushDefinedFunc(ctx, funcIdx, {
    name: "__date_iso_string",
    typeIdx: funcTypeIdx,
    locals: [
      { name: "$buf", type: dataRef },
      { name: "$pos", type: { kind: "i32" } },
      { name: "$packed", type: { kind: "i64" } },
      { name: "$year", type: { kind: "i64" } },
      { name: "$msOfDay", type: { kind: "i64" } },
      { name: "$days", type: { kind: "i64" } },
      { name: "$tmp", type: { kind: "i64" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/** Three-letter weekday abbreviations, index 0 = Sunday (ECMA-262 §21.4.4.41.4). */
const DATE_WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** Three-letter month abbreviations, index 0 = January. */
const DATE_MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * (#2164 — formatters slice) Ensure the
 * `__date_format_string(ts: i64, mode: i32) -> ref $NativeString` helper exists.
 *
 * Builds the non-ISO Date string formats purely in Wasm so standalone /
 * nativeStrings modes (no JS host, no `__date_format` import) produce
 * spec-correct results instead of the prior hard-coded placeholder. Standalone
 * has no timezone database, so every format is rendered in **UTC** (matching the
 * deterministic-clock decision in slice 1 and the UTC-for-local Date.parse in
 * slice 2). `mode` selects the format:
 *
 *   1 toUTCString / toGMTString : `WkDay, DD Mon YYYY HH:mm:ss GMT`  (§21.4.4.43)
 *   2 toString                  : `WkDay Mon DD YYYY HH:mm:ss GMT+0000 (Coordinated Universal Time)`
 *   3 toDateString              : `WkDay Mon DD YYYY`                (§21.4.4.35)
 *   4 toTimeString              : `HH:mm:ss GMT+0000 (Coordinated Universal Time)`
 *   6 toLocaleString            : same as mode 2 (locale-independent fallback)
 *   7 toLocaleDateString        : same as mode 3
 *   8 toLocaleTimeString        : `HH:mm:ss` (no GMT suffix — common Intl-free shape)
 *
 * The caller guards an Invalid-Date receiver before invoking (those modes return
 * the literal `"Invalid Date"` upstream — handled at the call site). Year is
 * rendered with the §21.4.1.18 extended ±6-digit form for years <0 / >9999, else
 * 4 digits (with a `-` sign and no zero-pad widening for negative non-extended is
 * not reachable: civil years are calendar years). Returns
 * `$NativeString(len, off=0, data)`; the buffer is sized for the longest format.
 */
export function ensureDateFormatStringHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__date_format_string");
  if (existing !== undefined) return existing;

  const MS_PER_DAY = 86400000n;
  const civilIdx = ensureDateCivilHelper(ctx);
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const dataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  // func (param $ts i64) (param $mode i32) (result ref $NativeString)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i64" }, { kind: "i32" }], [{ kind: "ref", typeIdx: strTypeIdx }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__date_format_string", funcIdx);

  // Param 0 $ts (i64), param 1 $mode (i32). Locals:
  const L_BUF = 2, // ref $strData target i16 array
    L_POS = 3, // i32 write cursor
    L_PACKED = 4, // i64 year*10000 + month*100 + day
    L_YEAR = 5, // i64
    L_MSDAY = 6, // i64 [0, 86399999]
    L_DAYS = 7, // i64 floor(ts / MS_PER_DAY)
    L_TMP = 8, // i64 scratch (digit extraction)
    L_DOW = 9, // i32 day-of-week 0..6 (0 = Sunday)
    L_I32 = 10; // i32 scratch (month index / weekday index)
  const body: Instr[] = [];

  // Buffer sized for the longest format (toString ~ 64 code units). 72 is safe.
  body.push(
    { op: "i32.const", value: 72 },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_BUF },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_POS },
  );

  // days = floor(ts / MS_PER_DAY)  (floor division, ts may be negative)
  body.push(
    { op: "local.get", index: 0 },
    { op: "i64.const", value: 0n },
    { op: "i64.ge_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: [{ op: "local.get", index: 0 }, { op: "i64.const", value: MS_PER_DAY }, { op: "i64.div_s" }],
      else: [
        { op: "local.get", index: 0 },
        { op: "i64.const", value: MS_PER_DAY - 1n },
        { op: "i64.sub" },
        { op: "i64.const", value: MS_PER_DAY },
        { op: "i64.div_s" },
      ],
    },
    { op: "local.set", index: L_DAYS },
  );

  // msOfDay = ts - days * MS_PER_DAY
  body.push(
    { op: "local.get", index: 0 },
    { op: "local.get", index: L_DAYS },
    { op: "i64.const", value: MS_PER_DAY },
    { op: "i64.mul" },
    { op: "i64.sub" },
    { op: "local.set", index: L_MSDAY },
  );

  // packed = civil_from_days(days); year = floor(packed / 10000). Negative-year
  // safe: replace $packed with the always-positive low part (month*100+day) so
  // the setMonthIdx/setDay extractions below work with truncating div/rem.
  body.push(
    { op: "local.get", index: L_DAYS },
    { op: "call", funcIdx: civilIdx },
    { op: "local.set", index: L_PACKED },
  );
  // year = floor(packed / 10000)  (uses L_TMP as scratch)
  body.push({ op: "local.get", index: L_PACKED });
  emitPackedYear(body, L_TMP);
  body.push({ op: "local.set", index: L_YEAR });
  // packed = packed - year*10000  (month*100+day, always positive)
  body.push(
    { op: "local.get", index: L_PACKED },
    { op: "local.get", index: L_YEAR },
    { op: "i64.const", value: 10000n },
    { op: "i64.mul" },
    { op: "i64.sub" },
    { op: "local.set", index: L_PACKED },
  );

  // dow = ((days % 7) + 4 + 7) % 7   (epoch day 0 = Thursday = 4)
  body.push(
    { op: "local.get", index: L_DAYS },
    { op: "i64.const", value: 7n },
    { op: "i64.rem_s" },
    { op: "i32.wrap_i64" },
    { op: "i32.const", value: 4 + 7 },
    { op: "i32.add" },
    { op: "i32.const", value: 7 },
    { op: "i32.rem_s" },
    { op: "local.set", index: L_DOW },
  );

  const writeChar = (ch: number): void => {
    body.push(
      { op: "local.get", index: L_BUF },
      { op: "local.get", index: L_POS },
      { op: "i32.const", value: ch },
      { op: "array.set", typeIdx: strDataTypeIdx },
      { op: "local.get", index: L_POS },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: L_POS },
    );
  };
  const writeLiteral = (s: string): void => {
    for (const ch of s) writeChar(ch.charCodeAt(0));
  };
  // Write `width` decimal digits of the non-negative i64 in `srcLocal`.
  const writeDigits = (srcLocal: number, width: number): void => {
    for (let d = 0; d < width; d++) {
      const div = 10n ** BigInt(width - 1 - d);
      body.push({ op: "local.get", index: L_BUF }, { op: "local.get", index: L_POS });
      body.push({ op: "local.get", index: srcLocal });
      if (div !== 1n) body.push({ op: "i64.const", value: div }, { op: "i64.div_s" });
      body.push(
        { op: "i64.const", value: 10n },
        { op: "i64.rem_s" },
        { op: "i32.wrap_i64" },
        { op: "i32.const", value: 0x30 },
        { op: "i32.add" },
        { op: "array.set", typeIdx: strDataTypeIdx },
        { op: "local.get", index: L_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: L_POS },
      );
    }
  };
  // Emit an if/else chain selecting one of `names` by the i32 in `idxLocal`,
  // writing the chosen 3-letter abbreviation. Implemented as nested ifs so it
  // works without a br_table.
  const writeAbbrByIndex = (idxLocal: number, names: readonly string[]): void => {
    // Emit `buf[pos++] = ch` for each char of `s` into an explicit Instr[].
    const litInstrs = (s: string): Instr[] => {
      const out: Instr[] = [];
      for (const ch of s) {
        out.push(
          { op: "local.get", index: L_BUF },
          { op: "local.get", index: L_POS },
          { op: "i32.const", value: ch.charCodeAt(0) },
          { op: "array.set", typeIdx: strDataTypeIdx },
          { op: "local.get", index: L_POS },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: L_POS },
        );
      }
      return out;
    };
    // Build the if-chain from the last index backwards so the innermost else is
    // index 0 (the default abbreviation).
    let chain: Instr[] = litInstrs(names[0]!);
    for (let i = 1; i < names.length; i++) {
      chain = [
        { op: "local.get", index: idxLocal },
        { op: "i32.const", value: i },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: litInstrs(names[i]!), else: chain },
      ];
    }
    body.push(...chain);
  };

  // Field extraction into scratch locals shared by the format builders.
  const setMonthIdx = (): void => {
    // monthIdx (0..11) = packed/100 % 100 - 1
    body.push(
      { op: "local.get", index: L_PACKED },
      { op: "i64.const", value: 100n },
      { op: "i64.div_s" },
      { op: "i64.const", value: 100n },
      { op: "i64.rem_s" },
      { op: "i64.const", value: 1n },
      { op: "i64.sub" },
      { op: "i32.wrap_i64" },
      { op: "local.set", index: L_I32 },
    );
  };
  const setDay = (): void => {
    body.push(
      { op: "local.get", index: L_PACKED },
      { op: "i64.const", value: 100n },
      { op: "i64.rem_s" },
      { op: "local.set", index: L_TMP },
    );
  };
  const writeYear = (): void => {
    // Human-readable formatters (toString/toUTCString/toDateString) render the
    // year as a sign-prefixed, minimum-4-digit decimal: V8 emits `-0001` for
    // year -1, `0099` for year 99, `9999`/`10000`/`275760` at natural width
    // for larger magnitudes — NOT the fixed ±6-digit ISO extended form (that
    // is only for toISOString, §21.4.1.18). So: write `-` when year < 0, then
    // abs(year) zero-padded to ≥4 digits (5 digits for |year| 10000..99999,
    // 6 digits for ≥100000).
    //
    // Emit `-` if year < 0.
    body.push(
      { op: "local.get", index: L_YEAR },
      { op: "i64.const", value: 0n },
      { op: "i64.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: L_BUF },
          { op: "local.get", index: L_POS },
          { op: "i32.const", value: 0x2d }, // '-'
          { op: "array.set", typeIdx: strDataTypeIdx },
          { op: "local.get", index: L_POS },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: L_POS },
        ],
      },
    );
    // L_TMP = abs(year)
    body.push(
      { op: "i64.const", value: 0n },
      { op: "local.get", index: L_YEAR },
      { op: "i64.sub" }, // -year
      { op: "local.get", index: L_YEAR }, // year
      { op: "local.get", index: L_YEAR },
      { op: "i64.const", value: 0n },
      { op: "i64.lt_s" }, // year < 0 ?
      { op: "select" }, // abs(year)
      { op: "local.set", index: L_TMP },
    );
    // Choose width: 4 (|y|<=9999), 5 (<=99999), else 6 (spec max year 275760).
    const writeWidth = (w: number): Instr[] => {
      const out: Instr[] = [];
      for (let d = 0; d < w; d++) {
        const div = 10n ** BigInt(w - 1 - d);
        out.push(
          { op: "local.get", index: L_BUF },
          { op: "local.get", index: L_POS },
          { op: "local.get", index: L_TMP },
        );
        if (div !== 1n) out.push({ op: "i64.const", value: div }, { op: "i64.div_s" });
        out.push(
          { op: "i64.const", value: 10n },
          { op: "i64.rem_s" },
          { op: "i32.wrap_i64" },
          { op: "i32.const", value: 0x30 },
          { op: "i32.add" },
          { op: "array.set", typeIdx: strDataTypeIdx },
          { op: "local.get", index: L_POS },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: L_POS },
        );
      }
      return out;
    };
    // if abs <= 9999: 4 digits; else if abs <= 99999: 5 digits; else 6 digits.
    body.push(
      { op: "local.get", index: L_TMP },
      { op: "i64.const", value: 9999n },
      { op: "i64.le_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: writeWidth(4),
        else: [
          { op: "local.get", index: L_TMP },
          { op: "i64.const", value: 99999n },
          { op: "i64.le_s" },
          { op: "if", blockType: { kind: "empty" }, then: writeWidth(5), else: writeWidth(6) },
        ],
      },
    );
  };
  // hh:mm:ss into the buffer.
  const writeTimeHMS = (): void => {
    // hours = msOfDay / 3600000
    body.push(
      { op: "local.get", index: L_MSDAY },
      { op: "i64.const", value: 3600000n },
      { op: "i64.div_s" },
      { op: "local.set", index: L_TMP },
    );
    writeDigits(L_TMP, 2);
    writeChar(0x3a);
    body.push(
      { op: "local.get", index: L_MSDAY },
      { op: "i64.const", value: 60000n },
      { op: "i64.div_s" },
      { op: "i64.const", value: 60n },
      { op: "i64.rem_s" },
      { op: "local.set", index: L_TMP },
    );
    writeDigits(L_TMP, 2);
    writeChar(0x3a);
    body.push(
      { op: "local.get", index: L_MSDAY },
      { op: "i64.const", value: 1000n },
      { op: "i64.div_s" },
      { op: "i64.const", value: 60n },
      { op: "i64.rem_s" },
      { op: "local.set", index: L_TMP },
    );
    writeDigits(L_TMP, 2);
  };

  // Each mode's byte sequence is built into its own arm, then dispatched by an
  // if-chain on $mode. Building per-mode keeps each format independent.
  const buildArm = (mode: number): Instr[] => {
    // The writer closures append to the shared `body`. Snapshot the current
    // length, run the builders, then splice off exactly what they appended so
    // each mode's instructions go into their own `if`-arm (not the main body).
    const start = body.length;
    switch (mode) {
      case 1: // toUTCString: "WkDay, DD Mon YYYY HH:mm:ss GMT"
        writeAbbrByIndex(L_DOW, DATE_WEEKDAY_ABBR);
        writeLiteral(", ");
        setDay();
        writeDigits(L_TMP, 2);
        writeChar(0x20);
        setMonthIdx();
        writeAbbrByIndex(L_I32, DATE_MONTH_ABBR);
        writeChar(0x20);
        writeYear();
        writeChar(0x20);
        writeTimeHMS();
        writeLiteral(" GMT");
        break;
      case 3: // toDateString: "WkDay Mon DD YYYY"
      case 7: // toLocaleDateString → same
        writeAbbrByIndex(L_DOW, DATE_WEEKDAY_ABBR);
        writeChar(0x20);
        setMonthIdx();
        writeAbbrByIndex(L_I32, DATE_MONTH_ABBR);
        writeChar(0x20);
        setDay();
        writeDigits(L_TMP, 2);
        writeChar(0x20);
        writeYear();
        break;
      case 4: // toTimeString: "HH:mm:ss GMT+0000 (Coordinated Universal Time)"
        writeTimeHMS();
        writeLiteral(" GMT+0000 (Coordinated Universal Time)");
        break;
      case 8: // toLocaleTimeString: "HH:mm:ss"
        writeTimeHMS();
        break;
      default: // 2 toString, 6 toLocaleString: date + " " + time + tz
        writeAbbrByIndex(L_DOW, DATE_WEEKDAY_ABBR);
        writeChar(0x20);
        setMonthIdx();
        writeAbbrByIndex(L_I32, DATE_MONTH_ABBR);
        writeChar(0x20);
        setDay();
        writeDigits(L_TMP, 2);
        writeChar(0x20);
        writeYear();
        writeChar(0x20);
        writeTimeHMS();
        writeLiteral(" GMT+0000 (Coordinated Universal Time)");
        break;
    }
    return body.splice(start);
  };

  // Dispatch: nested ifs on $mode. Order: 1,3,7,4,8 then default (2/6).
  const armUTC = buildArm(1);
  const armDate = buildArm(3);
  const armTime = buildArm(4);
  const armLocaleTime = buildArm(8);
  const armDefault = buildArm(2);

  const eqMode = (m: number): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "i32.const", value: m },
    { op: "i32.eq" },
  ];
  // if mode==1 -> UTC
  // elif mode==3||7 -> Date
  // elif mode==4 -> Time
  // elif mode==8 -> LocaleTime
  // else -> default (2/6)
  const dateChain: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 3 },
    { op: "i32.eq" },
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 7 },
    { op: "i32.eq" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: armDate,
      else: [
        ...eqMode(4),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: armTime,
          else: [
            ...eqMode(8),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: armLocaleTime,
              else: armDefault,
            },
          ],
        },
      ],
    },
  ];
  body.push(...eqMode(1), {
    op: "if",
    blockType: { kind: "empty" },
    then: armUTC,
    else: dateChain,
  });

  // return struct.new $NativeString(len = pos, off = 0, data = buf)
  body.push(
    { op: "local.get", index: L_POS },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: L_BUF },
    { op: "struct.new", typeIdx: strTypeIdx },
  );

  pushDefinedFunc(ctx, funcIdx, {
    name: "__date_format_string",
    typeIdx: funcTypeIdx,
    locals: [
      { name: "$buf", type: dataRef },
      { name: "$pos", type: { kind: "i32" } },
      { name: "$packed", type: { kind: "i64" } },
      { name: "$year", type: { kind: "i64" } },
      { name: "$msOfDay", type: { kind: "i64" } },
      { name: "$days", type: { kind: "i64" } },
      { name: "$tmp", type: { kind: "i64" } },
      { name: "$dow", type: { kind: "i32" } },
      { name: "$i32", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * (#3219) Shared zero-arg Date getter arithmetic, keyed on an i64 timestamp
 * local (`tsLocal`) rather than the Date ref, so BOTH the direct-call kernel
 * (`compileDateMethodCall`) and the reflective closure body
 * (`emitDateProtoMemberBody`) share ONE copy — no duplicated Date kernel
 * (#3174 anti-bloat). Covers the time-of-day + calendar getters
 * (getHours/getMinutes/getSeconds/getMilliseconds/getDay/getFullYear/getYear/
 * getMonth/getDate + UTC variants). Each arm reads `tsLocal` and pushes an f64
 * result (NaN for the Invalid-Date sentinel). Returns `{kind:"f64"}` when it
 * handled `methodName`, or `undefined` (emitting nothing) for any other method.
 *
 * getTime/valueOf/getTimezoneOffset are NOT here — they have distinct
 * non-guarded semantics and are handled inline by each caller.
 *
 * NOTE: for a non-matching method this returns BEFORE ensuring the civil helper,
 * so `compileDateMethodCall` re-asserts `ensureDateCivilHelper` after the call to
 * keep its formatter path byte-identical (the formatters historically ran after
 * the calendar-getter section had incidentally ensured that helper).
 */
export function emitDateZeroArgGetterFromTsLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  tsLocal: number,
): ValType | undefined {
  const MS_PER_DAY = 86400000n;
  const MS_PER_HOUR = 3600000n;
  const MS_PER_MINUTE = 60000n;
  const MS_PER_SECOND = 1000n;

  /** Wrap a getter's arithmetic in the invalid-Date NaN guard. The
   *  callback should emit instructions that consume the i64 timestamp
   *  on the stack and produce an f64 result. */
  const wrapWithInvalidDateGuard = (emitArithmetic: () => void): ValType => {
    fctx.body.push({ op: "local.get", index: tsLocal });
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
    fctx.body.push({ op: "i64.eq" });
    const savedBody = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tsLocal });
    emitArithmetic();
    const elseInstrs = fctx.body;
    popBody(fctx, savedBody);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN }],
      else: elseInstrs,
    });
    return { kind: "f64" };
  };

  if (methodName === "getHours" || methodName === "getUTCHours") {
    // hours = ((timestamp % 86400000) + 86400000) % 86400000 / 3600000
    return wrapWithInvalidDateGuard(() =>
      fctx.body.push(
        { op: "i64.const", value: MS_PER_DAY },
        { op: "i64.rem_s" },
        { op: "i64.const", value: MS_PER_DAY },
        { op: "i64.add" },
        { op: "i64.const", value: MS_PER_DAY },
        { op: "i64.rem_s" },
        { op: "i64.const", value: MS_PER_HOUR },
        { op: "i64.div_s" },
        { op: "f64.convert_i64_s" },
      ),
    );
  }

  if (methodName === "getMinutes" || methodName === "getUTCMinutes") {
    // minutes = ((timestamp % 3600000) + 3600000) % 3600000 / 60000
    return wrapWithInvalidDateGuard(() =>
      fctx.body.push(
        { op: "i64.const", value: MS_PER_HOUR },
        { op: "i64.rem_s" },
        { op: "i64.const", value: MS_PER_HOUR },
        { op: "i64.add" },
        { op: "i64.const", value: MS_PER_HOUR },
        { op: "i64.rem_s" },
        { op: "i64.const", value: MS_PER_MINUTE },
        { op: "i64.div_s" },
        { op: "f64.convert_i64_s" },
      ),
    );
  }

  if (methodName === "getSeconds" || methodName === "getUTCSeconds") {
    // seconds = ((timestamp % 60000) + 60000) % 60000 / 1000
    return wrapWithInvalidDateGuard(() =>
      fctx.body.push(
        { op: "i64.const", value: MS_PER_MINUTE },
        { op: "i64.rem_s" },
        { op: "i64.const", value: MS_PER_MINUTE },
        { op: "i64.add" },
        { op: "i64.const", value: MS_PER_MINUTE },
        { op: "i64.rem_s" },
        { op: "i64.const", value: MS_PER_SECOND },
        { op: "i64.div_s" },
        { op: "f64.convert_i64_s" },
      ),
    );
  }

  if (methodName === "getMilliseconds" || methodName === "getUTCMilliseconds") {
    // ms = ((timestamp % 1000) + 1000) % 1000
    return wrapWithInvalidDateGuard(() =>
      fctx.body.push(
        { op: "i64.const", value: MS_PER_SECOND },
        { op: "i64.rem_s" },
        { op: "i64.const", value: MS_PER_SECOND },
        { op: "i64.add" },
        { op: "i64.const", value: MS_PER_SECOND },
        { op: "i64.rem_s" },
        { op: "f64.convert_i64_s" },
      ),
    );
  }

  // getDay / getUTCDay: day of week (0=Sunday)
  // (floor(timestamp / 86400000) + 4) % 7  (1970-01-01 was Thursday = 4)
  if (methodName === "getDay" || methodName === "getUTCDay") {
    return wrapWithInvalidDateGuard(() =>
      fctx.body.push(
        { op: "i64.const", value: MS_PER_DAY },
        { op: "i64.div_s" },
        { op: "i64.const", value: 4n },
        { op: "i64.add" },
        { op: "i64.const", value: 7n },
        { op: "i64.rem_s" },
        { op: "i64.const", value: 7n },
        { op: "i64.add" },
        { op: "i64.const", value: 7n },
        { op: "i64.rem_s" },
        { op: "f64.convert_i64_s" },
      ),
    );
  }

  // Only the calendar getters below need civil_from_days. Return (without
  // ensuring it) for any other method so the caller's byte-identity re-assert
  // is the single place that (re)ensures the helper for the fall-through path.
  const CALENDAR_GETTERS = new Set([
    "getFullYear",
    "getUTCFullYear",
    "getYear",
    "getMonth",
    "getUTCMonth",
    "getDate",
    "getUTCDate",
  ]);
  if (!CALENDAR_GETTERS.has(methodName)) return undefined;

  // Calendar getters need civil_from_days.
  // (#1344) Each branch is wrapped with the invalid-Date guard. The guard
  // re-pushes the saved timestamp so the floor-div + civil_from_days
  // sequence below sees it on the stack.
  const civilIdx = ensureDateCivilHelper(ctx);

  /** Emit floor-div(ts, MS_PER_DAY) -> days, then civil_from_days(days). */
  const emitDaysToCivil = (): void => {
    const tempTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: tempTs });
    fctx.body.push(
      { op: "local.get", index: tempTs },
      { op: "i64.const", value: 0n },
      { op: "i64.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: [{ op: "local.get", index: tempTs }, { op: "i64.const", value: MS_PER_DAY }, { op: "i64.div_s" }],
        else: [
          { op: "local.get", index: tempTs },
          { op: "i64.const", value: MS_PER_DAY - 1n },
          { op: "i64.sub" },
          { op: "i64.const", value: MS_PER_DAY },
          { op: "i64.div_s" },
        ],
      },
    );
    releaseTempLocal(fctx, tempTs);
    fctx.body.push({ op: "call", funcIdx: civilIdx });
  };

  if (methodName === "getFullYear" || methodName === "getUTCFullYear") {
    return wrapWithInvalidDateGuard(() => {
      emitDaysToCivil(); // packed on stack
      const tmp = allocTempLocal(fctx, { kind: "i64" });
      emitPackedYear(fctx.body, tmp); // floor(packed/10000)
      releaseTempLocal(fctx, tmp);
      fctx.body.push({ op: "f64.convert_i64_s" });
    });
  }

  // (#2671) Annex B §B.2.4 `Date.prototype.getYear()` — legacy `getFullYear() -
  // 1900`. Like getFullYear but with the −1900 offset; NaN-guarded the same way.
  if (methodName === "getYear") {
    return wrapWithInvalidDateGuard(() => {
      emitDaysToCivil(); // packed on stack
      const tmp = allocTempLocal(fctx, { kind: "i64" });
      emitPackedYear(fctx.body, tmp); // floor(packed/10000) → full year (i64)
      releaseTempLocal(fctx, tmp);
      fctx.body.push(
        { op: "i64.const", value: 1900n },
        { op: "i64.sub" }, // year - 1900
        { op: "f64.convert_i64_s" },
      );
    });
  }

  if (methodName === "getMonth" || methodName === "getUTCMonth") {
    return wrapWithInvalidDateGuard(() => {
      emitDaysToCivil(); // packed on stack
      const tmp = allocTempLocal(fctx, { kind: "i64" });
      const yTmp = allocTempLocal(fctx, { kind: "i64" });
      emitPackedMmdd(fctx.body, tmp, yTmp); // month*100+day (always positive)
      releaseTempLocal(fctx, tmp);
      releaseTempLocal(fctx, yTmp);
      fctx.body.push(
        { op: "i64.const", value: 100n },
        { op: "i64.div_s" }, // month (1-12)
        { op: "i64.const", value: 1n },
        { op: "i64.sub" }, // 0-based
        { op: "f64.convert_i64_s" },
      );
    });
  }

  if (methodName === "getDate" || methodName === "getUTCDate") {
    return wrapWithInvalidDateGuard(() => {
      emitDaysToCivil(); // packed on stack
      const tmp = allocTempLocal(fctx, { kind: "i64" });
      const yTmp = allocTempLocal(fctx, { kind: "i64" });
      emitPackedMmdd(fctx.body, tmp, yTmp); // month*100+day (always positive)
      releaseTempLocal(fctx, tmp);
      releaseTempLocal(fctx, yTmp);
      fctx.body.push(
        { op: "i64.const", value: 100n },
        { op: "i64.rem_s" }, // day (1-31)
        { op: "f64.convert_i64_s" },
      );
    });
  }

  return undefined;
}

/**
 * (#3219) Native reflective body for a `Date.prototype.<getter>` closure value
 * under `--target standalone`. `this` is closure-param 1 (externref); the
 * closure ABI is `(self, this, …args)` and every zero-arg getter ignores args.
 *
 * Implements the §21.4.4 `thisTimeValue` brand check as the shared
 * [[DateValue]] preamble #3174 asks for: recover the receiver as a `$Date`
 * struct (`any.convert_extern` + `ref.test`); a receiver WITHOUT a [[DateValue]]
 * slot throws a (catchable) TypeError. For a genuine Date, read [[DateValue]]
 * (field 0) and compute the getter, boxing the f64 result to externref (the
 * uniform closure-call result type). This is what makes
 * `Date.prototype.<getter>.call(recv)` run host-free instead of falling through
 * to the legacy value-erased `.call` (which dropped `thisArg` → returned 0).
 *
 * Only the zero-arg getters are wired; setters/formatters return `null`, so
 * `ensureStandaloneNativeMethodClosure` mints no closure and the reflective call
 * falls through to the legacy path UNCHANGED (no vacuity introduced).
 *
 * Funcidx discipline: `__box_number` is ensured FIRST (earliest import slot →
 * its funcidx never shifts when `emitThrowTypeError` later adds `__new_TypeError`)
 * and re-fetched immediately before the box call; the civil-helper defined-func
 * idx is captured fresh inside `emitDateZeroArgGetterFromTsLocal` and used at
 * once. All emission is standalone-gated by construction (this body only emits
 * on the reflective-proto path, which is standalone-only).
 */
export function emitDateProtoMemberBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | null {
  const DIRECT_TS_GETTERS = new Set(["getTime", "valueOf", "getTimezoneOffset"]);
  const CIVIL_GETTERS = new Set([
    "getHours",
    "getUTCHours",
    "getMinutes",
    "getUTCMinutes",
    "getSeconds",
    "getUTCSeconds",
    "getMilliseconds",
    "getUTCMilliseconds",
    "getDay",
    "getUTCDay",
    "getFullYear",
    "getUTCFullYear",
    "getYear",
    "getMonth",
    "getUTCMonth",
    "getDate",
    "getUTCDate",
  ]);
  // Setters / formatters: refuse (null) → the closure is not minted and the
  // reflective call falls through to the legacy path, byte-identical to today.
  if (!DIRECT_TS_GETTERS.has(member) && !CIVIL_GETTERS.has(member)) return null;

  const SENTINEL = -9223372036854775808n; // Invalid-Date [[DateValue]] sentinel.

  // __box_number FIRST (earliest import slot) + flush → funcidx-shift-safe.
  const boxIdxProbe = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  if (boxIdxProbe === undefined) return null;
  flushLateImportShifts(ctx, fctx);

  const dateTypeIdx = ensureDateStruct(ctx);

  // ── [[DateValue]]-brand preamble ────────────────────────────────────────
  // this (param 1, externref) → anyref; throw TypeError if not a $Date struct.
  const anyTmp = allocTempLocal(fctx, { kind: "anyref" });
  fctx.body.push({ op: "local.get", index: 1 });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.tee", index: anyTmp });
  fctx.body.push({ op: "ref.test", typeIdx: dateTypeIdx });
  fctx.body.push({ op: "i32.eqz" });
  const savedThrow = pushBody(fctx);
  // §thisTimeValue step 2: no [[DateValue]] internal slot → TypeError.
  emitThrowTypeError(ctx, fctx, "Date.prototype method called on a non-Date receiver");
  const throwInstrs = fctx.body;
  popBody(fctx, savedThrow);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: throwInstrs,
    else: [],
  });

  // Genuine Date: read [[DateValue]] (field 0, i64) into tsLocal.
  const tsLocal = allocTempLocal(fctx, { kind: "i64" });
  fctx.body.push({ op: "local.get", index: anyTmp });
  fctx.body.push({ op: "ref.cast", typeIdx: dateTypeIdx });
  fctx.body.push({ op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: tsLocal });
  releaseTempLocal(fctx, anyTmp);

  // ── Compute the getter → f64 on the stack ───────────────────────────────
  if (member === "getTime" || member === "valueOf") {
    // §21.4.4.10 / §21.4.4.44: Invalid Date → NaN, else the ms timestamp.
    fctx.body.push({ op: "local.get", index: tsLocal });
    fctx.body.push({ op: "i64.const", value: SENTINEL });
    fctx.body.push({ op: "i64.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN }],
      else: [{ op: "local.get", index: tsLocal }, { op: "f64.convert_i64_s" }],
    });
  } else if (member === "getTimezoneOffset") {
    // §21.4.4.7: UTC-only runtime → 0 for a valid Date, NaN for Invalid Date.
    fctx.body.push({ op: "local.get", index: tsLocal });
    fctx.body.push({ op: "i64.const", value: SENTINEL });
    fctx.body.push({ op: "i64.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN }],
      else: [{ op: "f64.const", value: 0 }],
    });
  } else {
    const g = emitDateZeroArgGetterFromTsLocal(ctx, fctx, member, tsLocal);
    if (!g) {
      releaseTempLocal(fctx, tsLocal);
      return null; // unreachable (CIVIL_GETTERS gate above) — defensive.
    }
  }
  releaseTempLocal(fctx, tsLocal);

  // Box f64 → externref (uniform closure-call result). Re-fetch the funcidx
  // (idempotent; post-any-shift-correct) then flush before the call.
  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (boxIdx === undefined) return null;
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  return { kind: "externref" };
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
    "getYear", // (#2671) Annex B §B.2.4 legacy getter
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

  // (#4482) §21.4.4 "is not generic": once the program installs its OWN
  // `<methodName>` on this exact binding — `Object.defineProperty(d,
  // "valueOf", {value: Number.prototype.valueOf})` or `d.valueOf = …` — the
  // own slot shadows `Date.prototype`, so answering from the `$Date` struct
  // reads the timestamp where the transferred intrinsic must run (and throw a
  // real `TypeError`). Declining routes the call to the stored-member closure
  // arm, whose brand preamble already throws for the expando-named half of
  // these rows (`s.myValueOf = Number.prototype.valueOf` — measured passing
  // before this change).
  //
  // Receiver-PRECISE on purpose (`sourceOverridesMethodOnReceiver`, not the
  // whole-file `sourceHasMethodOverride`): the whole-file scan is safe for
  // arms that only ADD a dynamic exit, but gating a static arm OFF on an
  // unrelated `x.valueOf = …` elsewhere in the file would lose the native
  // answer for a Date that never had an own slot. A module that does not
  // override on this binding compiles byte-identically.
  if (sourceOverridesMethodOnReceiver(propAccess.expression, methodName)) return undefined;

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
    fctx.body.push({ op: "local.tee", index: tsLocal });
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
    fctx.body.push({ op: "i64.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN }],
      else: [{ op: "local.get", index: tsLocal }, { op: "f64.convert_i64_s" }],
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
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
    fctx.body.push({ op: "i64.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN }],
      else: [{ op: "f64.const", value: 0 }],
    });
    return { kind: "f64" };
  }

  // setTime(ms): update the timestamp field — with NaN / Invalid Date / TimeClip
  // propagation per §21.4.4.27. (#1440 Slice 1)
  if (methodName === "setTime") {
    // Stack: [dateRef]
    const tempRef = allocTempLocal(fctx, dateRefType);
    fctx.body.push({ op: "local.set", index: tempRef });

    if (callExpr.arguments.length >= 1) {
      // Evaluate arg to f64 (ToNumber; may throw on Symbol per §7.1.4).
      const tempArg = allocTempLocal(fctx, { kind: "f64" });
      compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tempArg });

      // isInvalid = (arg != arg)  // NaN
      //          OR (f64.abs(arg) > 8.64e15)  // TimeClip out-of-range / ±Inf
      fctx.body.push({ op: "local.get", index: tempArg });
      fctx.body.push({ op: "local.get", index: tempArg });
      fctx.body.push({ op: "f64.ne" });
      fctx.body.push({ op: "local.get", index: tempArg });
      fctx.body.push({ op: "f64.abs" });
      fctx.body.push({ op: "f64.const", value: 8.64e15 });
      fctx.body.push({ op: "f64.gt" });
      fctx.body.push({ op: "i32.or" });

      // then: write sentinel, push NaN
      const savedThen = pushBody(fctx);
      fctx.body.push({ op: "local.get", index: tempRef });
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
      fctx.body.push({
        op: "struct.set",
        typeIdx: dateTypeIdx,
        fieldIdx: 0,
      });
      fctx.body.push({ op: "f64.const", value: NaN });
      const thenInstrs = fctx.body;
      popBody(fctx, savedThen);

      // else: trunc to i64, write, return as f64
      const savedElse = pushBody(fctx);
      fctx.body.push({ op: "local.get", index: tempRef });
      fctx.body.push({ op: "local.get", index: tempArg });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" });
      const tempNewTs = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.tee", index: tempNewTs });
      fctx.body.push({
        op: "struct.set",
        typeIdx: dateTypeIdx,
        fieldIdx: 0,
      });
      fctx.body.push({ op: "local.get", index: tempNewTs });
      fctx.body.push({ op: "f64.convert_i64_s" });
      releaseTempLocal(fctx, tempNewTs);
      const elseInstrs = fctx.body;
      popBody(fctx, savedElse);

      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: thenInstrs,
        else: elseInstrs,
      });

      releaseTempLocal(fctx, tempArg);
    } else {
      // setTime() with no arg → NaN (Invalid Date)
      fctx.body.push({ op: "local.get", index: tempRef });
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
      fctx.body.push({
        op: "struct.set",
        typeIdx: dateTypeIdx,
        fieldIdx: 0,
      });
      fctx.body.push({ op: "f64.const", value: NaN });
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
    fctx.body.push({ op: "local.set", index: tempRef });

    // Read curTs FIRST — observable ordering: the receiver's [[DateValue]]
    // is sampled before any user code in arg ToNumber callbacks runs
    // (test262 `date-value-read-before-tonumber-when-date-is-valid.js`).
    const tempCurTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempRef });
    fctx.body.push({
      op: "struct.get",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    });
    fctx.body.push({ op: "local.set", index: tempCurTs });

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
    fctx.body.push({ op: "i32.const", value: args.length === 0 ? 1 : 0 });
    fctx.body.push({ op: "local.set", index: tempAnyInvalid });

    const argLocals: Partial<Record<"h" | "m" | "s" | "ms", number>> = {};
    for (let i = 0; i < unitsForArgs.length && i < args.length; i++) {
      const unit = unitsForArgs[i]!;
      const local = allocTempLocal(fctx, { kind: "f64" });
      argLocals[unit] = local;
      // Coerce: compileExpression w/ expectedType:f64 invokes ToNumber for
      // externref / struct refs / strings; the centralized __unbox_number
      // funnel handles valueOf / @@toPrimitive / Symbol-throw (#1434).
      compileExpression(ctx, fctx, args[i]!, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: local });
      // invalid_i = (x != x) | (f64.abs(x) > 8.64e15)
      fctx.body.push({ op: "local.get", index: local });
      fctx.body.push({ op: "local.get", index: local });
      fctx.body.push({ op: "f64.ne" });
      fctx.body.push({ op: "local.get", index: local });
      fctx.body.push({ op: "f64.abs" });
      fctx.body.push({ op: "f64.const", value: 8.64e15 });
      fctx.body.push({ op: "f64.gt" });
      fctx.body.push({ op: "i32.or" });
      fctx.body.push({ op: "local.get", index: tempAnyInvalid });
      fctx.body.push({ op: "i32.or" });
      fctx.body.push({ op: "local.set", index: tempAnyInvalid });
    }

    // isInvalid = (curTs == sentinel) | anyInvalid
    fctx.body.push({ op: "local.get", index: tempCurTs });
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
    fctx.body.push({ op: "i64.eq" });
    fctx.body.push({ op: "local.get", index: tempAnyInvalid });
    fctx.body.push({ op: "i32.or" });

    // then-branch: the time-value result is NaN → push NaN. Write the
    // Invalid-Date sentinel ONLY when the receiver was still VALID before
    // this call (curTs != sentinel) and an arg coerced to NaN / out-of-range
    // invalidated it — then §21.4.4.* step "Set dateObject.[[DateValue]] to u"
    // stores NaN. When the receiver was ALREADY invalid (curTs == sentinel),
    // the spec's earlier step "If t is NaN, return NaN" returns WITHOUT
    // touching [[DateValue]]; a ToNumber side-effect during arg coercion (e.g.
    // `value.valueOf()` calling `this.setTime(0)`) may have legitimately
    // re-set it, and clobbering it back to the sentinel violates the spec
    // (test262 date-value-read-before-tonumber-when-date-is-invalid).
    const savedThen = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempCurTs });
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
    fctx.body.push({ op: "i64.ne" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: tempRef },
        { op: "i64.const", value: -9223372036854775808n },
        { op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 },
      ],
    });
    fctx.body.push({ op: "f64.const", value: NaN });
    const thenInstrs = fctx.body;
    popBody(fctx, savedThen);

    // else-branch: valid arithmetic.
    const savedElse = pushBody(fctx);

    // ms_of_day = ((curTs mod MS_PER_DAY) + MS_PER_DAY) mod MS_PER_DAY
    const tempMsOfDay = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push(
      { op: "local.get", index: tempCurTs },
      { op: "i64.const", value: MS_PER_DAY },
      { op: "i64.rem_s" },
      { op: "i64.const", value: MS_PER_DAY },
      { op: "i64.add" },
      { op: "i64.const", value: MS_PER_DAY },
      { op: "i64.rem_s" },
      { op: "local.set", index: tempMsOfDay },
    );

    // day_ms = curTs - ms_of_day
    const tempDayMs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push(
      { op: "local.get", index: tempCurTs },
      { op: "local.get", index: tempMsOfDay },
      { op: "i64.sub" },
      { op: "local.set", index: tempDayMs },
    );

    // Push i64 component value: from arg (already coerced) or from current ms_of_day.
    const pushComponent = (unit: "h" | "m" | "s" | "ms") => {
      const argLocal = argLocals[unit];
      if (argLocal !== undefined) {
        fctx.body.push({ op: "local.get", index: argLocal });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
        return;
      }
      // Extract from tempMsOfDay.
      fctx.body.push({ op: "local.get", index: tempMsOfDay });
      if (unit === "ms") {
        fctx.body.push({ op: "i64.const", value: MS_PER_SECOND }, { op: "i64.rem_s" });
      } else if (unit === "s") {
        fctx.body.push(
          { op: "i64.const", value: MS_PER_SECOND },
          { op: "i64.div_s" },
          { op: "i64.const", value: 60n },
          { op: "i64.rem_s" },
        );
      } else if (unit === "m") {
        fctx.body.push(
          { op: "i64.const", value: MS_PER_MINUTE },
          { op: "i64.div_s" },
          { op: "i64.const", value: 60n },
          { op: "i64.rem_s" },
        );
      } else {
        fctx.body.push({ op: "i64.const", value: MS_PER_HOUR }, { op: "i64.div_s" });
      }
    };

    // newTs = day_ms + h*MS_PER_HOUR + m*MS_PER_MINUTE + s*MS_PER_SECOND + ms
    fctx.body.push({ op: "local.get", index: tempDayMs });
    pushComponent("h");
    fctx.body.push({ op: "i64.const", value: MS_PER_HOUR });
    fctx.body.push({ op: "i64.mul" });
    fctx.body.push({ op: "i64.add" });
    pushComponent("m");
    fctx.body.push({ op: "i64.const", value: MS_PER_MINUTE });
    fctx.body.push({ op: "i64.mul" });
    fctx.body.push({ op: "i64.add" });
    pushComponent("s");
    fctx.body.push({ op: "i64.const", value: MS_PER_SECOND });
    fctx.body.push({ op: "i64.mul" });
    fctx.body.push({ op: "i64.add" });
    pushComponent("ms");
    fctx.body.push({ op: "i64.add" });

    const tempNewTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: tempNewTs });

    // TimeClip (§21.4.1.31): if |newTs| > 8.64e15 ms → sentinel + NaN
    fctx.body.push({ op: "local.get", index: tempNewTs });
    fctx.body.push({ op: "i64.const", value: 8640000000000000n });
    fctx.body.push({ op: "i64.gt_s" });
    fctx.body.push({ op: "local.get", index: tempNewTs });
    fctx.body.push({ op: "i64.const", value: -8640000000000000n });
    fctx.body.push({ op: "i64.lt_s" });
    fctx.body.push({ op: "i32.or" });

    const savedClipThen = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempRef });
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
    fctx.body.push({
      op: "struct.set",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    });
    fctx.body.push({ op: "f64.const", value: NaN });
    const clipThenInstrs = fctx.body;
    popBody(fctx, savedClipThen);

    const savedClipElse = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempRef });
    fctx.body.push({ op: "local.get", index: tempNewTs });
    fctx.body.push({
      op: "struct.set",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    });
    fctx.body.push({ op: "local.get", index: tempNewTs });
    fctx.body.push({ op: "f64.convert_i64_s" });
    const clipElseInstrs = fctx.body;
    popBody(fctx, savedClipElse);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: clipThenInstrs,
      else: clipElseInstrs,
    });

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
    });

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
    fctx.body.push({ op: "local.set", index: tempRef });

    // Read curTs FIRST.
    const tempCurTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempRef });
    fctx.body.push({ op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "local.set", index: tempCurTs });

    // Mapping: setDate(d) → [d], setMonth(mo, d?) → [mo, d],
    // setFullYear(y, mo?, d?) → [y, mo, d], setYear(y) → [y]
    const calUnits: ("y" | "mo" | "d")[] = ["y", "mo", "d"];
    const startCalIdx = calUnits.indexOf(startUnit);
    const unitsForArgs = isLegacySetYear ? (["y"] as ("y" | "mo" | "d")[]) : calUnits.slice(startCalIdx);

    // Coerce all args left-to-right. If START arg is missing, ToNumber(undefined)=NaN.
    const tempAnyInvalid = allocTempLocal(fctx, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: args.length === 0 ? 1 : 0 });
    fctx.body.push({ op: "local.set", index: tempAnyInvalid });

    // (#4556) ToNumber(Symbol) throws — tonumber-symbol-throw.ts.
    const dateSym = emitSymbolArgToNumberThrow(ctx, fctx, args, { kind: "f64" });
    if (dateSym !== undefined) return dateSym;
    const argLocals: Partial<Record<"y" | "mo" | "d", number>> = {};
    for (let i = 0; i < unitsForArgs.length && i < args.length; i++) {
      const unit = unitsForArgs[i]!;
      const local = allocTempLocal(fctx, { kind: "f64" });
      argLocals[unit] = local;
      compileExpression(ctx, fctx, args[i]!, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: local });
      // invalid_i = (x != x) | (f64.abs(x) > 8.64e15)
      fctx.body.push({ op: "local.get", index: local });
      fctx.body.push({ op: "local.get", index: local });
      fctx.body.push({ op: "f64.ne" });
      fctx.body.push({ op: "local.get", index: local });
      fctx.body.push({ op: "f64.abs" });
      fctx.body.push({ op: "f64.const", value: 8.64e15 });
      fctx.body.push({ op: "f64.gt" });
      fctx.body.push({ op: "i32.or" });
      fctx.body.push({ op: "local.get", index: tempAnyInvalid });
      fctx.body.push({ op: "i32.or" });
      fctx.body.push({ op: "local.set", index: tempAnyInvalid });
    }

    // Legacy setYear: if 0 <= ToIntegerOrInfinity(y) <= 99, yyyy = 1900 + that
    // INTEGER (§B.2.4.2 steps 5-6); otherwise yyyy = y unchanged.
    // (#4485) The window test and the +1900 must both use the TRUNCATED value,
    // not the raw f64. Testing the raw double mis-routes every fractional year
    // in (-1, 0): `setYear(-0.9999999)` truncates to -0, which IS in [0, 99],
    // so the spec answer is 1900 — but `-0.9999999 >= 0` is false, so the raw
    // test fell through to the else arm and later truncation produced year 0
    // (test262 annexB .../setYear/year-number-relative.js). f64.trunc(-0.9…)
    // is -0, and both `-0 >= 0` and `-0 + 1900 === 1900` hold in IEEE-754, so
    // the ToIntegerOrInfinity "-0 → +0" normalisation needs no extra opcode.
    if (isLegacySetYear && argLocals.y !== undefined) {
      const yLocal = argLocals.y;
      const yTrunc = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.get", index: yLocal });
      fctx.body.push({ op: "f64.trunc" });
      fctx.body.push({ op: "local.set", index: yTrunc });
      fctx.body.push({ op: "local.get", index: yTrunc });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.ge" });
      fctx.body.push({ op: "local.get", index: yTrunc });
      fctx.body.push({ op: "f64.const", value: 99 });
      fctx.body.push({ op: "f64.le" });
      fctx.body.push({ op: "i32.and" });
      const savedY = pushBody(fctx);
      fctx.body.push({ op: "local.get", index: yTrunc });
      fctx.body.push({ op: "f64.const", value: 1900 });
      fctx.body.push({ op: "f64.add" });
      const yThenInstrs = fctx.body;
      popBody(fctx, savedY);
      const savedYElse = pushBody(fctx);
      fctx.body.push({ op: "local.get", index: yLocal });
      const yElseInstrs = fctx.body;
      popBody(fctx, savedYElse);
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: yThenInstrs,
        else: yElseInstrs,
      });
      fctx.body.push({ op: "local.set", index: yLocal });
    }

    // For setFullYear: an Invalid Date receiver is re-validated by setting
    // t to +0. So sentinelCurTs no longer poisons the result.
    // For other calendar setters: sentinel curTs → return NaN.
    fctx.body.push({ op: "local.get", index: tempAnyInvalid });
    if (!isSetFullYear) {
      fctx.body.push({ op: "local.get", index: tempCurTs });
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
      fctx.body.push({ op: "i64.eq" });
      fctx.body.push({ op: "i32.or" });
    }

    // then-branch: invalid → NaN.
    // setFullYear / setUTCFullYear / setYear (§21.4.4.21) re-validate an
    // Invalid receiver (t → +0) and ALWAYS write [[DateValue]] (no early "if t
    // is NaN return") — the then-branch is reached only when an arg coerced to
    // NaN/out-of-range, so the sentinel write is unconditional. setDate /
    // setMonth (+UTC) (§21.4.4.{20,24}) have step "If t is NaN, return NaN"
    // which returns WITHOUT writing when the receiver was ALREADY invalid
    // (curTs == sentinel) — a ToNumber side-effect during arg coercion
    // (`value.valueOf()` calling `this.setTime(0)`) may have legitimately
    // re-set it. So write the sentinel only when the receiver was still valid
    // (curTs != sentinel) and an arg invalidated it
    // (test262 date-value-read-before-tonumber-when-date-is-invalid).
    const savedThen = pushBody(fctx);
    if (isSetFullYear) {
      fctx.body.push({ op: "local.get", index: tempRef });
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
      fctx.body.push({
        op: "struct.set",
        typeIdx: dateTypeIdx,
        fieldIdx: 0,
      });
    } else {
      fctx.body.push({ op: "local.get", index: tempCurTs });
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
      fctx.body.push({ op: "i64.ne" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: tempRef },
          { op: "i64.const", value: -9223372036854775808n },
          { op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 },
        ],
      });
    }
    fctx.body.push({ op: "f64.const", value: NaN });
    const thenInstrs = fctx.body;
    popBody(fctx, savedThen);

    // else-branch: valid calendar arithmetic.
    const savedElse = pushBody(fctx);

    // For setFullYear with Invalid Date, treat curTs as 0 (re-validate).
    const tempEffTs = allocTempLocal(fctx, { kind: "i64" });
    if (isSetFullYear) {
      fctx.body.push({ op: "local.get", index: tempCurTs });
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
      fctx.body.push({ op: "i64.eq" });
      const savedReval = pushBody(fctx);
      fctx.body.push({ op: "i64.const", value: 0n });
      const revalThen = fctx.body;
      popBody(fctx, savedReval);
      const savedRevalElse = pushBody(fctx);
      fctx.body.push({ op: "local.get", index: tempCurTs });
      const revalElse = fctx.body;
      popBody(fctx, savedRevalElse);
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: revalThen,
        else: revalElse,
      });
      fctx.body.push({ op: "local.set", index: tempEffTs });
    } else {
      fctx.body.push({ op: "local.get", index: tempCurTs });
      fctx.body.push({ op: "local.set", index: tempEffTs });
    }

    // ms_of_day from tempEffTs (preserved into the new date).
    const tempMsOfDay = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push(
      { op: "local.get", index: tempEffTs },
      { op: "i64.const", value: MS_PER_DAY },
      { op: "i64.rem_s" },
      { op: "i64.const", value: MS_PER_DAY },
      { op: "i64.add" },
      { op: "i64.const", value: MS_PER_DAY },
      { op: "i64.rem_s" },
      { op: "local.set", index: tempMsOfDay },
    );

    // curDays = floor(tempEffTs / MS_PER_DAY), then civil_from_days.
    const civilIdx = ensureDateCivilHelper(ctx);
    const tempCurDays = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempEffTs });
    fctx.body.push({ op: "i64.const", value: 0n });
    fctx.body.push({ op: "i64.ge_s" });
    const savedFlrThen = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempEffTs });
    fctx.body.push({ op: "i64.const", value: MS_PER_DAY });
    fctx.body.push({ op: "i64.div_s" });
    const flrThenInstrs = fctx.body;
    popBody(fctx, savedFlrThen);
    const savedFlrElse = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempEffTs });
    fctx.body.push({ op: "i64.const", value: MS_PER_DAY - 1n });
    fctx.body.push({ op: "i64.sub" });
    fctx.body.push({ op: "i64.const", value: MS_PER_DAY });
    fctx.body.push({ op: "i64.div_s" });
    const flrElseInstrs = fctx.body;
    popBody(fctx, savedFlrElse);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i64" } },
      then: flrThenInstrs,
      else: flrElseInstrs,
    });
    fctx.body.push({ op: "local.set", index: tempCurDays });

    // packed = civil_from_days(curDays)  (year*10000 + month*100 + day, month 1-12)
    const tempPacked = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempCurDays });
    fctx.body.push({ op: "call", funcIdx: civilIdx });
    fctx.body.push({ op: "local.set", index: tempPacked });

    // Extract curY, curMo (1-based), curD from packed. Negative-year safe:
    // curY = floor(packed/10000); curMmdd = packed - curY*10000 ∈ [101, 1231];
    // curMo = curMmdd/100; curD = curMmdd%100 (see emitPackedYear/emitPackedMmdd).
    const tempCurY = allocTempLocal(fctx, { kind: "i64" });
    const tempMmddScratch = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempPacked });
    emitPackedYear(fctx.body, tempMmddScratch); // floor year on stack
    fctx.body.push({ op: "local.set", index: tempCurY });

    // curMmdd = packed - curY*10000  (always positive)
    const tempCurMmdd = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push(
      { op: "local.get", index: tempPacked },
      { op: "local.get", index: tempCurY },
      { op: "i64.const", value: 10000n },
      { op: "i64.mul" },
      { op: "i64.sub" },
      { op: "local.set", index: tempCurMmdd },
    );
    releaseTempLocal(fctx, tempMmddScratch);

    const tempCurMo = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempCurMmdd });
    fctx.body.push({ op: "i64.const", value: 100n });
    fctx.body.push({ op: "i64.div_s" });
    fctx.body.push({ op: "local.set", index: tempCurMo });

    const tempCurD = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: tempCurMmdd });
    fctx.body.push({ op: "i64.const", value: 100n });
    fctx.body.push({ op: "i64.rem_s" });
    fctx.body.push({ op: "local.set", index: tempCurD });

    // Push new component value (i64): from arg or from current.
    // Note: JS month is 0-based, but our helper uses 1-based. So when the
    // user supplies a month arg we add 1 here.
    const pushNewY = () => {
      if (argLocals.y !== undefined) {
        fctx.body.push({ op: "local.get", index: argLocals.y });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
      } else {
        fctx.body.push({ op: "local.get", index: tempCurY });
      }
    };
    const pushNewMo1Based = () => {
      if (argLocals.mo !== undefined) {
        fctx.body.push({ op: "local.get", index: argLocals.mo });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
        fctx.body.push({ op: "i64.const", value: 1n });
        fctx.body.push({ op: "i64.add" });
      } else {
        fctx.body.push({ op: "local.get", index: tempCurMo });
      }
    };
    const pushNewD = () => {
      if (argLocals.d !== undefined) {
        fctx.body.push({ op: "local.get", index: argLocals.d });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
      } else {
        fctx.body.push({ op: "local.get", index: tempCurD });
      }
    };

    // newDays = days_from_civil(newY, newMo1Based, newD)
    const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);
    pushNewY();
    pushNewMo1Based();
    pushNewD();
    fctx.body.push({ op: "call", funcIdx: daysFromCivilIdx });
    // newTs = newDays * MS_PER_DAY + msOfDay
    fctx.body.push({ op: "i64.const", value: MS_PER_DAY });
    fctx.body.push({ op: "i64.mul" });
    fctx.body.push({ op: "local.get", index: tempMsOfDay });
    fctx.body.push({ op: "i64.add" });

    const tempNewTs = allocTempLocal(fctx, { kind: "i64" });
    fctx.body.push({ op: "local.set", index: tempNewTs });

    // TimeClip: |newTs| > 8.64e15 → sentinel + NaN
    fctx.body.push({ op: "local.get", index: tempNewTs });
    fctx.body.push({ op: "i64.const", value: 8640000000000000n });
    fctx.body.push({ op: "i64.gt_s" });
    fctx.body.push({ op: "local.get", index: tempNewTs });
    fctx.body.push({ op: "i64.const", value: -8640000000000000n });
    fctx.body.push({ op: "i64.lt_s" });
    fctx.body.push({ op: "i32.or" });

    const savedClipThen = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempRef });
    fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
    fctx.body.push({
      op: "struct.set",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    });
    fctx.body.push({ op: "f64.const", value: NaN });
    const clipThenInstrs = fctx.body;
    popBody(fctx, savedClipThen);

    const savedClipElse = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tempRef });
    fctx.body.push({ op: "local.get", index: tempNewTs });
    fctx.body.push({
      op: "struct.set",
      typeIdx: dateTypeIdx,
      fieldIdx: 0,
    });
    fctx.body.push({ op: "local.get", index: tempNewTs });
    fctx.body.push({ op: "f64.convert_i64_s" });
    const clipElseInstrs = fctx.body;
    popBody(fctx, savedClipElse);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: clipThenInstrs,
      else: clipElseInstrs,
    });

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
    });

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
  fctx.body.push({ op: "local.set", index: tsLocalShared });
  // Stack: []

  // (#3219) The zero-arg time-of-day + calendar getters now live in the shared
  // `emitDateZeroArgGetterFromTsLocal` helper (reused by the reflective closure
  // body). It reads `tsLocalShared` and returns f64 for a getter, or undefined
  // (emitting nothing) for the string formatters below.
  const zeroArgGetter = emitDateZeroArgGetterFromTsLocal(ctx, fctx, methodName, tsLocalShared);
  if (zeroArgGetter) return zeroArgGetter;
  // (#3219 byte-identity) The formatter arms below historically ran only after
  // the calendar-getter section had (incidentally) ensured the civil helper.
  // The shared helper returns before ensuring it for non-getters, so re-assert
  // it here to keep the direct-path formatter emission byte-identical.
  ensureDateCivilHelper(ctx);

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
      // (#2164) Standalone / nativeStrings: build the ISO 8601 string in pure
      // Wasm — there is no `__date_format` host import. The helper returns a
      // `ref $NativeString`; convert to `ref $AnyString` (the type the rest of
      // the string pipeline expects). `tsLocalShared` (i64) holds the timestamp,
      // with `-9223372036854775808` (i64 MIN) as the Invalid-Date sentinel.
      if (methodName === "toISOString" || methodName === "toJSON") {
        const isoIdx = ensureDateIsoStringHelper(ctx);
        const anyStrType: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };

        // toISOString throws RangeError on Invalid Date (§21.4.4.36);
        // toJSON returns null on Invalid Date (§21.4.4.45 — toISOString skipped).
        fctx.body.push(
          { op: "local.get", index: tsLocalShared },
          { op: "i64.const", value: -9223372036854775808n },
          { op: "i64.eq" },
        );
        if (methodName === "toJSON") {
          // if invalid -> ref.null any (null); else build ISO string.
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx } },
            then: [{ op: "ref.null", typeIdx: ctx.anyStrTypeIdx }],
            else: [
              { op: "local.get", index: tsLocalShared },
              { op: "call", funcIdx: isoIdx },
            ],
          });
          releaseTempLocal(fctx, tsLocalShared);
          return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
        }
        // toISOString: throw RangeError when invalid, otherwise build the string.
        const thenThrow: Instr[] = [];
        {
          const saved = fctx.body;
          (fctx as { body: Instr[] }).body = thenThrow;
          emitThrowRangeError(ctx, fctx, "Invalid time value");
          (fctx as { body: Instr[] }).body = saved;
        }
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: thenThrow,
          else: [],
        });
        fctx.body.push({ op: "local.get", index: tsLocalShared }, { op: "call", funcIdx: isoIdx });
        releaseTempLocal(fctx, tsLocalShared);
        return anyStrType;
      }
      // (#2164 formatters slice) The remaining string formatters (toString,
      // toUTCString/toGMTString, toDateString, toTimeString, toLocale*) build
      // their spec format in pure Wasm via `__date_format_string(ts, mode)`.
      // Standalone has no timezone DB, so all are rendered in UTC. An Invalid
      // Date receiver (i64-MIN sentinel) yields the literal "Invalid Date"
      // (§21.4.4.41.4 ToDateString → "Invalid Date") for every format.
      {
        const fmtStrIdx = ensureDateFormatStringHelper(ctx);
        const anyStrType: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
        // if ts == i64-MIN (Invalid Date) -> "Invalid Date", else build format.
        fctx.body.push(
          { op: "local.get", index: tsLocalShared },
          { op: "i64.const", value: -9223372036854775808n },
          { op: "i64.eq" },
        );
        const invalidArm: Instr[] = [];
        {
          const saved = fctx.body;
          (fctx as { body: Instr[] }).body = invalidArm;
          compileStringLiteral(ctx, fctx, "Invalid Date");
          (fctx as { body: Instr[] }).body = saved;
        }
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: anyStrType },
          then: invalidArm,
          else: [
            { op: "local.get", index: tsLocalShared },
            { op: "i32.const", value: mode },
            { op: "call", funcIdx: fmtStrIdx },
          ],
        });
        releaseTempLocal(fctx, tsLocalShared);
        return anyStrType;
      }
    }

    const fmtIdx = ensureLateImport(ctx, "__date_format", [{ kind: "i64" }, { kind: "i32" }], [{ kind: "externref" }])!;
    flushLateImportShifts(ctx, fctx);

    // toJSON returns `null` (not "Invalid Date", not a throw) for an Invalid
    // Date receiver (§21.4.4.45 → toISOString is skipped when ToNumber is not
    // finite). Branch on the sentinel and return ref.null externref.
    if (methodName === "toJSON") {
      fctx.body.push({ op: "local.get", index: tsLocalShared });
      fctx.body.push({ op: "i64.const", value: -9223372036854775808n });
      fctx.body.push({ op: "i64.eq" });
      const thenInstrs: Instr[] = [{ op: "ref.null.extern" }];
      const elseInstrs: Instr[] = [
        { op: "local.get", index: tsLocalShared },
        { op: "i32.const", value: mode },
        { op: "call", funcIdx: fmtIdx },
      ];
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: thenInstrs,
        else: elseInstrs,
      });
      releaseTempLocal(fctx, tsLocalShared);
      return { kind: "externref" };
    }

    fctx.body.push({ op: "local.get", index: tsLocalShared });
    fctx.body.push({ op: "i32.const", value: mode });
    fctx.body.push({ op: "call", funcIdx: fmtIdx });
    releaseTempLocal(fctx, tsLocalShared);
    return { kind: "externref" };
  }

  // Shouldn't reach here. Timestamp was saved to a local; nothing to drop.
  releaseTempLocal(fctx, tsLocalShared);
  fctx.body.push({ op: "f64.const", value: 0 });
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
  if (ctx.funcMap.get(helperName) === undefined) return VOID_RESULT;

  // #2642 INVARIANT: a funcIdx read from ctx.funcMap must NEVER be reused
  // across a compileExpression / ensure*-Helper call. Those calls can insert a
  // late import (e.g. __extern_toString via ensureLateImport for a
  // string|null / string|undefined externref-union concat argument), which
  // shifts EVERY function index by +1 via flushLateImportShifts. A funcIdx
  // captured BEFORE such a call resolves to the WRONG function afterward (it
  // pointed at __wasi_write_string, post-shift it lands on __regex_escape),
  // emitting `call expected (ref null N), found i32.const` — invalid Wasm under
  // --target wasi. So re-read the index by NAME at every emission site instead
  // of caching it. Same family as #1461 / #2193 — name-based repoint is the fix.
  const writeStr = (offset: number, length: number): void => {
    const idx = ctx.funcMap.get(helperName);
    if (idx === undefined) return;
    fctx.body.push({ op: "i32.const", value: offset });
    fctx.body.push({ op: "i32.const", value: length });
    fctx.body.push({ op: "call", funcIdx: idx });
  };

  let first = true;
  for (const arg of expr.arguments) {
    // Add space separator between arguments (like console.log does)
    if (!first) {
      const spaceData = wasiAllocStringData(ctx, " ");
      writeStr(spaceData.offset, spaceData.length);
    }
    first = false;

    // Check if this is a string literal we can embed directly
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      const strValue = arg.text;
      const data = wasiAllocStringData(ctx, strValue);
      writeStr(data.offset, data.length);
    } else if (ts.isTemplateExpression(arg)) {
      // Template literal: handle head + spans
      if (arg.head.text) {
        const headData = wasiAllocStringData(ctx, arg.head.text);
        writeStr(headData.offset, headData.length);
      }
      for (const span of arg.templateSpans) {
        // Compile the expression and convert to string output. These calls can
        // add a late import → the trailing literal write below MUST re-read the
        // index (writeStr does); do not cache it across compileExpression.
        const exprType = compileExpression(ctx, fctx, span.expression);
        emitWasiValueToStdout(ctx, fctx, exprType, span.expression, useStderr);
        if (span.literal.text) {
          const litData = wasiAllocStringData(ctx, span.literal.text);
          writeStr(litData.offset, litData.length);
        }
      }
    } else {
      // For non-literal arguments, compile the expression and handle by type.
      // compileExpression can insert a late import (string|null concat) → the
      // trailing newline write below MUST re-read the index (writeStr does).
      const exprType = compileExpression(ctx, fctx, arg);
      emitWasiValueToStdout(ctx, fctx, exprType, arg, useStderr);
    }
  }

  // Emit newline at the end — re-read the index (it may have shifted while
  // compiling a union-concat argument above).
  const newlineData = wasiAllocStringData(ctx, "\n");
  writeStr(newlineData.offset, newlineData.length);

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
  if (ctx.funcMap.get(writeStringName) === undefined) return;

  // #2642 INVARIANT: never cache writeStringName's funcIdx across an
  // ensure*-Helper call below — those can add a late import that shifts every
  // index by +1. The placeholder-write fallbacks happen AFTER
  // ensureWasiWriteAnyStringHelper, so they MUST re-read the index by name.
  const writeStr = (offset: number, length: number): void => {
    const idx = ctx.funcMap.get(writeStringName);
    if (idx === undefined) return;
    fctx.body.push({ op: "i32.const", value: offset });
    fctx.body.push({ op: "i32.const", value: length });
    fctx.body.push({ op: "call", funcIdx: idx });
  };

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
      fctx.body.push({ op: "drop" });
    }
  } else if (exprType.kind === "i32") {
    // Boolean or i32: write "true"/"false" or the integer
    const writeI32Idx = ensureWasiWriteI32Helper(ctx, useStderr);
    if (writeI32Idx >= 0) {
      fctx.body.push({ op: "call", funcIdx: writeI32Idx });
    } else {
      fctx.body.push({ op: "drop" });
    }
  } else if (
    (exprType.kind === "ref" || exprType.kind === "ref_null") &&
    isStringType(ctx.checker.getTypeAtLocation(node)) &&
    ctx.nativeStrTypeIdx >= 0
  ) {
    // #1618 / #1723: runtime string value (variable / concatenation / template
    // span). The compiled value is a NativeString ref, a ConsString ref (a
    // rope, produced by concat / template interpolation), or their AnyString
    // supertype. Flatten + write its bytes to fd=1/fd=2 instead of dropping it
    // and emitting the "[object]" placeholder.
    //
    // #1723 ROOT CAUSE: this used to `ref.cast` the value DOWN to NativeString
    // before the call, on the assumption that "__str_flatten accepts the
    // supertype, so any non-flat tree is handled there". But the downcast runs
    // BEFORE flatten — so a ConsString value (the common case for any
    // multi-segment response, e.g. the Native Messaging host's
    // `{"received":${body},...}`) trapped with "illegal cast" at the call site,
    // never reaching flatten. The host worked for tiny single-segment messages
    // (still flat) and trapped once the response became a rope.
    //
    // FIX: `__wasi_write_any_string` now takes the AnyString supertype
    // (see ensureWasiWriteAnyStringHelper), so NO downcast is needed — a
    // NativeString or ConsString value is already a subtype of AnyString and
    // passes directly. For a `ref_null` we only need the non-null guarantee;
    // `ref.as_non_null` keeps the value's (sub)type intact instead of forcing
    // it to NativeString. Flatten inside the helper collapses any rope.
    const refKind = exprType.kind;
    if (refKind === "ref_null") {
      fctx.body.push({ op: "ref.as_non_null" });
    }
    const writeAnyIdx = ensureWasiWriteAnyStringHelper(ctx, useStderr);
    if (writeAnyIdx >= 0) {
      fctx.body.push({ op: "call", funcIdx: writeAnyIdx });
    } else {
      // Helper unavailable (no native strings) — fall back to placeholder.
      fctx.body.push({ op: "drop" });
      const placeholder = wasiAllocStringData(ctx, "[object]");
      writeStr(placeholder.offset, placeholder.length);
    }
  } else {
    // For other types (externref, etc.), just drop and write a placeholder
    fctx.body.push({ op: "drop" });
    const placeholder = wasiAllocStringData(ctx, "[object]");
    writeStr(placeholder.offset, placeholder.length);
  }
}

/**
 * Ensure the __wasi_write_i32 helper exists and return its function index.
 *
 * #1493: when `useStderr` is true, registers/uses a `__wasi_write_i32_stderr`
 * variant that routes the formatted digits through __wasi_write_string_stderr
 * (fd=2) instead of __wasi_write_string (fd=1).
 */
/**
 * Offset of the WASI integer-formatting (itoa) scratch buffer (#1724).
 *
 * Lives in the reserved low-scratch region (0..1023) that `registerWasiImports`
 * keeps below the first string-literal data segment (which starts at 1024). We
 * use offset 16 — above the iovec (memory[0..7]) and nwritten (memory[8..11])
 * that `__wasi_write_string` populates, and below Math.random's offset-64
 * scratch. 16 bytes is ample: a 32-bit int is at most 10 digits + sign = 11
 * bytes, and the helper reserves a 11-byte window from this base.
 *
 * Previously the itoa buffer used `global.get $__wasi_bump_ptr`, which
 * initialises to 1024 and is never advanced — colliding head-on with the
 * string-literal data segments (also based at 1024). That overwrote literal
 * bytes mid-string when a number was formatted between literal writes (#1724:
 * `"received"` -> `"re60ived"`). Anchoring to 16 removes the aliasing.
 */
const WASI_ITOA_SCRATCH = 16;

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
  const funcIdx = mintDefinedFunc(ctx);
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
    // buf_start = WASI_ITOA_SCRATCH (#1724). MUST NOT be the bump pointer
    // (=1024), which aliases the string-literal data segments — see the
    // WASI_ITOA_SCRATCH doc comment for the full root cause.
    { op: "i32.const", value: WASI_ITOA_SCRATCH },
    { op: "local.set", index: bufStartLocal },
    // buf_pos = buf_start + 11 (write digits right-to-left, max 11 digits + sign)
    { op: "local.get", index: bufStartLocal },
    { op: "i32.const", value: 11 },
    { op: "i32.add" },
    { op: "local.set", index: bufPosLocal },

    // Check if value == 0
    { op: "local.get", index: 0 },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // Write "0" directly
        { op: "local.get", index: bufPosLocal },
        { op: "i32.const", value: 48 }, // '0'
        { op: "i32.store8", align: 0, offset: 0 },
        { op: "local.get", index: bufPosLocal },
        { op: "i32.const", value: 1 },
        { op: "call", funcIdx: writeStringIdx },
        { op: "return" },
      ],
    },

    // Check if negative
    { op: "local.get", index: 0 },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "local.set", index: isNegLocal },

    // absVal = is_neg ? -value : value
    { op: "local.get", index: isNegLocal },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }, { op: "local.get", index: 0 }, { op: "i32.sub" }],
      else: [{ op: "local.get", index: 0 }],
    },
    { op: "local.set", index: absValLocal },

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
            { op: "local.get", index: absValLocal },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },

            // digit = absVal % 10
            { op: "local.get", index: absValLocal },
            { op: "i32.const", value: 10 },
            { op: "i32.rem_u" },
            { op: "local.set", index: tmpLocal },

            // absVal = absVal / 10
            { op: "local.get", index: absValLocal },
            { op: "i32.const", value: 10 },
            { op: "i32.div_u" },
            { op: "local.set", index: absValLocal },

            // buf_pos--
            { op: "local.get", index: bufPosLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.set", index: bufPosLocal },

            // memory[buf_pos] = digit + '0'
            { op: "local.get", index: bufPosLocal },
            { op: "local.get", index: tmpLocal },
            { op: "i32.const", value: 48 },
            { op: "i32.add" },
            { op: "i32.store8", align: 0, offset: 0 },

            // continue loop
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // If negative, prepend '-'
    { op: "local.get", index: isNegLocal },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: bufPosLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.set", index: bufPosLocal },
        { op: "local.get", index: bufPosLocal },
        { op: "i32.const", value: 45 }, // '-'
        { op: "i32.store8", align: 0, offset: 0 },
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
    { op: "local.get", index: bufPosLocal },
    { op: "local.get", index: bufStartLocal },
    { op: "i32.const", value: 11 },
    { op: "i32.add" },
    { op: "local.get", index: bufPosLocal },
    { op: "i32.sub" },
    { op: "call", funcIdx: writeStringIdx },
  );

  pushDefinedFunc(ctx, funcIdx, {
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
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);

  // Allocate data segments for special values
  const nanData = wasiAllocStringData(ctx, "NaN");
  const infData = wasiAllocStringData(ctx, "Infinity");
  const negInfData = wasiAllocStringData(ctx, "-Infinity");

  const body: Instr[] = [
    // Check NaN: value != value
    { op: "local.get", index: 0 },
    { op: "local.get", index: 0 },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: nanData.offset },
        { op: "i32.const", value: nanData.length },
        { op: "call", funcIdx: writeStringIdx },
        { op: "return" },
      ],
    },

    // Check positive infinity
    { op: "local.get", index: 0 },
    { op: "f64.const", value: Infinity },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: infData.offset },
        { op: "i32.const", value: infData.length },
        { op: "call", funcIdx: writeStringIdx },
        { op: "return" },
      ],
    },

    // Check negative infinity
    { op: "local.get", index: 0 },
    { op: "f64.const", value: -Infinity },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: negInfData.offset },
        { op: "i32.const", value: negInfData.length },
        { op: "call", funcIdx: writeStringIdx },
        { op: "return" },
      ],
    },

    // Normal number: truncate to i32 and print
    { op: "local.get", index: 0 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "call", funcIdx: writeI32Idx },
  ];

  pushDefinedFunc(ctx, funcIdx, {
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

  // ToNumber(Symbol) must throw TypeError (§7.1.4 step 5) — see
  // tonumber-symbol-throw.ts; `Math.abs(Symbol())` used to leak the raw id.
  const mathSym = emitSymbolArgToNumberThrow(ctx, fctx, expr.arguments, { kind: "f64" });
  if (mathSym !== undefined) return mathSym;

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
    fctx.body.push({ op: "local.tee", index: xLocal });
    fctx.body.push({ op: "f64.floor" });
    fctx.body.push({ op: "local.set", index: floorLocal });
    // frac = x - floor(x)
    fctx.body.push({ op: "local.get", index: xLocal });
    fctx.body.push({ op: "local.get", index: floorLocal });
    fctx.body.push({ op: "f64.sub" });
    // frac >= 0.5 ? ceil(x) : floor(x)
    fctx.body.push({ op: "f64.const", value: 0.5 });
    fctx.body.push({ op: "f64.ge" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "local.get", index: xLocal }, { op: "f64.ceil" }],
      else: [{ op: "local.get", index: floorLocal }],
    });
    fctx.body.push({ op: "local.tee", index: rLocal });
    // If result == 0, use copysign(0, x) to preserve -0
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: 0 }, { op: "local.get", index: xLocal }, { op: "f64.copysign" }],
      else: [{ op: "local.get", index: rLocal }],
    });
    return { kind: "f64" };
  }

  // Use own-property semantics, NOT the `in` operator: `in` walks the prototype
  // chain, so an inherited `Object.prototype` name — `Math.hasOwnProperty(…)`,
  // `Math.toString()`, `Math.valueOf()`, `Math.constructor(…)`, etc. — would
  // spuriously match this table and push `{ op: <inherited function> }` (a
  // non-string op), crashing codegen downstream with "op.endsWith is not a
  // function" (#3044). `Object.hasOwn` keeps the dispatch to the six genuine
  // native-unary Math methods; anything else falls through to `return undefined`
  // → generic call handling (which resolves `Math.hasOwnProperty` correctly).
  if (Object.hasOwn(nativeUnary, method) && expr.arguments.length >= 1) {
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    fctx.body.push({ op: nativeUnary[method]! } as Instr); // computed-op
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
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    fctx.body.push({ op: "i32.clz" });
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { kind: "f64" };
  }

  // Math.imul(a, b) → ToUint32(a) * ToUint32(b), result as signed i32
  if (method === "imul" && expr.arguments.length >= 2) {
    const toU32Idx = ctx.funcMap.get("__toUint32");
    compileExpression(ctx, fctx, expr.arguments[0]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    compileExpression(ctx, fctx, expr.arguments[1]!, f64Hint);
    if (toU32Idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toU32Idx });
    } else {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    fctx.body.push({ op: "i32.mul" });
    fctx.body.push({ op: "f64.convert_i32_s" });
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
    fctx.body.push({ op: "f64.ne" });
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
        { op: "f64.abs" },
        { op: "f64.const", value: 0 },
        { op: "f64.eq" },
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
    fctx.body.push({ op: "f32.demote_f64" });
    fctx.body.push({ op: "f64.promote_f32" });
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
      fctx.body.push({ op: "f64.abs" });
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
      fctx.body.push({ op: "local.get", index: hypotLocals[i]! });
      fctx.body.push({ op: "f64.abs" });
      fctx.body.push({ op: "f64.const", value: Infinity });
      fctx.body.push({ op: "f64.eq" });
      if (i > 0) {
        fctx.body.push({ op: "i32.or" });
      }
    }
    // if any is Inf, return +Infinity, else the scaled sum-of-squares (#2060).
    const thenBlock: Instr[] = [{ op: "f64.const", value: Infinity }];

    // Naive `sqrt(Σ aᵢ²)` overflows above ~1e154 and underflows below ~1e-162
    // because each square leaves the f64 range. Scale by the largest magnitude
    // `m = max(|aᵢ|)`: result = m * sqrt(Σ (aᵢ/m)²). Each ratio is in [0,1], so
    // its square is representable, and the single multiply by `m` at the end
    // restores the true magnitude. When `m == 0` every arg is ±0, so the result
    // is 0 (and we must avoid the 0/0 = NaN the scaling would otherwise yield).
    const mLocal = allocLocal(fctx, `__hypot_m_${fctx.locals.length}`, { kind: "f64" });
    const elseBlock: Instr[] = [];
    // m = max(|a0|, |a1|, ...) via f64.max over the absolute values.
    elseBlock.push({ op: "local.get", index: hypotLocals[0]! });
    elseBlock.push({ op: "f64.abs" });
    for (let i = 1; i < hypotLocals.length; i++) {
      elseBlock.push({ op: "local.get", index: hypotLocals[i]! });
      elseBlock.push({ op: "f64.abs" });
      elseBlock.push({ op: "f64.max" });
    }
    elseBlock.push({ op: "local.set", index: mLocal });

    // Guard m == 0 → 0; else m * sqrt(Σ (aᵢ/m)²).
    elseBlock.push({ op: "local.get", index: mLocal });
    elseBlock.push({ op: "f64.const", value: 0 });
    elseBlock.push({ op: "f64.eq" });
    const scaledBlock: Instr[] = [];
    for (let i = 0; i < hypotLocals.length; i++) {
      scaledBlock.push({ op: "local.get", index: hypotLocals[i]! });
      scaledBlock.push({ op: "local.get", index: mLocal });
      scaledBlock.push({ op: "f64.div" });
      scaledBlock.push({ op: "local.get", index: hypotLocals[i]! });
      scaledBlock.push({ op: "local.get", index: mLocal });
      scaledBlock.push({ op: "f64.div" });
      scaledBlock.push({ op: "f64.mul" });
    }
    for (let i = 1; i < hypotLocals.length; i++) {
      scaledBlock.push({ op: "f64.add" });
    }
    scaledBlock.push({ op: "f64.sqrt" });
    scaledBlock.push({ op: "local.get", index: mLocal });
    scaledBlock.push({ op: "f64.mul" });
    elseBlock.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: 0 }],
      else: scaledBlock,
    });

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
      });
      return { kind: "f64" };
    }

    // Spread arguments (`Math.max(...arr)`, `Math.min(0, ...arr)`): fold the
    // backing vec at runtime. Without this the generic SpreadElement
    // passthrough in compileExpressionInner unwraps `...arr` to `arr`, and the
    // array coerces to NaN. (#2054)
    if (expr.arguments.some((a) => ts.isSpreadElement(a))) {
      const spreadResult = compileMathMinMaxSpread(ctx, fctx, expr, method);
      if (spreadResult) return spreadResult;
      // Fall through to the legacy path only if every spread resolved to a
      // recognisable native vec failed — compileMathMinMaxSpread returns null
      // when a spread argument's element type cannot be resolved, leaving the
      // historical (incorrect) behaviour rather than emitting invalid Wasm.
    }

    // Check if any argument is statically NaN → evaluate all args for side effects, then return NaN
    if (expr.arguments.some((a) => isStaticNaN(ctx, a))) {
      // Must still evaluate all arguments (ToNumber coercion / side effects)
      for (const arg of expr.arguments) {
        if (!isStaticNaN(ctx, arg)) {
          compileExpression(ctx, fctx, arg, f64Hint);
          fctx.body.push({ op: "drop" });
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
        { op: "f64.ne" },
        {
          op: "if",
          blockType: f64Block,
          then: [{ op: "local.get", index: argLocals[i]! }],
          else: innerBody,
        },
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

/**
 * Lower `Math.min(...)` / `Math.max(...)` when at least one argument is a
 * SpreadElement (`Math.max(...arr)`, `Math.min(0, ...arr, 9)`). Folds the
 * arguments left to right into an f64 accumulator seeded with the identity
 * (+Infinity for min, -Infinity for max), iterating each spread's backing vec
 * with a native loop. NaN is tracked in a flag and propagated to the result
 * (§21.3.2.24/25: the result is NaN if any value is NaN).
 *
 * Returns null if a spread argument's element type cannot be resolved to a
 * numeric native vec (e.g. externref element); the caller then keeps the
 * legacy behaviour rather than emitting invalid Wasm. (#2054)
 */
function compileMathMinMaxSpread(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: "min" | "max",
): ValType | null {
  const wasmOp = method === "min" ? "f64.min" : "f64.max";

  // Pre-resolve each spread's vec info; bail (null) before emitting anything
  // if any spread element type is not a numeric native vec.
  const spreadInfos = new Map<ts.SpreadElement, { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType }>();
  for (const arg of expr.arguments) {
    if (!ts.isSpreadElement(arg)) continue;
    const innerTsType = ctx.checker.getTypeAtLocation(arg.expression);
    const info = resolveArrayInfo(ctx, innerTsType);
    if (!info) return null;
    if (info.elemType.kind !== "f64" && info.elemType.kind !== "i32") return null;
    spreadInfos.set(arg, info);
  }

  const accLocal = allocLocal(fctx, `__minmax_acc_${fctx.locals.length}`, { kind: "f64" });
  const nanLocal = allocLocal(fctx, `__minmax_nan_${fctx.locals.length}`, { kind: "i32" });

  // Seed: acc = identity, sawNaN = 0
  fctx.body.push({ op: "f64.const", value: method === "min" ? Infinity : -Infinity });
  fctx.body.push({ op: "local.set", index: accLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: nanLocal });

  // Fold one f64 value (already on the stack) into acc, NaN-guarded.
  const emitFoldStackValue = () => {
    const vTmp = allocTempLocal(fctx, { kind: "f64" });
    fctx.body.push({ op: "local.tee", index: vTmp });
    // isNaN(v): v !== v
    fctx.body.push({ op: "local.get", index: vTmp });
    fctx.body.push({ op: "f64.ne" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: nanLocal },
      ],
      else: [
        { op: "local.get", index: accLocal },
        { op: "local.get", index: vTmp },
        { op: wasmOp },
        { op: "local.set", index: accLocal },
      ],
    });
    releaseTempLocal(fctx, vTmp);
  };

  for (const arg of expr.arguments) {
    if (!ts.isSpreadElement(arg)) {
      // Positional numeric argument: compile to f64 and fold.
      compileExpression(ctx, fctx, arg, { kind: "f64" });
      emitFoldStackValue();
      continue;
    }

    const info = spreadInfos.get(arg)!;
    const vecLocal = allocLocal(fctx, `__minmax_vec_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: info.vecTypeIdx,
    });
    const dataLocal = allocLocal(fctx, `__minmax_data_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: info.arrTypeIdx,
    });
    const lenLocal = allocLocal(fctx, `__minmax_len_${fctx.locals.length}`, { kind: "i32" });
    const idxLocal = allocLocal(fctx, `__minmax_idx_${fctx.locals.length}`, { kind: "i32" });

    // vec = arr; if (vec == null) skip (empty contributes nothing).
    compileExpression(ctx, fctx, arg.expression);
    fctx.body.push({ op: "local.set", index: vecLocal });

    const loopBody: Instr[] = [
      // len = vec.length
      { op: "local.get", index: vecLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: info.vecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: lenLocal },
      // data = vec.data
      { op: "local.get", index: vecLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: info.vecTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: dataLocal },
      // idx = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: idxLocal },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if (idx >= len) break
              { op: "local.get", index: idxLocal },
              { op: "local.get", index: lenLocal },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // push data[idx] as f64, fold
              { op: "local.get", index: dataLocal },
              { op: "local.get", index: idxLocal },
              { op: "array.get", typeIdx: info.arrTypeIdx },
              ...(info.elemType.kind === "i32" ? ([{ op: "f64.convert_i32_s" }] satisfies Instr[]) : []),
              ...buildFoldInstrs(fctx, accLocal, nanLocal, wasmOp),
              // idx++
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: idxLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ];

    // Guard the whole loop on non-null vec (null array → contributes nothing).
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: loopBody,
    });
  }

  // result = sawNaN ? NaN : acc
  fctx.body.push({ op: "f64.const", value: NaN });
  fctx.body.push({ op: "local.get", index: accLocal });
  fctx.body.push({ op: "local.get", index: nanLocal });
  fctx.body.push({ op: "select" });
  return { kind: "f64" };
}

/**
 * Build the NaN-guarded fold of one f64 value (on the stack) into accLocal,
 * as a self-contained instruction list (used inside loop bodies where we build
 * Instr[] arrays rather than pushing to fctx.body directly).
 */
function buildFoldInstrs(
  fctx: FunctionContext,
  accLocal: number,
  nanLocal: number,
  wasmOp: "f64.min" | "f64.max",
): Instr[] {
  const vTmp = allocTempLocal(fctx, { kind: "f64" });
  const instrs: Instr[] = [
    { op: "local.tee", index: vTmp },
    { op: "local.get", index: vTmp },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: nanLocal },
      ],
      else: [
        { op: "local.get", index: accLocal },
        { op: "local.get", index: vTmp },
        { op: wasmOp },
        { op: "local.set", index: accLocal },
      ],
    },
  ];
  releaseTempLocal(fctx, vTmp);
  return instrs;
}

export { compileConsoleCall, compileDateMethodCall, compileMathCall, wasiAllocStringData };
