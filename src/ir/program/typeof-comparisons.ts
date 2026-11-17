// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7354 Ty) `typeof v <op> "literal"` as from-ast lowers it: a `dyn.typeof`
 * whose string result a `string.eq` compares with a string constant (`==` and
 * `===` agree on two strings, so all four operators and both operand orders
 * arrive in this one shape). The dynamic-value legalization answers such a
 * comparison with a tag test on the operand, which needs no string at all.
 */
import {
  collectTerminatorUses,
  collectUses,
  forEachInstrDeep,
  type IrFunction,
  type IrInstr,
  type IrValueId,
} from "../core/nodes.js";

/** One comparison: the `typeof` operand, the literal and the sense (`!==`/`!=`). */
interface TypeofComparison {
  readonly operand: IrValueId;
  readonly literal: string;
  readonly negate: boolean;
}

interface TypeofComparisons {
  /** Keyed by the comparison's `string.eq` result. */
  readonly comparisons: ReadonlyMap<IrValueId, TypeofComparison>;
  /**
   * The `typeof` results and literals that only these comparisons read: once the comparisons are tag tests,
   * nothing consumes them. A `typeof` result read anywhere else (assigned, returned, compared with a
   * non-literal) is not here, so it still reaches the legalization's `dyn.typeof` refusal.
   */
  readonly consumed: ReadonlySet<IrValueId>;
}

function forEachInstr(fn: IrFunction, visit: (instr: IrInstr) => void): void {
  for (const block of fn.blocks) for (const root of block.instrs) forEachInstrDeep(root, visit);
}

export function typeofComparisons(fn: IrFunction): TypeofComparisons {
  const typeofOperand = new Map<IrValueId, IrValueId>();
  const literal = new Map<IrValueId, string>();
  forEachInstr(fn, (instr) => {
    if (instr.kind === "dyn.typeof") typeofOperand.set(instr.result!, instr.value);
    else if (instr.kind === "string.const") literal.set(instr.result!, instr.value);
  });
  const comparisons = new Map<IrValueId, TypeofComparison>();
  const comparedReads = new Map<IrValueId, number>();
  const count = (counts: Map<IrValueId, number>, value: IrValueId) => counts.set(value, (counts.get(value) ?? 0) + 1);
  forEachInstr(fn, (instr) => {
    if (instr.kind !== "string.eq") return;
    const [probe, text] = typeofOperand.has(instr.lhs) ? [instr.lhs, instr.rhs] : [instr.rhs, instr.lhs];
    const operand = typeofOperand.get(probe);
    const value = literal.get(text);
    if (operand === undefined || value === undefined) return;
    comparisons.set(instr.result!, { operand, literal: value, negate: instr.negate });
    count(comparedReads, probe);
    count(comparedReads, text);
  });
  const reads = new Map<IrValueId, number>();
  for (const block of fn.blocks) {
    for (const root of block.instrs) for (const value of collectUses(root, { deep: true })) count(reads, value);
    for (const value of collectTerminatorUses(block)) count(reads, value);
  }
  const consumed = new Set([...comparedReads].filter(([value, n]) => reads.get(value) === n).map(([value]) => value));
  return { comparisons, consumed };
}
