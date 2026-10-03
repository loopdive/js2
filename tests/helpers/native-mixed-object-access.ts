// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import type { FunctionReservation } from "../../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../../src/emit/binary.js";
import {
  publicRealmFoundation,
  publicRealmClosures,
  publicRealmDeclarations,
  publicRealmSourceSlots,
} from "./native-object-realm.js";
import { fillRealmLayoutFixture, ext, i32, f64, get, as } from "./native-realm-object-layouts.js";
import {
  declareNativeRealmObjectLayouts,
  reserveNativeRealmObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-realm-object-layouts.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringEqualityResources,
  fillNativeStringEqualityResources,
} from "../../src/backend/wasmgc/resources/native-string-equality.js";
import {
  reserveNativeSymbolCarrierResources,
  fillNativeSymbolCarrierResources,
} from "../../src/backend/wasmgc/resources/native-symbol-carrier.js";
import { declareNativeObjectLookupResources } from "../../src/backend/wasmgc/resources/native-object-access-declarations.js";
import {
  reserveNativeObjectLookupResources,
  fillNativeObjectLookupResources,
} from "../../src/backend/wasmgc/resources/native-object-access.js";
import {
  declareNativeObjectStorageResources,
  reserveNativeObjectStorageResources,
  fillNativeObjectStorageResources,
} from "../../src/backend/wasmgc/resources/native-object-storage.js";
import {
  declareNativePrimitiveWrapperLayouts,
  reserveNativePrimitiveWrapperLayouts,
} from "../../src/backend/wasmgc/resources/native-primitive-wrapper-layouts.js";
import {
  declareNativePrimitiveWrapperStorageResources,
  reserveNativePrimitiveWrapperStorageResources,
  fillNativePrimitiveWrapperStorageResources,
} from "../../src/backend/wasmgc/resources/native-primitive-wrapper-storage.js";
import {
  declareNativeStringOwnDescriptorResources,
  reserveNativeStringOwnDescriptorResources,
  fillNativeStringOwnDescriptorResources,
} from "../../src/backend/wasmgc/resources/native-string-exotic-own-descriptors.js";
import {
  declareNativeStringCreateResources,
  reserveNativeStringCreateResources,
  fillNativeStringCreateResources,
} from "../../src/backend/wasmgc/resources/native-string-create.js";
import { deriveNativeValueResourcePlan } from "../../src/ir/program/native-value-resources.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
} from "../../src/backend/wasmgc/resources/native-string-number.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
} from "../../src/backend/wasmgc/resources/native-values.js";
import { fillNativeStringLiteralResources } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import { fillNativeInvocationSubstrateResources } from "../../src/backend/wasmgc/resources/native-invocation-substrate.js";
import { planNativeStringLiteral } from "../../src/runtime/wasmgc/values/string-literal-bodies.js";
import { createBuiltinFunctionType } from "../../src/runtime/wasmgc/values/builtin-function-layouts.js";
import {
  executeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "../../src/backend/wasmgc/resources/native-resource-declarations.js";
import {
  declareNativeMixedObjectAccessResources,
  reserveNativeMixedObjectAccessResources,
} from "../../src/backend/wasmgc/resources/native-mixed-object-access.js";
import {
  buildMixedObjectClassify,
  buildMixedObjectOwn,
  buildMixedObjectLookup,
  buildMixedObjectHas,
  buildMixedObjectGetPrototype,
  buildMixedObjectSetPrototype,
  buildMixedObjectGet,
  type MixedObjectAccessOperands,
} from "../../src/runtime/wasmgc/values/mixed-object-access-bodies.js";
import {
  bindNativeSourceClosureUnits,
  nativeRealmSourceClosureCallableBindings,
  nativeSourceClosureResolver,
  fillPreparedPrimaryUnit,
  requireCompletedNativeSourceClosures,
} from "../../src/ir/program-native-invocation.js";
import type { IrLowerResolver } from "../../src/ir/backend/lower-contracts.js";

export function mixedFoundation(displaced = false) {
  const f = publicRealmFoundation(displaced),
    { tx } = f,
    c = publicRealmClosures(f);
  const flatten = reserveNativeStringFlattenResources(tx, "mixed:flatten", f.strings);
  const equality = reserveNativeStringEqualityResources(tx, "mixed:equality", flatten, true);
  const symbols = reserveNativeSymbolCarrierResources(tx, "mixed:symbols", f.strings);
  const lookupDependencies = {
    layouts: f.objects,
    layoutPlan: f.objectPlan,
    strings: f.strings,
    flatten,
    equality,
    symbols,
  };
  const lookup = reserveNativeObjectLookupResources(
    tx,
    "mixed:keys",
    lookupDependencies,
    declareNativeObjectLookupResources("mixed:keys", {
      object: f.objects.object.key,
      propEntry: f.objects.propEntry.key,
      nativeString: f.stringTypes.key + ":flat",
    }),
  );
  const storageDependencies = { lookup, lookupDependencies };
  const storage = reserveNativeObjectStorageResources(
    tx,
    "mixed:storage",
    storageDependencies,
    declareNativeObjectStorageResources("mixed:storage", f.objects.object.key),
  );
  const layoutDependencies = {
    objects: f.objects,
    objectPlan: f.objectPlan,
    strings: f.strings,
    symbols,
    realmState: f.pack,
  };
  const keys = {
    object: f.objects.object.key,
    propMap: f.objects.propMap.key,
    anyString: f.stringTypes.key + ":any",
    symbol: symbols.types.symbol.key,
  };
  const layoutPlan = declareNativePrimitiveWrapperLayouts("mixed:wrappers", keys, f.pack.types.state.key);
  const layouts = reserveNativePrimitiveWrapperLayouts(tx, "mixed:wrappers", layoutPlan, layoutDependencies);
  const wrapperDependencies = { layouts, layoutPlan, layoutDependencies };
  const wrappers = reserveNativePrimitiveWrapperStorageResources(
    tx,
    "mixed:wrapper-storage",
    declareNativePrimitiveWrapperStorageResources("mixed:wrapper-storage", keys, 8),
    wrapperDependencies,
  );
  const ownDependencies = { ...wrapperDependencies, lookup, lookupDependencies };
  const own = reserveNativeStringOwnDescriptorResources(
    tx,
    "mixed:string-own",
    declareNativeStringOwnDescriptorResources("mixed:string-own", {
      object: keys.object,
      propEntry: f.objects.propEntry.key,
    }),
    ownDependencies,
  );
  const valuePlan = deriveNativeValueResourcePlan(f.program, f.projection, "native-string");
  const scanner = reserveNativeStringNumberResources(tx, valuePlan, flatten);
  const valueDependencies = { strings: { kind: "native-string" as const, stringPack: f.strings, scanner } };
  const values = reserveNativeValueResources(tx, valuePlan, valueDependencies);
  const stringCreateDependencies = {
    ...wrapperDependencies,
    storage,
    storageDependencies,
    values,
    valuePlan,
    valueDependencies,
    ownDescriptors: own,
    ownDescriptorDependencies: ownDependencies,
  };
  const stringCreate = reserveNativeStringCreateResources(
    tx,
    "mixed:string-create",
    declareNativeStringCreateResources("mixed:string-create", keys.anyString, 8),
    stringCreateDependencies,
  );
  return {
    f,
    c,
    tx,
    flatten,
    equality,
    symbols,
    lookupDependencies,
    lookup,
    storage,
    layouts,
    own,
    ownDependencies,
    valuePlan,
    valueDependencies,
    values,
    scanner,
    wrappers,
    stringCreate,
  };
}
export function mixedOwnerFixture(displaced = false) {
  const r = mixedFoundation(displaced),
    realm = publicRealmDeclarations(r.f, r.c);
  const dependencies = {
    realm: realm.declarations,
    realmDependencies: realm.dependencies,
    stringOwn: r.own,
    stringOwnDependencies: r.ownDependencies,
    values: r.values,
    valuePlan: r.valuePlan,
    valueDependencies: r.valueDependencies,
  };
  const plan = structuredClone(declareNativeMixedObjectAccessResources("mixed:access", r.f.objects.propEntry.key));
  return { ...r, realm, dependencies, plan };
}
export function reserveMixedOwner(r: ReturnType<typeof mixedOwnerFixture>) {
  return reserveNativeMixedObjectAccessResources(r.tx, "mixed:access", r.dependencies, r.plan);
}
/** Independently genuine same-ledger family, deliberately from a different state/anchor owner. */
export function alternativeMixedStringOwner(r: ReturnType<typeof mixedOwnerFixture>) {
  const state = reserveNativeRealmObjectLayouts(
    r.tx,
    "alternative:state",
    r.f.dependencies,
    declareNativeRealmObjectLayouts("alternative:state", r.f.objects.object.key, r.f.objects.propMap.key),
  );
  const layoutDependencies = { ...r.ownDependencies.layoutDependencies, realmState: state };
  const layoutPlan = declareNativePrimitiveWrapperLayouts(
    "alternative:wrappers",
    {
      object: r.f.objects.object.key,
      propMap: r.f.objects.propMap.key,
      anyString: r.f.stringTypes.key + ":any",
      symbol: r.symbols.types.symbol.key,
    },
    state.types.state.key,
  );
  const layouts = reserveNativePrimitiveWrapperLayouts(r.tx, "alternative:wrappers", layoutPlan, layoutDependencies);
  const dependencies = { ...r.ownDependencies, layoutDependencies, layoutPlan, layouts };
  const pack = reserveNativeStringOwnDescriptorResources(
    r.tx,
    "alternative:own",
    declareNativeStringOwnDescriptorResources("alternative:own", {
      object: r.f.objects.object.key,
      propEntry: r.f.objects.propEntry.key,
    }),
    dependencies,
  );
  return { pack, dependencies };
}
export function fillMixedDependencies(r: ReturnType<typeof mixedFoundation>) {
  fillRealmLayoutFixture(r.f);
  fillNativeStringLiteralResources(r.tx, r.f.strings);
  fillNativeInvocationSubstrateResources(r.tx, r.f.substrate);
  fillNativeStringFlattenResources(r.tx, r.flatten);
  fillNativeStringEqualityResources(r.tx, r.equality);
  fillNativeSymbolCarrierResources(r.tx, r.symbols);
  fillNativeObjectLookupResources(r.tx, r.lookup);
  fillNativeObjectStorageResources(r.tx, r.storage);
  fillNativePrimitiveWrapperStorageResources(r.tx, r.wrappers);
  fillNativeStringOwnDescriptorResources(r.tx, r.own);
  fillNativeStringNumberResources(r.tx, r.scanner);
  fillNativeValueResources(r.tx, r.values, r.valueDependencies);
  fillNativeStringCreateResources(r.tx, r.stringCreate);
}
const n = (value: number): Instr => ({ op: "i32.const", value });
const call = (token: FunctionReservation): Instr => ({ op: "call", funcIdx: token.handle });
const global = (index: number): Instr => ({ op: "global.get", index });
const empty = { kind: "empty" } as const;

/** Emitted component controls. No public population, standard algorithm stub or host semantic import is installed. */
export function mixedRuntime(displaced = false) {
  const r = mixedFoundation(displaced),
    { f, c, tx } = r;
  const source = publicRealmSourceSlots(f, c);
  const recipe = declareNativeMixedObjectAccessResources("control:access", f.objects.propEntry.key);
  const records = executeNativeResourceRecipe(tx, recipe, new Map([[f.objects.propEntry.key, f.objects.propEntry]]));
  const tokens = Object.fromEntries(
    ["classify", "own", "lookup", "has", "getPrototypeOf", "setPrototypeOf", "get"].map((role) => [
      role,
      requireNativeDeclaredReservation(records, "control:access:" + role, "function"),
    ]),
  ) as Record<string, FunctionReservation>;
  const objectPrototype = tx.reserveGlobal(
    "control:object-prototype",
    "controlObjectPrototype",
    { kind: "ref_null", typeIdx: f.pack.types.objectPrototype.typeIndex },
    true,
  );
  const metadata = c.closures.metadata[0]!.binding;
  const nativeType = tx.reserveType(
    "control:native-type",
    createBuiltinFunctionType(
      "ControlNative",
      metadata.type.typeIndex,
      f.pack.types.identity.typeIndex,
      f.strings.layout.anyStrTypeIdx,
    ),
  );
  const nativeSingleton = tx.reserveGlobal("control:native", "controlNative", ext, true);
  const observer = tx.reserveFunction("control:generic-call", "controlGenericCall", {
    params: [ext, ext, { kind: "ref", typeIdx: f.substrate.arguments.carrier.typeIndex }],
    results: [ext],
  });
  const lifted = tx.reserveFunction("control:native-lifted", "controlNativeLifted", {
    params: [
      { kind: "ref", typeIdx: c.closures.root.typeIndex },
      ext,
      { kind: "ref", typeIdx: f.substrate.arguments.carrier.typeIndex },
    ],
    results: [ext],
  });
  const counters = {
    calls: tx.reserveGlobal("control:calls", "calls", i32, true),
    argc: tx.reserveGlobal("control:argc", "argc", i32, true),
    receiver: tx.reserveGlobal("control:receiver", "receiver", ext, true),
    nested: tx.reserveGlobal("control:nested", "nested", ext, true),
    payload: tx.reserveGlobal("control:payload", "payload", ext, true),
  };
  const signatures: Record<string, { params: ValType[]; results: ValType[] }> = {
    initialize: { params: [], results: [] },
    ordinary: { params: [ext], results: [ext] },
    foreign: { params: [ext], results: [ext] },
    put: { params: [ext, ext, ext, i32, ext], results: [] },
    flags: { params: [ext, i32], results: [] },
    corruptParent: { params: [ext, ext], results: [] },
    fakePrefix: { params: [ext, ext], results: [] },
    nativeClone: { params: [i32, i32, ext], results: [ext] },
    wrongLift: { params: [], results: [ext] },
    unknownSource: { params: [], results: [ext] },
    isUtf8: { params: [ext], results: [i32] },
    codeUnit: { params: [ext, i32], results: [i32] },
    clearBag: { params: [ext], results: [] },
    ownFlags: { params: [ext, ext], results: [i32, i32] },
    callCaptured: { params: [ext, f64], results: [f64] },
  };
  const controls = Object.fromEntries(
    Object.entries(signatures).map(([name, signature]) => [
      name,
      tx.reserveFunction("control:" + name, name, signature),
    ]),
  );
  const keyGlobals = Object.fromEntries(
    ["own", "0", "1", "2", "01", "-0", "length", "absent", "reenter", "throw", "😀"].map((text) => {
      const plan = planNativeStringLiteral(f.strings.layout, displaced, text, displaced ? "utf8-guaranteed" : "wtf16");
      if (plan.kind !== "global") throw Error("control key unexpectedly chunked");
      return [
        text,
        {
          token: tx.reserveGlobal(
            "control:key:" + text,
            "key:" + text,
            { kind: "ref", typeIdx: plan.refTypeIdx },
            false,
          ),
          plan,
        },
      ];
    }),
  );
  tx.freezeReservations();
  tx.declareFunctionReference(lifted);
  bindNativeSourceClosureUnits(tx, c.source!, source.slots);
  const association = nativeRealmSourceClosureCallableBindings(tx, c.source!, f.realm);
  fillMixedDependencies(r);
  tx.fillGlobal(objectPrototype, [{ op: "ref.null", typeIdx: f.pack.types.objectPrototype.typeIndex }]);
  tx.fillGlobal(nativeSingleton, [{ op: "ref.null", typeIdx: -17 }]);
  for (const [name, token] of Object.entries(counters)) {
    tx.fillGlobal(token, name === "calls" || name === "argc" ? [n(0)] : [{ op: "ref.null", typeIdx: -17 }]);
    tx.defineExport("control:export:" + name, name, token);
  }
  for (const [text, row] of Object.entries(keyGlobals)) {
    tx.fillGlobal(row.token, row.plan.init);
    tx.defineExport("control:export:key:" + text, "key:" + text, row.token);
  }
  const realm = tx.physicalIndex(f.pack.anchors.realm),
    op = tx.physicalIndex(objectPrototype),
    ns = tx.physicalIndex(nativeSingleton);
  const operands: MixedObjectAccessOperands = {
    objectTypeIdx: f.objects.object.typeIndex,
    entryTypeIdx: f.objects.propEntry.typeIndex,
    stateTypeIdx: f.pack.types.state.typeIndex,
    anyStringTypeIdx: f.strings.layout.anyStrTypeIdx,
    symbolTypeIdx: r.symbols.types.symbol.typeIndex,
    realm,
    objectPrototype: op,
    metadataTypes: c.closures.metadata.map((row) => row.binding.type.typeIndex),
    carriers: [
      { kind: "string", typeIdx: r.layouts.types.String.typeIndex, stateField: 7 },
      { kind: "ordinary", typeIdx: f.pack.types.ordinary.typeIndex, stateField: 6 },
      ...(["Boolean", "Number", "Symbol", "BigInt"] as const).map((kind) => ({
        kind: "wrapper" as const,
        typeIdx: r.layouts.types[kind].typeIndex,
        stateField: 7,
      })),
      { kind: "object-prototype", typeIdx: f.pack.types.objectPrototype.typeIndex },
      {
        kind: "native",
        typeIdx: nativeType.typeIndex,
        native: {
          metadataId: metadata.metadata.id,
          liftedTypeIdx: metadata.signature.liftedFuncTypeIndex,
          singleton: ns,
          singletonExtern: true,
        },
      },
      ...c.source!.types.shapes.map((shape) => ({
        kind: "source" as const,
        typeIdx: shape.type.typeIndex,
        stateField: 3 + c.source!.requirements.shapes.find((row) => row.id === shape.id)!.captures.length,
      })),
    ],
    classify: tokens.classify!.handle,
    own: tokens.own!.handle,
    lookup: tokens.lookup!.handle,
    getPrototypeOf: tokens.getPrototypeOf!.handle,
    findOrdinary: r.lookup.findOwn.handle,
    findString: r.own.findOwn.handle,
  };
  const definitions = {
    classify: buildMixedObjectClassify,
    own: buildMixedObjectOwn,
    lookup: buildMixedObjectLookup,
    has: buildMixedObjectHas,
    getPrototypeOf: buildMixedObjectGetPrototype,
    setPrototypeOf: buildMixedObjectSetPrototype,
  };
  for (const [role, builder] of Object.entries(definitions)) tx.fillFunction(tokens[role]!, builder(operands));
  tx.fillFunction(
    tokens.get!,
    buildMixedObjectGet({
      entryTypeIdx: f.objects.propEntry.typeIndex,
      vectorTypeIdx: f.substrate.arguments.carrier.typeIndex,
      undefinedGlobal: tx.physicalIndex(r.values.globals.undefined),
      lookup: tokens.lookup!.handle,
      newVector: f.substrate.arguments.newVector.handle,
      call: observer.handle,
    }),
  );
  const literal = (text: string): Instr[] => [
    global(tx.physicalIndex(keyGlobals[text]!.token)),
    { op: "extern.convert_any" },
  ];
  const prefix: Instr[] = [
    { op: "ref.null", typeIdx: f.objects.object.typeIndex },
    n(8),
    { op: "array.new_default", typeIdx: f.objects.propMap.typeIndex },
    n(0),
    n(0),
    n(128),
    n(0),
  ];
  const state = (prototype: Instr[], foreign = false): Instr[] => [
    ...prototype,
    ...(foreign
      ? ([{ op: "struct.new", typeIdx: f.pack.types.identity.typeIndex }] as Instr[])
      : [global(realm), { op: "ref.as_non_null" }]),
    { op: "struct.new", typeIdx: f.pack.types.state.typeIndex },
  ];
  const native = (id: Instr[], foreign: Instr[], prototype: Instr[], functionHandle = lifted.handle): Instr[] => [
    { op: "ref.func", funcIdx: functionHandle },
    n(23),
    call(r.storage.createNull),
    n(0),
    ...id,
    ...prototype,
    ...foreign,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: f.pack.types.identity.typeIndex } },
      then: [{ op: "struct.new", typeIdx: f.pack.types.identity.typeIndex }],
      else: [global(realm), { op: "ref.as_non_null" }],
    },
    global(tx.physicalIndex(keyGlobals.own!.token)),
    ...(displaced ? ([{ op: "ref.cast", typeIdx: f.strings.layout.anyStrTypeIdx }] as Instr[]) : []),
    { op: "struct.new", typeIdx: nativeType.typeIndex },
    { op: "extern.convert_any" },
  ];
  tx.fillFunction(controls.initialize!, {
    locals: [],
    body: [
      { op: "struct.new", typeIdx: f.pack.types.identity.typeIndex },
      { op: "global.set", index: realm },
      ...prefix,
      { op: "struct.new", typeIdx: f.pack.types.objectPrototype.typeIndex },
      { op: "global.set", index: op },
      ...native([n(metadata.metadata.id)], [n(0)], [global(op), { op: "extern.convert_any" }]),
      { op: "global.set", index: ns },
      global(ns),
      { op: "global.set", index: tx.physicalIndex(f.pack.anchors.functionPrototype) },
    ],
  });
  for (const name of ["ordinary", "foreign"] as const)
    tx.fillFunction(controls[name]!, {
      locals: [],
      body: [
        ...prefix,
        ...state([get(0)], name === "foreign"),
        { op: "struct.new", typeIdx: f.pack.types.ordinary.typeIndex },
        { op: "extern.convert_any" },
      ],
    });
  tx.fillFunction(controls.nativeClone!, { locals: [], body: native([get(0)], [get(1)], [get(2)]) });
  tx.fillFunction(controls.wrongLift!, {
    locals: [],
    body: native(
      [n(metadata.metadata.id)],
      [n(0)],
      [global(op), { op: "extern.convert_any" }],
      controls.callCaptured!.handle,
    ),
  });
  tx.fillFunction(controls.unknownSource!, {
    locals: [],
    body: [
      { op: "ref.func", funcIdx: controls.callCaptured!.handle },
      n(1),
      { op: "ref.null", typeIdx: -17 },
      { op: "struct.new", typeIdx: c.closures.root.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(controls.isUtf8!, {
    locals: [],
    body: displaced
      ? [get(0), { op: "any.convert_extern" }, { op: "ref.test", typeIdx: f.strings.layout.utf8StrTypeIdx }]
      : [n(0)],
  });
  tx.fillFunction(lifted, { locals: [], body: [get(1)] });
  tx.fillFunction(controls.codeUnit!, {
    locals: [{ name: "flat", type: { kind: "ref", typeIdx: f.strings.layout.nativeStrTypeIdx } }],
    body: [
      ...as(0, f.strings.layout.anyStrTypeIdx),
      call(r.flatten.flatten),
      { op: "local.set", index: 2 },
      get(2),
      { op: "struct.get", typeIdx: f.strings.layout.nativeStrTypeIdx, fieldIdx: 2 },
      get(2),
      { op: "struct.get", typeIdx: f.strings.layout.nativeStrTypeIdx, fieldIdx: 1 },
      get(1),
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: f.strings.layout.nativeStrDataTypeIdx },
    ],
  });
  const bag = (local: number): Instr[] => [
    get(local),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: c.closures.root.typeIndex },
    {
      op: "if",
      blockType: { kind: "val", type: ext },
      then: [
        ...as(local, c.closures.root.typeIndex),
        { op: "struct.get", typeIdx: c.closures.root.typeIndex, fieldIdx: 2 },
      ],
      else: [get(local)],
    },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.objects.object.typeIndex },
  ];
  tx.fillFunction(controls.put!, {
    locals: [],
    body: [
      ...bag(0),
      get(1),
      get(2),
      { op: "any.convert_extern" },
      get(3),
      n(0),
      call(r.storage.insert),
      get(3),
      n(128),
      { op: "i32.and" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: empty,
        then: [
          ...bag(0),
          get(1),
          call(r.lookup.findOwn),
          { op: "ref.as_non_null" },
          get(4),
          { op: "any.convert_extern" },
          { op: "struct.set", typeIdx: f.objects.propEntry.typeIndex, fieldIdx: 4 },
        ],
      },
    ],
  });
  tx.fillFunction(controls.flags!, {
    locals: [],
    body: [...bag(0), get(1), { op: "struct.set", typeIdx: f.objects.object.typeIndex, fieldIdx: 4 }],
  });
  tx.fillFunction(controls.corruptParent!, {
    locals: [],
    body: [
      ...as(0, f.pack.types.ordinary.typeIndex),
      { op: "struct.get", typeIdx: f.pack.types.ordinary.typeIndex, fieldIdx: 6 },
      get(1),
      { op: "struct.set", typeIdx: f.pack.types.state.typeIndex, fieldIdx: 0 },
    ],
  });
  tx.fillFunction(controls.fakePrefix!, {
    locals: [],
    body: [
      ...as(0, f.objects.object.typeIndex),
      ...as(1, f.objects.object.typeIndex),
      { op: "struct.set", typeIdx: f.objects.object.typeIndex, fieldIdx: 0 },
    ],
  });
  tx.fillFunction(controls.clearBag!, {
    locals: [],
    body: [
      ...as(0, c.closures.root.typeIndex),
      { op: "ref.null", typeIdx: -17 },
      { op: "struct.set", typeIdx: c.closures.root.typeIndex, fieldIdx: 2 },
    ],
  });
  tx.fillFunction(controls.ownFlags!, {
    locals: [
      { name: "entry", type: { kind: "ref_null", typeIdx: f.objects.propEntry.typeIndex } },
      { name: "status", type: i32 },
    ],
    body: [
      get(0),
      get(1),
      call(tokens.own!),
      { op: "local.set", index: 2 },
      { op: "local.set", index: 3 },
      get(3),
      get(2),
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [n(-1)],
        else: [
          get(2),
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: f.objects.propEntry.typeIndex, fieldIdx: 2 },
        ],
      },
    ],
  });
  const cg = Object.fromEntries(Object.entries(counters).map(([key, token]) => [key, tx.physicalIndex(token)]));
  const keyIs = (text: string): Instr[] => [
    get(0),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: f.strings.layout.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [
        ...as(0, f.strings.layout.anyStrTypeIdx),
        global(tx.physicalIndex(keyGlobals[text]!.token)),
        { op: "ref.eq" },
      ],
      else: [n(0)],
    },
  ];
  tx.fillFunction(observer, {
    locals: [],
    body: [
      global(cg.calls!),
      n(1),
      { op: "i32.add" },
      { op: "global.set", index: cg.calls! },
      get(1),
      { op: "global.set", index: cg.receiver! },
      get(2),
      { op: "struct.get", typeIdx: f.substrate.arguments.carrier.typeIndex, fieldIdx: 0 },
      { op: "global.set", index: cg.argc! },
      ...keyIs("throw"),
      {
        op: "if",
        blockType: empty,
        then: [global(cg.payload!), { op: "throw", tagIdx: tx.physicalIndex(f.exception.tag) }],
      },
      ...keyIs("reenter"),
      {
        op: "if",
        blockType: empty,
        then: [global(cg.nested!), ...literal("own"), get(1), call(tokens.get!), { op: "drop" }, { op: "drop" }],
      },
      get(1),
    ],
  });
  const resolver: IrLowerResolver = {
    ...nativeSourceClosureResolver(tx, c.source!),
    resolveFunc(ref) {
      const slot = ref.binding.kind === "unit" && source.slots.get(ref.binding.unitId);
      if (slot) return slot.handle;
      throw Error("unexpected source callable");
    },
    resolveGlobal() {
      throw Error("unexpected source global");
    },
    resolveType() {
      throw Error("unexpected source type");
    },
    internFuncType(signature) {
      return tx.internFunctionType(signature.params, signature.results);
    },
  };
  for (const [id, slot] of source.slots)
    fillPreparedPrimaryUnit(
      tx,
      f.projection.prepared.functions.find((row) => row.unitId === id)!,
      slot,
      source.signatures.get(id)!,
      resolver,
      "wasmgc",
      c.source,
    );
  const signature = association.entries[0]!.signature;
  tx.fillFunction(controls.callCaptured!, {
    locals: [],
    body: [
      ...as(0, c.closures.root.typeIndex),
      get(1),
      ...as(0, c.closures.root.typeIndex),
      { op: "struct.get", typeIdx: c.closures.root.typeIndex, fieldIdx: 0 },
      { op: "ref.cast", typeIdx: signature.liftedFuncTypeIndex },
      { op: "call_ref", typeIdx: signature.liftedFuncTypeIndex },
    ],
  });
  for (const [name, token] of Object.entries({
    ...controls,
    ...tokens,
    native: nativeSingleton,
    objectPrototype,
    undefined: r.values.globals.undefined,
    stringCreate: r.stringCreate.create,
    newNumber: r.wrappers.allocation.Number,
    newBoolean: r.wrappers.allocation.Boolean,
    symbol: r.symbols.functions.box,
    unbox: r.values.functions.unboxNumber,
    ...Object.fromEntries(source.factories.map((row) => [row.name, row.slot])),
  }))
    tx.defineExport("control:export:" + name, name, token);
  tx.defineExport("control:export:exception", "exception", f.exception.tag);
  requireCompletedNativeSourceClosures(tx, c.source!);
  tx.seal();
  const wasm = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  const api = new WebAssembly.Instance(wasm).exports as Record<string, any>;
  return { r, wasm, api, operands, metadataId: metadata.metadata.id };
}
