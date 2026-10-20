// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  type PreparedIrProgram,
  type PreparedIrProgramRuntimeProjection,
} from "../../../ir/program/prepared-contracts.js";
import {
  preparedIrDataMismatch,
  assertPreparedIrData,
  freezePreparedIrValue,
} from "../../../shared/contracts/prepared-ir-data.js";
import {
  type PhysicalModuleReservations,
  type FunctionReservation,
  type GlobalReservation,
  type TagReservation,
  type TagImportReservation,
} from "../../../wasm/physical/module-reservations.js";
import {
  requireNativeStringLiteral,
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  type NativeStringLiteralReservations,
} from "../resources/native-string-literals.js";
import { type NativeJsClassLegalityUse } from "../../../ir/analysis/allocation-evidence/native-js-class-legality.js";
import { type IrFunction, type IrInstr, type IrFuncRef } from "../../../ir/core/nodes.js";
import { type IrType } from "../../../ir/core/types.js";
import {
  collectNativeProgramClassRequirements as collectNativeJsClassRequirements,
  describeNativeProgramClassPhysicalRequirements as describeNativeJsClassPhysicalRequirements,
  nativeProgramClassView,
  nativeProgramClassConstruction,
  nativeProgramClassLegality,
  type NativeProgramClassView,
} from "../../../ir/program/native-program-resource-requirements.js";
import {
  type NativeJsClassPhysicalDescription,
  type NativeJsClassRequirements,
} from "../../../ir/program/native-js-class-requirements.js";
import { BUILTIN_TYPE_TAGS } from "../../../shared/contracts/js-builtin-tags.js";
import { buildErrorConstructorBody } from "../../../runtime/wasmgc/values/error-bodies.js";
import {
  nativeJsClassTransactionState,
  reserveNativeJsClassGcValues,
  fillNativeJsClassGcValues,
  requireCompletedNativeJsClassGcValues,
  emitNativeJsClassGcBox,
  emitNativeJsClassGcDefinitionAggregate,
  emitNativeJsClassGcConstruction,
  emitNativeJsClassGcFrameNew,
  emitNativeJsClassGcFrameGet,
  reserveNativeJsClassManagedGcType,
  assertNativeJsClassManagedGcTypeCurrent,
  type NativeJsClassGcValues,
  type NativeJsClassManagedGcType,
  reserveNativeJsClassGcRealm,
  fillNativeJsClassGcRealm,
  requireCompletedNativeJsClassGcRealm,
  type NativeJsClassGcRealm,
} from "../resources/native-js-class.js";
import {
  reserveNativeErrorResources,
  requireNativeErrorReservations,
  fillNativeErrorResources,
  requireCompletedNativeErrors,
  type NativeErrorReservations,
  type NativeErrorRequirements,
  type NativeErrorDependencies,
} from "../resources/native-errors.js";
import {
  reserveLinearReferenceErrorResources,
  requireLinearReferenceErrorResources,
  fillLinearReferenceErrorResources,
  requireCompletedLinearReferenceErrorResources,
  type LinearReferenceErrorReservations,
  type LinearReferenceErrorRequirements,
  type LinearReferenceErrorDependencies,
} from "../resources/native-reference-error.js";
import { type IrBindingId, type IrUnitId } from "../../../shared/contracts/ir-identity.js";
import { type Instr, type ValType } from "../../../wasm/model/instructions.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";
import { IrUnsupportedError } from "../../../shared/contracts/ir-preparation-errors.js";

// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Issued primitive resources only. This marker never claims a completed class graph. */
export interface NativeJsClassPhysicalValues {
  readonly kind: "native-js-class-physical-values";
}
interface ClassErrors {
  readonly strings: NativeStringLiteralReservations;
  readonly errorAncestor: FunctionReservation;
  readonly typeError: NativeErrorReservations;
  readonly typeRequirements: NativeErrorRequirements;
  readonly typeDependencies: NativeErrorDependencies;
  readonly referenceError: LinearReferenceErrorReservations;
  readonly referenceRequirements: LinearReferenceErrorRequirements;
  readonly referenceDependencies: LinearReferenceErrorDependencies;
}
interface ClassOwner {
  readonly tx: PhysicalModuleReservations;
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly requirements: NativeJsClassRequirements;
  readonly exceptionTag?: TagReservation | TagImportReservation;
  logical: NativeProgramClassView;
  readonly gc: NativeJsClassGcValues;
  readonly graph: NativeJsClassManagedGcType;
  readonly errors: ClassErrors;
  functions?: readonly NativeJsClassFunctionSlot[];
  realm?: {
    readonly gc: NativeJsClassGcRealm;
    readonly bindings: readonly NativeJsClassRealmBinding[];
    filled: boolean;
  };
  moduleBindings?: readonly NativeJsClassRealmBinding[];
  moduleBindingsFilled?: true;
  filled: boolean;
}
const classOwners = new WeakMap<NativeJsClassPhysicalValues, ClassOwner>();
function classInvalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native class physical owner: " + detail);
}
function classCurrent(values: NativeJsClassPhysicalValues, fn?: IrFunction): ClassOwner {
  // Membership precedes all reads, including getters on a forged visible marker.
  const owner = classOwners.get(values);
  if (!owner) classInvalid("unissued or copied values");
  // Screen the complete owned physical reader closure before opaque ledger
  // replay, which observes every reserved object's descriptors and contents.
  assertPreparedIrData({
    exceptionTag: owner.exceptionTag,
    gc: owner.gc,
    graph: owner.graph,
    errors: [owner.errors.strings, owner.errors.typeError, owner.errors.referenceError, owner.errors.errorAncestor],
    realm: owner.realm?.gc,
    moduleBindings: owner.moduleBindings,
    functions: owner.functions,
  });
  if (nativeJsClassTransactionState(owner.tx) !== "reserving" && nativeJsClassTransactionState(owner.tx) !== "filling")
    classInvalid("revoked emission attempt");
  owner.logical = nativeProgramClassView(owner.requirements, owner.program, owner.projection);
  if (fn && !owner.projection.prepared.functions.includes(fn)) classInvalid("foreign selected function");
  assertNativeJsClassManagedGcTypeCurrent(owner.tx, owner.gc, owner.graph);
  const error = owner.errors;
  requireNativeErrorReservations(owner.tx, error.typeError, error.typeRequirements, error.typeDependencies);
  requireLinearReferenceErrorResources(
    owner.tx,
    error.referenceError,
    error.referenceRequirements,
    error.referenceDependencies,
  );
  if (owner.filled) {
    requireCompletedNativeJsClassGcValues(owner.tx, owner.gc);
    owner.tx.assertCompletedReservation(error.errorAncestor);
    requireCompletedNativeErrors(owner.tx, error.typeError, error.typeRequirements, error.typeDependencies);
    requireCompletedLinearReferenceErrorResources(owner.tx, error.referenceError);
    if (owner.realm?.filled) requireCompletedNativeJsClassGcRealm(owner.tx, owner.realm.gc);
  }
  return owner;
}
/** Full original/all-selected/support canonical validation occurs before any
 * primitive reservation. Complete class graph acquisition is a separate join. */
