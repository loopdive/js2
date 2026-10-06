// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { demandStringWrapperDynamicLength, stringWrapperLengthArm } from "../string-wrapper-dynamic-length.js";

/**
 * (#6875) Prepend a native-string RECEIVER arm onto the finalized
 * `__extern_get`. An `externref`-carried native string (an untyped or `any`
 * parameter, a `JSON.parse` result, a dynamic array element) reaches the
 * dynamic getter as `extern.convert_any(ref $AnyString)`, and until now no arm
 * tested the receiver for it: the `$AnyString` test near the top of the helper
 * is on the KEY. The read fell through the object / boundary / vec / closure
 * ladder to the undefined miss, so `input.length` on an untyped parameter
 * read `undefined` on standalone and on the native regime (hono's npm-compat
 * driver, `len(JSON.parse('"abcd"'))` on standalone).
 *
 * Answers exactly what the string-exotic WRAPPER arm answers for a `new
 * String(...)` object — `length` and an in-range canonical integer index —
 * with the same helpers, and falls through for every other key (a
 * `String.prototype` member read through a dynamic receiver stays on its
 * existing path). Standalone-only machinery (`ctx.standalone`): the host lane's
 * `__extern_get` is an import.
 */
export function unshiftExternGetNativeStringReceiverArm(ctx: CodegenContext): void {
  if (!ctx.standalone || !ctx.nativeStrings || ctx.anyStrTypeIdx < 0 || ctx.nativeStrTypeIdx < 0) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  if (!fn) return;
  demandStringWrapperDynamicLength(ctx);
  const strToNumIdx = ctx.funcMap.get("__str_to_number");
  const numToStringIdx = ctx.funcMap.get("number_toString");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
  const typeofNumberIdx = ctx.funcMap.get("__typeof_number");
  const unboxNumberIdx = ctx.funcMap.get("__unbox_number");
  if (
    typeofNumberIdx === undefined ||
    unboxNumberIdx === undefined ||
    strToNumIdx === undefined ||
    numToStringIdx === undefined ||
    flattenIdx === undefined ||
    equalsIdx === undefined ||
    charAtIdx === undefined
  )
    return;

  const base = 2 + fn.locals.length;
  const stringData = base;
  const index = base + 1;
  const keyFlat = base + 2;
  const numberFlat = base + 3;
  const indexI32 = base + 4;
  fn.locals.push(
    { name: "__string_recv_data", type: { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx } },
    { name: "__string_recv_index", type: { kind: "f64" } },
    { name: "__string_recv_key", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
    { name: "__string_recv_number", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
    { name: "__string_recv_i32", type: { kind: "i32" } },
  );

  // Code unit at `index` (an integral, non-negative f64) when in range.
  const charAtIndex: Instr[] = [
    { op: "local.get", index },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: indexI32 },
    { op: "local.get", index: indexI32 },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    { op: "local.get", index: indexI32 },
    { op: "local.get", index: stringData },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 },
    { op: "i32.lt_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: stringData },
        { op: "ref.as_non_null" },
        { op: "call", funcIdx: flattenIdx },
        { op: "local.get", index: indexI32 },
        { op: "call", funcIdx: charAtIdx },
        { op: "extern.convert_any" },
        { op: "return" },
      ],
    },
  ];

  // A string key that is a canonical numeric string (`"2"`, not `"02"`).
  const stringKeyArm: Instr[] = [
    ...stringWrapperLengthArm(ctx, 1, stringData),
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: strToNumIdx },
    { op: "local.tee", index },
    { op: "local.get", index },
    { op: "f64.eq" }, // n == n: not NaN
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        { op: "call", funcIdx: flattenIdx },
        { op: "local.set", index: keyFlat },
        { op: "local.get", index },
        { op: "call", funcIdx: numToStringIdx },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        { op: "call", funcIdx: flattenIdx },
        { op: "local.set", index: numberFlat },
        { op: "local.get", index: keyFlat },
        { op: "local.get", index: numberFlat },
        { op: "call", funcIdx: equalsIdx },
        { op: "if", blockType: { kind: "empty" }, then: charAtIndex },
      ],
    },
  ];

  // A Number key (`s[i]`): integral and non-negative, as the vec arm classifies.
  const numberKeyArm: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: typeofNumberIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: unboxNumberIdx },
        { op: "local.tee", index },
        { op: "local.get", index },
        { op: "f64.trunc" },
        { op: "f64.eq" },
        { op: "local.get", index },
        { op: "f64.const", value: 0 },
        { op: "f64.ge" },
        { op: "i32.and" },
        { op: "if", blockType: { kind: "empty" }, then: charAtIndex },
      ],
    },
  ];

  const arm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        { op: "local.set", index: stringData },
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        { op: "if", blockType: { kind: "empty" }, then: stringKeyArm },
        ...numberKeyArm,
      ],
    },
  ];
  fn.body.unshift(...arm);
}
