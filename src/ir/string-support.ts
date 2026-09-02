// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey, irTypeBindingKey } from "./abi-bindings.js";
import { irIntrinsicFuncRef, sameIrCallableBinding } from "./callable-bindings.js";
import {
  mapNestedBuffers,
  type IrFunction,
  type IrFuncRef,
  type IrGlobalRef,
  type IrInstr,
  type IrInstrStringConst,
  type IrInstrStringLen,
  type IrInstrStringRepeat,
  type IrStringLengthProvider,
} from "./nodes.js";
import {
  IR_STRING_CHAR_AT_FN,
  IR_STRING_CHAR_CODE_AT_FN,
  IR_STRING_CONCAT_FN,
  IR_STRING_CONCAT_OWNED_FN,
  IR_STRING_EQUALS_FN,
  IR_STRING_ITERATOR_CHAR_AT_FN,
  IR_STRING_REPEAT_FN,
} from "./string-runtime.js";

export interface IrStringSupportProviders {
  readonly storageForConst: (instr: IrInstrStringConst) => IrGlobalRef | undefined;
  readonly materializerForConst?: (instr: IrInstrStringConst) => IrFuncRef | undefined;
  readonly providerForLength: (instr: IrInstrStringLen) => IrStringLengthProvider | undefined;
  readonly providerForRepeat?: (instr: IrInstrStringRepeat) => IrFuncRef | undefined;
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

/** Semantic callable selected from final string IR, before backend binding. */
export function irStringCallableProviderRef(
  instr: IrInstr,
  providerForRepeat?: (instr: IrInstrStringRepeat) => IrFuncRef | undefined,
): IrFuncRef | undefined {
  switch (instr.kind) {
    case "string.concat":
      return irIntrinsicFuncRef(instr.concatMode === "owned-append" ? IR_STRING_CONCAT_OWNED_FN : IR_STRING_CONCAT_FN);
    case "string.repeat":
      return providerForRepeat?.(instr) ?? irIntrinsicFuncRef(IR_STRING_REPEAT_FN);
    case "string.eq":
      return irIntrinsicFuncRef(IR_STRING_EQUALS_FN);
    case "string.char_at":
      return irIntrinsicFuncRef(IR_STRING_CHAR_AT_FN);
    case "string.char_code_at":
      return irIntrinsicFuncRef(IR_STRING_CHAR_CODE_AT_FN);
    case "forof.string":
      return irIntrinsicFuncRef(IR_STRING_ITERATOR_CHAR_AT_FN);
    default:
      return undefined;
  }
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
      const materializer = providers.materializerForConst?.(nested);
      if ((storage && materializer) || (nested.storage && nested.materializer)) {
        throw new Error("IR string.const cannot carry both prepared storage and a materializer");
      }
      if (storage) {
        if (nested.materializer) {
          throw new Error("IR string.const materializer conflicts with prepared storage");
        }
        if (!nested.storage) return { ...nested, storage };
        if (irGlobalBindingKey(nested.storage.binding) !== irGlobalBindingKey(storage.binding)) {
          throw new Error("IR string.const already carries a different prepared storage binding");
        }
        return nested;
      }
      if (materializer) {
        if (nested.storage) {
          throw new Error("IR string.const storage conflicts with a prepared materializer");
        }
        if (!nested.materializer) return { ...nested, materializer };
        if (!sameIrCallableBinding(nested.materializer.binding, materializer.binding)) {
          throw new Error("IR string.const already carries a different prepared materializer binding");
        }
      }
      return nested;
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
    if (
      nested.kind === "string.concat" ||
      nested.kind === "string.repeat" ||
      nested.kind === "string.eq" ||
      nested.kind === "string.char_at" ||
      nested.kind === "string.char_code_at" ||
      nested.kind === "forof.string"
    ) {
      const provider = irStringCallableProviderRef(nested, providers.providerForRepeat)!;
      if (nested.provider) {
        if (!sameIrCallableBinding(nested.provider.binding, provider.binding)) {
          throw new Error(`IR ${nested.kind} already carries a different prepared provider binding`);
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

/**
 * (#3526 F2-S4) Attach ONLY the `string.len` provider.
 *
 * {@link attachIrStringSupport} is an omnibus pass, and its callable arm is
 * UNCONDITIONAL: it re-derives the provider for `string.concat`, `.repeat`,
 * `.eq`, `.char_at`, `.char_code_at` and `forof.string` on every run and
 * compares the result to whatever is already attached. So a caller that wants
 * to settle only the LENGTH seam — because the frozen manifest decides that one
 * later than the rest — cannot reuse it: it would have to re-decide five other
 * seams it has no authority over, and getting any one of them wrong is a hard
 * error rather than a no-op.
 *
 * Measured, not argued: running the omnibus pass a second time with only
 * `providerForLength` supplied made `irStringCallableProviderRef` fall back to
 * the generic `__ir_string_repeat` for instructions the first pass had bound to
 * the counted-native helper, and every module with a counted native
 * `string.repeat` failed with "IR string.repeat already carries a different
 * prepared provider binding" (4 corpus cells, invisible to the 60-cell byte
 * matrix because no fixture there carries that shape).
 *
 * Same discipline as the omnibus pass's own `string.len` arm: an existing
 * attachment is CHECKED, never overwritten, so repeated preparation is
 * idempotent and a component cannot seal against one provider then lower
 * through another.
 */
export function attachIrStringLengthProvider(fn: IrFunction, provider: IrStringLengthProvider): IrFunction {
  const mapBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] => mapArray(buffer, mapInstr);
  const mapInstr = (instr: IrInstr): IrInstr => {
    const nested = mapNestedBuffers(instr, mapBuffer);
    if (nested.kind !== "string.len") return nested;
    if (nested.provider) {
      if (!sameLengthProvider(nested.provider, provider)) {
        throw new Error("IR string.len already carries a different prepared provider binding");
      }
      return nested;
    }
    return { ...nested, provider };
  };
  const blocks = mapArray(fn.blocks, (block) => {
    const instrs = mapBuffer(block.instrs);
    return instrs === block.instrs ? block : { ...block, instrs };
  });
  return blocks === fn.blocks ? fn : { ...fn, blocks };
}