export function reserveNativeJsClassPhysicalValues(
  tx: PhysicalModuleReservations,
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  exceptionTag?: TagReservation | TagImportReservation,
): NativeJsClassPhysicalValues | undefined {
  if (exceptionTag !== undefined) assertPreparedIrData(exceptionTag);
  const requirements = collectNativeJsClassRequirements(program, projection);
  if (!requirements) return undefined;
  if (projection.backend !== "wasmgc" || (projection.target !== "standalone" && projection.target !== "wasi"))
    throw new IrUnsupportedError(
      "class-projection-unsupported",
      "resolve",
      "native class primitive reservation requires the genuine GC recipe; Linear class catalogue join is unavailable",
    );
  if (nativeJsClassTransactionState(tx) !== "reserving") classInvalid("invalid primitive reservation phase");
  const source = program.inventory.sources.find((row) => row.kind === "entry");
  if (!source) classInvalid("missing original source owner");
  const gc = reserveNativeJsClassGcValues(tx, "native-js-class:" + source.id);
  // Include initialization names even when no later source read observes them.
  // This is a closed inline-slot census, not inherited-property lookup proof.
  const keys = new Set(requirements.topology.literalPropertyKeys);
  for (const { definition } of requirements.domain.definitions) {
    for (const element of definition.instanceElements) keys.add(element.name);
    for (const member of definition.members) keys.add(member.name);
  }
  const graph = reserveNativeJsClassManagedGcType(tx, gc, "native-js-class:" + source.id + ":managed", [...keys]);
  // Realm declarations demand real producers, never fresh errors at definition.
  const features = requirements.realmErrors.map((row) => row.feature);
  if (!features.includes("error.type.construct") || !features.includes("error.reference.construct"))
    classInvalid("missing actual definition error provider demands");
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "native-js-class:" + source.id + ":error-names",
    utf8Storage: false,
    literals: [{ value: "TypeError" }, { value: "ReferenceError" }, { value: "Error" }],
  });
  const typeRequirements = Object.freeze({ key: "native-js-class:" + source.id + ":TypeError" });
  const typeDependencies = Object.freeze({ strings, typeErrorTag: BUILTIN_TYPE_TAGS.TypeError });
  const typeError = reserveNativeErrorResources(tx, typeRequirements, typeDependencies);
  const referenceRequirements = Object.freeze({ key: "native-js-class:" + source.id + ":ReferenceError" });
  const referenceDependencies = Object.freeze({ strings, referenceErrorTag: BUILTIN_TYPE_TAGS.ReferenceError });
  const referenceError = reserveLinearReferenceErrorResources(tx, referenceRequirements, referenceDependencies, () => {
    const phase = nativeJsClassTransactionState(tx);
    if (phase !== "reserving" && phase !== "filling") classInvalid("revoked class error provider attempt");
  });
  const errorAncestor = tx.reserveFunction(
    "native-js-class:" + source.id + ":Error-ancestor",
    "__class_Error_ancestor",
    { params: [{ kind: "externref" }], results: [{ kind: "externref" }] },
  );
  const errors = Object.freeze({
    strings,
    errorAncestor,
    typeError,
    typeRequirements,
    typeDependencies,
    referenceError,
    referenceRequirements,
    referenceDependencies,
  });
  const values = Object.freeze({
    kind: "native-js-class-physical-values" as const,
  });
  classOwners.set(values, {
    tx,
    program,
    projection,
    requirements,
    exceptionTag,
    logical: nativeProgramClassView(requirements, program, projection),
    gc,
    graph,
    errors,
    filled: false,
  });
  return values;
}
export function fillNativeJsClassPhysicalValues(values: NativeJsClassPhysicalValues): void {
  const owner = classCurrent(values);
  if (owner.filled) classInvalid("duplicate primitive fill");
  fillNativeStringLiteralResources(owner.tx, owner.errors.strings);
  fillNativeErrorResources(owner.tx, owner.errors.typeError);
  fillLinearReferenceErrorResources(owner.tx, owner.errors.referenceError);
  const name = requireNativeStringLiteral(owner.tx, owner.errors.strings, "Error");
  owner.tx.fillFunction(owner.errors.errorAncestor, {
    locals: [],
    body: buildErrorConstructorBody(
      owner.errors.typeError.type.typeIndex,
      BUILTIN_TYPE_TAGS.Error,
      1,
      name.kind === "global"
        ? { kind: "global", index: owner.tx.physicalIndex(name.global), representation: "gc" }
        : { kind: "callable", handle: name.function.handle, representation: "gc" },
    ),
  });
  fillNativeJsClassGcValues(owner.tx, owner.gc);
  owner.filled = true;
}
/** Fixed issued-owner checker, never a caller-provided positive verdict. */
export function assertNativeJsClassPhysicalValuesCurrent(values: NativeJsClassPhysicalValues, fn?: IrFunction): void {
  classCurrent(values, fn);
}

/** Actual common managed carrier coordinate for exact declared source roles.
 * This does not populate any role/global or authorize a class instruction. */
export function nativeJsClassPhysicalRoleType(values: NativeJsClassPhysicalValues, type: IrType): ValType | undefined {
  return physicalRoleType(classCurrent(values), type);
}
function physicalRoleType(owner: ClassOwner, type: IrType): ValType | undefined {
  assertPreparedIrData(type);
  if (type.kind !== "support-ref") return undefined;
  if (
    !owner.requirements.domain.definitions.some(({ definition }) =>
      Object.values(definition.roles).some((ref) => preparedIrDataMismatch(ref, type.ref) === undefined),
    )
  )
    return undefined;
  return {
    kind: type.nullable ? "ref_null" : "ref",
    typeIdx: owner.graph.managed.typeIndex,
  };
}
/** The actual immutable tagged carrier coordinate is issued only by the same
 * current canonical class pack. This is type resolution, never body admission. */
export function nativeJsClassPhysicalValueType(values: NativeJsClassPhysicalValues, type: IrType): ValType | undefined {
  return physicalValueType(classCurrent(values), type);
}
function physicalValueType(owner: ClassOwner, type: IrType): ValType | undefined {
  assertPreparedIrData(type);
  if (type.kind !== "dynamic") return physicalRoleType(owner, type);
  if (!owner.logical.types.some((candidate) => preparedIrDataMismatch(candidate, type) === undefined)) return undefined;
  return { kind: "ref", typeIdx: owner.gc.carrier.typeIndex };
}

