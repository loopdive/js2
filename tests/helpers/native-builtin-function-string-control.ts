// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { builtinFunctionFixture } from "./native-builtin-functions.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-object-layouts.js";
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
  declareNativeStringOwnDescriptorResources,
  reserveNativeStringOwnDescriptorResources,
  fillNativeStringOwnDescriptorResources,
} from "../../src/backend/wasmgc/resources/native-string-exotic-own-descriptors.js";
import {
  declareNativeStringCreateResources,
  reserveNativeStringCreateResources,
  fillNativeStringCreateResources,
  requireCompletedNativeStringCreate,
} from "../../src/backend/wasmgc/resources/native-string-create.js";

type Fixture = ReturnType<typeof builtinFunctionFixture>;
const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" };
const get = (index: number): Instr => ({ op: "local.get", index });
/** Genuine same-ledger StringCreate, kept outside the builtin intrinsic catalog. */
export function reserveBuiltinStringControl(f: Fixture, reuseStorage = false) {
  const key = "test-string-control",
    { tx } = f;
  const objectRequirements = { key: key + ":objects", extensible: true as const };
  const objectPlan = reuseStorage ? f.lookupDependencies.layoutPlan : declareNativeObjectLayouts(objectRequirements);
  const objects = reuseStorage ? f.layouts : reserveNativeObjectLayouts(tx, objectRequirements, objectPlan);
  const lookupDependencies = reuseStorage
    ? f.lookupDependencies
    : {
        ...f.lookupDependencies,
        layouts: objects,
        layoutPlan: objectPlan,
      };
  const nativeString = f.strings.types.find((row) => row.typeIndex === f.strings.layout.nativeStrTypeIdx)!;
  const anyString = f.strings.types.find((row) => row.typeIndex === f.strings.layout.anyStrTypeIdx)!;
  const lookup = reuseStorage
    ? f.lookup
    : reserveNativeObjectLookupResources(
        tx,
        key + ":lookup",
        lookupDependencies,
        declareNativeObjectLookupResources(key + ":lookup", {
          object: objects.object.key,
          propEntry: objects.propEntry.key,
          nativeString: nativeString.key,
        }),
      );
  const storageDependencies = reuseStorage ? f.storageDependencies : { lookup, lookupDependencies };
  const storage = reuseStorage
    ? f.storage
    : reserveNativeObjectStorageResources(
        tx,
        key + ":storage",
        storageDependencies,
        declareNativeObjectStorageResources(key + ":storage", objects.object.key),
      );
  const layoutDependencies = { objects, objectPlan, strings: f.strings, symbols: f.symbols };
  const layoutPlan = declareNativePrimitiveWrapperLayouts(key + ":wrappers", {
    object: objects.object.key,
    propMap: objects.propMap.key,
    anyString: anyString.key,
    symbol: f.symbols.types.symbol.key,
  });
  const layouts = reserveNativePrimitiveWrapperLayouts(tx, key + ":wrappers", layoutPlan, layoutDependencies);
  const ownDependencies = { layouts, layoutPlan, layoutDependencies, lookup, lookupDependencies };
  const ownPlan = declareNativeStringOwnDescriptorResources(key + ":own", {
    object: objects.object.key,
    propEntry: objects.propEntry.key,
  });
  const own = reserveNativeStringOwnDescriptorResources(tx, key + ":own", ownPlan, ownDependencies);
  const createDependencies = {
    layouts,
    layoutPlan,
    layoutDependencies,
    storage,
    storageDependencies,
    values: f.values,
    valuePlan: f.valuePlan,
    valueDependencies: f.valueDependencies,
    ownDescriptors: own,
    ownDescriptorDependencies: ownDependencies,
  };
  const create = reserveNativeStringCreateResources(
    tx,
    key + ":create",
    declareNativeStringCreateResources(key + ":create", anyString.key, 2),
    createDependencies,
  );
  const signatures = {
    stringMake: { params: [ext, ext], results: [ext] },
    stringOwnHas: { params: [ext, ext], results: [i32] },
    stringStoredHas: { params: [ext, ext], results: [i32] },
    stringOwnValue: { params: [ext, ext], results: [ext] },
  };
  const observers = Object.fromEntries(
    Object.entries(signatures).map(([name, signature]) => [
      name,
      tx.reserveFunction(key + ":" + name, name, signature),
    ]),
  );
  return {
    reuseStorage,
    lookup,
    storage,
    objects,
    anyString,
    own,
    ownDependencies,
    create,
    createDependencies,
    observers,
  };
}
export function fillBuiltinStringControl(f: Fixture, p: ReturnType<typeof reserveBuiltinStringControl>) {
  const { tx } = f;
  if (!p.reuseStorage) {
    fillNativeObjectLookupResources(tx, p.lookup);
    fillNativeObjectStorageResources(tx, p.storage);
  }
  fillNativeStringOwnDescriptorResources(tx, p.own);
  fillNativeStringCreateResources(tx, p.create);
  requireCompletedNativeStringCreate(tx, p.create, p.createDependencies);
  const cast = (index: number, typeIdx: number): Instr[] => [
    get(index),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx },
  ];
  const body = (name: string, instructions: Instr[]) =>
    tx.fillFunction(p.observers[name]!, { locals: [], body: instructions });
  body("stringMake", [get(0), ...cast(1, p.anyString.typeIndex), { op: "call", funcIdx: p.create.create.handle }]);
  for (const [name, token] of [
    ["stringOwnHas", p.own.findOwn],
    ["stringStoredHas", p.lookup.findOwn],
  ] as const) {
    body(name, [
      ...cast(0, p.objects.object.typeIndex),
      get(1),
      { op: "call", funcIdx: token.handle },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
    ]);
  }
  body("stringOwnValue", [
    ...cast(0, p.objects.object.typeIndex),
    get(1),
    { op: "call", funcIdx: p.own.findOwn.handle },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: p.objects.propEntry.typeIndex, fieldIdx: 1 },
    { op: "extern.convert_any" },
  ]);
  for (const [name, token] of Object.entries(p.observers)) tx.defineExport("export:" + name, name, token);
  tx.defineExport("export:stringSameValue", "stringSameValue", f.sameValue.sameValue);
}
