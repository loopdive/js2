// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { StringBackendEmitter } from "../backend/string-contract.js";
import type { IrInstr, IrValueId } from "../core/nodes.js";

export type StringOperation = Extract<
  IrInstr,
  {
    kind:
      | "string.const"
      | "string.concat"
      | "string.repeat"
      | "string.eq"
      | "string.len"
      | "string.char_at"
      | "string.char_code_at";
  }
>;

export interface StringOperationContext<S> {
  readonly emitter: StringBackendEmitter<S>;
  readonly emitValue: (value: IrValueId, out: S) => void;
}

/** Emit within the caller's source scope, preserving prepared dependencies. */
export function emitStringOperation<S>(instr: StringOperation, ctx: StringOperationContext<S>, out: S): void {
  switch (instr.kind) {
    case "string.const":
      ctx.emitter.emitStringConst(instr.value, instr.alloc, out, instr.storage, instr.materializer);
      return;
    case "string.concat":
      ctx.emitValue(instr.lhs, out);
      ctx.emitValue(instr.rhs, out);
      ctx.emitter.emitStringConcat(instr.alloc, instr.concatMode ?? "immutable", out, instr.provider);
      return;
    case "string.repeat":
      ctx.emitValue(instr.value, out);
      ctx.emitValue(instr.count, out);
      ctx.emitter.emitStringRepeat(
        instr.alloc,
        instr.encodingEvidence,
        out,
        instr.provider,
        instr.countedStringAppendTripCount,
      );
      return;
    case "string.eq":
      ctx.emitValue(instr.lhs, out);
      ctx.emitValue(instr.rhs, out);
      ctx.emitter.emitStringEquals(instr.negate, out, instr.provider);
      return;
    case "string.len":
      ctx.emitValue(instr.value, out);
      ctx.emitter.emitStringLength(instr.inputEncoding, out, instr.provider);
      return;
    case "string.char_at":
      ctx.emitValue(instr.value, out);
      ctx.emitValue(instr.index, out);
      ctx.emitter.emitStringCharAt(instr.alloc, instr.inputEncoding, out, instr.provider);
      return;
    case "string.char_code_at":
      ctx.emitValue(instr.value, out);
      ctx.emitValue(instr.index, out);
      ctx.emitter.emitStringCharCodeAt(instr.inputEncoding, out, instr.provider);
      return;
  }
  const exhaustive: never = instr;
  throw new Error(`Unsupported string operation: ${String(exhaustive)}`);
}
