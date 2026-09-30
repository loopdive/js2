// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import type {
  PhysicalModuleReservations,
  FunctionReservation,
  GlobalReservation,
  TypeReservation,
  TagReservation,
} from "../../../wasm/physical/module-reservations.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  buildArgumentVectorNewBody,
  buildArgumentVectorPushLocals,
  buildArgumentVectorPushBody,
} from "../../../runtime/wasmgc/values/argument-vector-bodies.js";
import {
  createBuiltinFunctionRealmType,
  createBuiltinFunctionType,
} from "../../../runtime/wasmgc/values/builtin-function-layouts.js";
import {
  buildBuiltinFunctionAlgorithmDefinition,
  buildBuiltinFunctionInitializer,
  buildBuiltinFunctionMatchDefinition,
  buildBuiltinFunctionLiftedDefinition,
  buildBuiltinFunctionCallDefinition,
  buildBuiltinFunctionMethodDefinition,
  buildBuiltinFunctionSingletonDefinition,
  buildBuiltinFunctionSlotDefinition,
  builtinFailure,
} from "../../../runtime/wasmgc/values/builtin-function-bodies.js";
import {
  buildBuiltinFunctionFindOwn,
  buildBuiltinFunctionHasOwn,
  buildBuiltinFunctionDefine,
  buildBuiltinFunctionGetOwn,
  buildBuiltinFunctionOwnDescriptor,
  buildBuiltinFunctionDeleteOwn,
  buildBuiltinFunctionExtensibility,
  buildBuiltinFunctionWriteOwn,
  buildBuiltinFunctionWriteOwnStrict,
  buildBuiltinFunctionOwnKeys,
} from "../../../runtime/wasmgc/values/builtin-function-property-bodies.js";
import { buildStringExoticIndexDefinition } from "../../../runtime/wasmgc/values/string-exotic-bodies.js";
import { buildStringKeyOrderDefinition } from "../../../runtime/wasmgc/values/string-own-keys-body.js";
import {
  buildBuiltinFunctionLookup,
  buildBuiltinFunctionGet,
  buildBuiltinFunctionHas,
  buildBuiltinFunctionSetPrototype,
  type BuiltinFunctionPrototypeOperands,
} from "../../../runtime/wasmgc/values/builtin-function-prototype-bodies.js";
import {
  declareNativeBuiltinFunctionRequests,
  requireNativeBuiltinFunctionRequests,
  nativeBuiltinFunctionRequestDependencies,
  assertBuiltinFunctionDataRecord,
  NATIVE_BUILTIN_FUNCTION_LITERALS,
  type NativeBuiltinFunctionRequests,
} from "./native-builtin-function-requests.js";
import {
  nativeClosureReservationInventory,
  type NativeClosureReservations,
  type NativeClosureDeclarationPlan,
  type NativeClosureMetadataBinding,
} from "./native-closures.js";
import {
  nativeObjectDescriptorReservationInventory,
  requireCompletedNativeObjectDescriptors,
  type NativeObjectDescriptorReservations,
  type NativeObjectDescriptorDependencies,
} from "./native-object-descriptors.js";
import { requireNativeStringLiteral } from "./native-string-literals.js";

