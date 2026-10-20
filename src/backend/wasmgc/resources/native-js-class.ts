// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  PhysicalModuleReservations,
  type TypeReservation,
  type GlobalReservation,
  type FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import { buildAnyValueType, buildUndefinedInitializer } from "../../../runtime/wasmgc/values/primitive-layouts.js";
import {
  assertPreparedIrData,
  preparedIrDataMismatch,
  freezePreparedIrValue,
} from "../../../shared/contracts/prepared-ir-data.js";
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import type { IrInstr } from "../../../ir/core/nodes.js";
import { JS_TAG_IDS } from "../../../ir/core/js-value-tag-identities.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";

const stateGetter = Object.getOwnPropertyDescriptor(PhysicalModuleReservations.prototype, "state")!.get!;
const reserveType = PhysicalModuleReservations.prototype.reserveType;
const assertTypeReservation = PhysicalModuleReservations.prototype.assertTypeReservation;
const reserveSelfType = PhysicalModuleReservations.prototype.reserveSelfReferentialStructType;
const reserveGlobal = PhysicalModuleReservations.prototype.reserveGlobal;
const reserveFunction = PhysicalModuleReservations.prototype.reserveFunction;
const physicalIndex = PhysicalModuleReservations.prototype.physicalIndex;
const fillGlobal = PhysicalModuleReservations.prototype.fillGlobal;
const fillFunction = PhysicalModuleReservations.prototype.fillFunction;
const assertCompleted = PhysicalModuleReservations.prototype.assertCompletedReservation;
// Exact method-reader closure of the reused string/Error reservation producers.
const transactionMethods = [
  "reserveType",
  "reserveGlobal",
  "reserveFunction",
  "physicalIndex",
  "physicalIndices",
  "fillGlobal",
  "fillFunction",
  "assertCompletedReservation",
  "assertTypeReservation",
  "assertReservationKeysAvailable",
  "internFunctionType",
  "reserveSelfReferentialStructType",
  "reserveExtensibleSelfReferentialStructType",
] as const;
const transactionMethodValues = transactionMethods.map(
  (key) => Object.getOwnPropertyDescriptor(PhysicalModuleReservations.prototype, key)!.value,
);
export function nativeJsClassTransactionState(tx: PhysicalModuleReservations): PhysicalModuleReservations["state"] {
  if (!tx || Object.getPrototypeOf(tx) !== PhysicalModuleReservations.prototype)
    invalid("foreign transaction prototype");
  if (Object.getOwnPropertyDescriptor(tx, "state")) invalid("shadowed transaction member");
  const stateDescriptor = Object.getOwnPropertyDescriptor(PhysicalModuleReservations.prototype, "state");
  if (stateDescriptor?.get !== stateGetter || stateDescriptor.set !== undefined)
    invalid("changed transaction state authority");
  for (const [index, key] of transactionMethods.entries()) {
    if (Object.getOwnPropertyDescriptor(tx, key)) invalid("shadowed transaction member");
    const descriptor = Object.getOwnPropertyDescriptor(PhysicalModuleReservations.prototype, key);
    if (!descriptor || descriptor.get || descriptor.set || descriptor.value !== transactionMethodValues[index])
      invalid("changed transaction method authority");
  }
  try {
    return Reflect.apply(stateGetter, tx, []) as PhysicalModuleReservations["state"];
  } catch {
    invalid("foreign transaction");
  }
}

