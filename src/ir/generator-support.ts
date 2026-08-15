// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irRuntimeFuncRef, sameIrCallableBinding } from "./callable-bindings.js";
import {
  asVal,
  forEachInstrDeep,
  mapNestedBuffers,
  type IrFuncRef,
  type IrFunction,
  type IrInstr,
  type IrType,
  type IrValueId,
} from "./nodes.js";

function mapArray<T>(values: readonly T[], map: (value: T) => T): readonly T[] {
  let changed = false;
  const mapped = values.map((value) => {
    const next = map(value);
    changed ||= next !== value;
    return next;
  });
  return changed ? mapped : values;
}

function valueTypesOf(fn: IrFunction): ReadonlyMap<IrValueId, IrType> {
  const result = new Map<IrValueId, IrType>();
  for (const param of fn.params) result.set(param.value, param.type);
  for (const value of fn.asyncPlan?.values ?? []) result.set(value.value, value.type);
  for (const block of fn.blocks) {
    for (let index = 0; index < block.blockArgs.length; index++) {
      const type = block.blockArgTypes[index];
      if (type) result.set(block.blockArgs[index]!, type);
    }
    for (const root of block.instrs) {
      forEachInstrDeep(root, (instr) => {
        if (instr.result !== null && instr.resultType) result.set(instr.result, instr.resultType);
      });
    }
  }
  return result;
}

/**
 * The exact typed `__gen_push_*` selection lowering performs.
 *
 * Keep this in lockstep with the `gen.push` arm of `src/ir/lower.ts`: sealing
 * proves the callable named here, so a divergent spelling would seal against
 * one import and emit another.
 */
export function irGeneratorPushProviderSymbol(valueType: IrType | undefined): string {
  const val = valueType === undefined ? undefined : asVal(valueType);
  if (val?.kind === "f64") return "__gen_push_f64";
  if (val?.kind === "i32") return "__gen_push_i32";
  return "__gen_push_ref";
}

/** True when a `gen.setReturn` value needs `__box_number` before the call. */
export function irGeneratorSetReturnNeedsBoxing(valueType: IrType | undefined): boolean {
  const val = valueType === undefined ? undefined : asVal(valueType);
  return val?.kind === "f64" || val?.kind === "i32";
}

function requireSameProvider(kind: string, existing: IrFuncRef, next: IrFuncRef): void {
  if (!sameIrCallableBinding(existing.binding, next.binding)) {
    throw new Error(`IR ${kind} already carries a different prepared provider binding`);
  }
}

/**
 * Attach exact symbolic generator-runtime dependencies to final IR.
 *
 * #2951 — the `gen.*` instructions used to resolve their host callables by
 * name inside the lowerer, which made them invisible to prepared-component
 * dependency discovery: an IR-claimed generator always reported
 * `implicit-support-reference-unavailable` and could never compile once.
 * Selecting the provider here (after inference and middle-end transforms have
 * settled the value types) lets sealing prove the same Program ABI callable
 * lowering will consume. Repeated preparation is idempotent and rejects a
 * stale or conflicting attachment, mirroring `attachIrExternSupport`.
 */
export function attachIrGeneratorSupport(fn: IrFunction): IrFunction {
  if (fn.funcKind !== "generator") return fn;
  const valueTypes = valueTypesOf(fn);
  const mapBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] => mapArray(buffer, mapInstr);
  const mapInstr = (instr: IrInstr): IrInstr => {
    const nested = mapNestedBuffers(instr, mapBuffer);
    switch (nested.kind) {
      case "gen.push": {
        const provider = irRuntimeFuncRef(irGeneratorPushProviderSymbol(valueTypes.get(nested.value)));
        if (nested.provider) {
          requireSameProvider(nested.kind, nested.provider, provider);
          return nested;
        }
        return { ...nested, provider };
      }
      case "gen.epilogue": {
        const provider = irRuntimeFuncRef("__create_generator");
        if (nested.provider) {
          requireSameProvider(nested.kind, nested.provider, provider);
          return nested;
        }
        return { ...nested, provider };
      }
      case "gen.yieldStar": {
        const provider = irRuntimeFuncRef("__gen_yield_star");
        if (nested.provider) {
          requireSameProvider(nested.kind, nested.provider, provider);
          return nested;
        }
        return { ...nested, provider };
      }
      case "gen.setReturn": {
        const provider = irRuntimeFuncRef("__gen_set_return");
        const boxProvider = irGeneratorSetReturnNeedsBoxing(valueTypes.get(nested.value))
          ? irRuntimeFuncRef("__box_number")
          : undefined;
        if (nested.provider) {
          requireSameProvider(nested.kind, nested.provider, provider);
          if ((nested.boxProvider === undefined) !== (boxProvider === undefined)) {
            throw new Error("IR gen.setReturn already carries a different prepared boxing attachment");
          }
          if (nested.boxProvider && boxProvider) requireSameProvider(nested.kind, nested.boxProvider, boxProvider);
          return nested;
        }
        return { ...nested, provider, ...(boxProvider ? { boxProvider } : {}) };
      }
      default:
        return nested;
    }
  };

  const blocks = mapArray(fn.blocks, (block) => {
    const instrs = mapBuffer(block.instrs);
    return instrs === block.instrs ? block : { ...block, instrs };
  });
  return blocks === fn.blocks ? fn : { ...fn, blocks };
}

/**
 * Every generator-runtime callable the attached IR of `fns` will consume.
 *
 * The caller observes these against the Program ABI BEFORE prepared-component
 * sealing. Sealing runs ahead of lowering, so a `runtime`-bound provider that
 * is only resolved inside the lowerer has not crossed the observation boundary
 * yet and the component is rejected with an `unplanned-abi-binding` for a
 * callable that is in fact perfectly available.
 */
export function collectAttachedGeneratorProviders(fns: readonly IrFunction[]): readonly IrFuncRef[] {
  const refs: IrFuncRef[] = [];
  for (const fn of fns) {
    if (fn.funcKind !== "generator") continue;
    for (const block of fn.blocks) {
      for (const root of block.instrs) {
        forEachInstrDeep(root, (instr) => {
          switch (instr.kind) {
            case "gen.push":
            case "gen.epilogue":
            case "gen.yieldStar":
              if (instr.provider) refs.push(instr.provider);
              return;
            case "gen.setReturn":
              if (instr.provider) refs.push(instr.provider);
              if (instr.boxProvider) refs.push(instr.boxProvider);
              return;
            default:
              return;
          }
        });
      }
    }
  }
  return refs;
}