export { declareNativeBuiltinFunctionRequests as declareNativeBuiltinFunctionResources };
export interface NativeBuiltinFunctionDependencies {
  readonly requests: NativeBuiltinFunctionRequests;
  readonly closures: NativeClosureReservations;
  readonly closurePlan: NativeClosureDeclarationPlan;
  readonly descriptors: NativeObjectDescriptorReservations;
  readonly descriptorDependencies: NativeObjectDescriptorDependencies;
}
const functionRoles = [
  "initialize",
  "match",
  "callVector",
  "construct",
  "bag",
  "getPrototypeOf",
  "initialName",
  "arity",
  "objectPrototype",
  "realmIdentity",
  "findOwn",
  "hasOwn",
  "getOwn",
  "ownDescriptor",
  "defineData",
  "defineAccessor",
  "defineAttributes",
  "deleteOwn",
  "isExtensible",
  "preventExtensions",
  "writeOwn",
  "writeOwnStrict",
  "arrayIndex",
  "keyBefore",
  "ownKeys",
  "method0",
  "method1",
  "method2",
  "method3",
  "lookup",
  "get",
  "has",
  "setPrototypeOf",
] as const;
type FunctionRole = (typeof functionRoles)[number];
interface Entry {
  readonly id: string;
  readonly metadata: NativeClosureMetadataBinding;
  readonly type: TypeReservation;
  readonly singleton: GlobalReservation;
  readonly algorithm: FunctionReservation;
  readonly lifted: FunctionReservation;
  readonly getter: FunctionReservation;
}
export interface NativeBuiltinFunctionReservations {
  readonly requests: NativeBuiltinFunctionRequests;
  readonly entries: readonly Entry[];
  readonly functions: Readonly<Record<FunctionRole, FunctionReservation>>;
  readonly globals: {
    readonly realm: GlobalReservation;
    readonly objectPrototype: GlobalReservation;
    readonly state: GlobalReservation;
    readonly realmReady: GlobalReservation;
  };
  readonly realmType: TypeReservation;
  readonly exception: TagReservation;
  readonly completionScope: "synchronous-builtin-object-kernel";
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly dependencies: NativeBuiltinFunctionDependencies;
  readonly identities: NativeBuiltinFunctionDependencies;
  readonly keys: readonly string[];
  readonly functions: readonly FunctionReservation[];
  readonly globals: readonly GlobalReservation[];
  readonly descriptorInventory: ReturnType<typeof nativeObjectDescriptorReservationInventory>;
  filled: boolean;
}
const owners = new WeakMap<NativeBuiltinFunctionReservations, Owner>();
const ext = { kind: "externref" } as const,
  i32 = { kind: "i32" } as const,
  f64 = { kind: "f64" } as const;