/** Primitive substrate only. No class graph, role binding or admission is issued here. */
export interface NativeJsClassGcValues {
  readonly carrier: TypeReservation;
  readonly undefinedValue: GlobalReservation;
  readonly functionPrototypeBody: FunctionReservation;
}
const owners = new WeakMap<NativeJsClassGcValues, { tx: PhysicalModuleReservations; filled: boolean }>();
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", "native JS class GC values: " + detail);
}
export function reserveNativeJsClassGcValues(tx: PhysicalModuleReservations, key: string): NativeJsClassGcValues {
  if (!key || nativeJsClassTransactionState(tx) !== "reserving") invalid("invalid reservation phase/key");
  // All fields of the tagged carrier are immutable. A property get returns this
  // value reference, never a mutable view into the instance's property storage.
  const carrier = reserveType.call(tx, key + ":value", buildAnyValueType());
  const type = { kind: "ref" as const, typeIdx: carrier.typeIndex };
  const undefinedValue = reserveGlobal.call(tx, key + ":undefined", "__class_undefined", type, false);
  const functionPrototypeBody = reserveFunction.call(
    tx,
    key + ":function-prototype-body",
    "__class_function_prototype",
    {
      params: [],
      results: [type],
    },
  );
  const pack = Object.freeze({
    carrier,
    undefinedValue,
    functionPrototypeBody,
  });
  owners.set(pack, { tx, filled: false });
  return pack;
}
function current(tx: PhysicalModuleReservations, pack: NativeJsClassGcValues) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx || nativeJsClassTransactionState(tx) !== "filling")
    invalid("foreign pack or inactive attempt");
  assertPreparedIrData([pack.carrier.object, pack.undefinedValue.object, pack.functionPrototypeBody.object]);
  physicalIndex.call(tx, pack.carrier);
  physicalIndex.call(tx, pack.undefinedValue);
  physicalIndex.call(tx, pack.functionPrototypeBody);
  return owner;
}
export function fillNativeJsClassGcValues(tx: PhysicalModuleReservations, pack: NativeJsClassGcValues): void {
  const owner = current(tx, pack);
  if (owner.filled) invalid("duplicate fill");
  fillGlobal.call(tx, pack.undefinedValue, buildUndefinedInitializer(pack.carrier.typeIndex));
  fillFunction.call(tx, pack.functionPrototypeBody, {
    locals: [],
    body: [{ op: "global.get", index: physicalIndex.call(tx, pack.undefinedValue) }],
  });
  owner.filled = true;
}
export function requireCompletedNativeJsClassGcValues(
  tx: PhysicalModuleReservations,
  pack: NativeJsClassGcValues,
): void {
  if (!current(tx, pack).filled) invalid("unfilled values");
  assertCompleted.call(tx, pack.undefinedValue);
  assertCompleted.call(tx, pack.functionPrototypeBody);
}

/** Materialize only a genuine source-owned primitive box. Parent canonical
 * requirements must authorize its exact occurrence and allocation site. */
export function emitNativeJsClassGcBox(
  tx: PhysicalModuleReservations,
  pack: NativeJsClassGcValues,
  instruction: Extract<IrInstr, { kind: "box" }>,
  operand: readonly Instr[],
): readonly Instr[] {
  if (!current(tx, pack).filled) invalid("unfilled values");
  if (
    instruction.alloc === undefined ||
    instruction.resultType?.kind !== "dynamic" ||
    instruction.toType.kind !== "dynamic"
  )
    invalid("box lacks site/tagged result");
  const tag = instruction.toType.tag;
  if (tag !== instruction.resultType.tag || (tag !== JS_TAG_IDS.NumberF64 && tag !== JS_TAG_IDS.Boolean))
    invalid("unsupported box tag");
  const number = tag === JS_TAG_IDS.NumberF64;
  return [
    { op: "i32.const", value: Number(tag) },
    ...(number
      ? [{ op: "i32.const", value: 0 } as const]
      : [...operand, { op: "i32.eqz" } as const, { op: "i32.eqz" } as const]),
    ...(number ? operand : [{ op: "f64.const", value: NaN } as const]),
    { op: "ref.null", typeIdx: -19 },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: pack.carrier.typeIndex },
  ];
}

export interface NativeJsClassManagedGcType {
  readonly managed: TypeReservation;
  readonly propertyKeys: readonly string[];
}
const managedOwners = new WeakMap<
  NativeJsClassManagedGcType,
  {
    tx: PhysicalModuleReservations;
    values: NativeJsClassGcValues;
    snapshot: unknown;
  }
>();
/** One genuine managed root representation for all source-qualified roles.
 * Replacement objects never require a declaring-class nominal cast. Inline
 * property slots allocate no hidden property-table children. */
