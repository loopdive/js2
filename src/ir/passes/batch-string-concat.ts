// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irIntrinsicFuncRef } from "../callable-bindings.js";
import {
  collectUses,
  forEachInstrDeep,
  mapNestedBuffers,
  type IrBlock,
  type IrFunction,
  type IrInstr,
  type IrInstrStringConcat,
  type IrValueId,
} from "../nodes.js";
import { irStringConcatManySymbol } from "../string-runtime.js";

function immutableConcat(instr: IrInstr | undefined): instr is IrInstrStringConcat {
  return instr?.kind === "string.concat" && (instr.concatMode ?? "immutable") === "immutable";
}

function recordTerminatorUses(block: IrBlock, add: (value: IrValueId) => void): void {
  const term = block.terminator;
  switch (term.kind) {
    case "br":
      for (const value of term.branch.args) add(value);
      return;
    case "br_if":
      add(term.condition);
      for (const value of term.ifTrue.args) add(value);
      for (const value of term.ifFalse.args) add(value);
      return;
    case "return":
      for (const value of term.values) add(value);
      return;
    case "unreachable":
      return;
  }
}

/**
 * Fuse maximal, single-use immutable concat trees into one semantic N-ary
 * call. Leaves stay in source evaluation order; DCE removes the now-unused
 * pure pairwise nodes and retires their allocation sites.
 */
export function batchStringConcat(fn: IrFunction): IrFunction {
  const defs = new Map<IrValueId, IrInstr>();
  const uses = new Map<IrValueId, number>();
  const consumedByConcat = new Set<IrValueId>();
  const addUse = (value: IrValueId): void => {
    uses.set(value, (uses.get(value) ?? 0) + 1);
  };

  for (const block of fn.blocks) {
    for (const root of block.instrs) {
      forEachInstrDeep(root, (instr) => {
        if (instr.result !== null) defs.set(instr.result, instr);
        for (const value of collectUses(instr)) addUse(value);
        if (instr.kind === "string.concat") {
          consumedByConcat.add(instr.lhs);
          consumedByConcat.add(instr.rhs);
        }
      });
    }
    recordTerminatorUses(block, addUse);
  }

  const flatten = (value: IrValueId, out: IrValueId[]): void => {
    const producer = defs.get(value);
    if (immutableConcat(producer) && (uses.get(value) ?? 0) === 1) {
      flatten(producer.lhs, out);
      flatten(producer.rhs, out);
      return;
    }
    out.push(value);
  };

  let changed = false;
  const rewriteBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] => {
    let bufferChanged = false;
    const rewritten = buffer.map((original) => {
      const instr = mapNestedBuffers(original, rewriteBuffer);
      if (instr !== original) bufferChanged = true;
      if (!immutableConcat(instr) || instr.result === null || consumedByConcat.has(instr.result)) return instr;
      const args: IrValueId[] = [];
      flatten(instr.lhs, args);
      flatten(instr.rhs, args);
      if (args.length < 3) return instr;
      bufferChanged = true;
      changed = true;
      return {
        kind: "call",
        target: irIntrinsicFuncRef(irStringConcatManySymbol(args.length)),
        args,
        result: instr.result,
        resultType: instr.resultType,
        ...(instr.site === undefined ? {} : { site: instr.site }),
        ...(instr.alloc === undefined ? {} : { alloc: instr.alloc }),
      } satisfies IrInstr;
    });
    return bufferChanged ? rewritten : buffer;
  };

  const blocks = fn.blocks.map((block) => {
    const instrs = rewriteBuffer(block.instrs);
    return instrs === block.instrs ? block : { ...block, instrs };
  });
  return changed ? { ...fn, blocks } : fn;
}
