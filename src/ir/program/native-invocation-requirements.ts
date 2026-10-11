// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrInstr, IrInstrCall, IrValueId, IrType } from "../core/nodes.js";
import { closureSignatureEquals } from "../core/types.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import {
  IR_CLOSURE_VECTOR_APPLY,
  IR_CLOSURE_UNDEFINED,
  closureMethodArity,
} from "../core/closure-invocation-callables.js";
import { nativeAsyncCallableValueTypes } from "../runtime/native-async-callables.js";
import {
  assertNativeSourceClosureRequirementsCurrent,
  type NativeSourceClosureRequirements,
} from "./native-source-closure-requirements.js";
import {
  collectNativePromiseSourceCensus,
  assertNativePromiseSourceCensusCurrent,
  type NativePromiseSourceCensus,
} from "./native-promise-inventory.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import {
  deriveNativeObjectAccessRequirements,
  type NativeObjectAccessRequirements,
} from "./native-object-access-requirements.js";
import {
  deriveNativeObjectResultRequirements,
  assertNativeObjectResultRequirementsCurrent,
  type NativeObjectResultRequirements,
} from "./native-object-result-requirements.js";
import {
  reconcileNativeGetterInvocationRequirements,
  type NativeGetterInvocationUse,
} from "./native-getter-invocation-requirements.js";

export interface NativeInvocationUse {
  readonly occurrence: number;
  readonly ownerUnitId: IrUnitId;
  readonly kind: "method" | "apply-vector" | "undefined";
  readonly arity?: number;
  readonly liftedUnitId?: IrUnitId;
  readonly callbacks?: readonly {
    readonly argument: number;
    readonly allocationOccurrence: number;
    readonly liftedUnitId: IrUnitId;
  }[];
}
export interface NativeInvocationRequirements {
  readonly key: string;
  readonly source: NativeSourceClosureRequirements;
  readonly runtimeCreated: NativePromiseSourceCensus;
  readonly uses: readonly NativeInvocationUse[];
  /** Exact C1 issuer identity; its property/prototype gaps remain owned by C1. */
  readonly objectAccess?: NativeObjectAccessRequirements;
  readonly objectResults?: NativeObjectResultRequirements;
  readonly getterUses: readonly NativeGetterInvocationUse[];
  readonly methodArities: readonly number[];
  readonly applyVector: boolean;
  readonly gaps: readonly { readonly unitId: IrUnitId; readonly detail: string }[];
  /** This owner cannot certify other compiler-created callable producers. */
  readonly completionScope: "selected-source-invocation";
}
const owners = new WeakMap<NativeInvocationRequirements, unknown>();
function fail(detail: string): never {
  throw new Error(`native invocation requirements: ${detail}`);
}
function external(type: IrType | undefined): boolean {
  return (
    type?.kind === "extern" ||
    type?.kind === "callable" ||
    (type?.kind === "val" && !type.typeRef && type.val.kind === "externref")
  );
}

/** Reconcile the actual pack graph with this projection's current allocation site. */
function callableAllocation(
  source: NativeSourceClosureRequirements,
  unitId: IrUnitId,
  value: IrValueId,
  defs: ReadonlyMap<IrValueId, IrInstr>,
  types: ReadonlyMap<IrValueId, IrType>,
  role: string,
) {
  const erased = defs.get(value);
  const packed = erased?.kind === "coerce.to_externref" ? defs.get(erased.value) : undefined;
  const type = erased?.kind === "coerce.to_externref" ? types.get(erased.value) : undefined;
  if (type?.kind !== "callable") fail(`${role} lost its actual logical callable signature`);
  const allocation = packed?.kind === "coerce.to_externref" ? defs.get(packed.value) : undefined;
  if (allocation?.kind !== "closure.new" || allocation.liftedFunc.binding.kind !== "unit")
    fail(`${role} is not its selected source allocation`);
  if (!closureSignatureEquals(type.signature, allocation.signature))
    fail(`${role} pack differs from its actual allocation signature`);
  const associations = source.allocations.filter((item) => {
    const occurrence = source.demands.occurrences[item.occurrence];
    const region = occurrence && source.demands.buffers[occurrence.bufferIndex];
    return (
      occurrence?.instruction === allocation &&
      region?.view === "projection" &&
      region.ownerUnitId === unitId &&
      item.ownerUnitId === unitId
    );
  });
  if (associations.length !== 1) fail(`${role} has no one-to-one current allocation association`);
  return { type, liftedUnitId: allocation.liftedFunc.binding.unitId, association: associations[0]! };
}

