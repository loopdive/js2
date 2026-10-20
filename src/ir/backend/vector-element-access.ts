// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { ValType } from "../../wasm/model/instructions.js";
import type { BackendEmitter } from "./emitter.js";
import type { IrVecRepresentation } from "./vector-representation.js";

interface VectorElementAccessContext<S> {
  readonly emitter: BackendEmitter<S>;
  readonly emitValue: (value: IrValueId, out: S) => void;
  readonly construction: IrInstr | undefined;
  readonly requestedCapacity?: number;
  readonly indexScratch: () => number;
  readonly receiverScratch: (type: ValType) => number;
  readonly elementScratch: (type: ValType) => number;
}

/**
 * Emit the complete terminal access with its original operand evaluation order.
 * `representation` was resolved for `context.emitter.backend` (#6920); its
 * `kind` — never the raw handle's shape — selects the receiver carrier and the
 * Linear backing-extent guard.
 */
export function emitVectorElementAccess<S>(
  instr: Extract<IrInstr, { kind: "vec.get" | "vec.set" }>,
  representation: IrVecRepresentation,
  context: VectorElementAccessContext<S>,
  out: S,
): void {
  const { emitter, emitValue, construction } = context;
  const vec = representation.lowering;
  if (context.requestedCapacity !== undefined) {
    // Issued native origins retain the captured logical receiver, never a pre-effect backing pointer.
    const receiver = context.receiverScratch(
        representation.kind === "linear-memory"
          ? representation.valueType
          : { kind: "ref_null", typeIdx: representation.lowering.vecStructTypeIdx },
      ),
      index = context.indexScratch(),
      length = context.indexScratch();
    const value = instr.kind === "vec.set" ? context.elementScratch(vec.elementValType) : undefined;
    emitValue(instr.vec, out);
    emitter.emitLocalSet(receiver, out);
    emitValue(instr.index, out);
    emitter.emitLocalSet(index, out);
    if (value !== undefined && instr.kind === "vec.set") {
      emitValue(instr.newValue, out);
      emitter.emitLocalSet(value, out);
    }
    emitter.emitLocalGet(receiver, out);
    emitter.emitVecLen(vec, out);
    emitter.emitLocalSet(length, out);
    emitter.emitLocalGet(index, out);
    emitter.emitLocalGet(length, out);
    emitter.emitScalarConst("i32", context.requestedCapacity, out);
    emitter.emitBinary("i32.gt_u", out);
    const grown = emitter.newSink(),
      original = emitter.newSink();
    emitter.emitLocalGet(length, grown);
    emitter.emitScalarConst("i32", context.requestedCapacity, original);
    emitter.emitIf({ kind: "val", type: { kind: "i32" } }, grown, original, out);
    emitter.emitBinary("i32.ge_u", out);
    const trap = emitter.newSink();
    emitter.emitUnreachable(trap);
    emitter.emitIf({ kind: "empty" }, trap, emitter.newSink(), out);
    // Resolution and length refresh occur after all operand effects, with no callbacks between.
    emitter.emitLocalGet(receiver, out);
    emitter.emitVecDataPtr(vec, out);
    emitter.emitLocalGet(index, out);
    if (value !== undefined) emitter.emitLocalGet(value, out);
    if (instr.kind === "vec.get") emitter.emitElemGet(vec, out);
    else emitter.emitElemSet(vec, value!, out);
    return;
  }
  emitValue(instr.vec, out);
  emitter.emitVecDataPtr(vec, out);
  emitValue(instr.index, out);
  if (instr.kind === "vec.set") emitValue(instr.newValue, out);
  const capacity =
    context.requestedCapacity ??
    (construction?.kind === "vec.new_fixed" ? (construction.capacity ?? construction.elements.length) : undefined);
  if (representation.kind === "linear-memory" && capacity !== undefined) {
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
    emitter.emitUnreachable(trap);
    emitter.emitIf({ kind: "empty" }, trap, emitter.newSink(), out);
    emitter.emitLocalGet(index, out);
    if (value !== undefined) emitter.emitLocalGet(value, out);
  }
  // Native transported operands retain their complete issued origin/extent join.
  // Legacy operands keep the original local defining-instruction guard.
  if (instr.kind === "vec.get") emitter.emitElemGet(vec, out);
  else emitter.emitElemSet(vec, context.elementScratch(vec.elementValType), out);
}
