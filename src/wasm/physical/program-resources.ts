// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Descriptive checks only: raw maps/callbacks/definitions issue no semantic authority here.
import type { IrBindingId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import { sameValTypes } from "./function-types.js";
import { buildNumberRemainderBody } from "./number-remainder.js";
import type { Instr, ValType, LocalDef } from "../model/instructions.js";
import type { WasmFunction } from "../model/module-records.js";
import type {
  PhysicalModuleReservations,
  PhysicalFunctionSignature,
  PhysicalReservation,
  CallableReservation,
  GlobalReservation,
  GlobalImportReservation,
  FunctionReservation,
} from "./module-reservations.js";

type FailurePolicy = (detail: string) => never;
interface SignatureData<T> {
  readonly params: readonly T[];
  readonly results: readonly T[];
}
interface GlobalData {
  readonly bindingId: IrBindingId;
  readonly referenceKey: string;
  readonly name: string;
  readonly type: ValType;
  readonly mutable: boolean;
}
/** Physical data only. Opaque signature elements are converted by the original compiler owner. */
interface ProgramResourceData<T> {
  readonly startup: {
    readonly units: readonly IrUnitId[];
    readonly adapter: "none" | "wasm-start" | "deferred-export";
  };
  readonly importedFunctions: readonly (SignatureData<T> & {
    readonly bindingId: IrBindingId;
    readonly referenceKey: string;
    readonly module: string;
    readonly field: string;
  })[];
  readonly functions: readonly (SignatureData<T> & {
    readonly bindingId: IrBindingId;
    readonly unitId: IrUnitId;
    readonly name: string;
  })[];
  readonly importedGlobals: readonly (GlobalData & { readonly module: string; readonly field: string })[];
  readonly definedGlobals: readonly GlobalData[];
  readonly numberRemainders: readonly (SignatureData<ValType> & {
    readonly bindingId: IrBindingId;
    readonly referenceKey: string;
    readonly symbol: string;
    readonly earlyMagnitude: boolean;
  })[];
}

interface PhysicalProgramBindingData {
  /** Error classification remains with the original compiler owner, not Wasm storage. */
  readonly fail: FailurePolicy;
  readonly reservations: PhysicalModuleReservations;
  readonly resourcesByBinding: ReadonlyMap<IrBindingId, PhysicalReservation>;
  readonly functionsByKey: ReadonlyMap<string, CallableReservation>;
  readonly globalsByKey: ReadonlyMap<string, GlobalReservation | GlobalImportReservation>;
}
type SignatureConverter<T> = (signature: SignatureData<T>) => PhysicalFunctionSignature;

/** Materialize the selected physical startup adapter without changing source evaluation order. */
export function fillStartupAdapter<T>(
  startAdapter: FunctionReservation | undefined,
  plan: ProgramResourceData<T>,
  slots: ReadonlyMap<IrUnitId, FunctionReservation>,
  context: PhysicalProgramBindingData,
): void {
  if (!startAdapter) return;
  const fail: FailurePolicy = context.fail;
  const body = plan.startup.units.map((unitId): Instr => {
    const target = slots.get(unitId);
    if (!target) fail(`startup unit ${unitId} has no reserved slot`);
    return { op: "call", funcIdx: target.handle };
  });
  context.reservations.fillFunction(startAdapter, { locals: [], body });
  if (plan.startup.adapter === "wasm-start") context.reservations.defineStart(startAdapter);
  else if (plan.startup.adapter === "deferred-export")
    context.reservations.defineExport("publication:startup", "__module_init", startAdapter);
  else fail(`startup adapter ${plan.startup.adapter} has executable units but no materialization`);
}

/** Index physical input rows only; the genuine consumer retains semantic custody. */
export function indexSupportFunctions(
  rows: readonly { readonly space: string; readonly reservation: PhysicalReservation }[],
  fail: FailurePolicy,
): Map<WasmFunction, FunctionReservation> {
  const functions = new Map<WasmFunction, FunctionReservation>();
  for (const row of rows) {
    if (row.space !== "function") continue;
    const token = row.reservation;
    if (token.kind !== "function") fail("support function row has a non-function reservation");
    const previous = functions.get(token.object);
    if (previous && previous !== row.reservation) fail("support function has competing reservation owners");
    functions.set(token.object, token);
  }
  return functions;
}

/** Data audit only: async exclusions still need their actual separate completion producer. */
export function assertSynchronousPrimaryDefinitions<T>(
  plan: ProgramResourceData<T>,
  context: PhysicalProgramBindingData,
  definitions: ReadonlyMap<
    IrUnitId,
    { readonly locals: LocalDef[]; readonly body: Instr[]; readonly signature: PhysicalFunctionSignature }
  >,
  asyncOwners: ReadonlyMap<IrUnitId, unknown>,
): void {
  const fail: FailurePolicy = context.fail;
  const synchronous = plan.functions.filter((row) => !asyncOwners.has(row.unitId));
  if (definitions.size !== synchronous.length) fail("primary canonical population is incomplete");
  for (const row of synchronous) {
    const definition = definitions.get(row.unitId),
      slot = context.resourcesByBinding.get(row.bindingId);
    if (!definition || !slot || slot.kind !== "function")
      fail("primary definition lost its original unit/slot association");
    context.reservations.assertFunctionSignature(slot, definition.signature);
    context.reservations.assertCanonicalFunctionDefinition(slot, definition);
  }
}

/** Actual physical module census/order, not completion or callable authority. */
export function collectEmittedPrimaryUnitIds<T>(
  plan: ProgramResourceData<T>,
  functions: readonly WasmFunction[],
  slotOwners: ReadonlyMap<WasmFunction, IrUnitId>,
  permittedUnowned: readonly (WasmFunction | undefined)[],
  fail: FailurePolicy,
): IrUnitId[] {
  const emittedUnitIds: IrUnitId[] = [];
  for (const fn of functions) {
    const unitId = slotOwners.get(fn);
    if (unitId === undefined) {
      if (!permittedUnowned.includes(fn)) fail(`module carries an unowned function ${fn.name}`);
      continue;
    }
    emittedUnitIds.push(unitId);
  }
  if (emittedUnitIds.length !== plan.functions.length)
    fail(`module holds ${emittedUnitIds.length} owned bodies but the plan reserved ${plan.functions.length}`);
  if (emittedUnitIds.some((unitId, index) => unitId !== plan.functions[index]!.unitId))
    fail("module function ownership order contradicts the reserved program projection");
  return emittedUnitIds;
}

/** Original consumer scalar initialization policy; fresh instructions at every occurrence. */
export function defaultPhysicalScalarInitializer(type: ValType, fail: FailurePolicy): Instr[] {
  switch (type.kind) {
    case "i32":
      return [{ op: "i32.const", value: 0 }];
    case "i64":
      return [{ op: "i64.const", value: 0n }];
    case "f32":
      return [{ op: "f32.const", value: 0 }];
    case "f64":
      return [{ op: "f64.const", value: 0 }];
    default:
      return fail(`no default initializer for global type ${type.kind}`);
  }
}

/** Existing consumer scalar resource fill, with the same canonical initializer/body builders. */
export function fillPhysicalScalarResources<T>(
  plan: ProgramResourceData<T>,
  context: PhysicalProgramBindingData,
): void {
  const { reservations, globalsByKey } = context;
  const fail: FailurePolicy = context.fail;
  for (const global of plan.definedGlobals) {
    const reserved = globalsByKey.get(global.referenceKey);
    if (!reserved || reserved.kind !== "global") fail(`global ${global.name} has no defined reservation`);
    reservations.fillGlobal(reserved, defaultPhysicalScalarInitializer(global.type, fail));
  }
  for (const resource of plan.numberRemainders) {
    const token = context.resourcesByBinding.get(resource.bindingId);
    if (!token || token.kind !== "function") fail("number remainder reservation vanished before fill");
    context.reservations.fillFunction(token, buildNumberRemainderBody(resource.earlyMagnitude));
  }
}

/** Re-derive original program resource headers; accepted fill receipts alone are insufficient. */
export function assertPhysicalProgramBindings<T>(
  plan: ProgramResourceData<T>,
  context: PhysicalProgramBindingData,
  physicalSignature: SignatureConverter<T>,
  unitFunctions: ReadonlyMap<IrUnitId, CallableReservation | undefined>,
): void {
  const { reservations: tx, resourcesByBinding, functionsByKey, globalsByKey } = context;
  const fail: FailurePolicy = context.fail;
  for (const row of plan.importedFunctions) {
    const slot = resourcesByBinding.get(row.bindingId);
    if (
      !slot ||
      slot.kind !== "function-import" ||
      slot.key !== row.bindingId ||
      functionsByKey.get(row.referenceKey) !== slot ||
      slot.object.module !== row.module ||
      slot.object.name !== row.field
    )
      fail("imported callable differs from its original accepted binding");
    tx.assertFunctionSignature(slot, physicalSignature(row));
  }
  for (const row of plan.functions) {
    const slot = resourcesByBinding.get(row.bindingId);
    if (
      !slot ||
      slot.kind !== "function" ||
      slot.key !== row.bindingId ||
      slot.object.name !== row.name ||
      unitFunctions.get(row.unitId) !== slot
    )
      fail("primary callable differs from its original accepted binding");
    tx.assertFunctionSignature(slot, physicalSignature(row));
  }
  for (const row of plan.importedGlobals) {
    const slot = resourcesByBinding.get(row.bindingId);
    if (
      !slot ||
      slot.kind !== "global-import" ||
      slot.key !== row.bindingId ||
      globalsByKey.get(row.referenceKey) !== slot ||
      slot.object.module !== row.module ||
      slot.object.name !== row.field ||
      slot.object.desc.kind !== "global" ||
      slot.object.desc.mutable !== row.mutable ||
      !sameValTypes([slot.object.desc.type], [row.type])
    )
      fail("imported scalar global has a substituted original descriptor");
    tx.physicalIndex(slot);
  }
  for (const row of plan.definedGlobals) {
    const slot = resourcesByBinding.get(row.bindingId);
    if (
      !slot ||
      slot.kind !== "global" ||
      slot.key !== row.bindingId ||
      globalsByKey.get(row.referenceKey) !== slot ||
      slot.object.name !== row.name ||
      slot.object.mutable !== row.mutable ||
      !sameValTypes([slot.object.type], [row.type])
    )
      fail("defined scalar global has a substituted original descriptor");
    tx.assertCanonicalGlobalInitializer(slot, defaultPhysicalScalarInitializer(row.type, fail));
  }
}

/** Reserve the original data-selected scalar helpers; this mints physical slots, not semantic authority. */
export function reserveNumberRemainders<T>(
  plan: ProgramResourceData<T>,
  context: PhysicalProgramBindingData & {
    readonly functionsByKey: Map<string, CallableReservation>;
    readonly resourcesByBinding: Map<IrBindingId, PhysicalReservation>;
  },
  supportFunctions: Map<WasmFunction, FunctionReservation>,
): void {
  const { reservations, functionsByKey, resourcesByBinding } = context;
  const fail: FailurePolicy = context.fail;
  for (const resource of plan.numberRemainders) {
    const token = reservations.reserveFunction(resource.bindingId, resource.symbol, {
      params: [...resource.params],
      results: [...resource.results],
    });
    if (functionsByKey.has(resource.referenceKey) || resourcesByBinding.has(resource.bindingId))
      fail("number remainder has competing physical owners");
    functionsByKey.set(resource.referenceKey, token);
    resourcesByBinding.set(resource.bindingId, token);
    supportFunctions.set(token.object, token);
  }
}
