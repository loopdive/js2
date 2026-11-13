// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6912, S3-m of #5385) `Array.prototype.{indexOf,lastIndexOf,includes}` as
 * callable VALUES on the native regime.
 *
 * The reflective spellings that are not the literal
 * `Array.prototype.indexOf.call(...)` borrow — the method stored in a variable,
 * transferred onto an ordinary object (`obj.indexOf = Array.prototype.indexOf`)
 * or reached through a computed member — call the native-proto closure, which
 * until now threw "not yet callable as a value". The closure takes the
 * receiver-aware VARIADIC ABI (`(self, this, (ref null $vec_externref))`):
 * `lastIndexOf` §23.1.3.20 step 4 distinguishes a PRESENT `fromIndex` (an
 * explicit `undefined` is ToIntegerOrInfinity'd to 0) from an omitted one
 * (len - 1), which a padded fixed slot cannot express.
 *
 * Steps (§23.1.3.17 indexOf; .20 lastIndexOf; .16 includes):
 *   1. ToObject(this) — null/undefined receiver is a TypeError.
 *   2. len = LengthOfArrayLike(O).
 *   3. len = 0 → -1 / false, BEFORE fromIndex is converted (a throwing or
 *      counting `valueOf` on fromIndex must not run).
 *   4. fromIndex → ToNumber (the coercion engine: observable valueOf/toString,
 *      Symbol throws), then the shared clamp and scan (array-search-core.ts),
 *      the same instructions the direct `.call` borrow runs.
 *
 * Gated on the native regime (`ctx.standalone || ctx.wasi`); host-assisted
 * `gc` keeps its fixed-slot closure type and its host bridge, byte-identical.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import {
  canonicalUndefinedExternInstrs,
  ensureExternSameValueZeroHelper,
  ensureExternStrictEqHelper,
} from "../any-helpers.js";
import { emitArrayProtoHofReceiverGuard, emitVariadicArgsUnpack } from "../array-reduce-proto-value.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { coerceType, ensureLateImport, flushLateImportShifts } from "../shared.js";
import {
  arraySearchDefaultStartInstrs,
  arraySearchFromIndexClampInstrs,
  arraySearchLoopInstrs,
} from "./array-search-core.js";

const SEARCH_MEMBERS: ReadonlySet<string> = new Set(["indexOf", "lastIndexOf", "includes"]);

/** True when `Array.prototype.<member>`'s closure uses the packed variadic ABI for the search family. */
export function isArraySearchVariadicMember(ctx: CodegenContext, member: string): boolean {
  return SEARCH_MEMBERS.has(member) && (ctx.standalone || ctx.wasi);
}

const EXT: ValType = { kind: "externref" };
const F64: ValType = { kind: "f64" };
const I32: ValType = { kind: "i32" };

/**
 * Emit the search-family closure body. Returns `undefined`, emitting nothing,
 * off the native regime or when a dependency is unavailable — the caller keeps
 * its refusal.
 */
export function emitArraySearchProtoMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | undefined {
  if (!isArraySearchVariadicMember(ctx, member)) return undefined;
  const isLast = member === "lastIndexOf";
  const isIncludes = member === "includes";

  // Every late-import-adding ensure BEFORE the first body instruction; funcIdx
  // values are read by NAME afterwards (the #16 discipline).
  ensureObjectRuntime(ctx); // `__extern_is_undefined` for the receiver guard
  const deps = [
    ensureLateImport(ctx, "__extern_length", [EXT], [F64]),
    ensureLateImport(ctx, "__extern_get_idx", [EXT, F64], [EXT]),
    ensureLateImport(ctx, "__extern_has_idx", [EXT, F64], [I32]),
    isIncludes ? ensureExternSameValueZeroHelper(ctx) : ensureExternStrictEqHelper(ctx),
    isIncludes
      ? ensureLateImport(ctx, "__box_boolean", [I32], [EXT])
      : ensureLateImport(ctx, "__box_number", [F64], [EXT]),
  ];
  if (deps.some((d) => d === undefined)) return undefined;
  // Pre-register whatever the ToNumber lowering needs, into a discarded body,
  // so the real conversion below adds no import after indices are baked.
  const realBody = fctx.body;
  fctx.body = [{ op: "ref.null.extern" }];
  try {
    coerceType(ctx, fctx, EXT, F64);
  } finally {
    fctx.body = realBody;
  }
  flushLateImportShifts(ctx, fctx);
  const fn = (name: string): number => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) throw new Error(`Array.prototype.${member} value body lacks ${name}`);
    return idx;
  };
  const cmpName = isIncludes ? "__extern_same_value_zero" : "__extern_strict_eq";
  const undef = canonicalUndefinedExternInstrs(ctx);

  emitArrayProtoHofReceiverGuard(ctx, fctx, member);
  const args = emitVariadicArgsUnpack(ctx, fctx, "search");
  if (args === undefined) throw new Error(`Array.prototype.${member} value body lacks its argument vector`);
  const { argsLen, argAt } = args;

  const lenTmp = allocLocal(fctx, `__search_len_${fctx.locals.length}`, F64);
  const searchTmp = allocLocal(fctx, `__search_elem_${fctx.locals.length}`, EXT);
  const iTmp = allocLocal(fctx, `__search_i_${fctx.locals.length}`, F64);
  const resTmp = allocLocal(fctx, `__search_res_${fctx.locals.length}`, isIncludes ? I32 : F64);

  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: fn("__extern_length") },
    { op: "local.set", index: lenTmp },
    ...argAt(0, undef),
    { op: "local.set", index: searchTmp },
    isIncludes ? { op: "i32.const", value: 0 } : { op: "f64.const", value: -1 },
    { op: "local.set", index: resTmp },
  );

  // fromIndex: PRESENT (argc > 1, even when it is `undefined`) → ToNumber +
  // clamp; absent → the default start.
  const convert: Instr[] = [];
  fctx.body = convert;
  try {
    fctx.body.push(...argAt(1, undef));
    coerceType(ctx, fctx, EXT, F64);
    fctx.body.push(...arraySearchFromIndexClampInstrs(isLast, iTmp, lenTmp));
  } finally {
    fctx.body = realBody;
  }
  const scan: Instr[] = [
    { op: "local.get", index: argsLen },
    { op: "i32.const", value: 1 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: convert,
      else: arraySearchDefaultStartInstrs(isLast, iTmp, lenTmp),
    },
    ...arraySearchLoopInstrs({
      isLast,
      isIncludes,
      receiverTmp: 1,
      lenTmp,
      searchTmp,
      iTmp,
      resTmp,
      getIdx: fn("__extern_get_idx"),
      hasIdx: fn("__extern_has_idx"),
      cmp: fn(cmpName),
    }),
    { op: "drop" }, // the loop leaves the result local on the stack; re-read below
  ];
  // len = 0 → the defaulted result, with fromIndex never converted.
  fctx.body.push(
    { op: "local.get", index: lenTmp },
    { op: "f64.const", value: 0 },
    { op: "f64.gt" },
    { op: "if", blockType: { kind: "empty" }, then: scan },
    { op: "local.get", index: resTmp },
    { op: "call", funcIdx: fn(isIncludes ? "__box_boolean" : "__box_number") },
  );
  return EXT;
}
