// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { closureSignatureEquals } from "../core/types.js";
import { closureMethodArity, IR_CLOSURE_VECTOR_APPLY } from "../core/closure-invocation-callables.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";
import type { NativeStringValueView } from "./native-string-value-demands.js";
import {
  objectResultDefinitions,
  objectResultOriginal,
  objectResultIsBoolean,
  proveObjectGetterReturns,
} from "./native-object-result-values.js";

/** Actual return producers in BOTH views, never a Boolean signature annotation alone. */
export function nativeSourceReturnsBoolean(source: NativeSourceClosureRequirements, unitId: IrUnitId): boolean {
  const owner = source.demands.owners.find((row) => row.unitId === unitId);
  const expected = owner?.projectedFunction.closureSubtype?.signature.returnType;
  return !!(
    objectResultIsBoolean(expected) &&
    objectResultIsBoolean(owner?.programFunction.closureSubtype?.signature.returnType) &&
    proveObjectGetterReturns(source, unitId, expected!)
  );
}

/** Exact semantic invocation -> original closure allocation -> actual Boolean body. */
export function nativeInvocationBooleanResult(
  source: NativeSourceClosureRequirements,
  ownerUnitId: IrUnitId,
  view: NativeStringValueView,
  occurrence: number,
) {
  const row = source.demands.occurrences[occurrence];
  const region = row && source.demands.buffers[row.bufferIndex];
  const extraction = row?.instruction;
  if (
    region?.ownerUnitId !== ownerUnitId ||
    region.view !== view ||
    extraction?.kind !== "intrinsic" ||
    extraction.id !== "js.boolean.unbox" ||
    extraction.args.length !== 1 ||
    !objectResultIsBoolean(extraction.resultType)
  )
    return undefined;
  const definitions = objectResultDefinitions(source.demands, ownerUnitId, view);
  const invocation = objectResultOriginal(extraction.args[0]!, definitions);
  const call = invocation?.instruction;
  if (call?.kind !== "call" || call.target.binding.kind !== "intrinsic") return undefined;
  const symbol = call.target.binding.symbol;
  const method = closureMethodArity(symbol);
  if (method === undefined && symbol !== IR_CLOSURE_VECTOR_APPLY) return undefined;
  const callee = call.args[method === undefined ? 0 : 1];
  const allocation = callee === undefined ? undefined : objectResultOriginal(callee, definitions);
  const closure = allocation?.instruction;
  if (closure?.kind !== "closure.new" || closure.liftedFunc.binding.kind !== "unit") return undefined;
  const liftedUnitId = closure.liftedFunc.binding.unitId;
  const actual = source.demands.owners.find((row) => row.unitId === liftedUnitId);
  const fn = view === "program" ? actual?.programFunction : actual?.projectedFunction;
  if (
    !fn?.closureSubtype ||
    !closureSignatureEquals(fn.closureSubtype.signature, closure.signature) ||
    !source.allocations.some(
      (row) =>
        row.occurrence === allocation!.occurrence &&
        row.ownerUnitId === ownerUnitId &&
        row.liftedUnitId === liftedUnitId,
    ) ||
    !nativeSourceReturnsBoolean(source, liftedUnitId)
  )
    return undefined;
  return { occurrence, callOccurrence: invocation!.occurrence, ownerUnitId, liftedUnitId, symbol, site: call.site };
}
