// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared descriptor instructions for the `$Vec` length overlay.
 *
 * Arrays and arguments objects share the physical vector representation, but
 * their ordinary `length` properties have different default configurability.
 * Keep the brand-sensitive seed and descriptor reads out of the overlay
 * emitter so the length implementation remains within its subsystem budget.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import {
  ARGUMENTS_LENGTH_ABSENT_FIELD,
  ARGUMENTS_LENGTH_OVERRIDE_FIELD,
  ARGUMENTS_LENGTH_VALUE_FIELD,
  buildArgumentsBrandBit,
} from "./arguments-length-brand.js";

const FLAG_CONFIGURABLE = 0x04;

/** Seed flags for a length companion, preserving the arguments default. */
export function buildLengthSeedFlags(ctx: CodegenContext, anyLocal: number, arrayFlags: number): Instr[] {
  const argumentsTypeIdx = ctx.structMap.get("__arguments_vec");
  if (argumentsTypeIdx === undefined) return [{ op: "f64.const", value: arrayFlags }];
  return [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx: argumentsTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: arrayFlags | FLAG_CONFIGURABLE }],
      else: [{ op: "f64.const", value: arrayFlags }],
    },
  ];
}

/**
 * Read a synthesized length's configurable bit. An existing companion entry
 * wins over the brand default, while object integrity still clears the bit.
 */
export function buildVecLengthConfig(
  argumentsTypeIdx: number | undefined,
  entryLocal: number,
  propEntryTypeIdx: number,
  integrityBit: (bit: number) => Instr[],
  integrityMask: number,
): Instr[] {
  return [
    { op: "local.get", index: entryLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        ...buildArgumentsBrandBit(0, argumentsTypeIdx),
        ...integrityBit(integrityMask),
        { op: "i32.eqz" },
        { op: "i32.and" },
      ],
      else: [
        { op: "local.get", index: entryLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
        { op: "i32.const", value: FLAG_CONFIGURABLE },
        { op: "i32.and" },
        { op: "i32.const", value: 0 },
        { op: "i32.ne" },
        ...integrityBit(integrityMask),
        { op: "i32.and" },
      ],
    },
  ];
}

/**
 * (#6651 cluster H) The `value` field of a synthesized `length` descriptor.
 *
 * For an Array the answer is the LIVE vec length field — never a companion
 * copy, which goes stale on push/pop (the rule `lengthGopdBody` states). An
 * `arguments` exotic object shares that representation but NOT that rule:
 * §10.4.4 makes its `length` an ORDINARY data property, so an explicit
 * `args.length = v` / `defineProperty(args, "length", {value: v})` stores an
 * arbitrary JS value in the `$__arguments_vec` override fields and leaves the
 * index domain alone.
 *
 * Without this arm the three surfaces disagreed. Measured on the branch base,
 * standalone, on a 3-argument `arguments` after `args.length = 6`: the READ
 * (`args.length`) answered 6 through the override arm in `object-runtime.ts`,
 * while `Object.getOwnPropertyDescriptor(args, "length").value` answered 3 —
 * the physical count — for the same property in the same module.
 *
 * The stored value is reported RAW (not ToLength-converted): a descriptor's
 * `[[Value]]` is what was stored, so `args.length = "unlikelyValue"` — which
 * is exactly what `propertyHelper.isWritable` writes — must read back as that
 * string here, while the array-like `__extern_length` consumer applies §7.1.20
 * to the same field.
 */
export function buildVecLengthDescriptorValue(
  ctx: CodegenContext,
  anyLocal: number,
  vecBaseIdx: number,
  boxNumIdx: number,
): Instr[] {
  const physical: Instr[] = [
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: vecBaseIdx },
    { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: boxNumIdx },
  ];
  const argumentsTypeIdx = ctx.structMap.get("__arguments_vec");
  if (argumentsTypeIdx === undefined) return physical;
  const cast: Instr[] = [
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: argumentsTypeIdx },
  ];
  return [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx: argumentsTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [...cast, { op: "struct.get", typeIdx: argumentsTypeIdx, fieldIdx: ARGUMENTS_LENGTH_OVERRIDE_FIELD }],
      else: [{ op: "i32.const", value: 0 }],
    },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [...cast, { op: "struct.get", typeIdx: argumentsTypeIdx, fieldIdx: ARGUMENTS_LENGTH_VALUE_FIELD }],
      else: physical,
    },
  ];
}

/**
 * (#6651 cluster H) `__vec_dp_value`'s `"length"` arm for an `arguments`
 * receiver — §10.4.4, where `length` is an ORDINARY data property, so
 * ArraySetLength (§10.4.2.1) does not describe it.
 *
 * What it replaces: routing `Object.defineProperty(args, "length", {value: n})`
 * through the Array body GREW the physical backing (`array.new_default` +
 * `array.copy`), so the new tail read back as wasm null — JS `null`, not
 * `undefined` — and `n in args` answered TRUE for a slot that is not an own
 * property. Measured on the branch base, standalone, on a 3-argument
 * `arguments` after `defineProperty(args, "length", {value: 6})`: `args[4]`
 * was `null` and `4 in args` was `true`, and `[].concat(args)` produced
 * `[1, 2, 3, null, null, null]` where §23.1.3.1 wants three values and three
 * holes (test262 `Array.prototype.concat_{sloppy-arguments,
 * sloppy-arguments-with-dupes,strict-arguments}.js`).
 *
 * The ASSIGNMENT half already models the rule correctly — `member-set-
 * dispatch.ts`'s `argumentsLengthSetArm` and `vec-length-set.ts`'s
 * `__extern_set` arm both record the value in the `$__arguments_vec` override
 * fields and leave the index domain alone — so this is the define half of ONE
 * rule rather than a second rule, and the two cannot disagree.
 *
 * Gated on the descriptor actually carrying a `value` (the host flag bit the
 * caller passes): an attribute-only define (`{writable: false}`) changes no
 * length and keeps its existing path. `[]` — and therefore byte-identical
 * output — for any module that never branded an arguments object.
 *
 * Deliberate residual: the descriptor ATTRIBUTES of an arguments `length` are
 * still answered from the brand defaults above, not from the descriptor this
 * define carried — exactly as the assignment half leaves them.
 *
 * `__vec_dp_value`'s fixed frame: param 0 = receiver (externref), param 2 =
 * value, param 3 = flags (f64), local 4 = that receiver as `anyref`.
 */
export function buildArgumentsOrdinaryLengthDefineArm(ctx: CodegenContext, hasValueBit: number): Instr[] {
  const typeIdx = ctx.structMap.get("__arguments_vec");
  if (typeIdx === undefined) return [];
  const setField = (fieldIdx: number, value: Instr[]): Instr[] => [
    { op: "local.get", index: 4 },
    { op: "ref.cast", typeIdx },
    ...value,
    { op: "struct.set", typeIdx, fieldIdx },
  ];
  return [
    { op: "local.get", index: 4 },
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        { op: "i32.trunc_f64_s" },
        { op: "i32.const", value: hasValueBit },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...setField(ARGUMENTS_LENGTH_VALUE_FIELD, [{ op: "local.get", index: 2 }]),
            ...setField(ARGUMENTS_LENGTH_OVERRIDE_FIELD, [{ op: "i32.const", value: 1 }]),
            ...setField(ARGUMENTS_LENGTH_ABSENT_FIELD, [{ op: "i32.const", value: 0 }]),
            { op: "local.get", index: 0 },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}