export function reserveNativeJsClassManagedGcType(
  tx: PhysicalModuleReservations,
  values: NativeJsClassGcValues,
  key: string,
  actualPropertyKeys: readonly string[],
): NativeJsClassManagedGcType {
  if (owners.get(values)?.tx !== tx || nativeJsClassTransactionState(tx) !== "reserving")
    invalid("foreign values or invalid graph type phase");
  assertPreparedIrData(actualPropertyKeys);
  if (
    !actualPropertyKeys.every((value) => typeof value === "string") ||
    new Set(actualPropertyKeys).size !== actualPropertyKeys.length
  )
    invalid("invalid closed key domain");
  assertPreparedIrData(values.carrier.object);
  assertTypeReservation.call(tx, values.carrier);
  const carrier = values.carrier.typeIndex;
  const root = (name: string) => ({
    name,
    type: { kind: "ref_null" as const, self: true as const },
    mutable: true,
  });
  const managed = reserveSelfType.call(tx, key, {
    name: "NativeJsClassManagedRoot",
    fields: [
      { name: "role", type: { kind: "i32" }, mutable: false },
      root("prototype"),
      root("environment"),
      root("home-object"),
      root("new-target"),
      root("this"),
      root("instance-prototype"),
      root("binding-value"),
      { name: "binding-flags", type: { kind: "i32" }, mutable: true },
      { name: "callable", type: { kind: "i32" }, mutable: false },
      ...actualPropertyKeys.flatMap((name, index) => [
        {
          name: "property:" + index + ":flags:" + name,
          type: { kind: "i32" as const },
          mutable: true,
        },
        {
          name: "property:" + index + ":value:" + name,
          type: { kind: "ref" as const, typeIdx: carrier },
          mutable: true,
        },
      ]),
    ],
  });
  const graph = Object.freeze({
    managed,
    propertyKeys: Object.freeze([...actualPropertyKeys]),
  });
  managedOwners.set(graph, {
    tx,
    values,
    snapshot: freezePreparedIrValue(managed.object),
  });
  return graph;
}
export function assertNativeJsClassManagedGcTypeCurrent(
  tx: PhysicalModuleReservations,
  values: NativeJsClassGcValues,
  graph: NativeJsClassManagedGcType,
): void {
  const owner = managedOwners.get(graph);
  if (!owner || owner.tx !== tx || owner.values !== values) invalid("unissued or foreign graph type");
  const state = nativeJsClassTransactionState(tx);
  if (state !== "reserving" && state !== "filling") invalid("revoked graph type attempt");
  assertPreparedIrData(graph.managed.object);
  if (preparedIrDataMismatch(owner.snapshot, graph.managed.object) !== undefined)
    invalid("changed managed root geometry");
  if (state === "reserving") assertTypeReservation.call(tx, graph.managed);
  else physicalIndex.call(tx, graph.managed);
}

/** Physical aggregate-child recipe, not a semantic class/realm certificate.
 * The mixed owner must join the real root/child catalogue and source lifetime.
 * A callable coordinate comes only from this exact transaction's reservation. */
export function emitNativeJsClassGcAggregateRoot(
  tx: PhysicalModuleReservations,
  values: NativeJsClassGcValues,
  graph: NativeJsClassManagedGcType,
  role: 0 | 1 | 2 | 3 | 4 | 6,
  prototype: readonly Instr[],
  callable?: FunctionReservation,
  instancePrototype?: readonly Instr[],
): readonly Instr[] {
  assertNativeJsClassManagedGcTypeCurrent(tx, values, graph);
  if (!current(tx, values).filled || ![0, 1, 2, 3, 4, 6].includes(role)) invalid("invalid aggregate root recipe");
  assertPreparedIrData(prototype);
  if (callable) assertPreparedIrData(callable);
  if (instancePrototype) assertPreparedIrData(instancePrototype);
  if ((role === 1 || role === 6) !== (callable !== undefined)) invalid("aggregate callable/role mismatch");
  if ((role === 1) !== (instancePrototype !== undefined)) invalid("aggregate constructor/prototype mismatch");
  const index = callable ? physicalIndex.call(tx, callable) : -1;
  const type = graph.managed.typeIndex;
  return [
    { op: "i32.const", value: role },
    ...prototype,
    ...Array.from({ length: 4 }, () => ({ op: "ref.null" as const, typeIdx: type })),
    ...(instancePrototype ?? [{ op: "ref.null" as const, typeIdx: type }]),
    { op: "ref.null", typeIdx: type },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: index },
    ...graph.propertyKeys.flatMap(() => [
      { op: "i32.const" as const, value: 0 },
      { op: "global.get" as const, index: physicalIndex.call(tx, values.undefinedValue) },
    ]),
    { op: "struct.new", typeIdx: type },
  ];
}

/** Own populated slot recipe only. Parent class dispatch must establish actual
 * own presence before selecting this recipe; it proves no inherited absence.
 * The returned tagged reference is immutable, so later slot replacement cannot
 * change a previously observed value. Neither recipe allocates a value box. */
