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
import { buildArgumentsBrandBit } from "./arguments-length-brand.js";

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
