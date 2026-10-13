// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { ValType } from "../../wasm/model/instructions.js";
import type { BackendEmitter } from "./emitter.js";
import type { IrVectorLowering } from "./handles.js";

interface VectorElementAccessContext<S> {
  readonly emitter: BackendEmitter<S>;
  readonly emitValue: (value: IrValueId, out: S) => void;
  readonly construction: IrInstr | undefined;
  readonly requestedCapacity?: number;
  readonly indexScratch: () => number;
  readonly elementScratch: (type: ValType) => number;
}

/** Emit the complete terminal access with its original operand evaluation order. */
export function emitVectorElementAccess<S>(
  instr: Extract<IrInstr, { kind: "vec.get" | "vec.set" }>,
  vec: IrVectorLowering,
  context: VectorElementAccessContext<S>,
  out: S,
): void {
  const { emitter, emitValue, construction } = context;
  emitValue(instr.vec, out);
  emitter.emitVecDataPtr(vec, out);
  emitValue(instr.index, out);
  if (instr.kind === "vec.set") emitValue(instr.newValue, out);
  const capacity =
    context.requestedCapacity ??
    (construction?.kind === "vec.new_fixed" ? (construction.capacity ?? construction.elements.length) : undefined);
  if ("linearMemory" in vec && capacity !== undefined) {
    // GC array.get/set check requested backing extent, not logical length or
    // physical Linear padding. Native admission joins this exact SSA owner.
    const index = context.indexScratch();
    const value = instr.kind === "vec.set" ? context.elementScratch(vec.elementValType) : undefined;
    if (value !== undefined) emitter.emitLocalSet(value, out);
    emitter.emitLocalSet(index, out);
    emitter.emitLocalGet(index, out);
    emitter.emitScalarConst("i32", capacity, out);
    emitter.emitBinary("i32.ge_u", out);
    const trap = emitter.newSink();
    emitter.pushRaw(trap, { op: "unreachable" });
    emitter.emitIf({ kind: "empty" }, trap, emitter.newSink(), out);
    emitter.emitLocalGet(index, out);
    if (value !== undefined) emitter.emitLocalGet(value, out);
  }
  // Native transported operands retain their complete issued origin/extent join.
  // Legacy operands keep the original local defining-instruction guard.
  if (instr.kind === "vec.get") emitter.emitElemGet(vec, out);
  else emitter.emitElemSet(vec, context.elementScratch(vec.elementValType), out);
}
