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

type OwnershipRuleEvent =
  | { readonly op: "read" | "write"; readonly operand: "vec" }
  | { readonly op: "escape"; readonly operand: "newValue" };
type AllocationEvidenceRule =
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "effects";
      readonly ownership: readonly OwnershipRuleEvent[];
      readonly directEscape: readonly [];
      readonly encoding: "no-write";
    };

const UNSUPPORTED_RULE: AllocationEvidenceRule = Object.freeze({ kind: "unsupported" });
const NO_LOCAL_EFFECT_RULE: AllocationEvidenceRule = Object.freeze({
  kind: "effects",
  ownership: Object.freeze([] as const),
  directEscape: Object.freeze([] as const),
  encoding: "no-write",
});
const VECTOR_READ_RULE: AllocationEvidenceRule = Object.freeze({
  kind: "effects",
  ownership: Object.freeze([Object.freeze({ op: "read", operand: "vec" } as const)]),
  directEscape: Object.freeze([] as const),
  encoding: "no-write",
});
const VECTOR_WRITE_RULE: AllocationEvidenceRule = Object.freeze({
  kind: "effects",
  ownership: Object.freeze([
    Object.freeze({ op: "write", operand: "vec" } as const),
    Object.freeze({ op: "escape", operand: "newValue" } as const),
  ]),
  directEscape: Object.freeze([] as const),
  encoding: "no-write",
});

/** Shared instruction-local policy. Rule recognition is not finite-profile admission. */
export function allocationEvidenceRule(instr: IrInstr): AllocationEvidenceRule {
  switch (instr.kind) {
    case "vec.get":
    case "vec.len":
      return VECTOR_READ_RULE;
    case "vec.set":
      return VECTOR_WRITE_RULE;
    case "binary":
      if (instr.op !== "i32.lt_u" && instr.op !== "f64.add") return UNSUPPORTED_RULE;
      break;
    case "const":
    case "vec.new_fixed":
    case "if":
      break;
    default:
      return UNSUPPORTED_RULE;
  }
  return NO_LOCAL_EFFECT_RULE;
}

/** Resolve one current operand immediately before its rule event is applied. */
export function allocationEvidenceOperand(instr: IrInstr, operand: "vec" | "newValue"): IrValueId {
  switch (operand) {
    case "vec":
      if (instr.kind === "vec.get" || instr.kind === "vec.len" || instr.kind === "vec.set") return instr.vec;
      break;
    case "newValue":
      if (instr.kind === "vec.set") return instr.newValue;
      break;
  }
  throw new Error("allocation rule mismatch: vector operand");
}

/** Compatibility descriptor: materialize fresh events without retaining operands. */
export function allocationEvidenceEffect(instr: IrInstr): AllocationEvidenceEffect {
  const rule = allocationEvidenceRule(instr);
  if (rule.kind === "unsupported") return { kind: "unsupported" };
  const ownership: { value: IrValueId; op: OwnershipRuleEvent["op"] }[] = [];
  for (let index = 0; index < rule.ownership.length; index++) {
    const event = rule.ownership[index]!;
    ownership.push({ value: allocationEvidenceOperand(instr, event.operand), op: event.op });
  }
  return { kind: "effects", ownership, directEscape: [], encoding: rule.encoding };
}

export function primitiveKind(type: IrType | null | undefined): "i32" | "f64" | undefined {
  return type?.kind === "val" && (type.val.kind === "i32" || type.val.kind === "f64") ? type.val.kind : undefined;
}

/** Shape/primitive exclusions supplement, never replace, canonical type validity. */
export function profileInstructionExclusion(instr: IrInstr): AllocationEvidenceCoverageReason | undefined {
  if (instr.kind !== "vec.new_fixed" && instr.alloc !== undefined) return "instruction-kind";
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
