// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7354 Str2) The Prepared program's one Number::toString. from-ast converts a number to a string through the
 * ordinary pipeline's `IR_NUMBER_TO_STRING_FN` (`String(n)`, a template, `vec.join`); the Prepared program binds
 * number formatting only through `async.native.number-to-string` (the native formatter: support batch, physical
 * setup, adapter `__ir_number_toString_native`; the "async" in its name is historical). Both are `(f64) -> string`
 * with the same meaning, so each such call is retargeted to that one binding, and the formatter's existing demand,
 * ABI and setup plumbing apply unchanged: there is no second formatter body.
 */
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { IR_ASYNC_NUMBER_TO_STRING_FN } from "../core/async-callables.js";
import { mapNestedBuffers, type IrFunction, type IrInstr } from "../core/nodes.js";
import { IR_NUMBER_TO_STRING_FN } from "../core/string-runtime.js";

const FORMATTER = irIntrinsicFuncRef(IR_ASYNC_NUMBER_TO_STRING_FN);

/** Retarget every `IR_NUMBER_TO_STRING_FN` call of `fn` (nested buffers included); `fn` itself when it has none. */
export function retargetNumberToString(fn: IrFunction): IrFunction {
  let changed = false;
  const mapBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] => {
    const mapped = buffer.map((instr) => {
      const nested = mapNestedBuffers(instr, mapBuffer);
      if (
        nested.kind !== "call" ||
        nested.target.binding.kind !== "intrinsic" ||
        nested.target.binding.symbol !== IR_NUMBER_TO_STRING_FN
      )
        return nested;
      changed = true;
      return { ...nested, target: FORMATTER };
    });
    return mapped.every((instr, index) => instr === buffer[index]) ? buffer : mapped;
  };
  const blocks = fn.blocks.map((block) => ({ ...block, instrs: mapBuffer(block.instrs) }));
  return changed ? { ...fn, blocks } : fn;
}