/** Bind only exact operation/definition-derived canonical error declarations.
 * A constructor index alone grants neither realm identity nor throw readiness. */
export function nativeJsClassPhysicalErrorConstructor(
  values: NativeJsClassPhysicalValues,
  ref: IrFuncRef,
): number | undefined {
  const owner = classCurrent(values);
  assertPreparedIrData(ref);
  const declaration = [
    ...owner.requirements.realmErrors,
    ...owner.requirements.errors.map((row) => row.declaration),
  ].find((row) => preparedIrDataMismatch(row.ref, ref) === undefined);
  if (!declaration) return undefined;
  if (!owner.filled || nativeJsClassTransactionState(owner.tx) !== "filling")
    classInvalid("unfilled class error provider");
  const constructorBinding =
    declaration.feature === "error.type.construct"
      ? owner.errors.typeError.newTypeError
      : owner.errors.referenceError.newReferenceError;
  const result = owner.tx.physicalIndex(constructorBinding);
  classCurrent(values);
  return result;
}

export interface NativeJsClassRealmBinding {
  readonly bindingId: IrBindingId;
  readonly referenceKey: string;
  readonly reservation: import("../../../wasm/physical/module-reservations.js").GlobalReservation;
}
/** Reserve only the four canonical immutable source-qualified realm entries.
 * This issues resources, not class body or public dynamic ABI permission. */
export function reserveNativeJsClassPhysicalRealm(values: NativeJsClassPhysicalValues): void {
  const owner = classCurrent(values);
  if (nativeJsClassTransactionState(owner.tx) !== "reserving" || owner.realm)
    classInvalid("invalid realm acquisition phase");
  const definition = owner.requirements.domain.definitions[0]?.definition;
  if (!definition) classInvalid("missing original class realm owner");
  const roles = {
    objectPrototype: "prototype",
    functionPrototype: "method",
    typeError: "constructor",
    referenceError: "constructor",
  } as const;
  const entries = Object.keys(roles).map((key) => {
    const role = key as keyof typeof roles;
    const entry = owner.program.abi.entries.find(({ plan }) => plan.id === definition.realm[role]);
    if (
      !entry ||
      entry.contract.kind !== "global" ||
      entry.contract.mutable ||
      entry.plan.slotPolicy !== "required" ||
      entry.plan.slotSpace !== "global" ||
      entry.contract.type.kind !== "support-ref" ||
      entry.contract.type.nullable ||
      preparedIrDataMismatch(entry.contract.type.ref, definition.roles[roles[role]]) !== undefined ||
      entry.plan.structuralReferenceKey !== classGlobalKey(owner, entry.contract.ref)
    )
      classInvalid("noncanonical realm global");
    return { role, entry, name: entry.contract.ref.name, referenceKey: classGlobalKey(owner, entry.contract.ref) };
  });
  const name = (role: keyof typeof roles) => entries.find((entry) => entry.role === role)!.name;
  const gc = reserveNativeJsClassGcRealm(
    owner.tx,
    owner.gc,
    owner.graph,
    "native-js-class:" + definition.sourceId + ":realm",
    {
      objectPrototype: name("objectPrototype"),
      functionPrototype: name("functionPrototype"),
      typeError: name("typeError"),
      referenceError: name("referenceError"),
    },
    [owner.errors.typeError.newTypeError, owner.errors.referenceError.newReferenceError],
    owner.errors.errorAncestor,
  );
  owner.realm = {
    gc,
    bindings: Object.freeze(
      entries.map(({ role, entry, referenceKey }) =>
        Object.freeze({
          bindingId: entry.plan.id,
          referenceKey,
          reservation: gc.globals[role],
        }),
      ),
    ),
    filled: false,
  };
}
export function fillNativeJsClassPhysicalRealm(values: NativeJsClassPhysicalValues): void {
  const owner = classCurrent(values);
  if (!owner.filled || !owner.realm || owner.realm.filled) classInvalid("invalid realm fill phase");
  fillNativeJsClassGcRealm(owner.tx, owner.realm.gc);
  owner.realm.filled = true;
}
/** Actual reserved binding rows. Completed emission custody remains mandatory
 * for presentation; these rows alone cannot admit a global or a class body. */
export function nativeJsClassPhysicalRealmBindings(
  values: NativeJsClassPhysicalValues,
): readonly NativeJsClassRealmBinding[] {
  const owner = classCurrent(values);
  if (!owner.realm) classInvalid("unacquired realm resources");
  return owner.realm.bindings;
}
/** Fixed current issuer check for the real bootstrap call. Source units are
 * matched to the authentic semantic startup sequence, never supplied as code. */
export function nativeJsClassPhysicalBootstrapCall(
  values: NativeJsClassPhysicalValues,
  units: readonly IrUnitId[],
): readonly Instr[] {
  const owner = classCurrent(values);
  assertPreparedIrData(units);
  if (!owner.realm?.filled) classInvalid("unfilled realm bootstrap");
  const expected = owner.program.startup
    .filter((plan) => plan.executable && plan.unitId !== null)
    .map((plan) => plan.unitId);
  if (preparedIrDataMismatch(units, expected) !== undefined) classInvalid("foreign or reordered startup sequence");
  requireCompletedNativeJsClassGcRealm(owner.tx, owner.realm.gc);
  return [{ op: "call", funcIdx: owner.tx.physicalIndex(owner.realm.gc.bootstrap) }];
}

/** Actual constructor/TDZ storage only for descriptor-declared module bindings.
 * Inner live cells belong to the definition aggregate and are not globals. */
