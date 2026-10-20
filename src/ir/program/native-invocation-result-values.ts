// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrValueId } from "../core/nodes.js";
import { closureSignatureEquals } from "../core/types.js";
import { closureMethodArity, IR_CLOSURE_VECTOR_APPLY } from "../core/closure-invocation-callables.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";
import type { NativeStringValueView } from "./native-string-value-demands.js";
import {
  objectResultDefinitions,
  objectResultOriginal,
  objectResultIsBoolean,
  proveObjectGetterReturns,
  proveObjectResultValue,
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
function invocationCall(
  source: NativeSourceClosureRequirements,
  ownerUnitId: IrUnitId,
  view: NativeStringValueView,
  occurrence: number,
) {
  const row = source.demands.occurrences[occurrence];
  const region = row && source.demands.buffers[row.bufferIndex];
  if (region?.ownerUnitId !== ownerUnitId || region.view !== view) return undefined;
  const call = row?.instruction;
  if (call?.kind !== "call" || call.target.binding.kind !== "intrinsic") return undefined;
  const definitions = objectResultDefinitions(source.demands, ownerUnitId, view);
  const symbol = call.target.binding.symbol;
  const method = closureMethodArity(symbol);
  if (method === undefined && symbol !== IR_CLOSURE_VECTOR_APPLY) return undefined;
  if (call.args.length !== (method === undefined ? 3 : method + 2)) return undefined;
  const callee = call.args[method === undefined ? 0 : 1];
  const allocation = callee === undefined ? undefined : objectResultOriginal(callee, definitions);
  const closure = allocation?.instruction;
  if (closure?.kind !== "closure.new" || closure.liftedFunc.binding.kind !== "unit") return undefined;
  const erased = callee === undefined ? undefined : definitions.get(callee)?.instruction;
  const packed = erased?.kind === "coerce.to_externref" ? definitions.get(erased.value)?.instruction : undefined;
  if (
    packed?.kind !== "coerce.to_externref" ||
    packed.resultType?.kind !== "callable" ||
    !closureSignatureEquals(packed.resultType.signature, closure.signature)
  )
    return undefined;
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
    )
  )
    return undefined;
  const vector = method === undefined ? objectResultOriginal(call.args[2]!, definitions)?.instruction : undefined;
  const args =
    method !== undefined ? call.args.slice(2) : vector?.kind === "vec.new_fixed" ? vector.elements : undefined;
  return { call, occurrence, ownerUnitId, liftedUnitId, symbol, view, fn, definitions, args };
}
type InvocationCall = NonNullable<ReturnType<typeof invocationCall>>;
const BOOLEAN = { kind: "val", val: { kind: "i32", boolean: true } } as const;
export interface NativeBooleanArgumentUse {
  readonly argument: number;
  readonly value: IrValueId;
}

function booleanArguments(source: NativeSourceClosureRequirements, call: InvocationCall, active: Set<string>) {
  const uses: NativeBooleanArgumentUse[] = [];
  for (const [argument, type] of call.fn.closureSubtype!.signature.params.entries()) {
    if (!objectResultIsBoolean(type)) continue;
    const value = call.args?.[argument];
    if (value === undefined) return undefined;
    if (proveObjectResultValue(source, call.ownerUnitId, call.view, value, BOOLEAN, true) === undefined) {
      const box = objectResultOriginal(value, call.definitions)?.instruction;
      const unbox =
        box?.kind === "intrinsic" && box.id === "js.boolean.box" && box.args.length === 1
          ? call.definitions.get(box.args[0]!)
          : undefined;
      if (!unbox || !booleanResult(source, call.ownerUnitId, call.view, unbox.occurrence, active)) return undefined;
    }
    uses.push({ argument, value });
  }
  return uses;
}

