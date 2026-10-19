// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { objectIsFixture } from "./native-object-is-fixture.js";
import { fillDescriptorDependencies } from "./native-descriptor-fixture.js";
import { fillNativeObjectDescriptorResources } from "../../src/backend/wasmgc/resources/native-object-descriptors.js";
import { fillNativeInvocationSubstrateResources } from "../../src/backend/wasmgc/resources/native-invocation-substrate.js";
import { fillNativeBooleanBoxResources } from "../../src/backend/wasmgc/resources/native-booleans.js";
import {
  reserveNativeObjectRealmException,
  reserveNativeRealmBaseAlgorithms,
  fillNativeRealmBaseAlgorithms,
  reserveNativeObjectRealmDeclarations,
  fillNativeObjectRealmDeclarations,
  reserveNativeRealmLiftedCalls,
} from "../../src/backend/wasmgc/resources/native-object-realm.js";
import { fillNativeObjectIsAlgorithm } from "../../src/backend/wasmgc/resources/native-object-is.js";
import {
  declareNativeRealmObjectLayouts,
  reserveNativeRealmObjectLayouts,
  fillNativeRealmObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-realm-object-layouts.js";
import {
  declareNativeClosureResources,
  instantiateNativeClosureRequirements,
  reserveNativeClosureResources,
} from "../../src/backend/wasmgc/resources/native-closures.js";
import { beginNativeSourceClosureEmission } from "../../src/ir/program-native-invocation.js";
import {
  nativeStringLiteralReservationInventory,
  requireNativeStringLiteral,
} from "../../src/backend/wasmgc/resources/native-string-literals.js";
import { buildBuiltinFunctionCheckedEntryDefinition } from "../../src/runtime/wasmgc/values/builtin-function-bodies.js";
import { createBuiltinFunctionType } from "../../src/runtime/wasmgc/values/builtin-function-layouts.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import type { FunctionReservation } from "../../src/wasm/physical/module-reservations.js";

export const liftedIds = ["%Function.prototype%", "%ThrowTypeError%", "%Object.is%"] as const;
export function liftedAlgorithmFixture(displaced = false, decoded = false) {
  const f = objectIsFixture(displaced, decoded);
  const exception = reserveNativeObjectRealmException(f.tx, f.realm, { required: true, shared: false });
  const baseDependencies = {
    requests: f.requests,
    substrate: f.substrate,
    exception,
    values: f.values,
    valuePlan: f.valuePlan,
    valueDependencies: f.valueDependencies,
    errors: f.errors,
    errorRequirements: f.errorRequirements,
    errorDependencies: f.errorDependencies,
  };
  const base = reserveNativeRealmBaseAlgorithms(f.tx, baseDependencies);
  const layoutDependencies = { objects: f.layouts, objectPlan: f.lookupDependencies.layoutPlan };
  const layouts = reserveNativeRealmObjectLayouts(
    f.tx,
    "lifted:realm",
    layoutDependencies,
    declareNativeRealmObjectLayouts("lifted:realm", f.layouts.object.key, f.layouts.propMap.key),
  );
  return { ...f, publicException: exception, baseDependencies, base, realmLayouts: layouts };
}
export function liftedOwnerFixture(displaced = false, decoded = false) {
  const f = liftedAlgorithmFixture(displaced, decoded);
  const strings = nativeStringLiteralReservationInventory(f.tx, f.strings).typePack;
  const source = beginNativeSourceClosureEmission(
    f.tx,
    f.realm.source!,
    {
      vectors: f.vectors,
      vectorPlan: f.vectorPlan,
      strings: { types: strings, key: strings.key, utf8Storage: strings.utf8Storage },
      realmState: f.realmLayouts,
    },
    f.requests,
  );
  const realmDependencies = {
    requests: f.requests,
    closures: source.types.closures,
    closurePlan: source.types.closurePlan,
    layouts: f.realmLayouts,
    substrate: f.substrate,
    vectors: f.vectors,
    vectorPlan: f.vectorPlan,
    exception: f.publicException,
    source: source.types,
    objectIs: f.objectIs,
    baseAlgorithms: f.base,
  };
  const declarations = reserveNativeObjectRealmDeclarations(f.tx, f.realm, realmDependencies);
  const lifted = reserveNativeRealmLiftedCalls(f.tx, declarations);
  return { ...f, source, realmDependencies, declarations, lifted };
}
export function fillLiftedAlgorithmFixture(f: ReturnType<typeof liftedAlgorithmFixture>) {
  if (f.tx.state === "reserving") f.tx.freezeReservations();
  fillDescriptorDependencies(f);
  fillNativeObjectDescriptorResources(f.tx, f.pack, f.exception);
  fillNativeInvocationSubstrateResources(f.tx, f.substrate);
  fillNativeBooleanBoxResources(f.tx, f.booleanBoxes);
  fillNativeRealmObjectLayouts(f.tx, f.realmLayouts);
  fillNativeObjectIsAlgorithm(f.tx, f.objectIs);
  fillNativeRealmBaseAlgorithms(f.tx, f.base);
}
export function fillLiftedOwnerFixture(f: ReturnType<typeof liftedOwnerFixture>) {
  fillLiftedAlgorithmFixture(f);
  fillNativeObjectRealmDeclarations(f.tx, f.declarations);
}

const ext = { kind: "externref" } as const,
  i32 = { kind: "i32" } as const;
const get = (index: number): Instr => ({ op: "local.get", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const global = (index: number): Instr => ({ op: "global.get", index });
const call = (token: FunctionReservation): Instr => ({ op: "call", funcIdx: token.handle });

/** Three-entry component witness, NOT a production population or whole-realm completion certificate. */
export function liftedComponentRuntime(displaced = false, decoded = false) {
  const f = liftedAlgorithmFixture(displaced, decoded),
    { tx } = f;
  const plan = declareNativeClosureResources({
    key: "lifted:component:closures",
    startingClosureCounter: 0,
    requests: f.requests.requests,
    referenceTypeKeys: f.requests.referenceTypes.map((row) => row.key),
  });
  const closures = reserveNativeClosureResources(
    tx,
    instantiateNativeClosureRequirements(tx, plan, new Map(f.requests.referenceTypes.map((row) => [row.key, row]))),
    plan,
  );
  const argv: ValType = { kind: "ref", typeIdx: f.substrate.arguments.carrier.typeIndex };
  const entries = liftedIds.map((id, index) => {
    const request = f.requests.intrinsics.find((row) => row.intrinsic.id === id)!;
    const metadata = closures.metadata.find((row) => row.id === request.metadataId)!.binding;
    const type = tx.reserveType(
      "component:type:" + id,
      createBuiltinFunctionType(
        id,
        metadata.type.typeIndex,
        f.realmLayouts.types.identity.typeIndex,
        f.strings.layout.anyStrTypeIdx,
      ),
    );
    const singleton =
      index === 0
        ? f.realmLayouts.anchors.functionPrototype
        : tx.reserveGlobal("component:singleton:" + id, id, { kind: "ref_null", typeIdx: type.typeIndex }, true);
    const lifted = tx.reserveFunction("component:lifted:" + id, id + ":lifted", {
      params: [{ kind: "ref", typeIdx: closures.root.typeIndex }, ext, argv],
      results: [ext],
    });
    if (lifted.object.typeIdx !== metadata.signature.liftedFuncTypeIndex) throw Error("wrong real lifted signature");
    const algorithm = id === "%Object.is%" ? f.objectIs.algorithm : f.base.algorithms[id];
    const clone = tx.reserveFunction("component:clone:" + id, id + ":clone", {
      params: [i32, i32, i32],
      results: [ext],
    });
    const storedCall = tx.reserveFunction("component:stored-call:" + id, id + ":stored-call", {
      params: [ext, ext, argv],
      results: [ext],
    });
    return { id, request, metadata, type, singleton, lifted, algorithm, clone, storedCall };
  });
  const initialize = tx.reserveFunction("component:initialize", "initialize", { params: [], results: [] });
  const undefinedValue = tx.reserveFunction("component:undefined", "undefinedValue", { params: [], results: [ext] });
  const observe = Object.fromEntries(
    ["errorMessage", "errorTag"].map((name) => [
      name,
      tx.reserveFunction("component:" + name, name, { params: [ext], results: name === "errorTag" ? [i32] : [ext] }),
    ]),
  );
  const literalObservers = Object.fromEntries(
    ["incompatible", "restricted"].map((name) => [
      name,
      tx.reserveFunction("component:literal:" + name, name, { params: [], results: [ext] }),
    ]),
  );
  fillLiftedAlgorithmFixture(f);
  const realm = tx.physicalIndex(f.realmLayouts.anchors.realm);
  const literal = (text: string): Instr[] => {
    const value = requireNativeStringLiteral(tx, f.strings, text);
    return [
      value.kind === "global" ? global(tx.physicalIndex(value.global)) : call(value.function),
      { op: "extern.convert_any" },
    ];
  };
  const typedName = (text: string): Instr[] => {
    const value = requireNativeStringLiteral(tx, f.strings, text);
    return [value.kind === "global" ? global(tx.physicalIndex(value.global)) : call(value.function)];
  };
  const allocate = (entry: (typeof entries)[number], clone: boolean): Instr[] => [
    ...(clone
      ? [
          get(2),
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "funcref" } },
            then: [{ op: "ref.func", funcIdx: undefinedValue.handle }],
            else: [{ op: "ref.func", funcIdx: entry.lifted.handle }],
          } as Instr,
        ]
      : [{ op: "ref.func", funcIdx: entry.lifted.handle } as Instr]),
    n(entry.request.intrinsic.callable.length),
    call(f.storage.createNull),
    n(0),
    n(entry.metadata.metadata.id),
    ...(clone ? [get(0), { op: "i32.add" } as Instr] : []),
    { op: "ref.null.extern" },
    ...(clone
      ? [
          get(1),
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "ref", typeIdx: f.realmLayouts.types.identity.typeIndex } },
            then: [{ op: "struct.new", typeIdx: f.realmLayouts.types.identity.typeIndex }],
            else: [global(realm), { op: "ref.as_non_null" }],
          } as Instr,
        ]
      : [global(realm), { op: "ref.as_non_null" } as Instr]),
    ...typedName(entry.request.intrinsic.callable.initialName),
    { op: "struct.new", typeIdx: entry.type.typeIndex },
    { op: "extern.convert_any" },
  ];
  tx.fillFunction(initialize, {
    locals: [],
    body: [
      { op: "struct.new", typeIdx: f.realmLayouts.types.identity.typeIndex },
      { op: "global.set", index: realm },
      ...entries.flatMap((entry): Instr[] => [
        ...allocate(entry, false),
        ...(entry.singleton.object.type.kind === "externref"
          ? []
          : [{ op: "any.convert_extern" } as Instr, { op: "ref.cast", typeIdx: entry.type.typeIndex } as Instr]),
        { op: "global.set", index: tx.physicalIndex(entry.singleton) },
      ]),
    ],
  });
  tx.fillFunction(undefinedValue, {
    locals: [],
    body: [global(tx.physicalIndex(f.values.globals.undefined)), { op: "extern.convert_any" }],
  });
  tx.declareFunctionReference(undefinedValue);
  for (const [name, token] of Object.entries(observe))
    tx.fillFunction(token, {
      locals: [],
      body: [
        get(0),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: f.errors.type.typeIndex },
        { op: "struct.get", typeIdx: f.errors.type.typeIndex, fieldIdx: name === "errorTag" ? 0 : 1 },
      ],
    });
  for (const [name, token] of Object.entries(literalObservers))
    tx.fillFunction(token, {
      locals: [],
      body: literal(
        name === "incompatible"
          ? "TypeError: incompatible native builtin function"
          : "TypeError: restricted function property",
      ),
    });
  for (const [index, entry] of entries.entries()) {
    if (index !== 0) tx.fillGlobal(entry.singleton, [{ op: "ref.null", typeIdx: entry.type.typeIndex }]);
    tx.declareFunctionReference(entry.lifted);
    tx.fillFunction(
      entry.lifted,
      buildBuiltinFunctionCheckedEntryDefinition({
        identity: {
          typeIdx: entry.type.typeIndex,
          metadataId: entry.metadata.metadata.id,
          liftedTypeIdx: entry.metadata.signature.liftedFuncTypeIndex,
          singleton: tx.physicalIndex(entry.singleton),
          singletonExtern: entry.singleton.object.type.kind === "externref",
          realm,
        },
        algorithm: entry.algorithm.handle,
        failure: [
          ...literal("TypeError: incompatible native builtin function"),
          call(f.errors.newTypeError),
          { op: "throw", tagIdx: tx.physicalIndex(f.publicException.tag) },
        ],
      }),
    );
    tx.fillFunction(entry.clone, { locals: [], body: allocate(entry, true) });
    const root = (): Instr[] => [
      get(0),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: closures.root.typeIndex },
    ];
    tx.fillFunction(entry.storedCall, {
      locals: [],
      body: [
        ...root(),
        get(1),
        get(2),
        ...root(),
        { op: "struct.get", typeIdx: closures.root.typeIndex, fieldIdx: 0 },
        { op: "ref.cast", typeIdx: entry.metadata.signature.liftedFuncTypeIndex },
        { op: "call_ref", typeIdx: entry.metadata.signature.liftedFuncTypeIndex },
      ],
    });
    for (const [name, token] of Object.entries({
      singleton: entry.singleton,
      call: entry.lifted,
      clone: entry.clone,
      storedCall: entry.storedCall,
    }))
      tx.defineExport("component:export:" + index + ":" + name, index + ":" + name, token);
  }
  for (const [name, token] of Object.entries({
    initialize,
    undefinedValue,
    ...observe,
    ...literalObservers,
    newVector: f.substrate.arguments.newVector,
    push: f.substrate.arguments.push,
    unboxBoolean: f.booleans.unboxBoolean,
    boxNumber: f.values.functions.boxNumber,
    exception: f.publicException.tag,
  }))
    tx.defineExport("component:export:" + name, name, token);
  tx.seal();
  const bytes = emitBinary(f.module),
    module = new WebAssembly.Module(bytes as BufferSource),
    ex = new WebAssembly.Instance(module).exports as Record<string, any>;
  const vector = (values: readonly unknown[]) => {
    const result = ex.newVector();
    values.forEach((value) => ex.push(result, value));
    return result;
  };
  return { f, entries, ex, vector, bytes, module };
}