export function emitNativeJsClassGcOwnPropertySnapshot(
  tx: PhysicalModuleReservations,
  values: NativeJsClassGcValues,
  graph: NativeJsClassManagedGcType,
  key: string,
  receiver: readonly Instr[],
): readonly Instr[] {
  assertNativeJsClassManagedGcTypeCurrent(tx, values, graph);
  if (nativeJsClassTransactionState(tx) !== "filling") invalid("inactive property recipe");
  const index = graph.propertyKeys.indexOf(key);
  if (index < 0) invalid("property outside complete key census");
  return [
    ...receiver,
    {
      op: "struct.get",
      typeIdx: graph.managed.typeIndex,
      fieldIdx: 11 + 2 * index,
    },
  ];
}

/** Replace an existing own tagged slot. Define/accessor/writability semantics
 * remain the caller's full canonical operation obligation, not this recipe. */
export function emitNativeJsClassGcOwnPropertyReplacement(
  tx: PhysicalModuleReservations,
  values: NativeJsClassGcValues,
  graph: NativeJsClassManagedGcType,
  key: string,
  receiver: readonly Instr[],
  value: readonly Instr[],
): readonly Instr[] {
  assertNativeJsClassManagedGcTypeCurrent(tx, values, graph);
  if (nativeJsClassTransactionState(tx) !== "filling") invalid("inactive property recipe");
  const index = graph.propertyKeys.indexOf(key);
  if (index < 0) invalid("property outside complete key census");
  return [
    ...receiver,
    ...value,
    {
      op: "struct.set",
      typeIdx: graph.managed.typeIndex,
      fieldIdx: 11 + 2 * index,
    },
  ];
}

/** A frame owns one declared activation allocation. Evaluate the four original
 * operands exactly once in source order before laying out the managed fields.
 * The mixed owner must authenticate the actual frame instruction/site. */
export function emitNativeJsClassGcFrameNew(
  tx: PhysicalModuleReservations,
  values: NativeJsClassGcValues,
  graph: NativeJsClassManagedGcType,
  operands: readonly (readonly Instr[])[],
  scratch: (type: ValType) => number,
): readonly Instr[] {
  assertNativeJsClassManagedGcTypeCurrent(tx, values, graph);
  if (!current(tx, values).filled || operands.length !== 4) invalid("invalid activation frame operands");
  const type = graph.managed.typeIndex;
  const locals = operands.map(() => scratch({ kind: "ref_null", typeIdx: type }));
  if (locals.some((index) => !Number.isSafeInteger(index) || index < 0) || new Set(locals).size !== 4)
    invalid("invalid activation scratch locals");
  return [
    ...operands.flatMap((operand, index) => [...operand, { op: "local.set" as const, index: locals[index]! }]),
    { op: "i32.const", value: 5 },
    { op: "ref.null", typeIdx: type },
    ...[0, 2, 3, 1].map((index) => ({
      op: "local.get" as const,
      index: locals[index]!,
    })),
    { op: "ref.null", typeIdx: type },
    { op: "ref.null", typeIdx: type },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: -1 },
    ...graph.propertyKeys.flatMap(() => [
      { op: "i32.const" as const, value: 0 },
      {
        op: "global.get" as const,
        index: physicalIndex.call(tx, values.undefinedValue),
      },
    ]),
    { op: "struct.new", typeIdx: type },
  ];
}
export function emitNativeJsClassGcFrameGet(
  tx: PhysicalModuleReservations,
  values: NativeJsClassGcValues,
  graph: NativeJsClassManagedGcType,
  instruction: Extract<IrInstr, { kind: "js.class.frame.get" }>,
  frame: readonly Instr[],
): readonly Instr[] {
  assertNativeJsClassManagedGcTypeCurrent(tx, values, graph);
  if (!current(tx, values).filled) invalid("unfilled activation values");
  assertPreparedIrData(instruction);
  const kind = instruction.access.kind;
  if (kind === "capture") invalid("capture requires actual binding/global custody");
  const index = { this: 5, environment: 2, "home-object": 3, "new-target": 4 }[kind];
  if (index === undefined) invalid("unknown activation field");
  if (instruction.resultType?.kind !== "support-ref") invalid("unmapped activation read result");
  return [
    ...frame,
    { op: "struct.get", typeIdx: graph.managed.typeIndex, fieldIdx: index },
    ...(instruction.resultType.nullable ? [] : [{ op: "ref.as_non_null" as const }]),
  ];
}

/** Real reserved realm graph resources. This physical pack alone is not a
 * source/body admission certificate or a complete builtin property catalogue. */