export function reserveNativeJsClassPhysicalModuleBindings(values: NativeJsClassPhysicalValues): void {
  const owner = classCurrent(values);
  if (nativeJsClassTransactionState(owner.tx) !== "reserving" || owner.moduleBindings)
    classInvalid("invalid class module binding acquisition");
  const rows: NativeJsClassRealmBinding[] = [];
  for (const { definition } of owner.requirements.domain.definitions)
    for (const binding of [definition.outerBinding, definition.innerBinding]) {
      if (!binding || binding.storage !== "module") continue;
      if (
        binding.valueType.kind !== "support-ref" ||
        !binding.valueType.nullable ||
        preparedIrDataMismatch(binding.valueType.ref, definition.roles.constructor) !== undefined
      )
        classInvalid("class module value is not the actual nullable constructor role");
      for (const [ref, expectedType, mutable] of [
        [binding.valueGlobal, binding.valueType, true],
        [binding.tdzGlobal, { kind: "val", val: { kind: "i32" } }, true],
      ] as const) {
        if (!ref) classInvalid("missing actual class module global reference");
        const entry = owner.program.abi.entries.find(({ plan }) => plan.id === ref.binding.bindingId);
        if (
          !entry ||
          entry.contract.kind !== "global" ||
          entry.plan.slotPolicy !== "required" ||
          entry.plan.slotSpace !== "global" ||
          entry.contract.mutable !== mutable ||
          preparedIrDataMismatch(entry.contract.ref, ref) !== undefined ||
          preparedIrDataMismatch(entry.contract.type, expectedType) !== undefined ||
          entry.plan.structuralReferenceKey !== classGlobalKey(owner, ref)
        )
          classInvalid("noncanonical class module global");
        const type: ValType =
          entry.contract.type.kind === "val"
            ? { kind: "i32" }
            : { kind: "ref_null", typeIdx: owner.graph.managed.typeIndex };
        const reservation = owner.tx.reserveGlobal(
          "native-js-class:binding:" + entry.plan.id,
          entry.contract.ref.name,
          type,
          entry.contract.mutable,
        );
        rows.push(Object.freeze({ bindingId: entry.plan.id, referenceKey: classGlobalKey(owner, ref), reservation }));
      }
    }
  if (new Set(rows.map((row) => row.bindingId)).size !== rows.length) classInvalid("duplicate class module binding");
  owner.moduleBindings = Object.freeze(rows);
}
export function fillNativeJsClassPhysicalModuleBindings(values: NativeJsClassPhysicalValues): void {
  const owner = classCurrent(values);
  if (!owner.moduleBindings || owner.moduleBindingsFilled) classInvalid("invalid class module binding fill");
  for (const { reservation } of owner.moduleBindings) {
    const type = reservation.object.type;
    if (type.kind === "ref_null") owner.tx.fillGlobal(reservation, [{ op: "ref.null", typeIdx: type.typeIdx }]);
    else if (type.kind === "i32") owner.tx.fillGlobal(reservation, [{ op: "i32.const", value: 0 }]);
    else classInvalid("unissued class module storage type");
  }
  owner.moduleBindingsFilled = true;
}
export function nativeJsClassPhysicalModuleBindings(
  values: NativeJsClassPhysicalValues,
): readonly NativeJsClassRealmBinding[] {
  const owner = classCurrent(values);
  if (!owner.moduleBindings) classInvalid("unacquired class module bindings");
  if (owner.moduleBindingsFilled)
    for (const row of owner.moduleBindings) owner.tx.assertCompletedReservation(row.reservation);
  return owner.moduleBindings;
}

/** Pre-emission neutral admissibility only; actual class resource acquisition
 * and every lowering use separately require the complete current physical pack. */

export interface NativeJsClassFunctionSlot {
  readonly fn: IrFunction;
  readonly bindingId: IrBindingId;
  readonly referenceKey: string;
  readonly reservation: FunctionReservation;
}
/** Construct actual unit slots in the same owner as the current class carrier.
 * Callers never supply a unit/reservation association or a signature verdict. */
export function reserveNativeJsClassPhysicalFunctions(
  values: NativeJsClassPhysicalValues,
): readonly NativeJsClassFunctionSlot[] {
  const owner = classCurrent(values);
  if (nativeJsClassTransactionState(owner.tx) !== "reserving" || owner.functions)
    classInvalid("invalid class unit reservation phase");
  const convert = (type: IrType): ValType => {
    const mapped = nativeJsClassPhysicalValueType(values, type);
    if (mapped) return mapped;
    if (
      type.kind === "val" &&
      !type.typeRef &&
      (type.val.kind === "f64" || (type.val.kind === "i32" && !type.val.symbol))
    )
      return { kind: type.val.kind };
    throw new IrUnsupportedError("body-shape-rejected", "build", "native class unit signature has no genuine carrier");
  };
  const rows: NativeJsClassFunctionSlot[] = [];
  for (const { fn, bindingId, referenceKey } of owner.logical.units) {
    const reservation = owner.tx.reserveFunction(bindingId, fn.name, {
      params: fn.params.map((parameter) => convert(parameter.type)),
      results: fn.resultTypes.map(convert),
    });
    rows.push(Object.freeze({ fn, bindingId, referenceKey, reservation }));
  }
  owner.functions = Object.freeze(rows);
  classCurrent(values);
  return owner.functions;
}
export function nativeJsClassPhysicalFunctionSlots(
  values: NativeJsClassPhysicalValues,
): readonly NativeJsClassFunctionSlot[] {
  const owner = classCurrent(values);
  if (!owner.functions) classInvalid("class units have not been reserved");
  if (nativeJsClassTransactionState(owner.tx) === "filling")
    for (const row of owner.functions) owner.tx.physicalIndex(row.reservation);
  return owner.functions;
}

/** Complete source-owned bodies are mandatory before the class attempt can
 * become a completed emission. Reserved forward references grant no receipt. */
export function requireCompletedNativeJsClassPhysicalFunctions(values: NativeJsClassPhysicalValues): void {
  const owner = classCurrent(values);
  if (!owner.filled || !owner.realm?.filled || !owner.functions) classInvalid("unfilled class function owner");
  for (const row of owner.functions) owner.tx.assertCompletedReservation(row.reservation);
  assertNativeJsClassPhysicalValuesCurrent(values);
}

const loweringOwners = new WeakMap<NativeJsClassLowering, { values: NativeJsClassPhysicalValues; fn: IrFunction }>();
const loweringPorts = new WeakMap<NativeJsClassPhysicalValues, WeakMap<IrFunction, NativeJsClassLowering>>();
/** Fixed proof replay precedes all observations of a resolver-provided handle. */
export function assertNativeJsClassPhysicalLowering(port: NativeJsClassLowering, fn: IrFunction): void {
  loweringCurrent(port, fn);
}
function loweringCurrent(port: NativeJsClassLowering, fn: IrFunction): ClassOwner {
  const owner = loweringOwners.get(port);
  if (!owner || owner.fn !== fn) classInvalid("foreign or copied class lowering");
  return classCurrent(owner.values, fn);
}
/** This initial finite dispatch does not silently grant unfinished operations. */
export function nativeJsClassPhysicalLowering(
  values: NativeJsClassPhysicalValues,
  fn: IrFunction,
): NativeJsClassLowering {
  const owner = classCurrent(values, fn);
  // Reuse an issued handle, never a verdict: the complete current proof above
  // runs on every resolve and the neutral token independently replays on use.
  const existing = loweringPorts.get(values)?.get(fn);
  if (existing) return existing;
  const unitId = fn.unitId;
  const legality = nativeProgramClassLegality(owner.program, owner.projection, fn);
  if (!legality) classInvalid("missing independent class representability");
  const owns = (instruction: IrInstr): instruction is NativeJsClassInstruction =>
    owner.requirements.occurrences.some((row) => row.unitId === unitId && row.instruction === instruction) ||
    owner.requirements.boxes.some((row) => row.unitId === unitId && row.instruction === instruction);
  const port: NativeJsClassLowering = Object.freeze({
    legality,
    assertFunction(actual: IrFunction) {
      assertNativeJsClassPhysicalLowering(port, actual);
    },
    owns(instruction: IrInstr): instruction is NativeJsClassInstruction {
      // Identity membership is not an emission grant. No instruction/function
      // field is read here; actual emit replays the complete canonical proof.
      if (!loweringOwners.has(port)) classInvalid("unissued class lowering");
      return owns(instruction);
    },
    valueType(type: IrType) {
      return physicalValueType(loweringCurrent(port, fn), type);
    },
    typeReference(ref: import("../../../ir/core/types.js").IrTypeRef) {
      const owner = loweringCurrent(port, fn);
      assertPreparedIrData(ref);
      if (ref.binding.kind !== "support") return undefined;
      const type = physicalRoleType(owner, {
        kind: "support-ref",
        ref: { ...ref, binding: ref.binding },
        nullable: false,
      });
      return type && (type.kind === "ref" || type.kind === "ref_null") ? type.typeIdx : undefined;
    },
    emit(
      instruction: NativeJsClassInstruction,
      operands: readonly (readonly Instr[])[],
      scratch: (type: ValType) => number,
    ) {
      if (loweringOwners.get(port)?.fn !== fn) classInvalid("foreign or copied class lowering");
      return emitClassOperation(values, fn, instruction, operands, scratch);
    },
  });
  loweringOwners.set(port, { values, fn });
  let ports = loweringPorts.get(values);
  if (!ports) {
    ports = new WeakMap();
    loweringPorts.set(values, ports);
  }
  ports.set(fn, port);
  return port;
}

