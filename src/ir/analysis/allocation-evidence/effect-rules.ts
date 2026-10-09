// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { directUses, type IrInstr, type IrValueId } from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import type { AllocationEvidenceCoverageReason } from "./contracts.js";

type OperandRole = "i32" | "f64" | "receiver";
export interface ProfileOperand {
  readonly value: IrValueId;
  readonly role: OperandRole;
}

export type AllocationEvidenceEffect =
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "effects";
      readonly ownership: readonly { readonly value: IrValueId; readonly op: "read" | "write" | "escape" }[];
      readonly directEscape: readonly [];
      readonly encoding: "no-write";
    };

/** Finite descriptors only. Legacy analysis sharing is a separate source join. */
export function allocationEvidenceEffect(instr: IrInstr): AllocationEvidenceEffect {
  switch (instr.kind) {
    case "vec.get":
    case "vec.len":
      return { kind: "effects", ownership: [{ value: instr.vec, op: "read" }], directEscape: [], encoding: "no-write" };
    case "vec.set":
      return {
        kind: "effects",
        ownership: [
          { value: instr.vec, op: "write" },
          { value: instr.newValue, op: "escape" },
        ],
        directEscape: [],
        encoding: "no-write",
      };
    case "binary":
      if (instr.op !== "i32.lt_u" && instr.op !== "f64.add") return { kind: "unsupported" };
      break;
    case "const":
    case "vec.new_fixed":
    case "if":
      break;
    default:
      return { kind: "unsupported" };
  }
  return { kind: "effects", ownership: [], directEscape: [], encoding: "no-write" };
}

export function primitiveKind(type: IrType | null | undefined): "i32" | "f64" | undefined {
  return type?.kind === "val" && (type.val.kind === "i32" || type.val.kind === "f64") ? type.val.kind : undefined;
}

/** Shape/primitive exclusions supplement, never replace, canonical type validity. */
export function profileInstructionExclusion(instr: IrInstr): AllocationEvidenceCoverageReason | undefined {
  switch (instr.kind) {
    case "const":
      return primitiveKind(instr.resultType) && instr.value.kind === primitiveKind(instr.resultType)
        ? undefined
        : "reference-carrier";
    case "binary":
      if (instr.op !== "i32.lt_u" && instr.op !== "f64.add") return "numeric-opcode";
      return primitiveKind(instr.resultType) === (instr.op === "i32.lt_u" ? "i32" : "f64")
        ? undefined
        : "reference-carrier";
    case "vec.new_fixed":
      return instr.resultType?.kind === "vec" &&
        !instr.resultType.nullable &&
        primitiveKind(instr.resultType.elementType) === "f64" &&
        primitiveKind(instr.elementType) === "f64"
        ? undefined
        : "reference-carrier";
    case "vec.get":
      return primitiveKind(instr.resultType) === "f64" ? undefined : "reference-carrier";
    case "vec.len":
      if (Object.hasOwn(instr, "integer") && instr.integer !== true) return "instruction-kind";
      return primitiveKind(instr.resultType) === (instr.integer === true ? "i32" : "f64")
        ? undefined
        : "reference-carrier";
    case "vec.set":
      return instr.result === null && instr.resultType === null ? undefined : "reference-carrier";
    case "if":
      return instr.result !== null && primitiveKind(instr.resultType) ? undefined : "reference-carrier";
    default:
      return "instruction-kind";
  }
}

/** Cross-checked against core directUses; arm results are checked in arm scope. */
export function profileOperands(instr: IrInstr): readonly ProfileOperand[] {
  switch (instr.kind) {
    case "const":
      return [];
    case "binary": {
      const role = instr.op === "i32.lt_u" ? "i32" : "f64";
      return [
        { value: instr.lhs, role },
        { value: instr.rhs, role },
      ];
    }
    case "vec.new_fixed":
      return instr.elements.map((value) => ({ value, role: "f64" }));
    case "vec.get":
      return [
        { value: instr.vec, role: "receiver" },
        { value: instr.index, role: "i32" },
      ];
    case "vec.len":
      return [{ value: instr.vec, role: "receiver" }];
    case "vec.set":
      return [
        { value: instr.vec, role: "receiver" },
        { value: instr.index, role: "i32" },
        { value: instr.newValue, role: "f64" },
      ];
    case "if": {
      const role = primitiveKind(instr.resultType)!;
      return [
        { value: instr.cond, role: "i32" },
        { value: instr.thenValue, role },
        { value: instr.elseValue, role },
      ];
    }
    default:
      return [];
  }
}

export function profileOperandPopulationMatches(instr: IrInstr, operands: readonly ProfileOperand[]): boolean {
  const actual = directUses(instr);
  return actual.length === operands.length && actual.every((value, index) => value === operands[index]!.value);
}

export function profileFunctionExclusion(
  fn: import("../../core/nodes.js").IrFunction,
): AllocationEvidenceCoverageReason | undefined {
  if (
    fn.funcKind === "async" ||
    fn.funcKind === "generator" ||
    ["asyncPlan", "asyncRuntime", "generatorBufferSlot"].some((key) => Object.hasOwn(fn, key))
  )
    return "async-domain";
  if (
    fn.blocks.length !== 1 ||
    fn.blocks[0]!.blockArgs.length ||
    fn.blocks[0]!.blockArgTypes.length ||
    Object.hasOwn(fn, "closureSubtype") ||
    Object.hasOwn(fn, "captures") ||
    fn.slots?.length ||
    (fn.funcKind !== undefined && fn.funcKind !== "regular")
  )
    return "function-shape";
  if (fn.params.some((param) => !primitiveKind(param.type)) || fn.resultTypes.some((type) => !primitiveKind(type)))
    return "reference-carrier";
  const terminator = fn.blocks[0]!.terminator;
  return terminator.kind === "return" || terminator.kind === "unreachable" ? undefined : "function-shape";
}