function fail(detail: string): never {
  throw new Error("native builtin functions: " + detail);
}
function same(a: unknown, b: unknown, detail: string): void {
  if (preparedIrDataMismatch(a, b)) fail(detail);
}
function dependencies(tx: PhysicalModuleReservations, d: NativeBuiltinFunctionDependencies) {
  assertBuiltinFunctionDataRecord(d);
  if (
    Object.keys(d).length !== 5 ||
    Object.keys(d).some(
      (key) => !["requests", "closures", "closurePlan", "descriptors", "descriptorDependencies"].includes(key),
    )
  )
    fail("unexpected dependency input");
  requireNativeBuiltinFunctionRequests(tx, d.requests);
  const input = nativeBuiltinFunctionRequestDependencies(tx, d.requests),
    dd = d.descriptorDependencies;
  assertBuiltinFunctionDataRecord(dd);
  assertBuiltinFunctionDataRecord(dd.storageDependencies);
  assertBuiltinFunctionDataRecord(dd.storageDependencies.lookupDependencies);
  assertBuiltinFunctionDataRecord(dd.sameValueDependencies);
  assertBuiltinFunctionDataRecord(dd.errorDependencies);
  assertBuiltinFunctionDataRecord(dd.errorRequirements);
  assertBuiltinFunctionDataRecord(dd.sameValueDependencies.valueDependencies);
  nativeClosureReservationInventory(tx, d.closures, d.closurePlan);
  const inventory = nativeObjectDescriptorReservationInventory(tx, d.descriptors, dd);
  const ordinary = dd.storageDependencies.lookupDependencies.layouts.object.object;
  // ref.test includes subtypes. Plain storage lookup cannot stand in for an
  // exotic carrier's own-property method (String's virtual indices, for example).
  // Parentless structs are implicitly final in the emitted Wasm representation.
  if (ordinary.kind !== "struct" || (ordinary.superTypeIdx !== undefined && ordinary.final !== true))
    fail("extensible ordinary carrier requires heterogeneous prototype dispatch");
  if (
    dd.closures !== d.closures ||
    dd.storageDependencies.lookupDependencies.strings !== input.strings ||
    dd.sameValueDependencies.strings !== input.strings
  )
    fail("different closure root or string owner");
  const suffix = d.closurePlan.requirements.requests.slice(-d.requests.requests.length);
  same(suffix, d.requests.requests, "builtin requests are not the exact suffix of the shared closure pack");
  for (const row of d.requests.requirements.intrinsics) {
    const signature = d.closures.signatures.find((entry) => entry.id === row.signatureId)?.binding;
    const metadata = d.closures.metadata.find((entry) => entry.id === row.metadataId)?.binding;
    if (
      !signature ||
      !metadata ||
      metadata.signature !== signature ||
      signature.liftedSelfTypeIndex !== d.closures.root.typeIndex
    )
      fail("missing exact signature/metadata binding");
    same(
      signature.info.paramTypes,
      [ext, { kind: "ref", typeIdx: input.arguments.carrier.typeIndex }],
      "wrong builtin transport signature",
    );
    same(signature.info.returnType, ext, "wrong builtin result");
    same(
      metadata.metadata,
      {
        key: d.requests.requirements.key + ":intrinsic:" + row.id,
        name: row.initialName,
        length: row.initialLength,
        id: metadata.type.typeIndex,
      },
      "wrong metadata identity",
    );
  }
  const declaration = inventory.plan.declarations[0];
  if (declaration?.space !== "function") fail("missing internal descriptor body");
  same(declaration.role, ["ordinary-descriptor", "data-body"], "wrong descriptor behavior");
  same(declaration.signature, { params: [ext, ext, ext, f64], results: [ext] }, "wrong descriptor return-target ABI");
  return inventory;
}
function resourceKeys(requests: NativeBuiltinFunctionRequests): readonly string[] {
  const key = requests.requirements.key;
  return [
    key + ":realm-type",
    key + ":exception",
    ...["realm", "object-prototype", "state", "realm-ready"].map((role) => key + ":global:" + role),
    ...functionRoles.map((role) => key + ":function:" + role),
    ...requests.requirements.intrinsics.flatMap((row) =>
      ["type", "singleton", "algorithm", "lifted", "getter"].map((role) => key + ":" + row.id + ":" + role),
    ),
  ];
}
export function reserveNativeBuiltinFunctionResources(
  tx: PhysicalModuleReservations,
  d: NativeBuiltinFunctionDependencies,
): NativeBuiltinFunctionReservations {
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const inventory = dependencies(tx, d),
    input = nativeBuiltinFunctionRequestDependencies(tx, d.requests);
  const keys = Object.freeze(resourceKeys(d.requests));
  tx.assertReservationKeysAvailable(keys);
  const key = d.requests.requirements.key,
    realmType = tx.reserveType(key + ":realm-type", createBuiltinFunctionRealmType(key + ":realm"));
  const realm = tx.reserveGlobal(
    key + ":global:realm",
    key + ":realm",
    { kind: "ref_null", typeIdx: realmType.typeIndex },
    true,
  );
  const objectPrototype = tx.reserveGlobal(key + ":global:object-prototype", key + ":object-prototype", ext, true);
  const state = tx.reserveGlobal(key + ":global:state", key + ":state", i32, true);
  // Intentionally never raised by kernel completion. The actual standard realm graph is still missing.
  const realmReady = tx.reserveGlobal(key + ":global:realm-ready", key + ":realm-ready", i32, false);
  const entries = d.requests.requirements.intrinsics.map((row) => {
    const metadata = d.closures.metadata.find((entry) => entry.id === row.metadataId)!.binding;
    const prefix = key + ":" + row.id;
    const type = tx.reserveType(
      prefix + ":type",
      createBuiltinFunctionType(
        prefix,
        metadata.type.typeIndex,
        realmType.typeIndex,
        input.strings.layout.anyStrTypeIdx,
      ),
    );
    const singleton = tx.reserveGlobal(
      prefix + ":singleton",
      prefix,
      { kind: "ref_null", typeIdx: type.typeIndex },
      true,
    );
    const algorithm = tx.reserveFunction(prefix + ":algorithm", prefix + ":algorithm", {
      params: [ext, { kind: "ref", typeIdx: input.arguments.carrier.typeIndex }],
      results: [ext],
    });
    const lifted = tx.reserveFunction(prefix + ":lifted", prefix + ":lifted", {
      params: [
        { kind: "ref", typeIdx: d.closures.root.typeIndex },
        ext,
        { kind: "ref", typeIdx: input.arguments.carrier.typeIndex },
      ],
      results: [ext],
    });
    if (lifted.object.typeIdx !== metadata.signature.liftedFuncTypeIndex)
      fail("issued lifted signature did not intern exactly");
    const getter = tx.reserveFunction(prefix + ":getter", prefix + ":getter", { params: [], results: [ext] });
    return Object.freeze({ id: row.id, metadata, type, singleton, algorithm, lifted, getter });
  });
  const entryRef = {
    kind: "ref" as const,
    typeIdx: d.descriptorDependencies.storageDependencies.lookupDependencies.layouts.propEntry.typeIndex,
  };
  const signature = (role: FunctionRole): { params: ValType[]; results: ValType[] } => {
    if (role === "initialize") return { params: [], results: [] };
    if (role === "objectPrototype" || role === "realmIdentity") return { params: [], results: [ext] };
    if (role.startsWith("method"))
      return { params: Array.from({ length: Number(role.slice(6)) + 2 }, () => ext), results: [ext] };
    if (role === "callVector" || role === "construct")
      return { params: [ext, ext, { kind: "ref", typeIdx: input.arguments.carrier.typeIndex }], results: [ext] };
    if (role === "findOwn") return { params: [ext, ext], results: [{ kind: "ref_null", typeIdx: entryRef.typeIdx }] };
    if (role === "lookup")
      return { params: [ext, ext], results: [i32, { kind: "ref_null", typeIdx: entryRef.typeIdx }] };
    if (role === "ownDescriptor") return { params: [ext, ext], results: [i32, i32, ext, ext, ext] };
    if (role === "getOwn" || role === "get") return { params: [ext, ext, ext], results: [i32, ext] };
    if (role === "defineData") return { params: [ext, ext, ext, f64], results: [ext] };
    if (role === "defineAccessor") return { params: [ext, ext, ext, ext, f64], results: [ext] };
    if (role === "defineAttributes") return { params: [ext, ext, f64], results: [ext] };
    if (role === "writeOwn" || role === "writeOwnStrict") return { params: [ext, ext, ext], results: [i32] };
    if (role === "hasOwn" || role === "deleteOwn" || role === "has" || role === "setPrototypeOf")
      return { params: [ext, ext], results: [i32] };
    if (role === "keyBefore") return { params: [entryRef, entryRef], results: [i32] };
    if (role === "arrayIndex") return { params: [ext], results: [{ kind: "i64" }] };
    return {
      params: [ext],
      results: [["match", "arity", "isExtensible", "preventExtensions"].includes(role) ? i32 : ext],
    };
  };
  const functions = Object.freeze(
    Object.fromEntries(
      functionRoles.map((role) => [
        role,
        tx.reserveFunction(key + ":function:" + role, key + ":" + role, signature(role)),
      ]),
    ),
  ) as Readonly<Record<FunctionRole, FunctionReservation>>;
  const exception = tx.reserveTag(
    key + ":exception",
    { params: [ext], results: [] },
    { kind: "defined", name: key + ":exception" },
  ) as TagReservation;
  const globals = Object.freeze({ realm, objectPrototype, state, realmReady });
  const pack = Object.freeze({
    requests: d.requests,
    entries: Object.freeze(entries),
    functions,
    globals,
    realmType,
    exception,
    completionScope: "synchronous-builtin-object-kernel" as const,
  });
  owners.set(pack, {
    tx,
    dependencies: d,
    identities: Object.freeze({ ...d }),
    keys,
    functions: Object.freeze([
      ...Object.values(functions),
      ...entries.flatMap((row) => [row.algorithm, row.lifted, row.getter]),
    ]),
    globals: Object.freeze([...Object.values(globals), ...entries.map((row) => row.singleton)]),
    descriptorInventory: inventory,
    filled: false,
  });
  return pack;
}
function current(tx: PhysicalModuleReservations, pack: NativeBuiltinFunctionReservations): Owner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied builtin owner");
  assertBuiltinFunctionDataRecord(owner.dependencies);
  for (const key of Object.keys(owner.identities) as (keyof NativeBuiltinFunctionDependencies)[])
    if (owner.dependencies[key] !== owner.identities[key]) fail("substituted dependency identity");
  const inventory = dependencies(tx, owner.dependencies);
  if (inventory.functions !== owner.descriptorInventory.functions || inventory.plan !== owner.descriptorInventory.plan)
    fail("changed descriptor inventory");
  if (tx.state === "reserving")
    [pack.realmType, ...pack.entries.map((row) => row.type)].forEach((token) => tx.assertTypeReservation(token));
  else
    [
      pack.realmType,
      pack.exception,
      ...pack.entries.map((row) => row.type),
      ...owner.functions,
      ...owner.globals,
    ].forEach((token) => tx.physicalIndex(token));
  return owner;
}
export function requireNativeBuiltinFunctionReservations(
  tx: PhysicalModuleReservations,
  pack: NativeBuiltinFunctionReservations,
  expectedDependencies: NativeBuiltinFunctionDependencies,
): NativeBuiltinFunctionReservations {
  if (current(tx, pack).dependencies !== expectedDependencies) fail("foreign expected dependency record");
  return pack;
}
function completedDependencies(
  tx: PhysicalModuleReservations,
  pack: NativeBuiltinFunctionReservations,
  owner: Owner,
): void {
  requireCompletedNativeObjectDescriptors(
    tx,
    owner.dependencies.descriptors,
    owner.dependencies.descriptorDependencies,
  );
  const input = nativeBuiltinFunctionRequestDependencies(tx, pack.requests);
  tx.assertCompletedReservation(input.arguments.newVector);
  tx.assertCompletedReservation(input.arguments.push);
  // A filled token alone is not an attestation of argument transport. This
  // dependency currently has no private canonical-completion API, so compare
  // both definitions with fresh recipes over the reauthenticated issued layout.
  const vector = input.arguments;
  same(
    { locals: vector.newVector.object.locals, body: vector.newVector.object.body },
    { locals: [], body: buildArgumentVectorNewBody(vector.layout) },
    "noncanonical argument-vector new definition",
  );
  same(
    { locals: vector.push.object.locals, body: vector.push.object.body },
    { locals: buildArgumentVectorPushLocals(vector.layout), body: buildArgumentVectorPushBody(vector.layout) },
    "noncanonical argument-vector push definition",
  );
  const tag = tx.physicalIndex(pack.exception);
  // The descriptor owner retains its tag privately. Check authenticated canonical bodies
  // against the shared tag instead of treating another tag as an equivalent dependency.
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("op" in value && value.op === "throw" && "tagIdx" in value && value.tagIdx !== tag)
      fail("descriptor owner uses another exception tag");
    Object.values(value).forEach(visit);
  };
  owner.descriptorInventory.functions.forEach((token) => visit(token.object.body));
}
function operands(
  tx: PhysicalModuleReservations,
  pack: NativeBuiltinFunctionReservations,
  owner: Owner,
): BuiltinFunctionPrototypeOperands {
  const input = nativeBuiltinFunctionRequestDependencies(tx, pack.requests),
    dd = owner.dependencies.descriptorDependencies;
  const lookup = dd.storageDependencies.lookupDependencies,
    values = dd.sameValueDependencies.values;
  const literal = (text: string, external = true): Instr[] => {
    const token = requireNativeStringLiteral(tx, input.strings, text);
    return [
      token.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(token.global) }
        : { op: "call", funcIdx: token.function.handle },
      ...(external ? [{ op: "extern.convert_any" } as Instr] : []),
    ];
  };
  return {
    rootTypeIdx: owner.dependencies.closures.root.typeIndex,
    realmTypeIdx: pack.realmType.typeIndex,
    objectTypeIdx: lookup.layouts.object.typeIndex,
    vectorTypeIdx: input.arguments.carrier.typeIndex,
    vectorArrayTypeIdx: input.arguments.array.typeIndex,
    realm: tx.physicalIndex(pack.globals.realm),
    objectPrototype: tx.physicalIndex(pack.globals.objectPrototype),
    state: tx.physicalIndex(pack.globals.state),
    undefinedGlobal: tx.physicalIndex(values.globals.undefined),
    initializer: pack.functions.initialize.handle,
    match: pack.functions.match.handle,
    callVector: pack.functions.callVector.handle,
    bag: pack.functions.bag.handle,
    newVector: input.arguments.newVector.handle,
    push: input.arguments.push.handle,
    createNull: dd.storage.createNull.handle,
    boxNumber: values.functions.boxNumber.handle,
    defineDataBody: owner.descriptorInventory.functions[0]!.handle,
    defineAttributes: owner.dependencies.descriptors.defineAttributes.handle,
    typeError: dd.errors.newTypeError.handle,
    exceptionTag: tx.physicalIndex(pack.exception),
    lengthKey: literal("length"),
    nameKey: literal("name"),
    errors: NATIVE_BUILTIN_FUNCTION_LITERALS.slice(3).map((text) => literal(text)),
    entries: pack.entries.map((entry, index) => ({
      ...pack.requests.requirements.intrinsics[index]!,
      typeIdx: entry.type.typeIndex,
      metadataId: entry.metadata.metadata.id,
      liftedTypeIdx: entry.metadata.signature.liftedFuncTypeIndex,
      singleton: tx.physicalIndex(entry.singleton),
      lifted: entry.lifted.handle,
      algorithm: entry.algorithm.handle,
      initialName: literal(pack.requests.requirements.intrinsics[index]!.initialName, false),
    })),
    entryTypeIdx: lookup.layouts.propEntry.typeIndex,
    mapTypeIdx: lookup.layouts.propMap.typeIndex,
    findOrdinary: dd.storageDependencies.lookup.findOwn.handle,
    findOwn: pack.functions.findOwn.handle,
    defineData: owner.dependencies.descriptors.defineData.handle,
    defineAccessor: owner.dependencies.descriptors.defineAccessor.handle,
    keyBefore: pack.functions.keyBefore.handle,
    writeOwn: pack.functions.writeOwn.handle,
    getPrototypeOf: pack.functions.getPrototypeOf.handle,
    lookup: pack.functions.lookup.handle,
    isExtensible: pack.functions.isExtensible.handle,
    sameValue: dd.sameValue.sameValue.handle,
  };
}
export function fillNativeBuiltinFunctionResources(
  tx: PhysicalModuleReservations,
  pack: NativeBuiltinFunctionReservations,
): void {
  const owner = current(tx, pack);
  if (tx.state !== "filling" || owner.filled) fail("invalid phase or duplicate canonical fill");
  completedDependencies(tx, pack, owner);
  const d = operands(tx, pack, owner),
    lookup = owner.dependencies.descriptorDependencies.storageDependencies.lookupDependencies;
  tx.fillGlobal(pack.globals.realm, [{ op: "ref.null", typeIdx: pack.realmType.typeIndex }]);
  tx.fillGlobal(pack.globals.objectPrototype, [{ op: "ref.null.extern" }]);
  tx.fillGlobal(pack.globals.state, [{ op: "i32.const", value: 0 }]);
  tx.fillGlobal(pack.globals.realmReady, [{ op: "i32.const", value: 0 }]);
  pack.entries.forEach((entry, index) => {
    tx.fillGlobal(entry.singleton, [{ op: "ref.null", typeIdx: entry.type.typeIndex }]);
    tx.fillFunction(entry.algorithm, buildBuiltinFunctionAlgorithmDefinition(d, d.entries[index]!.behavior));
    tx.fillFunction(entry.lifted, buildBuiltinFunctionLiftedDefinition(d, d.entries[index]!, index));
    tx.fillFunction(entry.getter, buildBuiltinFunctionSingletonDefinition(d, d.entries[index]!));
    tx.declareFunctionReference(entry.lifted);
  });
  const fill = (role: FunctionRole, body: ReturnType<typeof buildBuiltinFunctionInitializer>) =>
    tx.fillFunction(pack.functions[role], body);
  fill("initialize", buildBuiltinFunctionInitializer(d));
  fill("match", buildBuiltinFunctionMatchDefinition(d));
  fill("callVector", buildBuiltinFunctionCallDefinition(d));
  fill("construct", { locals: [], body: builtinFailure(d, 1) });
  for (const [role, slot] of [
    ["bag", "bag"],
    ["arity", "arity"],
    ["getPrototypeOf", "prototype"],
    ["initialName", "initialName"],
  ] as const)
    fill(role, buildBuiltinFunctionSlotDefinition(d, slot));
  fill("objectPrototype", {
    locals: [],
    body: [
      { op: "call", funcIdx: d.initializer },
      { op: "global.get", index: d.objectPrototype },
    ],
  });
  fill("realmIdentity", {
    locals: [],
    body: [
      { op: "call", funcIdx: d.initializer },
      { op: "global.get", index: d.realm },
      { op: "ref.as_non_null" },
      { op: "extern.convert_any" },
    ],
  });
  fill("findOwn", buildBuiltinFunctionFindOwn(d));
  fill("hasOwn", buildBuiltinFunctionHasOwn(d));
  fill("getOwn", buildBuiltinFunctionGetOwn(d));
  fill("ownDescriptor", buildBuiltinFunctionOwnDescriptor(d));
  fill("defineData", buildBuiltinFunctionDefine(d, "data"));
  fill("defineAccessor", buildBuiltinFunctionDefine(d, "accessor"));
  fill("defineAttributes", buildBuiltinFunctionDefine(d, "attributes"));
  fill("deleteOwn", buildBuiltinFunctionDeleteOwn(d));
  fill("isExtensible", buildBuiltinFunctionExtensibility(d, false));
  fill("preventExtensions", buildBuiltinFunctionExtensibility(d, true));
  fill("writeOwn", buildBuiltinFunctionWriteOwn(d));
  fill("writeOwnStrict", buildBuiltinFunctionWriteOwnStrict(d));
  fill(
    "arrayIndex",
    buildStringExoticIndexDefinition({
      anyStrTypeIdx: lookup.strings.layout.anyStrTypeIdx,
      nativeStrTypeIdx: lookup.strings.layout.nativeStrTypeIdx,
      nativeStrDataTypeIdx: lookup.strings.layout.nativeStrDataTypeIdx,
      flattenIdx: lookup.flatten.flatten.handle,
    }),
  );
  fill(
    "keyBefore",
    buildStringKeyOrderDefinition({
      propEntryType: d.entryTypeIdx,
      symbolType: lookup.symbols.types.symbol.typeIndex,
      arrayIndex: pack.functions.arrayIndex.handle,
    }),
  );
  fill("ownKeys", buildBuiltinFunctionOwnKeys(d));
  fill("lookup", buildBuiltinFunctionLookup(d));
  fill("get", buildBuiltinFunctionGet(d));
  fill("has", buildBuiltinFunctionHas(d));
  fill("setPrototypeOf", buildBuiltinFunctionSetPrototype(d));
  for (const arity of [0, 1, 2, 3] as const)
    fill(("method" + arity) as FunctionRole, buildBuiltinFunctionMethodDefinition(d, arity));
  owner.filled = true;
}
/** Kernel completion deliberately grants no standard realm/provider acceptance. */
export function requireCompletedNativeBuiltinFunctionKernel(
  tx: PhysicalModuleReservations,
  pack: NativeBuiltinFunctionReservations,
  expectedDependencies: NativeBuiltinFunctionDependencies,
): NativeBuiltinFunctionReservations {
  requireNativeBuiltinFunctionReservations(tx, pack, expectedDependencies);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical builtin fill");
  completedDependencies(tx, pack, owner);
  [...owner.functions, ...owner.globals].forEach((token) => tx.assertCompletedReservation(token));
  return pack;
}
export function nativeBuiltinFunctionReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeBuiltinFunctionReservations,
) {
  const owner = current(tx, pack);
  return Object.freeze({
    keys: owner.keys,
    functions: owner.functions,
    globals: owner.globals,
    types: Object.freeze([pack.realmType, ...pack.entries.map((row) => row.type)]),
    completionScope: pack.completionScope,
    gaps: Object.freeze([
      "complete Object/Function realm",
      "heterogeneous Get/SetPrototypeOf",
      "source/builtin getter invocation",
      "canonical intrinsic descriptor demand issuer",
    ] as const),
  });
}
export function nativeBuiltinFunctionSingletonBinding(
  tx: PhysicalModuleReservations,
  pack: NativeBuiltinFunctionReservations,
  alias: string,
): Entry {
  current(tx, pack);
  const index = pack.requests.requirements.intrinsics.findIndex((row) => row.aliases.includes(alias));
  if (index < 0) fail("unknown intrinsic alias");
  return pack.entries[index]!;
}