const directClassErrors = Object.freeze({
  box: "unissued box occurrence/site",
  frame: "unissued activation occurrence",
  "js.class.define": "unissued definition occurrence/aggregate",
  "js.class.binding.init": "unissued module binding initialization",
  "js.class.constructor.complete": "unissued constructor completion occurrence",
});
function emitClassRecipe(
  owner: ClassOwner,
  fn: IrFunction,
  instruction: NativeJsClassInstruction,
  operands: readonly (readonly Instr[])[],
  scratch: (type: ValType) => number,
  kind?: keyof typeof directClassErrors,
): readonly Instr[] {
  if (
    !owner.requirements.occurrences.some((row) => row.unitId === fn.unitId && row.instruction === instruction) &&
    !owner.requirements.boxes.some((row) => row.unitId === fn.unitId && row.instruction === instruction)
  )
    classInvalid(kind ? directClassErrors[kind] : "foreign class lowering occurrence");
  if (
    kind !== undefined &&
    instruction.kind !== kind &&
    !(kind === "frame" && instruction.kind.startsWith("js.class.frame."))
  )
    classInvalid("wrong direct class recipe family");
  assertPreparedIrData(operands);
  operands = freezePreparedIrValue(operands) as readonly (readonly Instr[])[];
  const allocate = (type: ValType): number => {
    const result = scratch(type);
    if (nativeJsClassTransactionState(owner.tx) !== "filling") classInvalid("revoked scratch allocation");
    assertNativeJsClassManagedGcTypeCurrent(owner.tx, owner.gc, owner.graph);
    return result;
  };
  switch (instruction.kind) {
    case "box": {
      if (operands.length !== 1) classInvalid("invalid box operand count");

      if (
        !owner.filled ||
        !owner.requirements.boxes.some(
          (row) =>
            row.unitId === fn.unitId && row.instruction === instruction && row.allocationId === instruction.alloc,
        )
      )
        classInvalid("unissued box occurrence/site");
      return emitNativeJsClassGcBox(owner.tx, owner.gc, instruction, operands[0]!);
    }
    case "js.class.frame.new":
    case "js.class.frame.get": {
      if (!owner.filled) classInvalid("unissued activation occurrence");
      if (
        instruction.kind === "js.class.frame.new" &&
        !owner.requirements.topology.roots.some(
          (root) =>
            root.unitId === fn.unitId &&
            root.instruction === instruction &&
            root.site === instruction.alloc &&
            root.role === "activation-frame",
        )
      )
        classInvalid("unissued activation allocation site");
      if (instruction.kind === "js.class.frame.get" && operands.length !== 1)
        classInvalid("invalid activation read operands");
      return instruction.kind === "js.class.frame.new"
        ? emitNativeJsClassGcFrameNew(owner.tx, owner.gc, owner.graph, operands, allocate)
        : emitNativeJsClassGcFrameGet(owner.tx, owner.gc, owner.graph, instruction, operands[0]!);
    }
    case "js.class.define": {
      if (operands.length !== 0) classInvalid("uncertified class capture operands");

      if (
        !owner.filled ||
        !owner.realm?.filled ||
        !owner.functions ||
        instruction.captures.length !== 0 ||
        !owner.requirements.topology.roots.some(
          (row) =>
            row.unitId === fn.unitId &&
            row.instruction === instruction &&
            row.site === instruction.alloc &&
            row.role === "definition",
        )
      )
        classInvalid("unissued definition occurrence/aggregate");
      const descriptor = owner.requirements.domain.definitions.find(
        (row) => row.id === instruction.definition,
      )?.definition;
      if (!descriptor) classInvalid("missing actual definition descriptor");
      const target = (unitId: IrUnitId): FunctionReservation => {
        const row = owner.functions!.find((row) => row.fn.unitId === unitId);
        if (!row) classInvalid("missing original class USER slot");
        // A genuine USER body may be filled later in the unchanged original-unit
        // order. Its issued slot/type coordinate is already fixed at this phase.
        owner.tx.physicalIndex(row.reservation);
        return row.reservation;
      };
      return emitNativeJsClassGcDefinitionAggregate(
        owner.tx,
        owner.gc,
        owner.graph,
        owner.realm.gc,
        target(descriptor.constructor.unitId),
        descriptor.members.map((member) => ({
          name: member.name,
          static: member.static,
          body: target(member.body.unitId),
        })),
        descriptor.innerBinding !== null,
        allocate,
      );
    }
    case "js.class.binding.read":
      return emitClassBindingRead(owner, fn, instruction, operands);
    case "js.class.construct": {
      if (operands.length !== 2 + instruction.args.length || !owner.filled || !owner.realm?.filled || !owner.functions)
        classInvalid("unissued construct operands/resources");
      const recipe = nativeProgramClassConstruction(owner.requirements, owner.program, owner.projection).find(
        (row) => row.instruction === instruction && row.unitId === fn.unitId,
      );
      if (!recipe || recipe.gap)
        throw new IrUnsupportedError(
          "class-projection-unsupported",
          "resolve",
          recipe?.gap ?? "missing actual constructor candidate closure",
        );
      if (
        !owner.requirements.topology.roots.some(
          (row) =>
            row.instruction === instruction &&
            row.unitId === fn.unitId &&
            row.site === instruction.alloc &&
            row.value === instruction.result &&
            row.role === "instance",
        )
      )
        classInvalid("construction lacks its actual instance root/site");
      const slot = (unitId: IrUnitId) => {
        const row = owner.functions!.find((row) => row.fn.unitId === unitId);
        if (!row) classInvalid("constructor lacks its actual USER reservation");
        return row;
      };
      const targets = recipe.targets.map((target) => {
        const row = slot(target.fn.unitId);
        if (row.fn !== target.fn) classInvalid("foreign constructor USER body");
        return { body: row.reservation, parameters: target.fn.params.length - 4 };
      });
      const newTargets = recipe.newTargets.map((id) => {
        const descriptor = owner.requirements.domain.definitions.find((row) => row.id === id)?.definition;
        if (!descriptor) classInvalid("newTarget definition disappeared");
        return slot(descriptor.constructor.unitId).reservation;
      });
      return emitNativeJsClassGcConstruction(
        owner.tx,
        owner.gc,
        owner.graph,
        targets,
        newTargets,
        operands,
        classThrow(owner, fn, instruction, "TypeError"),
        allocate,
      );
    }
    case "js.class.binding.init": {
      if (operands.length !== 1) classInvalid("uncertified class initialization operands");

      if (
        !owner.filled ||
        !owner.moduleBindingsFilled ||
        instruction.storage.kind !== "module" ||
        !owner.program.startup.some((row) => row.executable && row.unitId === fn.unitId)
      )
        classInvalid("unissued module binding initialization");
      const binding = owner.requirements.domain.definitions
        .flatMap(({ definition }) => [definition.outerBinding, definition.innerBinding])
        .find((binding) => binding?.id === instruction.storage.bindingId);
      if (!binding || binding.storage !== "module" || !binding.valueGlobal || !binding.tdzGlobal)
        classInvalid("missing original module binding");
      const find = (key: string) => {
        const row = owner.moduleBindings!.find((row) => row.referenceKey === key);
        if (!row) classInvalid("missing actual module binding reservation");
        return owner.tx.physicalIndex(row.reservation);
      };
      const value = find(classGlobalKey(owner, binding.valueGlobal)),
        tdz = find(classGlobalKey(owner, binding.tdzGlobal));
      return [
        { op: "global.get", index: tdz },
        // Double initialization is a broken internal startup protocol, not a
        // substitute JavaScript ReferenceError/TypeError construction.
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }], else: [] },
        ...operands[0]!,
        { op: "global.set", index: value },
        { op: "i32.const", value: 1 },
        { op: "global.set", index: tdz },
      ];
    }
    case "js.class.constructor.complete": {
      if (operands.length !== 1) classInvalid("uncertified constructor completion operands");

      if (!owner.filled) classInvalid("unissued constructor completion occurrence");
      if (instruction.completion.kind !== "normal")
        throw new IrUnsupportedError(
          "class-projection-unsupported",
          "resolve",
          "constructor return replacement requires actual tagged/managed completion dispatch",
        );
      return [...operands[0]!];
    }
    default:
      throw new IrUnsupportedError(
        "class-projection-unsupported",
        "resolve",
        "class physical recipe is not issued for " + instruction.kind,
      );
  }
}
function emitClassOperation(
  values: NativeJsClassPhysicalValues,
  fn: IrFunction,
  instruction: NativeJsClassInstruction,
  operands: readonly (readonly Instr[])[],
  scratch: (type: ValType) => number,
  kind?: keyof typeof directClassErrors,
): readonly Instr[] {
  const owner = classCurrent(values, fn);
  const result = emitClassRecipe(owner, fn, instruction, operands, scratch, kind);
  classCurrent(values, fn);
  return result;
}
function noClassScratch(): never {
  throw Error("this class recipe has no scratch allocation");
}
export function emitNativeJsClassPhysicalBox(
  values: NativeJsClassPhysicalValues,
  fn: IrFunction,
  instruction: Extract<IrInstr, { kind: "box" }>,
  operand: readonly Instr[],
): readonly Instr[] {
  return emitClassOperation(values, fn, instruction, [operand], noClassScratch, "box");
}
export function emitNativeJsClassPhysicalFrame(
  values: NativeJsClassPhysicalValues,
  fn: IrFunction,
  instruction: Extract<IrInstr, { kind: "js.class.frame.new" | "js.class.frame.get" }>,
  operands: readonly (readonly Instr[])[],
  scratch: (type: ValType) => number,
): readonly Instr[] {
  return emitClassOperation(values, fn, instruction, operands, scratch, "frame");
}
export function emitNativeJsClassPhysicalDefinition(
  values: NativeJsClassPhysicalValues,
  fn: IrFunction,
  instruction: Extract<IrInstr, { kind: "js.class.define" }>,
  scratch: (type: ValType) => number,
): readonly Instr[] {
  return emitClassOperation(values, fn, instruction, [], scratch, "js.class.define");
}
export function emitNativeJsClassPhysicalModuleInitialization(
  values: NativeJsClassPhysicalValues,
  fn: IrFunction,
  instruction: Extract<IrInstr, { kind: "js.class.binding.init" }>,
  operand: readonly Instr[],
): readonly Instr[] {
  return emitClassOperation(values, fn, instruction, [operand], noClassScratch, "js.class.binding.init");
}
export function emitNativeJsClassPhysicalNormalCompletion(
  values: NativeJsClassPhysicalValues,
  fn: IrFunction,
  instruction: Extract<IrInstr, { kind: "js.class.constructor.complete" }>,
  self: readonly Instr[],
): readonly Instr[] {
  return emitClassOperation(values, fn, instruction, [self], noClassScratch, "js.class.constructor.complete");
}

