// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey, irTypeBindingKey } from "./abi-bindings.js";
import { sameIrCallableBinding } from "./callable-bindings.js";
import {
  mapNestedBuffers,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrInstrStringConst,
  type IrInstrStringLen,
  type IrStringLengthProvider,
} from "./nodes.js";

export interface IrStringSupportProviders {
  readonly storageForConst: (instr: IrInstrStringConst) => IrGlobalRef | undefined;
  readonly providerForLength: (instr: IrInstrStringLen) => IrStringLengthProvider | undefined;
}

function mapArray<T>(values: readonly T[], map: (value: T) => T): readonly T[] {
  let changed = false;
  const mapped = values.map((value) => {
    const next = map(value);
    changed ||= next !== value;
    return next;
  });
  return changed ? mapped : values;
}

function sameLengthProvider(left: IrStringLengthProvider, right: IrStringLengthProvider): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "callable" && right.kind === "callable") {
    return sameIrCallableBinding(left.target.binding, right.target.binding);
  }
  return (
    left.kind === "struct-field" &&
    right.kind === "struct-field" &&
    left.fieldIndex === right.fieldIndex &&
    irTypeBindingKey(left.ownerType.binding) === irTypeBindingKey(right.ownerType.binding)
  );
}

/**
 * Attach the exact storage/callable/layout dependencies used by string
 * lowering to final IR.
 *
 * This pass sits after inference and middle-end transforms. It is therefore
 * free to select a backend representation without teaching the JS type layer
 * about Wasm imports, globals, or GC layouts. Existing attachments are
 * checked rather than overwritten, which makes repeated preparation
 * idempotent and prevents a component from sealing against one provider then
 * lowering through another.
 */
export function attachIrStringSupport(fn: IrFunction, providers: IrStringSupportProviders): IrFunction {
  const mapBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] => mapArray(buffer, mapInstr);
  const mapInstr = (instr: IrInstr): IrInstr => {
    const nested = mapNestedBuffers(instr, mapBuffer);
    if (nested.kind === "string.const") {
      const storage = providers.storageForConst(nested);
      if (!storage) return nested;
      if (nested.storage) {
        if (irGlobalBindingKey(nested.storage.binding) !== irGlobalBindingKey(storage.binding)) {
          throw new Error("IR string.const already carries a different prepared storage binding");
        }
        return nested;
      }
      return { ...nested, storage };
    }
    if (nested.kind === "string.len") {
      const provider = providers.providerForLength(nested);
      if (!provider) return nested;
      if (nested.provider) {
        if (!sameLengthProvider(nested.provider, provider)) {
          throw new Error("IR string.len already carries a different prepared provider binding");
        }
        return nested;
      }
      return { ...nested, provider };
    }
    return nested;
  };

  const blocks = mapArray(fn.blocks, (block) => {
    const instrs = mapBuffer(block.instrs);
    return instrs === block.instrs ? block : { ...block, instrs };
  });
  return blocks === fn.blocks ? fn : { ...fn, blocks };
}