export interface NativeJsClassGcRealm {
  readonly globals: Readonly<
    Record<"objectPrototype" | "functionPrototype" | "typeError" | "referenceError", GlobalReservation>
  >;
  readonly errorAncestor: GlobalReservation;
  readonly errorAncestorPrototype: GlobalReservation;
  readonly errorPrototypes: readonly [GlobalReservation, GlobalReservation];
  readonly bootstrap: FunctionReservation;
}
const realmOwners = new WeakMap<
  NativeJsClassGcRealm,
  {
    tx: PhysicalModuleReservations;
    values: NativeJsClassGcValues;
    graph: NativeJsClassManagedGcType;
    errorAncestorBody: FunctionReservation;
    errors: readonly [FunctionReservation, FunctionReservation];
    filled: boolean;
  }
>();
export function reserveNativeJsClassGcRealm(
  tx: PhysicalModuleReservations,
  values: NativeJsClassGcValues,
  graph: NativeJsClassManagedGcType,
  key: string,
  names: Readonly<Record<keyof NativeJsClassGcRealm["globals"], string>>,
  errors: readonly [FunctionReservation, FunctionReservation],
  errorAncestorBody: FunctionReservation,
): NativeJsClassGcRealm {
  assertNativeJsClassManagedGcTypeCurrent(tx, values, graph);
  if (nativeJsClassTransactionState(tx) !== "reserving" || !key) invalid("invalid realm reservation phase/key");
  assertPreparedIrData([names, errors, errorAncestorBody]);
  if (
    Object.keys(names).sort().join(",") !== "functionPrototype,objectPrototype,referenceError,typeError" ||
    !Object.values(names).every((name) => typeof name === "string" && name.length > 0)
  )
    invalid("invalid realm names");
  const type = { kind: "ref" as const, typeIdx: graph.managed.typeIndex };
  const reserve = (role: string, name: string) => reserveGlobal.call(tx, key + ":" + role, name, type, false);
  const objectPrototype = reserve("Object.prototype", names.objectPrototype);
  const functionPrototype = reserve("Function.prototype", names.functionPrototype);
  // Immutable initializer dependencies precede their readers. Cyclic
  // constructor back-links are populated by the declared bootstrap function.
  const errorAncestorPrototype = reserve("Error.prototype", "__class_Error_prototype");
  const errorAncestor = reserve("Error", "__class_Error");
  const errorPrototypes = Object.freeze([
    reserve("TypeError.prototype", "__class_TypeError_prototype"),
    reserve("ReferenceError.prototype", "__class_ReferenceError_prototype"),
  ] as const);
  const globals = Object.freeze({
    objectPrototype,
    functionPrototype,
    typeError: reserve("TypeError", names.typeError),
    referenceError: reserve("ReferenceError", names.referenceError),
  });
  const bootstrap = reserveFunction.call(tx, key + ":bootstrap", "__class_realm_bootstrap", {
    params: [],
    results: [],
  });
  const realm = Object.freeze({ globals, errorAncestor, errorAncestorPrototype, errorPrototypes, bootstrap });
  realmOwners.set(realm, {
    tx,
    values,
    graph,
    errorAncestorBody,
    errors: Object.freeze([errors[0], errors[1]] as const),
    filled: false,
  });
  return realm;
}
function realmCurrent(tx: PhysicalModuleReservations, realm: NativeJsClassGcRealm) {
  const owner = realmOwners.get(realm);
  if (!owner || owner.tx !== tx) invalid("unissued or foreign realm resources");
  assertPreparedIrData([owner.values, owner.graph, realm, owner.errors, owner.errorAncestorBody]);
  assertNativeJsClassManagedGcTypeCurrent(tx, owner.values, owner.graph);
  assertPreparedIrData([
    ...Object.values(realm.globals).map((token) => token.object),
    realm.errorAncestor.object,
    realm.errorAncestorPrototype.object,
    ...realm.errorPrototypes.map((token) => token.object),
    realm.bootstrap.object,
  ]);
  if (nativeJsClassTransactionState(tx) === "filling") {
    for (const token of [
      ...Object.values(realm.globals),
      ...realm.errorPrototypes,
      realm.errorAncestor,
      realm.errorAncestorPrototype,
      realm.bootstrap,
      owner.errorAncestorBody,
      ...owner.errors,
    ])
      physicalIndex.call(tx, token);
  }
  return owner;
}
export function fillNativeJsClassGcRealm(tx: PhysicalModuleReservations, realm: NativeJsClassGcRealm): void {
  const owner = realmCurrent(tx, realm);
  if (owner.filled) invalid("duplicate realm fill");
  requireCompletedNativeJsClassGcValues(tx, owner.values);
  for (const error of [...owner.errors, owner.errorAncestorBody]) assertCompleted.call(tx, error);
  const typeIdx = owner.graph.managed.typeIndex;
  const get = (token: GlobalReservation): Instr[] => [{ op: "global.get", index: physicalIndex.call(tx, token) }];
  const root = (
    role: 1 | 2 | 6,
    prototype: readonly Instr[],
    callable?: FunctionReservation,
    instancePrototype?: readonly Instr[],
  ) => [
    ...emitNativeJsClassGcAggregateRoot(tx, owner.values, owner.graph, role, prototype, callable, instancePrototype),
  ];
  fillGlobal.call(tx, realm.globals.objectPrototype, root(2, [{ op: "ref.null", typeIdx }]));
  fillGlobal.call(
    tx,
    realm.globals.functionPrototype,
    root(6, get(realm.globals.objectPrototype), owner.values.functionPrototypeBody),
  );
  fillGlobal.call(tx, realm.errorAncestorPrototype, root(2, get(realm.globals.objectPrototype)));
  fillGlobal.call(
    tx,
    realm.errorAncestor,
    root(1, get(realm.globals.functionPrototype), owner.errorAncestorBody, get(realm.errorAncestorPrototype)),
  );
  for (const prototype of realm.errorPrototypes)
    fillGlobal.call(tx, prototype, root(2, get(realm.errorAncestorPrototype)));
  const constructors = [realm.globals.typeError, realm.globals.referenceError] as const;
  for (const [index, errorConstructor] of constructors.entries())
    fillGlobal.call(
      tx,
      errorConstructor,
      root(1, get(realm.errorAncestor), owner.errors[index]!, get(realm.errorPrototypes[index]!)),
    );
  const body: Instr[] = [];
  const put = (receiver: GlobalReservation, key: string, target: GlobalReservation, tag: number, flags: number) => {
    const index = owner.graph.propertyKeys.indexOf(key);
    if (index < 0) return;
    body.push(
      ...get(receiver),
      { op: "i32.const", value: flags },
      { op: "struct.set", typeIdx, fieldIdx: 10 + 2 * index },
      ...get(receiver),
      { op: "i32.const", value: tag },
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: NaN },
      ...get(target),
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: owner.values.carrier.typeIndex },
      { op: "struct.set", typeIdx, fieldIdx: 11 + 2 * index },
    );
  };
  put(realm.errorAncestorPrototype, "constructor", realm.errorAncestor, Number(JS_TAG_IDS.Function), 11);
  put(realm.errorAncestor, "prototype", realm.errorAncestorPrototype, Number(JS_TAG_IDS.Object), 1);
  for (const [index, errorConstructor] of constructors.entries()) {
    put(realm.errorPrototypes[index]!, "constructor", errorConstructor, Number(JS_TAG_IDS.Function), 11);
    put(errorConstructor, "prototype", realm.errorPrototypes[index]!, Number(JS_TAG_IDS.Object), 1);
  }
  fillFunction.call(tx, realm.bootstrap, { locals: [], body });
  owner.filled = true;
}
export function requireCompletedNativeJsClassGcRealm(
  tx: PhysicalModuleReservations,
  realm: NativeJsClassGcRealm,
): void {
  if (!realmCurrent(tx, realm).filled) invalid("unfilled realm resources");
  for (const token of [
    ...Object.values(realm.globals),
    ...realm.errorPrototypes,
    realm.errorAncestor,
    realm.errorAncestorPrototype,
    realm.bootstrap,
  ])
    assertCompleted.call(tx, token);
}