/** Recollect the complete canonical logical input before a detached plan can
 * acquire resources. No caller-supplied binding list grants authority. */
export function assertNativeJsClassPhysicalDescription(
  description: NativeJsClassPhysicalDescription,
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): void {
  assertPreparedIrData(description);
  const requirements = collectNativeJsClassRequirements(program, projection);
  if (
    !requirements ||
    preparedIrDataMismatch(
      description,
      describeNativeJsClassPhysicalRequirements(requirements, program, projection),
    ) !== undefined
  )
    classInvalid("foreign or stale class physical description");
}
export function nativeJsClassPhysicalCallableBindings(values: NativeJsClassPhysicalValues): readonly {
  readonly bindingId: IrBindingId;
  readonly referenceKey: string;
  readonly reservation: FunctionReservation;
}[] {
  const owner = classCurrent(values);
  return owner.requirements.realmErrors.map((declaration) => {
    const entry = owner.program.abi.entries.find(
      (row) =>
        row.contract.kind === "callable" && preparedIrDataMismatch(row.contract.ref, declaration.ref) === undefined,
    );
    if (!entry || !entry.plan.structuralReferenceKey) classInvalid("missing issued error callable ABI");
    const reservation =
      declaration.feature === "error.type.construct"
        ? owner.errors.typeError.newTypeError
        : declaration.feature === "error.reference.construct"
          ? owner.errors.referenceError.newReferenceError
          : undefined;
    if (!reservation) classInvalid("unknown class error provider");
    if (nativeJsClassTransactionState(owner.tx) === "filling") owner.tx.physicalIndex(reservation);
    return Object.freeze({ bindingId: entry.plan.id, referenceKey: entry.plan.structuralReferenceKey, reservation });
  });
}
export function requireCompletedNativeJsClassPhysicalValues(values: NativeJsClassPhysicalValues): void {
  const owner = classCurrent(values);
  if (owner.requirements.errors.length) classExceptionTagIndex(owner);
  const gap = nativeProgramClassConstruction(owner.requirements, owner.program, owner.projection).find(
    (row) => row.gap,
  );
  if (gap) throw new IrUnsupportedError("class-projection-unsupported", "resolve", gap.gap!);
  requireCompletedNativeJsClassPhysicalFunctions(values);
  if (!owner.moduleBindingsFilled || !owner.moduleBindings) classInvalid("unfilled class module storage");
  for (const row of owner.moduleBindings) owner.tx.assertCompletedReservation(row.reservation);
  assertNativeJsClassPhysicalValuesCurrent(values);
}

