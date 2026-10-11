// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { closureSignatureEquals, type IrInstr, type IrInstrCall, type IrType, type IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { nativeAsyncCallableValueTypes } from "../runtime/native-async-callables.js";
import { irOrdinaryObjectCallableDeclaration } from "../runtime/ordinary-object-callables.js";
import {
  assertNativeObjectAccessRequirementsCurrent,
  type NativeObjectAccessRequirements,
} from "./native-object-access-requirements.js";
import {
  assertNativeSourceClosureRequirementsCurrent,
  type NativeSourceClosureRequirements,
} from "./native-source-closure-requirements.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import {
  objectResultDefinitions,
  objectResultOriginal,
  objectResultIsBoolean,
  proveObjectGetterReturns,
  proveObjectResultValue,
  type ObjectResultDefinition,
} from "./native-object-result-values.js";

export interface NativeObjectResultUse {
  readonly occurrence: number;
  readonly getOccurrence: number;
  readonly ownerUnitId: IrUnitId;
  readonly definitionOccurrence: number;
  readonly resultType: IrType;
  readonly getterIndex?: number;
  readonly returnedAllocations: readonly number[];
}
export interface NativeObjectResultRequirements {
  readonly source: NativeSourceClosureRequirements;
  readonly access: NativeObjectAccessRequirements;
  readonly uses: readonly NativeObjectResultUse[];
  readonly gaps: readonly { readonly occurrence: number; readonly unitId: IrUnitId; readonly detail: string }[];
}
const issued = new WeakMap<NativeObjectResultRequirements, unknown>();
function fail(detail: string): never {
  throw new Error(`ordinary Get result proof: ${detail}`);
}
function feature(instruction: IrInstr | undefined): string | undefined {
  return instruction?.kind === "call" ? irOrdinaryObjectCallableDeclaration(instruction.target)?.feature : undefined;
}
function literalKey(value: IrValueId, definitions: ReadonlyMap<IrValueId, ObjectResultDefinition>): string | undefined {
  const instruction = objectResultOriginal(value, definitions)?.instruction;
  return instruction?.kind === "string.const" ? instruction.value : undefined;
}
function sameBuffer(access: NativeObjectAccessRequirements, left: number, right: number): boolean {
  return access.demands.occurrences[left]?.bufferIndex === access.demands.occurrences[right]?.bufferIndex;
}
function before(access: NativeObjectAccessRequirements, left: number, right: number): boolean {
  return (
    sameBuffer(access, left, right) &&
    access.demands.occurrences[left]!.instructionIndex < access.demands.occurrences[right]!.instructionIndex
  );
}

/** An execution-order proof, not an exemption from C1 prototype/resource obligations. */
function prefixGap(access: NativeObjectAccessRequirements, creation: number, get: number): string | undefined {
  if (!before(access, creation, get)) return "creation/Get needs its authenticated control-flow order";
  const start = access.demands.occurrences[creation]!,
    end = access.demands.occurrences[get]!;
  const buffer = access.demands.buffers[start.bufferIndex]!;
  if (buffer.root.kind !== "block" || buffer.path.length) return "nested ordinary Get needs its control/effect join";
  for (const instruction of buffer.instructions.slice(start.instructionIndex + 1, end.instructionIndex)) {
    const ordinary = feature(instruction);
    if (ordinary?.startsWith("js.object.define-") || ordinary?.startsWith("js.object.create-")) continue;
    if (instruction.kind === "intrinsic" && ["js.number.box", "js.boolean.box"].includes(instruction.id)) continue;
    if (
      [
        "const",
        "string.const",
        "coerce.to_externref",
        "closure.new",
        "closure.cap",
        "refcell.new",
        "refcell.get",
        "binary",
        "unary",
        "select",
      ].includes(instruction.kind)
    )
      continue;
    return `operation ${instruction.kind} before Get lacks its descriptor-preservation proof`;
  }
  return undefined;
}

