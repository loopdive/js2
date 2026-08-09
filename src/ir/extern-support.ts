// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irImportFuncRef, sameIrCallableBinding } from "./callable-bindings.js";
import { mapNestedBuffers, type IrFuncRef, type IrFunction, type IrInstr } from "./nodes.js";

function mapArray<T>(values: readonly T[], map: (value: T) => T): readonly T[] {
  let changed = false;
  const mapped = values.map((value) => {
    const next = map(value);
    changed ||= next !== value;
    return next;
  });
  return changed ? mapped : values;
}

/** Resolve the exact host callable used by one semantic extern operation. */
export function irExternCallableProviderRef(instr: IrInstr): IrFuncRef | undefined {
  switch (instr.kind) {
    case "extern.new":
      return irImportFuncRef("env", `${instr.importPrefix}_new`);
    case "extern.call":
      return irImportFuncRef("env", `${instr.className}_${instr.method}`);
    case "extern.prop":
      return irImportFuncRef("env", `${instr.className}_get_${instr.property}`);
    case "extern.propSet":
      return irImportFuncRef("env", `${instr.className}_set_${instr.property}`);
    default:
      return undefined;
  }
}

/**
 * Attach exact symbolic host-call dependencies to final extern IR.
 *
 * AST lowering retains source meaning (`className`, member, receiver) while
 * this post-pass chooses the backend provider after middle-end transforms.
 * Prepared-component sealing can then prove the same Program ABI import that
 * lowering will consume. Repeated preparation is idempotent and rejects a
 * stale or conflicting attachment.
 */
export function attachIrExternSupport(fn: IrFunction): IrFunction {
  const mapBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] => mapArray(buffer, mapInstr);
  const mapInstr = (instr: IrInstr): IrInstr => {
    const nested = mapNestedBuffers(instr, mapBuffer);
    if (
      nested.kind !== "extern.new" &&
      nested.kind !== "extern.call" &&
      nested.kind !== "extern.prop" &&
      nested.kind !== "extern.propSet"
    ) {
      return nested;
    }
    const provider = irExternCallableProviderRef(nested)!;
    if (nested.provider) {
      if (!sameIrCallableBinding(nested.provider.binding, provider.binding)) {
        throw new Error(`IR ${nested.kind} already carries a different prepared provider binding`);
      }
      return nested;
    }
    return { ...nested, provider };
  };

  const blocks = mapArray(fn.blocks, (block) => {
    const instrs = mapBuffer(block.instrs);
    return instrs === block.instrs ? block : { ...block, instrs };
  });
  // asyncPlan is the frozen, target-neutral semantic program. Provider refs
  // are backend attachments, so only the post-manifest asyncRuntime clone may
  // carry them. Keeping this boundary also preserves semantic plan hashing.
  const asyncRuntime = fn.asyncRuntime
    ? (() => {
        const states = mapArray(fn.asyncRuntime.states, (state) => {
          const body = mapBuffer(state.body);
          return body === state.body ? state : { ...state, body };
        });
        return states === fn.asyncRuntime.states ? fn.asyncRuntime : { ...fn.asyncRuntime, states };
      })()
    : undefined;
  return blocks === fn.blocks && asyncRuntime === fn.asyncRuntime
    ? fn
    : {
        ...fn,
        blocks,
        ...(asyncRuntime ? { asyncRuntime } : {}),
      };
}
