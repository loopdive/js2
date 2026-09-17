// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";

/** Selected conversion arm; omission is never a request to drop native strings. */
export type NativeNumberStringConversion =
  | { readonly kind: "native-string"; readonly anyStringTypeIdx: number; readonly toNumber: FuncHandle }
  | { readonly kind: "absent"; readonly evidence: "selected-primitive-only" };

/** Parameter 0 is f64; local 1 retains the donor's signed-i31 candidate. */
export function buildBoxNumberLocals(): LocalDef[] {
  return [{ name: "$i31_temp", type: { kind: "i32" } }];
}

// 3. __box_number(f64) -> externref
// (#3673) i31 fast path: an integral value in the signed-31-bit range is
// encoded as an UNBOXED `(ref i31)` — no allocation. Every consumer that
// discriminates boxed numbers carries a matching i31 arm. Excluded: -0
// (i31 cannot carry the sign — `1/x` and Object.is would lose it), NaN and
// infinities (fail the trunc round-trip), and values outside [-2^30, 2^30-1]
// (fail the shl/shr round-trip).
export function buildBoxNumberBody(boxNumStructIdx: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: 1 },
    { op: "f64.convert_i32_s" },
    { op: "local.get", index: 0 },
    { op: "f64.eq" }, // integral (and clamp-free) round-trip
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 1 },
    { op: "i32.shl" },
    { op: "i32.const", value: 1 },
    { op: "i32.shr_s" },
    { op: "local.get", index: 1 },
    { op: "i32.eq" }, // fits signed 31 bits
    { op: "i32.and" },
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
    { op: "local.get", index: 0 },
    { op: "i64.reinterpret_f64" },
    { op: "i64.const", value: 0n },
    { op: "i64.lt_s" },
    { op: "i32.eqz" },
    { op: "i32.or" }, // t != 0 || sign bit clear (rejects -0 only)
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "local.get", index: 1 }, { op: "ref.i31" }, { op: "extern.convert_any" }],
      else: [
        { op: "local.get", index: 0 },
        { op: "struct.new", typeIdx: boxNumStructIdx },
        { op: "extern.convert_any" },
      ],
    },
  ];
}

export function buildUnboxNumberLocals(): LocalDef[] {
  return [{ name: "$any_temp", type: { kind: "anyref" } }];
}

// 4. __unbox_number(externref) -> f64
//    Local 1 is an anyref temp used to ref.test then ref.cast without
//    re-evaluating the parameter (which is fine — it's a local.get —
//    but the temp shape mirrors the spec'd structure for symmetry).
export function buildUnboxNumberBody(
  boxNumStructIdx: number,
  boxBoolStructIdx: number,
  strings: NativeNumberStringConversion,
): Instr[] {
  if (!strings || (strings.kind !== "native-string" && strings.kind !== "absent"))
    throw new Error("native number bodies: missing explicit string conversion");
  if (strings.kind === "absent" && strings.evidence !== "selected-primitive-only")
    throw new Error("native number bodies: missing string absence evidence");
  if (
    strings.kind === "native-string" &&
    (!Number.isInteger(strings.anyStringTypeIdx) ||
      strings.anyStringTypeIdx < 0 ||
      !Number.isInteger(strings.toNumber) ||
      strings.toNumber < 0)
  )
    throw new Error("native number bodies: unresolved string conversion binding");
  return [
    // if (ref.is_null param) return 0   // Number(null) === 0
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: 0 }, { op: "return" }],
    },
    // any = any.convert_extern(param)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: 1 },
    // (#3673) i31-boxed small int → its value.
    { op: "local.get", index: 1 },
    { op: "ref.test", typeIdx: -20 },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: -20 },
        { op: "i31.get_s" },
        { op: "f64.convert_i32_s" },
        { op: "return" },
      ],
    },
    { op: "local.get", index: 1 },
    // if (ref.test $box_number_struct any) return any.value
    { op: "ref.test", typeIdx: boxNumStructIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: boxNumStructIdx },
        { op: "struct.get", typeIdx: boxNumStructIdx, fieldIdx: 0 },
        { op: "return" },
      ],
    },
    // #1910 R3 — a boxed boolean (the [[BooleanData]] slot of a
    // `new Boolean(x)` wrapper, recovered by `__to_primitive`) coerces per
    // §7.1.4 ToNumber(true)=1, ToNumber(false)=0. Without this arm a boxed
    // boolean fell through to the opaque-ref NaN fallback, so
    // `Number(new Boolean(true))` returned NaN instead of 1.
    { op: "local.get", index: 1 },
    { op: "ref.test", typeIdx: boxBoolStructIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: boxBoolStructIdx },
        { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
        { op: "f64.convert_i32_s" },
        { op: "return" },
      ],
    },
    ...(strings.kind === "native-string"
      ? ([
          // StringToNumber (§7.1.4.1): object ToPrimitive can yield a native
          // string; parse it with the existing pure-Wasm scanner before the
          // opaque-ref NaN fallback.
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: strings.anyStringTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: strings.toNumber }, { op: "return" }],
          },
        ] satisfies Instr[])
      : []),
    // not a recognized boxed number → NaN (matches Number(opaque))
    { op: "f64.const", value: NaN },
  ];
}

// 8. __typeof_number(externref) -> i32 — `ref.test $box_number_struct`.
export function buildTypeofNumberBody(boxNumStructIdx: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: boxNumStructIdx },
    // (#3673) …or an i31-boxed small int.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: -20 },
    { op: "i32.or" },
  ];
}