interface SelectedDescriptor {
  readonly occurrence: number;
  readonly kind: "data" | "accessor";
  readonly value: IrValueId | undefined;
}
function selectDescriptor(
  access: NativeObjectAccessRequirements,
  get: NativeObjectAccessRequirements["uses"][number],
  definitions: ReadonlyMap<IrValueId, ObjectResultDefinition>,
  view: "program" | "projection",
): SelectedDescriptor | string {
  if (get.creationOccurrence === undefined) return "Get receiver lacks its actual ordinary creation";
  const coordinate = (use: NativeObjectAccessRequirements["uses"][number]) =>
    view === "program" ? use.semanticOccurrence : use.occurrence;
  const creationUse = access.uses.find((row) => row.occurrence === get.creationOccurrence);
  if (!creationUse) return "Get creation lacks its paired semantic operation";
  const getOccurrence = coordinate(get),
    creationOccurrence = coordinate(creationUse);
  const call = access.demands.occurrences[getOccurrence]!.instruction as IrInstrCall;
  if (objectResultOriginal(call.args[0]!, definitions)?.occurrence !== creationOccurrence)
    return "semantic/projection Get receiver creation differs";
  const key = literalKey(call.args[1]!, definitions);
  if (key === undefined) return "Get key lacks its exact canonical String producer";
  const prefix = prefixGap(access, creationOccurrence, getOccurrence);
  if (prefix) return prefix;
  let selected: SelectedDescriptor | undefined;
  for (const use of access.uses) {
    if (use.ownerUnitId !== get.ownerUnitId || !use.feature.startsWith("js.object.define-")) continue;
    const occurrence = coordinate(use);
    if (!sameBuffer(access, occurrence, getOccurrence))
      return "descriptor/Get needs its authenticated control-flow order";
    if (!before(access, occurrence, getOccurrence)) continue;
    const definition = access.demands.occurrences[occurrence]!.instruction as IrInstrCall;
    const receiver = objectResultOriginal(definition.args[0]!, definitions);
    if (!feature(receiver?.instruction)?.startsWith("js.object.create-"))
      return "preceding descriptor write lacks its actual receiver creation";
    if (receiver!.occurrence !== creationOccurrence) continue;
    const definedKey = literalKey(definition.args[1]!, definitions);
    if (definedKey === undefined) return "preceding descriptor has an unresolved potentially matching key";
    if (definedKey !== key) continue;
    const mask = use.descriptorMask;
    if (mask === undefined) return "selected descriptor lacks its actual presence mask";
    if (use.feature === "js.object.define-attributes") continue;
    const kind = use.feature === "js.object.define-data" ? "data" : "accessor";
    const supplied = !!(mask & (kind === "data" ? 128 : 256));
    selected = supplied
      ? { kind, occurrence, value: definition.args[2] }
      : selected?.kind === kind
        ? selected
        : { kind, occurrence, value: undefined };
  }
  return selected ?? "selected key needs its inherited/default-prototype result proof";
}

function selectedResult(
  source: NativeSourceClosureRequirements,
  access: NativeObjectAccessRequirements,
  occurrence: number,
  getOccurrence: number,
  expected: IrType,
): NativeObjectResultUse | string {
  const get = access.uses.find((row) => row.occurrence === getOccurrence && row.feature === "js.object.get");
  if (!get) return "projection is not attached to its actual ordinary Get";
  if (!before(access, getOccurrence, occurrence))
    return "Get/result projection needs its authenticated control-flow order";
  const definitions = objectResultDefinitions(access.demands, get.ownerUnitId, "projection");
  const descriptor = selectDescriptor(access, get, definitions, "projection");
  if (typeof descriptor === "string") return descriptor;
  const semanticDefinitions = objectResultDefinitions(access.demands, get.ownerUnitId, "program");
  const semantic = selectDescriptor(access, get, semanticDefinitions, "program");
  if (typeof semantic === "string") return semantic;
  const pairedDescriptor = access.uses.find((row) => row.occurrence === descriptor.occurrence);
  if (semantic.occurrence !== pairedDescriptor?.semanticOccurrence || semantic.kind !== descriptor.kind)
    return "semantic/projection selected descriptor differs";
  const projectedCall = access.demands.occurrences[getOccurrence]!.instruction as IrInstrCall;
  const semanticCall = access.demands.occurrences[get.semanticOccurrence]!.instruction as IrInstrCall;
  if (literalKey(projectedCall.args[1]!, definitions) !== literalKey(semanticCall.args[1]!, semanticDefinitions))
    return "semantic/projection selected Get key differs";
  if (descriptor.value === undefined) return "selected descriptor yields undefined, not the requested logical result";
  const base = {
    occurrence,
    getOccurrence,
    ownerUnitId: get.ownerUnitId,
    definitionOccurrence: descriptor.occurrence,
    resultType: expected,
  };
  if (descriptor.kind === "data") {
    const returnedAllocations = proveObjectResultValue(
      source,
      get.ownerUnitId,
      "projection",
      descriptor.value,
      expected,
      true,
    );
    const semanticProof =
      semantic.value === undefined
        ? undefined
        : proveObjectResultValue(source, get.ownerUnitId, "program", semantic.value, expected, true);
    return returnedAllocations && semanticProof
      ? { ...base, returnedAllocations }
      : "selected data value lacks its actual Boolean/callable producer";
  }
  const candidates = access.getters
    .map((getter, getterIndex) => ({ getter, getterIndex }))
    .filter(
      ({ getter }) =>
        getter.getOccurrence === getOccurrence &&
        getter.definitionOccurrence === descriptor.occurrence &&
        getter.getterValue === descriptor.value,
    );
  if (candidates.length !== 1) return "selected getter lacks its exact allocation/descriptor association";
  const { getter, getterIndex } = candidates[0]!;
  if (preparedIrDataMismatch(getter.signature.returnType, expected) !== undefined)
    return "selected getter signature differs from requested logical result";
  const returnedAllocations = proveObjectGetterReturns(source, getter.liftedUnitId, expected);
  return returnedAllocations
    ? { ...base, getterIndex, returnedAllocations }
    : "selected getter has an unproved or mixed actual return producer";
}