function callbackArguments(
  source: NativeSourceClosureRequirements,
  unitId: IrUnitId,
  signature: Extract<IrType, { kind: "callable" }>["signature"],
  args: readonly IrValueId[],
  defs: ReadonlyMap<IrValueId, IrInstr>,
  types: ReadonlyMap<IrValueId, IrType>,
): NonNullable<NativeInvocationUse["callbacks"]> {
  return signature.params.flatMap((expected, index) => {
    if (expected.kind !== "callable") return [];
    const value = args[index];
    if (value === undefined) fail("callback argument lacks its actual source allocation");
    const actual = callableAllocation(source, unitId, value, defs, types, "callback argument");
    if (!closureSignatureEquals(expected.signature, actual.type.signature))
      fail("callback argument differs from the receiving parameter's exact signature");
    return [
      { argument: index, allocationOccurrence: actual.association.occurrence, liftedUnitId: actual.liftedUnitId },
    ];
  });
}

/** A numeric default consumes the sentinel; other f64 bodies cannot preserve an undefined value. */
function undefinedScalarArguments(
  signature: Extract<IrType, { kind: "callable" }>["signature"],
  args: readonly IrValueId[],
  defs: ReadonlyMap<IrValueId, IrInstr>,
): readonly number[] {
  return signature.params.flatMap((type, index) => {
    if (
      type.kind !== "val" ||
      type.typeRef ||
      type.val.kind !== "f64" ||
      index >= (signature.defaultParamStart ?? signature.params.length)
    )
      return [];
    const argument = args[index];
    const definition = argument === undefined ? undefined : defs.get(argument);
    return argument === undefined ||
      (definition?.kind === "call" &&
        definition.target.binding.kind === "intrinsic" &&
        definition.target.binding.symbol === IR_CLOSURE_UNDEFINED)
      ? [index]
      : [];
  });
}