/** Complete private-helper census from actual issued producer reservations.
 * Source USER units remain separately associated with their original units. */
export function nativeJsClassPhysicalSupportFunctions(
  values: NativeJsClassPhysicalValues,
): readonly FunctionReservation[] {
  const owner = classCurrent(values);
  if (!owner.realm) classInvalid("missing class realm helper owner");
  const functions = [
    owner.gc.functionPrototypeBody,
    owner.errors.typeError.newTypeError,
    owner.errors.referenceError.newReferenceError,
    owner.errors.errorAncestor,
    owner.realm.gc.bootstrap,
  ];
  for (const name of ["TypeError", "ReferenceError", "Error"]) {
    const literal = requireNativeStringLiteral(owner.tx, owner.errors.strings, name);
    if (literal.kind === "callable") functions.push(literal.function);
  }
  if (new Set(functions).size !== functions.length) classInvalid("duplicate class private helper owner");
  return Object.freeze(functions);
}

function classGlobalKey(owner: ClassOwner, ref: import("../../../ir/core/value-references.js").IrGlobalRef): string {
  assertPreparedIrData(ref);
  const row = owner.logical.globals.find((row) => preparedIrDataMismatch(row.ref.binding, ref.binding) === undefined);
  if (!row) classInvalid("missing actual current global binding key");
  return row.key;
}

type NativeJsClassInstruction = Extract<IrInstr, { kind: `js.class.${string}` | "box" }>;
interface NativeJsClassLowering {
  readonly legality: NativeJsClassLegalityUse;
  assertFunction(fn: IrFunction): void;
  owns(instruction: IrInstr): instruction is NativeJsClassInstruction;
  valueType(type: IrType): ValType | undefined;
  typeReference(ref: import("../../../ir/core/types.js").IrTypeRef): number | undefined;
  emit(
    instruction: NativeJsClassInstruction,
    operands: readonly (readonly Instr[])[],
    scratch: (type: ValType) => number,
  ): readonly Instr[];
}

interface ClassTerminalEmitter {
  nativeJsClassLegality(fn: IrFunction): NativeJsClassLegalityUse;
  emitNativeJsClass(
    fn: IrFunction,
    instruction: NativeJsClassInstruction,
    operands: readonly (readonly Instr[])[],
    scratch: (type: ValType) => number,
    out: Instr[],
  ): void;
}
const classFunctionPlans = new WeakMap<
  object,
  { readonly values: NativeJsClassPhysicalValues; readonly fn: IrFunction }
>();
/** Concrete generic procedures carry no class verdict. Only this owner's exact
 * current pack supplies class legality, types and terminal emission. */
export function nativeJsClassPhysicalFunctionPlan<
  R extends { resolveType(ref: import("../../../ir/core/types.js").IrTypeRef): number },
  E extends { pushRaw(out: Instr[], instruction: Instr): void },
  T extends { readonly backend: string; convertType(type: IrType): readonly ValType[] },