function projectedIntent(instruction: IrInstr, types: ReadonlyMap<IrValueId, IrType>) {
  if (instruction.kind === "intrinsic" && instruction.id === "js.boolean.unbox")
    return {
      value: instruction.args.length === 1 ? instruction.args[0] : undefined,
      resultType: instruction.resultType,
    };
  if (instruction.kind !== "coerce.to_externref" || instruction.resultType?.kind !== "callable") return undefined;
  const type = types.get(instruction.value);
  if (
    (type?.kind === "closure" || type?.kind === "callable") &&
    closureSignatureEquals(type.signature, instruction.resultType.signature)
  )
    return undefined;
  return { value: instruction.value, resultType: instruction.resultType };
}

function calculate(source: NativeSourceClosureRequirements, access: NativeObjectAccessRequirements) {
  assertNativeSourceClosureRequirementsCurrent(source);
  assertNativeObjectAccessRequirementsCurrent(access);
  if (
    source.demands.program !== access.demands.program ||
    source.demands.projection !== access.demands.projection ||
    source.demands.allocations !== access.demands.allocations
  )
    fail("different prepared program/projection/allocation owner");
  const uses: NativeObjectResultUse[] = [],
    gaps: NativeObjectResultRequirements["gaps"][number][] = [];
  for (const owner of access.demands.owners) {
    const populations: { get: number | undefined; resultType: IrType | null }[][] = [];
    for (const view of ["program", "projection"] as const) {
      const fn = view === "program" ? owner.programFunction : owner.projectedFunction;
      const types = nativeAsyncCallableValueTypes(fn),
        definitions = objectResultDefinitions(access.demands, owner.unitId, view);
      const population: { get: number | undefined; resultType: IrType | null }[] = [];
      for (const [occurrence, row] of access.demands.occurrences.entries()) {
        const buffer = access.demands.buffers[row.bufferIndex]!;
        if (buffer.ownerUnitId !== owner.unitId || buffer.view !== view) continue;
        const intent = projectedIntent(row.instruction, types);
        if (!intent) continue;
        const get = intent.value === undefined ? undefined : definitions.get(intent.value);
        population.push({
          get:
            view === "program"
              ? get?.occurrence
              : access.uses.find((use) => use.occurrence === get?.occurrence)?.semanticOccurrence,
          resultType: intent.resultType,
        });
        let result: NativeObjectResultUse | string;
        if (!intent.resultType || (!objectResultIsBoolean(intent.resultType) && intent.resultType.kind !== "callable"))
          result = "result projection lost its branded Boolean/callable type";
        else if (feature(get?.instruction) !== "js.object.get")
          result = "raw externref projection lacks its actual ordinary Get result";
        else if (view === "program") continue;
        else result = selectedResult(source, access, occurrence, get!.occurrence, intent.resultType);
        if (typeof result === "string") gaps.push({ occurrence, unitId: owner.unitId, detail: result });
        else uses.push(result);
      }
      populations.push(population);
    }
    if (preparedIrDataMismatch(populations[0], populations[1]) !== undefined)
      gaps.push({
        occurrence: -1,
        unitId: owner.unitId,
        detail: "semantic/projection result occurrence or logical contract differs",
      });
  }
  return { uses, gaps };
}

export function deriveNativeObjectResultRequirements(
  source: NativeSourceClosureRequirements,
  access: NativeObjectAccessRequirements,
): NativeObjectResultRequirements {
  const data = calculate(source, access);
  const pack = Object.freeze({ source, access, ...(freezePreparedIrValue(data) as typeof data) });
  issued.set(pack, freezePreparedIrValue(data));
  return pack;
}
export function assertNativeObjectResultRequirementsCurrent(pack: NativeObjectResultRequirements): void {
  const snapshot = issued.get(pack);
  if (
    !snapshot ||
    preparedIrDataMismatch(snapshot, { uses: pack.uses, gaps: pack.gaps }) !== undefined ||
    preparedIrDataMismatch(snapshot, calculate(pack.source, pack.access)) !== undefined
  )
    fail("unissued, copied or stale result proof");
}