function calculate(
  source: NativeSourceClosureRequirements,
  objectAccess?: NativeObjectAccessRequirements,
  objectResults?: NativeObjectResultRequirements,
) {
  assertNativeSourceClosureRequirementsCurrent(source);
  const uses: NativeInvocationUse[] = [],
    gaps: NativeInvocationRequirements["gaps"][number][] = [];
  if (objectResults) {
    assertNativeObjectResultRequirementsCurrent(objectResults);
    if (objectResults.source !== source || objectResults.access !== objectAccess)
      fail("detached keyed Get result proof");
    gaps.push(...objectResults.gaps.map((row) => ({ unitId: row.unitId, detail: row.detail })));
  }
  const { demands } = source;
  const typeMaps = new Map<IrUnitId, ReturnType<typeof nativeAsyncCallableValueTypes>>();
  const definitions = new Map<IrUnitId, Map<IrValueId, IrInstr>>();
  for (const [occurrence, row] of demands.occurrences.entries()) {
    const buffer = demands.buffers[row.bufferIndex]!;
    if (buffer.view !== "projection" || row.instruction.kind !== "call") continue;
    const call: IrInstrCall = row.instruction,
      binding = call.target.binding;
    if (binding.kind !== "intrinsic") continue;
    const arity = closureMethodArity(binding.symbol);
    const kind =
      arity !== undefined
        ? "method"
        : binding.symbol === IR_CLOSURE_VECTOR_APPLY
          ? "apply-vector"
          : binding.symbol === IR_CLOSURE_UNDEFINED
            ? "undefined"
            : undefined;
    if (!kind) continue;
    const unitId = buffer.ownerUnitId;
    let types = typeMaps.get(unitId);
    if (!types) {
      const fn = demands.owners.find((owner) => owner.unitId === unitId)?.projectedFunction;
      if (!fn) fail("invocation occurrence has no actual selected owner");
      typeMaps.set(unitId, (types = nativeAsyncCallableValueTypes(fn)));
    }
    if (call.result === null || !external(call.resultType ?? undefined))
      fail("semantic invocation result is not externref");
    if (kind === "undefined") {
      if (call.args.length) fail("canonical undefined callable takes no operands");
      uses.push({ occurrence, ownerUnitId: unitId, kind });
      continue;
    }
    if (call.args.length !== (kind === "method" ? arity! + 2 : 3)) fail("semantic invocation argument count differs");
    const callee = call.args[kind === "method" ? 1 : 0]!;
    if (!external(types.get(callee))) fail("callee has no external invocation carrier");
    if (!external(types.get(call.args[kind === "method" ? 0 : 1]!))) fail("receiver is not an external value");
    if (kind === "method") {
      if (!call.args.slice(2).every((value) => external(types.get(value))))
        fail("method operand has no exact external carrier");
    } else {
      const argv = types.get(call.args[2]!);
      if (argv?.kind !== "vec" || !external(argv.elementType) || argv.layout)
        fail("apply lacks its actual native argument-vector input");
    }
    let defs = definitions.get(unitId);
    if (!defs) {
      defs = new Map();
      for (const candidate of demands.occurrences) {
        const region = demands.buffers[candidate.bufferIndex]!;
        if (region.view === "projection" && region.ownerUnitId === unitId && candidate.instruction.result !== null)
          defs.set(candidate.instruction.result, candidate.instruction);
      }
      definitions.set(unitId, defs);
    }
    const { type: calleeType, liftedUnitId } = callableAllocation(
      source,
      unitId,
      callee,
      defs,
      types,
      "invocation callee",
    );
    const argv = kind === "apply-vector" ? defs.get(call.args[2]!) : undefined;
    if (
      calleeType.signature.params.some((type) => type.kind === "callable") &&
      kind === "apply-vector" &&
      argv?.kind !== "vec.new_fixed"
    )
      fail("callback apply arguments lack their actual fixed-vector producers");
    const args = kind === "method" ? call.args.slice(2) : argv?.kind === "vec.new_fixed" ? argv.elements : [];
    const callbacks = callbackArguments(source, unitId, calleeType.signature, args, defs, types);
    for (const argument of undefinedScalarArguments(calleeType.signature, args, defs))
      gaps.push({
        unitId,
        detail: `callable ${liftedUnitId} argument ${argument} needs an undefined-preserving value carrier; non-default f64 omission/undefined is unsupported`,
      });
    const fn = demands.owners.find((owner) => owner.unitId === liftedUnitId)?.projectedFunction;
    const metadata = fn?.closureSubtype;
    if (
      !metadata?.parameters ||
      metadata.parameters.kind !== "fixed" ||
      metadata.parameters.count !== metadata.signature.params.length ||
      metadata.parameters.publicLength !== (metadata.signature.defaultParamStart ?? metadata.parameters.count)
    )
      gaps.push({
        unitId,
        detail: `callable ${liftedUnitId} needs its fixed-parameter/public-length producer contract`,
      });
    const supported = (type: IrType): boolean =>
      external(type) || (type.kind === "val" && !type.typeRef && type.val.kind === "f64");
    if (
      !calleeType.signature.params.every(supported) ||
      (calleeType.signature.returnType && !supported(calleeType.signature.returnType))
    )
      gaps.push({ unitId, detail: `callable ${liftedUnitId} needs its actual argument/result conversion owner` });
    uses.push({
      occurrence,
      ownerUnitId: unitId,
      kind,
      ...(arity === undefined ? {} : { arity }),
      liftedUnitId,
      callbacks,
    });
  }
  const getters = objectAccess
    ? reconcileNativeGetterInvocationRequirements(source, objectAccess)
    : { getterUses: [], gaps: [] };
  gaps.push(...getters.gaps);
  return {
    uses,
    getterUses: getters.getterUses,
    methodArities: [
      ...new Set([
        ...uses.flatMap((use) => (use.arity === undefined ? [] : [use.arity])),
        ...(getters.getterUses.length ? [0] : []),
      ]),
    ].sort((a, b) => a - b),
    applyVector: uses.some((use) => use.kind === "apply-vector"),
    gaps,
  };
}

