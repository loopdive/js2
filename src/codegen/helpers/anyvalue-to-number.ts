// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6998) ToNumber for the string (tag 5) and object (tag 6) payloads of an
 * `$AnyValue` box, for `coerceType`'s inline `$AnyValue → f64` dispatch.
 *
 * That dispatch decodes the numeric tags in place (2/4 → `i32val`, 1 → NaN,
 * 0/3 → `f64val`) and used to read `f64val` for tags 5 and 6 as well — a field
 * that is `0` for a string or an object. So a `string | number` holding `"9"`
 * multiplied by 2 gave 0, `"abc"` gave 0 instead of NaN, and an object's
 * `valueOf` was never called.
 *
 * Tags 5/6 carry their payload as a reference (tag 5: `externval`, tag 6:
 * `refval`), so the correct conversion is the one every dynamic externref
 * already takes on a host-free target: §7.1.1 ToPrimitive (`__to_primitive`)
 * then §7.1.4 ToNumber (`__unbox_number`, whose native body runs the
 * StringToNumber scanner). Both instruction runs come from the coercion engine
 * (`runtimeToPrimitiveInstrs` / `runtimeToNumberInstrs`), which also registers
 * the helper (`ensureAnyValuePayloadToNumber`); this file only shapes the Wasm
 * and imports nothing at runtime, so it stays out of the value-import SCC.
 *
 * Host-free targets only: the js-host lane keeps its bytes.
 */
import type { Instr } from "../../ir/types.js";

const TAG_STRING = 5;
const TAG_OBJECT = 6;
const FIELD_F64 = 2;
const FIELD_REF = 3;
const FIELD_EXTERN = 4;

/**
 * Body of the out-of-line `(ref null $AnyValue) → f64` helper for tags 5/6:
 * tag 5 converts `externval`, tag 6 converts `extern.convert_any(refval)`, each
 * with `convert` (an externref → f64 run). Registered by the coercion engine's
 * `ensureAnyValuePayloadToNumber`; kept out of line so every inline dispatch
 * site pays one cold `call`, not a copy of the chain (hot numeric twins stay
 * call-free on their fast tags — #3765).
 */
export function anyValuePayloadToNumberBody(anyTypeIdx: number, convert: readonly Instr[]): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: TAG_STRING },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: FIELD_EXTERN },
        ...convert.map((i) => ({ ...i })),
      ],
      else: [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: FIELD_REF },
        { op: "extern.convert_any" },
        ...convert.map((i) => ({ ...i })),
      ],
    },
  ];
}

/**
 * The dispatch's final arm (tags 0/3/5/6 reach it). Without the helper this is
 * the historical `f64val` read; with it, tags 5/6 call the helper.
 */
export function anyValueF64DefaultArm(
  anyTypeIdx: number,
  anyLocal: number,
  tagLocal: number,
  payloadToNumber: number | null,
): Instr[] {
  const readF64: Instr[] = [
    { op: "local.get", index: anyLocal },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: FIELD_F64 },
  ];
  if (payloadToNumber === null) return readF64;
  const isTag = (tag: number): Instr[] => [
    { op: "local.get", index: tagLocal },
    { op: "i32.const", value: tag },
    { op: "i32.eq" },
  ];
  return [
    ...isTag(TAG_STRING),
    ...isTag(TAG_OBJECT),
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "call", funcIdx: payloadToNumber },
      ],
      else: readF64,
    },
  ];
}