/** Call-specific formals are proved at the caller, not inferred from the callee's annotation. */
function returnsBoolean(
  source: NativeSourceClosureRequirements,
  call: InvocationCall,
  args: readonly NativeBooleanArgumentUse[],
  active: Set<string>,
): boolean {
  if (nativeSourceReturnsBoolean(source, call.liftedUnitId)) return true;
  if (!objectResultIsBoolean(call.fn.closureSubtype!.signature.returnType) || !args.length) return false;
  const owner = source.demands.owners.find((row) => row.unitId === call.liftedUnitId)!;
  return (["program", "projection"] as const).every((view) => {
    const fn = view === "program" ? owner.programFunction : owner.projectedFunction;
    if (
      !fn.closureSubtype ||
      !closureSignatureEquals(fn.closureSubtype.signature, call.fn.closureSubtype!.signature) ||
      fn.params.length !== fn.closureSubtype.signature.params.length + 1
    )
      return false;
    const parameters = new Set<IrValueId>();
    for (const arg of args) {
      const param = fn.params[arg.argument + 1];
      if (!param || !objectResultIsBoolean(param.type)) return false;
      parameters.add(param.value);
    }
    const definitions = objectResultDefinitions(source.demands, call.liftedUnitId, view);
    const seen = new Set<IrValueId>();
    const prove = (value: IrValueId): boolean => {
      if (seen.has(value)) return false;
      if (
        parameters.has(value) ||
        proveObjectResultValue(source, call.liftedUnitId, view, value, BOOLEAN, false) !== undefined
      )
        return true;
      seen.add(value);
      try {
        const row = definitions.get(value),
          instruction = row?.instruction;
        if (instruction?.kind === "intrinsic" && instruction.id === "js.boolean.unbox")
          return !!booleanResult(source, call.liftedUnitId, view, row!.occurrence, active);
        const arms =
          instruction?.kind === "if"
            ? [instruction.thenValue, instruction.elseValue]
            : instruction?.kind === "select"
              ? [instruction.whenTrue, instruction.whenFalse]
              : undefined;
        return !!arms?.every(prove);
      } finally {
        seen.delete(value);
      }
    };
    const values = fn.blocks.flatMap((block) => (block.terminator.kind === "return" ? [block.terminator.values] : []));
    for (const row of source.demands.occurrences) {
      const region = source.demands.buffers[row.bufferIndex]!;
      if (region.ownerUnitId === call.liftedUnitId && region.view === view && row.instruction.kind === "early.return")
        values.push(row.instruction.value === null ? [] : [row.instruction.value]);
    }
    return values.length > 0 && values.every((row) => row.length === 1 && prove(row[0]!));
  });
}

function checkedCall(
  source: NativeSourceClosureRequirements,
  ownerUnitId: IrUnitId,
  view: NativeStringValueView,
  occurrence: number,
  active: Set<string>,
) {
  const key = JSON.stringify([ownerUnitId, view, occurrence]);
  if (active.has(key)) return undefined;
  const call = invocationCall(source, ownerUnitId, view, occurrence);
  if (!call) return undefined;
  active.add(key);
  try {
    const args = booleanArguments(source, call, active);
    return args === undefined ? undefined : { call, args, booleanReturn: returnsBoolean(source, call, args, active) };
  } finally {
    active.delete(key);
  }
}

export function nativeInvocationBooleanArguments(
  source: NativeSourceClosureRequirements,
  ownerUnitId: IrUnitId,
  view: NativeStringValueView,
  occurrence: number,
) {
  const result = checkedCall(source, ownerUnitId, view, occurrence, new Set());
  if (!result) return undefined;
  return {
    arguments: result.args,
    liftedUnitId: result.call.liftedUnitId,
    symbol: result.call.symbol,
    site: result.call.call.site,
  };
}
export function nativeInvocationReturnsBoolean(
  source: NativeSourceClosureRequirements,
  ownerUnitId: IrUnitId,
  view: NativeStringValueView,
  occurrence: number,
): boolean {
  return checkedCall(source, ownerUnitId, view, occurrence, new Set())?.booleanReturn === true;
}
function booleanResult(
  source: NativeSourceClosureRequirements,
  ownerUnitId: IrUnitId,
  view: NativeStringValueView,
  occurrence: number,
  active: Set<string>,
) {
  const row = source.demands.occurrences[occurrence],
    region = row && source.demands.buffers[row.bufferIndex];
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
  const invocation = objectResultOriginal(
    extraction.args[0]!,
    objectResultDefinitions(source.demands, ownerUnitId, view),
  );
  if (!invocation) return undefined;
  const result = checkedCall(source, ownerUnitId, view, invocation.occurrence, active);
  if (!result?.booleanReturn) return undefined;
  const { call } = result;
  return {
    occurrence,
    callOccurrence: invocation.occurrence,
    ownerUnitId,
    liftedUnitId: call.liftedUnitId,
    symbol: call.symbol,
    site: call.call.site,
  };
}
export function nativeInvocationBooleanResult(
  source: NativeSourceClosureRequirements,
  ownerUnitId: IrUnitId,
  view: NativeStringValueView,
  occurrence: number,
) {
  return booleanResult(source, ownerUnitId, view, occurrence, new Set());
}