/** Actual definition aggregate geometry. The constructor is the output/root;
 * all other nodes and tagged method wrappers share its declared aggregate
 * lifetime. Source/site and USER-body authority belongs to the mixed issuer. */
export function emitNativeJsClassGcDefinitionAggregate(
  tx: PhysicalModuleReservations,
  values: NativeJsClassGcValues,
  graph: NativeJsClassManagedGcType,
  realm: NativeJsClassGcRealm,
  body: FunctionReservation,
  members: readonly { readonly name: string; readonly static: boolean; readonly body: FunctionReservation }[],
  innerBinding: boolean,
  scratch: (type: ValType) => number,
): readonly Instr[] {
  const owner = realmCurrent(tx, realm);
  if (owner.values !== values || owner.graph !== graph) invalid("foreign definition realm");
  requireCompletedNativeJsClassGcRealm(tx, realm);
  assertPreparedIrData([body, members]);
  for (const member of members)
    if (
      typeof member.name !== "string" ||
      typeof member.static !== "boolean" ||
      !graph.propertyKeys.includes(member.name)
    )
      invalid("definition member outside complete key census");
  const typeIdx = graph.managed.typeIndex,
    type: ValType = { kind: "ref", typeIdx };
  const prototype = scratch(type),
    environment = scratch(type),
    root = scratch(type);
  const cell = innerBinding ? scratch(type) : undefined;
  if (
    ![prototype, environment, root, ...(cell === undefined ? [] : [cell])].every(
      (index) => Number.isSafeInteger(index) && index >= 0,
    )
  )
    invalid("invalid definition scratch coordinate");
  const locals = [prototype, environment, root, ...(cell === undefined ? [] : [cell])];
  if (new Set(locals).size !== locals.length) invalid("aliased definition scratch");
  const get = (index: number): Instr[] => [{ op: "local.get", index }];
  const global = (token: GlobalReservation): Instr[] => [{ op: "global.get", index: physicalIndex.call(tx, token) }];
  const out: Instr[] = [
    ...emitNativeJsClassGcAggregateRoot(tx, values, graph, 2, global(realm.globals.objectPrototype)),
    { op: "local.set", index: prototype },
    ...emitNativeJsClassGcAggregateRoot(tx, values, graph, 3, [{ op: "ref.null", typeIdx }]),
    { op: "local.set", index: environment },
    ...emitNativeJsClassGcAggregateRoot(
      tx,
      values,
      graph,
      1,
      global(realm.globals.functionPrototype),
      body,
      get(prototype),
    ),
    { op: "local.set", index: root },
    ...get(root),
    ...get(environment),
    { op: "struct.set", typeIdx, fieldIdx: 2 },
  ];
  if (cell !== undefined) {
    out.push(
      ...emitNativeJsClassGcAggregateRoot(tx, values, graph, 4, [{ op: "ref.null", typeIdx }]),
      { op: "local.set", index: cell },
      ...get(cell),
      ...get(root),
      { op: "struct.set", typeIdx, fieldIdx: 7 },
      ...get(cell),
      { op: "i32.const", value: 3 },
      { op: "struct.set", typeIdx, fieldIdx: 8 },
      ...get(environment),
      ...get(cell),
      { op: "struct.set", typeIdx, fieldIdx: 7 },
    );
  }
  const put = (receiver: number, key: string, target: readonly Instr[], tag: number, flags: number) => {
    const index = graph.propertyKeys.indexOf(key);
    if (index < 0) return;
    out.push(
      ...get(receiver),
      { op: "i32.const", value: flags },
      { op: "struct.set", typeIdx, fieldIdx: 10 + 2 * index },
      ...get(receiver),
      { op: "i32.const", value: tag },
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: NaN },
      ...target,
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: values.carrier.typeIndex },
      { op: "struct.set", typeIdx, fieldIdx: 11 + 2 * index },
    );
  };
  put(prototype, "constructor", get(root), Number(JS_TAG_IDS.Function), 11);
  put(root, "prototype", get(prototype), Number(JS_TAG_IDS.Object), 1);
  for (const member of members) {
    const method = scratch(type);
    if (!Number.isSafeInteger(method) || method < 0 || locals.includes(method)) invalid("invalid method scratch");
    locals.push(method);
    const home = member.static ? root : prototype;
    out.push(
      ...emitNativeJsClassGcAggregateRoot(tx, values, graph, 6, global(realm.globals.functionPrototype), member.body),
      { op: "local.set", index: method },
      ...get(method),
      ...get(environment),
      { op: "struct.set", typeIdx, fieldIdx: 2 },
      ...get(method),
      ...get(home),
      { op: "struct.set", typeIdx, fieldIdx: 3 },
    );
    put(home, member.name, get(method), Number(JS_TAG_IDS.Function), 11);
  }
  out.push(...get(root));
  realmCurrent(tx, realm);
  return out;
}