export function planNativeInvocationRequirements(
  source: NativeSourceClosureRequirements,
  options: { readonly utf8Storage: boolean; readonly objectAccess?: NativeObjectAccessRequirements },
): NativeInvocationRequirements | undefined {
  const objectAccess =
    options.objectAccess ??
    (needsObjectResultProof(source)
      ? deriveNativeObjectAccessRequirements(source.demands.program, source.demands.projection)
      : undefined);
  const objectResults = objectAccess ? deriveNativeObjectResultRequirements(source, objectAccess) : undefined;
  const data = calculate(source, objectAccess, objectResults);
  if (!data.uses.length && !data.getterUses.length && !objectResults?.gaps.length) return undefined;
  const { program, projection } = source.demands;
  const runtimeCreated = collectNativePromiseSourceCensus(program, projection, {
    backend: projection.backend,
    target: projection.target,
    utf8Storage: options.utf8Storage,
  });
  if (runtimeCreated.required)
    data.gaps.push({
      unitId: runtimeCreated.anchorUnitId,
      detail: "runtime-created Promise settlement callables need their issued producer/fill association",
    });
  const pack = Object.freeze({
    key: `${source.key}:invocation`,
    source,
    runtimeCreated,
    ...(objectAccess ? { objectAccess } : {}),
    ...(objectResults ? { objectResults } : {}),
    ...(freezePreparedIrValue(data) as typeof data),
    completionScope: "selected-source-invocation" as const,
  });
  owners.set(pack, freezePreparedIrValue(data));
  return pack;
}

function needsObjectResultProof(source: NativeSourceClosureRequirements): boolean {
  for (const owner of source.demands.owners) {
    const types = nativeAsyncCallableValueTypes(owner.projectedFunction);
    for (const row of source.demands.occurrences) {
      const buffer = source.demands.buffers[row.bufferIndex]!;
      if (buffer.ownerUnitId !== owner.unitId || buffer.view !== "projection") continue;
      const instruction = row.instruction;
      if (
        instruction.kind === "call" &&
        instruction.target.binding.kind === "intrinsic" &&
        instruction.target.binding.symbol === "js.object.get"
      )
        return true;
      if (instruction.kind === "intrinsic" && instruction.id === "js.boolean.unbox") return true;
      if (instruction.kind === "coerce.to_externref" && instruction.resultType?.kind === "callable") {
        const input = types.get(instruction.value);
        if (input?.kind !== "closure" && input?.kind !== "callable") return true;
      }
    }
  }
  return false;
}

export function assertNativeInvocationRequirementsCurrent(pack: NativeInvocationRequirements): void {
  const snapshot = owners.get(pack);
  if (!snapshot) fail("unissued or copied invocation requirements");
  assertNativePromiseSourceCensusCurrent(pack.runtimeCreated);
  const data = calculate(pack.source, pack.objectAccess, pack.objectResults);
  if (pack.runtimeCreated.required)
    data.gaps.push({
      unitId: pack.runtimeCreated.anchorUnitId,
      detail: "runtime-created Promise settlement callables need their issued producer/fill association",
    });
  if (
    pack.runtimeCreated.program !== pack.source.demands.program ||
    pack.runtimeCreated.projection !== pack.source.demands.projection ||
    pack.completionScope !== "selected-source-invocation" ||
    pack.key !== `${pack.source.key}:invocation` ||
    preparedIrDataMismatch(data, snapshot) !== undefined ||
    preparedIrDataMismatch(data, {
      uses: pack.uses,
      getterUses: pack.getterUses,
      methodArities: pack.methodArities,
      applyVector: pack.applyVector,
      gaps: pack.gaps,
    }) !== undefined
  )
    fail("stale invocation source, population or scope");
}
