// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { BackendEmitter } from "../backend/emitter.js";
import type { TypeConverter } from "../backend/contract.js";
import type { IrInstrSelect, IrValueId } from "../core/nodes.js";
import type { ValType } from "../../wasm/model/instructions.js";

function referenceScratch(type: ValType): ValType | undefined {
  switch (type.kind) {
    case "ref":
      return { kind: "ref_null", typeIdx: type.typeIdx };
    case "ref_extern":
      return { kind: "externref" };
    case "ref_null":
    case "externref":
    case "funcref":
    case "eqref":
    case "anyref":
      return type;
    default:
      return undefined;
  }
}

/** Select evaluates both operands eagerly; only the final local reads are conditional. */
export function createIrSelectLowering<S, Slot>(
  emitter: BackendEmitter<S>,
  converter: TypeConverter<Slot>,
  emitValue: (value: IrValueId, out: S) => void,
  allocateLocal: (name: string, type: ValType) => number,
): (instruction: IrInstrSelect, out: S) => void {
  const scratch = new WeakMap<IrInstrSelect, { whenTrue: number; whenFalse: number }>();
  return (instruction, out) => {
    let physical: ValType | undefined;
    if (emitter.backend === "wasmgc" || emitter.backend === "linear") {
      const slots = converter.convertType(instruction.resultType!);
      if (slots.length !== 1) throw Error("ir/lower: Wasm select requires one physical slot");
      // The active Wasm backend contract uses ValType slots; other backends never enter this arm.
      physical = slots[0] as unknown as ValType;
    }
    const temporaryType = physical && referenceScratch(physical);
    if (!temporaryType) {
      emitValue(instruction.whenTrue, out);
      emitValue(instruction.whenFalse, out);
      emitValue(instruction.condition, out);
      emitter.emitSelect(out);
      return;
    }
    let pair = scratch.get(instruction);
    if (!pair) {
      pair = {
        whenTrue: allocateLocal("__select_true", temporaryType),
        whenFalse: allocateLocal("__select_false", temporaryType),
      };
      scratch.set(instruction, pair);
    }
    emitValue(instruction.whenTrue, out);
    emitter.emitLocalSet(pair.whenTrue, out);
    emitValue(instruction.whenFalse, out);
    emitter.emitLocalSet(pair.whenFalse, out);
    emitValue(instruction.condition, out);
    const arm = (local: number): S => {
      const body = emitter.newSink();
      emitter.emitLocalGet(local, body);
      if (temporaryType.kind !== physical!.kind) {
        // pushraw-ok(#7139): restore exact non-null select operand from its defaultable scratch slot
        emitter.pushRaw(body, { op: "ref.as_non_null" });
      }
      return body;
    };
    emitter.emitIf({ kind: "val", type: physical! }, arm(pair.whenTrue), arm(pair.whenFalse), out);
  };
}