/** Genuine empty base-constructor recipe. Logical candidate/source/site and
 * error-demand custody are checked by the private class session at every use. */
export function emitNativeJsClassGcConstruction(
  tx: PhysicalModuleReservations,
  values: NativeJsClassGcValues,
  graph: NativeJsClassManagedGcType,
  targets: readonly { readonly body: FunctionReservation; readonly parameters: number }[],
  newTargets: readonly FunctionReservation[],
  operands: readonly (readonly Instr[])[],
  typeError: readonly Instr[],
  scratch: (type: ValType) => number,
): readonly Instr[] {
  assertNativeJsClassManagedGcTypeCurrent(tx, values, graph);
  if (
    !current(tx, values).filled ||
    nativeJsClassTransactionState(tx) !== "filling" ||
    operands.length < 2 ||
    !targets.length ||
    !newTargets.length
  )
    invalid("unissued construction resources/candidates");
  assertPreparedIrData([targets, newTargets, operands, typeError]);
  targets = targets.map(({ body, parameters }) => Object.freeze({ body, parameters }));
  newTargets = [...newTargets];
  operands = freezePreparedIrValue(operands) as typeof operands;
  typeError = freezePreparedIrValue(typeError) as typeof typeError;
  const typeIdx = graph.managed.typeIndex;
  const managed: ValType = { kind: "ref", typeIdx };
  const carrier: ValType = { kind: "ref", typeIdx: values.carrier.typeIndex };
  const ctor = scratch(managed),
    newTarget = scratch(managed),
    self = scratch(managed);
  const args = operands.slice(2).map(() => scratch(carrier));
  const locals = [ctor, newTarget, self, ...args];
  if (locals.some((index) => !Number.isSafeInteger(index) || index < 0) || new Set(locals).size !== locals.length)
    invalid("invalid/aliased construction scratch");
  const get = (index: number): Instr[] => [{ op: "local.get", index }];
  const field = (index: number, fieldIdx: number): Instr[] => [...get(index), { op: "struct.get", typeIdx, fieldIdx }];
  const nonnull = (index: number, fieldIdx: number): Instr[] => [...field(index, fieldIdx), { op: "ref.as_non_null" }];
  const coordinate = (target: FunctionReservation): number => physicalIndex.call(tx, target);
  const targetIndices = targets.map(({ body, parameters }) => {
    if (!Number.isSafeInteger(parameters) || parameters < 0) invalid("invalid original USER arity");
    const signature = tx.internFunctionType(
      [managed, managed, managed, { kind: "ref_null", typeIdx }, ...Array.from({ length: parameters }, () => carrier)],
      [managed],
    );
    if (body.object.typeIdx !== signature) invalid("constructor actual USER signature mismatch");
    return coordinate(body);
  });
  const newTargetIndices = newTargets.map(coordinate);
  if (new Set(targetIndices).size !== targets.length || new Set(newTargetIndices).size !== newTargets.length)
    invalid("duplicate construction callable coordinate");
  // All original operands, including discarded extras, run before guards or allocation.
  const out: Instr[] = operands.flatMap((operand, index) => [
    ...operand,
    { op: "local.set" as const, index: index === 0 ? ctor : index === 1 ? newTarget : args[index - 2]! },
  ]);
  for (const index of [ctor, newTarget])
    out.push(
      ...field(index, 0),
      { op: "i32.const", value: 1 },
      { op: "i32.ne" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...typeError],
        else: [],
      },
    );
  out.push(...field(newTarget, 9), { op: "i32.const", value: newTargetIndices[0]! }, { op: "i32.eq" });
  for (const index of newTargetIndices.slice(1))
    out.push(...field(newTarget, 9), { op: "i32.const", value: index }, { op: "i32.eq" }, { op: "i32.or" });
  // A role-correct foreign coordinate contradicts the closed current producer census.
  out.push({ op: "i32.eqz" }, { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }], else: [] });
  out.push(...emitNativeJsClassGcAggregateRoot(tx, values, graph, 0, nonnull(newTarget, 6)), {
    op: "local.set",
    index: self,
  });
  let dispatch: Instr[] = [{ op: "unreachable" }];
  for (let index = targets.length - 1; index >= 0; index--) {
    const target = targets[index]!;
    const actualArgs = Array.from({ length: target.parameters }, (_, ordinal): Instr[] =>
      ordinal < args.length
        ? get(args[ordinal]!)
        : [{ op: "global.get", index: physicalIndex.call(tx, values.undefinedValue) }],
    );
    dispatch = [
      ...field(ctor, 9),
      { op: "i32.const", value: targetIndices[index]! },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...nonnull(ctor, 2),
          ...get(self),
          ...nonnull(ctor, 6),
          ...get(newTarget),
          ...actualArgs.flat(),
          { op: "call", funcIdx: targetIndices[index]! },
          { op: "local.set", index: self },
        ],
        else: dispatch,
      },
    ];
  }
  out.push(...dispatch, ...get(self));
  assertNativeJsClassManagedGcTypeCurrent(tx, values, graph);
  return out;
}
