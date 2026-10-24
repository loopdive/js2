// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ts } from "../ts-api.js";
import type { IrUnitId } from "./identity.js";
import { forEachInstrDeep, type IrClosureSignature, type IrFunction, type IrInstr, type IrTypeRef } from "./nodes.js";

/** Compiler-local source sidecar; never part of transported IR or a generic type policy. */
export interface IrFunctionMemberClosurePlan {
  readonly expression: ts.FunctionExpression;
  readonly ownerUnitId: IrUnitId;
  readonly sourceUnitId: IrUnitId;
  /** Actual canonical wrapper ABI, including raw externref user slots. */
  readonly signature: IrClosureSignature;
  /** Only these exact raw parameters acquire logical dynamic SSA at entry. */
  readonly dynamicParameterIndices: ReadonlySet<number>;
  /**
   * (#7106 Stage 4) The body reads its own `this`: bound once at entry through
   * `dyn.current_this` with this strictness. Absent → the body never reads it.
   */
  readonly thisStrict?: boolean;
  /** Rechecks original AST, checker, source inventory, receiver and physical ABI. */
  isCurrent(): boolean;
}

export interface IrFunctionMemberClosures {
  resolve(expression: ts.FunctionExpression): IrFunctionMemberClosurePlan | undefined;
  /** Runs after actual closure layouts + lifted slots exist, before their consumers/seal. */
  notePreparedAllocation(
    instruction: Extract<IrInstr, { kind: "closure.new" }>,
    refs: readonly IrTypeRef[] | undefined,
  ): void;
}

/** Walk actual final allocation instructions, without guessing a layout array position. */
export function notePreparedFunctionMemberClosures(
  source: IrFunctionMemberClosures | undefined,
  entries: readonly { readonly fn: IrFunction }[],
  instructionRefs: ReadonlyMap<IrInstr, readonly IrTypeRef[]>,
): void {
  if (!source) return;
  for (const { fn } of entries)
    for (const block of fn.blocks)
      for (const root of block.instrs) {
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "closure.new")
            source.notePreparedAllocation(instruction, instructionRefs.get(instruction));
        });
      }
}