>(values: NativeJsClassPhysicalValues, fn: IrFunction, resolver: R, emitter: E, converter: T) {
  const owner = classCurrent(values, fn);
  if (!owner.logical.routedFunctions.includes(fn)) return undefined;
  const port = nativeJsClassPhysicalLowering(values, fn);
  const actualResolver = Object.create(null) as R;
  for (const key of Reflect.ownKeys(resolver)) {
    const descriptor = Object.getOwnPropertyDescriptor(resolver, key);
    if (!descriptor || !("value" in descriptor)) classInvalid("executable generic resolver descriptor");
    // Preserve the genuine attempt-scoped resolver proxy wrapper after the DATA screen.
    const value = typeof descriptor.value === "function" ? Reflect.get(resolver, key) : descriptor.value;
    Object.defineProperty(actualResolver, key, { ...descriptor, value, configurable: true });
  }
  Object.defineProperties(actualResolver, {
    resolveDynamic: {
      value: () => {
        const type = port.valueType({ kind: "dynamic" });
        if (!type) classInvalid("missing actual class dynamic carrier");
        return type;
      },
      enumerable: true,
    },
    resolveType: {
      value: (ref: import("../../../ir/core/types.js").IrTypeRef) => {
        const result = port.typeReference(ref) ?? resolver.resolveType(ref);
        port.assertFunction(fn);
        return result;
      },
      enumerable: true,
    },
  });
  Object.freeze(actualResolver);
  const actualEmitter = Object.create(null) as E & ClassTerminalEmitter;
  // Capture actual generic procedures without consulting executable accessors.
  // Binding preserves their original private receiver and freezes this plan's method identities.
  for (
    let prototype: object | null = emitter;
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  )
    for (const key of Reflect.ownKeys(prototype)) {
      if (key === "constructor" || Object.hasOwn(actualEmitter, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor || !("value" in descriptor)) classInvalid("executable generic emitter descriptor");
      Object.defineProperty(actualEmitter, key, {
        value: typeof descriptor.value === "function" ? descriptor.value.bind(emitter) : descriptor.value,
        enumerable: descriptor.enumerable,
        configurable: true,
      });
    }
  const raw = actualEmitter.pushRaw;
  Object.defineProperties(actualEmitter, {
    nativeJsClassLegality: {
      value: (actual: IrFunction) => {
        assertNativeJsClassPhysicalLowering(port, actual);
        return port.legality;
      },
    },
    emitNativeJsClass: {
      value: (
        actual: IrFunction,
        instruction: NativeJsClassInstruction,
        operands: readonly (readonly Instr[])[],
        scratch: (type: ValType) => number,
        out: Instr[],
      ) => {
        const owner = loweringCurrent(port, actual);
        if (!port.owns(instruction)) classInvalid("foreign class lowering occurrence");
        for (const operation of emitClassRecipe(owner, actual, instruction, operands, scratch)) raw(out, operation);
        assertNativeJsClassPhysicalLowering(port, actual);
      },
    },
  });
  Object.freeze(actualEmitter);
  const convert = Object.getOwnPropertyDescriptor(converter, "convertType"),
    backend = Object.getOwnPropertyDescriptor(converter, "backend");
  if (
    !convert ||
    !("value" in convert) ||
    typeof convert.value !== "function" ||
    !backend ||
    !("value" in backend) ||
    backend.value !== owner.projection.backend
  )
    classInvalid("invalid concrete type converter");
  const actualConverter = Object.freeze({
    backend: backend.value as T["backend"],
    convertType: (type: IrType): readonly ValType[] => {
      const physical = port.valueType(type);
      const result = physical ? [physical] : convert.value.call(converter, type);
      port.assertFunction(fn);
      assertPreparedIrData(result);
      return freezePreparedIrValue(result) as readonly ValType[];
    },
  });
  const result = Object.freeze({
    fn,
    resolver: actualResolver,
    emitter: actualEmitter,
    typeConverter: actualConverter,
  });
  classFunctionPlans.set(result, { values, fn });
  return result;
}
export function assertNativeJsClassPhysicalFunctionPlan(plan: object, fn: IrFunction): void {
  const owner = classFunctionPlans.get(plan);
  if (!owner || owner.fn !== fn) classInvalid("foreign or copied concrete class function plan");
  classCurrent(owner.values, fn);
}
/** Ordinary projection is the existing concrete generic TypeConverter procedure,
 * never positive class permission. Class carriers are resolved by this owner. */
export function nativeJsClassPhysicalSignatureConverter<T extends IrType | ValType>(
  values: NativeJsClassPhysicalValues,
  base: (signature: { readonly params: readonly T[]; readonly results: readonly T[] }) => {
    params: ValType[];
    results: ValType[];
  },
) {
  classCurrent(values);
  return (signature: { readonly params: readonly T[]; readonly results: readonly T[] }) => {
    const owner = classCurrent(values);
    assertPreparedIrData(signature);
    signature = freezePreparedIrValue(signature) as typeof signature;
    const convert = (types: readonly T[]) =>
      types.map((type) => {
        if (type.kind === "support-ref" || type.kind === "dynamic") {
          const physical = physicalValueType(owner, type);
          if (physical) return physical;
          if (type.kind === "dynamic")
            classStartupFailed("logical class dynamic signature has no issued current carrier");
        }
        const projected = base({ params: [type], results: [] });
        classCurrent(values);
        assertPreparedIrData(projected);
        const row = (freezePreparedIrValue(projected) as typeof projected).params;
        if (row.length !== 1) classInvalid("generic signature is not a single actual carrier");
        return row[0]!;
      });
    const result = { params: convert(signature.params), results: convert(signature.results) };
    classCurrent(values);
    return result;
  };
}

function classStartupFailed(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", `program emission: ${detail}`);
}

/** Only the actual consumer-reserved tag can carry a native class exception. */
function classExceptionTagIndex(owner: ClassOwner): number {
  const tag = owner.exceptionTag;
  if (!tag) classInvalid("class exceptional completion lacks its issued exception tag");
  assertPreparedIrData(tag);
  if (nativeJsClassTransactionState(owner.tx) !== "filling" || tag.key !== "physical:exception-tag")
    classInvalid("class exception tag has no current frozen owner");
  const type = owner.tx.internFunctionType([{ kind: "externref" }], []);
  const typeIdx =
    tag.kind === "tag" ? tag.object.typeIdx : tag.object.desc.kind === "tag" ? tag.object.desc.typeIdx : undefined;
  if (
    typeIdx !== type ||
    (tag.kind === "tag" ? tag.object.name !== "__exn" : tag.object.module !== "env" || tag.object.name !== "__exn")
  )
    classInvalid("class exception tag contradicts its canonical payload/linkage");
  return owner.tx.physicalIndex(tag);
}

/** The canonical provider owns the error object; null means omitted message. */
function classThrow(
  owner: ClassOwner,
  fn: IrFunction,
  instruction: IrInstr,
  error: "TypeError" | "ReferenceError",
): readonly Instr[] {
  const demand = owner.requirements.errors.find(
    (row) => row.instruction === instruction && row.unitId === fn.unitId && row.error === error,
  );
  if (
    !demand ||
    demand.declaration.feature !== (error === "TypeError" ? "error.type.construct" : "error.reference.construct")
  )
    classInvalid("missing exact operation-derived error provider demand");
  const tagIdx = classExceptionTagIndex(owner);
  const provider =
    error === "TypeError" ? owner.errors.typeError.newTypeError : owner.errors.referenceError.newReferenceError;
  return [
    { op: "ref.null.extern" },
    { op: "call", funcIdx: owner.tx.physicalIndex(provider) },
    { op: "throw", tagIdx },
  ];
}
function emitClassBindingRead(
  owner: ClassOwner,
  fn: IrFunction,
  instruction: Extract<IrInstr, { kind: "js.class.binding.read" }>,
  operands: readonly (readonly Instr[])[],
): readonly Instr[] {
  if (instruction.storage.kind !== "module")
    throw new IrUnsupportedError(
      "class-projection-unsupported",
      "resolve",
      "class cell binding read has no issued physical recipe",
    );
  if (operands.length !== 0 || !owner.filled || !owner.moduleBindingsFilled || !owner.moduleBindings)
    classInvalid("unissued module binding read");
  const binding = owner.requirements.domain.definitions
    .flatMap(({ definition }) => [definition.outerBinding, definition.innerBinding])
    .find((row) => row?.id === instruction.storage.bindingId);
  if (!binding || binding.storage !== "module" || !binding.valueGlobal || !binding.tdzGlobal)
    classInvalid("module read lacks actual constructor/TDZ pair");
  const index = (ref: import("../../../ir/core/value-references.js").IrGlobalRef) => {
    const key = classGlobalKey(owner, ref),
      row = owner.moduleBindings!.find((row) => row.referenceKey === key);
    if (!row) classInvalid("missing original module read reservation");
    return owner.tx.physicalIndex(row.reservation);
  };
  return [
    { op: "global.get", index: index(binding.tdzGlobal) },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...classThrow(owner, fn, instruction, "ReferenceError")],
      else: [],
    },
    { op: "global.get", index: index(binding.valueGlobal) },
    { op: "ref.as_non_null" },
  ];
}
