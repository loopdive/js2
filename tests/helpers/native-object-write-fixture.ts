// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createEmptyModule } from "../../src/ir/types.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { Instr, LocalDef, ValType } from "../../src/wasm/model/instructions.js";
import { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-object-layouts.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../../src/backend/wasmgc/resources/native-string-literals.js";
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
  requireCompletedNativeObjectStorage,
} from "../../src/backend/wasmgc/resources/native-object-storage.js";
import { buildOrdinaryObjectDataDescriptorBody } from "../../src/runtime/wasmgc/values/ordinary-object-descriptor-data.js";
import { buildOrdinaryObjectAccessorDescriptorBody } from "../../src/runtime/wasmgc/values/ordinary-object-descriptor-accessor.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "../../src/runtime/wasmgc/values/ordinary-object-descriptor-common.js";
import { buildObjectSameValueBody } from "../../src/runtime/wasmgc/values/object-same-value-body.js";
import { buildOrdinaryObjectGetDefinition } from "../../src/runtime/wasmgc/values/ordinary-object-access-bodies.js";
import { buildAnyValueType, buildUndefinedInitializer } from "../../src/runtime/wasmgc/values/primitive-layouts.js";
import { buildOrdinaryObjectGrowDefinition } from "../../src/runtime/wasmgc/values/ordinary-object-storage-definitions.js";
import {
  reserveNativeClosureResources,
  requireNativeClosureReservations,
} from "../../src/backend/wasmgc/resources/native-closures.js";
import { buildBuiltinClosureValueInstrs } from "../../src/runtime/wasmgc/values/closure-layouts.js";

const extern: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" },
  f64: ValType = { kind: "f64" };
export function objectStorageFixture(offset = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  if (offset) {
    tx.reserveType("prefix:type", { kind: "struct", name: "Prefix", fields: [] });
    tx.reserveFunctionImport("prefix:function", "prefix", "unused", { params: [], results: [] });
    tx.reserveGlobalImport("prefix:global", "prefix", "number", i32, false);
  }
  // Explicit controls for detached descriptor/SameValue recipes, not issued provider authority.
  const control = Object.fromEntries(
    [
      ["isNumber", [extern], [i32]],
      ["isBoolean", [extern], [i32]],
      ["isBigInt", [extern], [i32]],
      ["number", [extern], [f64]],
      ["boolean", [extern], [i32]],
      ["bigint", [extern], [{ kind: "i64" }]],
      ["message", [i32], [extern]],
      ["error", [extern], [extern]],
      ["method0", [extern, extern], [extern]],
    ].map(([name, params, results]) => [
      name,
      tx.reserveFunctionImport("control:" + name, "control", name as string, {
        params: params as ValType[],
        results: results as ValType[],
      }),
    ]),
  );
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: offset,
    literals: [
      { value: "", encoding: "wtf16" },
      ...Array.from({ length: 20 }, (_, i) => ({ value: "k" + i, encoding: "wtf16" as const })),
    ],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "flatten", strings);
  const equality = reserveNativeStringEqualityResources(tx, "equality", flatten, true);
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const layoutRequirements = { key: "objects" },
    layoutPlan = declareNativeObjectLayouts(layoutRequirements);
  const layouts = reserveNativeObjectLayouts(tx, layoutRequirements, layoutPlan);
  const lookupDependencies = { layouts, layoutPlan, strings, flatten, equality, symbols };
  const lookupPlan = declareNativeObjectLookupResources("lookup", {
    object: layouts.object.key,
    propEntry: layouts.propEntry.key,
    nativeString: "strings:flat",
  });
  const lookup = reserveNativeObjectLookupResources(tx, "lookup", lookupDependencies, lookupPlan);
  const dependencies = { lookup, lookupDependencies };
  const plan = declareNativeObjectStorageResources("storage", layouts.object.key);
  const pack = reserveNativeObjectStorageResources(tx, "storage", dependencies, plan);
  return {
    module,
    tx,
    control,
    strings,
    flatten,
    equality,
    symbols,
    layouts,
    lookup,
    lookupDependencies,
    dependencies,
    plan,
    pack,
  };
}
export function fillStorageDependencies(f: ReturnType<typeof objectStorageFixture>) {
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeStringFlattenResources(f.tx, f.flatten);
  fillNativeStringEqualityResources(f.tx, f.equality);
  fillNativeSymbolCarrierResources(f.tx, f.symbols);
  fillNativeObjectLookupResources(f.tx, f.lookup);
}
export interface ObjectWriteRuntime {
  createDefault(): object;
  createNull(): object;
  createWithPrototype(proto: object | null): object;
  insert(object: object, key: object, value: unknown, flags: number, seq: number): void;
  grow(object: object): void;
  data(object: object, key: object, value: unknown, flags: number): object;
  accessor(object: object, key: object, get: unknown, set: unknown, flags: number): object;
  has(object: object, key: object): number;
  get(object: object, key: object, receiver: unknown): [number, unknown];
  entry(object: object, key: object): [number, number, unknown, unknown, unknown];
  stats(object: object): [number, number, number, number, number];
  flags(object: object, flags: number): void;
  tombstone(object: object, key: object): void;
  key(index: number): object;
  symbol(id: number): object;
  undefinedValue(): object;
  sameValue(a: unknown, b: unknown): number;
  closure(): object;
  invokeClosure(value: object): number;
}

/** Actual issued storage/read owners; detached descriptor recipes have labelled controlled dependencies. */
export function objectWriteRuntime(
  offset = false,
  method0: (receiver: unknown, callee: unknown) => unknown = () => {
    throw Error("unexpected getter");
  },
  mutateGrow?: (body: Instr[]) => Instr[],
) {
  const f = objectStorageFixture(offset),
    { tx, pack, lookup, layouts, strings, control } = f;
  const tag = tx.reserveTag("control:tag", { params: [extern], results: [] }, { kind: "defined", name: "error" });
  const any = tx.reserveType("control:any", buildAnyValueType());
  const undef = tx.reserveGlobal("control:undefined", "undefined", { kind: "ref", typeIdx: any.typeIndex }, false);
  const sameValue = tx.reserveFunction("control:same-value", "sameValue", { params: [extern, extern], results: [i32] });
  const getBody = tx.reserveFunction("control:get-body", "get_body", {
    params: [{ kind: "ref", typeIdx: layouts.object.typeIndex }, extern, extern],
    results: [i32, extern],
  });
  // These are actual issued native carriers for the native SameValue identity
  // controls. They grant no source-closure or generic invocation authority.
  const closures = reserveNativeClosureResources(tx, {
    key: "control:closures",
    startingClosureCounter: 0,
    referenceTypes: [],
    requests: [{ kind: "signature", id: "getter", params: [], results: [f64], allocationMode: "ordinary" }],
  });
  const getter = closures.signatures[0]!.binding;
  const getterTarget = tx.reserveFunction("control:getter-target", "getterTarget", {
    params: [{ kind: "ref", typeIdx: closures.root.typeIndex }],
    results: [f64],
  });
  const signatures: Record<string, [ValType[], ValType[]]> = {
    createWithPrototype: [[extern], [extern]],
    insert: [[extern, extern, extern, i32, i32], []],
    grow: [[extern], []],
    data: [[extern, extern, extern, f64], [extern]],
    accessor: [[extern, extern, extern, extern, f64], [extern]],
    has: [[extern, extern], [i32]],
    get: [
      [extern, extern, extern],
      [i32, extern],
    ],
    entry: [
      [extern, extern],
      [i32, i32, extern, extern, extern],
    ],
    stats: [[extern], [i32, i32, i32, i32, i32]],
    flags: [[extern, i32], []],
    tombstone: [[extern, extern], []],
    undefinedValue: [[], [extern]],
    closure: [[], [extern]],
    invokeClosure: [[extern], [f64]],
  };
  const wrappers = Object.fromEntries(
    Object.entries(signatures).map(([name, [params, results]]) => [
      name,
      tx.reserveFunction("control:export:" + name, name, { params, results }),
    ]),
  );
  const keys = Array.from({ length: 20 }, (_, i) =>
    tx.reserveFunction("control:key:" + i, "key" + i, { params: [], results: [extern] }),
  );
  const detachedGrow = mutateGrow
    ? tx.reserveFunction("control:mutant-grow", "mutantGrow", {
        params: [{ kind: "ref", typeIdx: layouts.object.typeIndex }],
        results: [],
      })
    : undefined;
  tx.freezeReservations();
  requireNativeClosureReservations(tx, closures);
  tx.fillFunction(getterTarget, { locals: [], body: [{ op: "f64.const", value: 1 }] });
  tx.declareFunctionReference(getterTarget);
  fillStorageDependencies(f);
  fillNativeObjectStorageResources(tx, pack);
  requireCompletedNativeObjectStorage(tx, pack, f.dependencies);
  if (mutateGrow && detachedGrow) {
    const definition = buildOrdinaryObjectGrowDefinition({
      objectTypeIdx: layouts.object.typeIndex,
      propMapTypeIdx: layouts.propMap.typeIndex,
      propEntryTypeIdx: layouts.propEntry.typeIndex,
      objInsertIdx: pack.insert.handle,
      objFindIdx: lookup.findOwn.handle,
      tombstoneFlag: 128,
      accessorFlag: 8,
    });
    tx.fillFunction(detachedGrow, { ...definition, body: mutateGrow(definition.body) });
  }
  tx.fillGlobal(undef, buildUndefinedInitializer(any.typeIndex));
  tx.fillFunction(sameValue, {
    locals: [
      { name: "aa", type: { kind: "anyref" } },
      { name: "ba", type: { kind: "anyref" } },
    ],
    body: buildObjectSameValueBody({
      typeofNumIdx: control.isNumber!.handle,
      typeofBoolIdx: control.isBoolean!.handle,
      typeofBigIdx: control.isBigInt!.handle,
      unboxNumIdx: control.number!.handle,
      unboxBoolIdx: control.boolean!.handle,
      // This controlled historical fixture preserves the original i64 donor branch.
      bigint: { kind: "legacy-i64", toBigIdx: control.bigint!.handle },
      anyStrTypeIdx: strings.layout.anyStrTypeIdx,
      strFlattenIdx: f.flatten.flatten.handle,
      strEqualsIdx: f.equality.equals.handle,
    }),
  });
  const object = (index: number, nullable = false): Instr[] => [
    { op: "local.get", index },
    { op: "any.convert_extern" },
    { op: nullable ? "ref.cast_null" : "ref.cast", typeIdx: layouts.object.typeIndex },
  ];
  const find = (): Instr[] => [
    ...object(0),
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: lookup.findOwn.handle },
    { op: "ref.as_non_null" },
  ];
  const fill = (name: string, body: Instr[], locals: LocalDef[] = []) =>
    tx.fillFunction(wrappers[name]!, { locals, body });
  fill("closure", [
    ...buildBuiltinClosureValueInstrs(getter.type.typeIndex, getterTarget.handle, 0, false),
    { op: "extern.convert_any" },
  ]);
  const closureReceiver = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: closures.root.typeIndex },
  ];
  fill("invokeClosure", [
    ...closureReceiver(),
    ...closureReceiver(),
    { op: "struct.get", typeIdx: closures.root.typeIndex, fieldIdx: 0 },
    { op: "ref.cast", typeIdx: getter.liftedFuncTypeIndex },
    { op: "call_ref", typeIdx: getter.liftedFuncTypeIndex },
  ]);
  fill("createWithPrototype", [...object(0, true), { op: "call", funcIdx: pack.createWithPrototype.handle }]);
  fill("insert", [
    ...object(0),
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "any.convert_extern" },
    { op: "local.get", index: 3 },
    { op: "local.get", index: 4 },
    { op: "call", funcIdx: pack.insert.handle },
  ]);
  fill("grow", [...object(0), { op: "call", funcIdx: (detachedGrow ?? pack.grow).handle }]);
  const errors = (count: number) => ({
    constructorIdx: control.error!.handle,
    tagIdx: tx.physicalIndex(tag),
    messages: Array.from({ length: count }, (_, i): Instr[] => [
      { op: "i32.const", value: i },
      { op: "call", funcIdx: control.message!.handle },
    ]),
  });
  const descriptor = {
    objectTypeIdx: layouts.object.typeIndex,
    propEntryTypeIdx: layouts.propEntry.typeIndex,
    objFindIdx: lookup.findOwn.handle,
    objInsertIdx: pack.insert.handle,
    objGrowIdx: pack.grow.handle,
    sameValueIdx: sameValue.handle,
    flags: ORDINARY_OBJECT_DESCRIPTOR_ENCODING,
  };
  const dataLocals: LocalDef[] = [
    { name: "o", type: { kind: "ref_null", typeIdx: layouts.object.typeIndex } },
    { name: "any", type: { kind: "anyref" } },
    ...["cap", "load", "nflags", "hf", "seq"].map((name) => ({ name, type: i32 })),
    { name: "e", type: { kind: "ref_null", typeIdx: layouts.propEntry.typeIndex } },
    { name: "efl", type: i32 },
  ];
  fill(
    "data",
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 5 },
      // This historical donor harness retains the original null-slot behavior.
      ...buildOrdinaryObjectDataDescriptorBody({ ...descriptor, errors: errors(6) }, [
        { op: "ref.null", typeIdx: descriptor.flags.noneHeap },
      ]),
    ],
    dataLocals,
  );
  fill(
    "accessor",
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 6 },
      ...buildOrdinaryObjectAccessorDescriptorBody({
        ...descriptor,
        errors: errors(5),
        nonExtensible: { ownKeyIdx: undefined, errors: errors(1) },
      }),
    ],
    [...structuredClone(dataLocals), { name: "getSpec", type: i32 }, { name: "setSpec", type: i32 }],
  );
  fill("has", [...object(0), { op: "local.get", index: 1 }, { op: "call", funcIdx: lookup.has.handle }]);
  tx.fillFunction(
    getBody,
    buildOrdinaryObjectGetDefinition({
      propEntryTypeIdx: layouts.propEntry.typeIndex,
      lookupIdx: lookup.lookup.handle,
      getterDispatchIdx: control.method0!.handle,
      undefinedGlobalIdx: tx.physicalIndex(undef),
    }),
  );
  fill("get", [
    ...object(0),
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: getBody.handle },
  ]);
  fill(
    "entry",
    [2, 3, 1, 4, 5].flatMap((fieldIdx): Instr[] => [
      ...find(),
      { op: "struct.get", typeIdx: layouts.propEntry.typeIndex, fieldIdx },
      ...(fieldIdx === 2 || fieldIdx === 3 ? [] : [{ op: "extern.convert_any" } as Instr]),
    ]),
  );
  fill(
    "stats",
    [2, 3, 4, 5, 1].flatMap((fieldIdx): Instr[] => [
      ...object(0),
      { op: "struct.get", typeIdx: layouts.object.typeIndex, fieldIdx },
      ...(fieldIdx === 1 ? [{ op: "array.len" } as Instr] : []),
    ]),
  );
  fill("flags", [
    ...object(0),
    { op: "local.get", index: 1 },
    { op: "struct.set", typeIdx: layouts.object.typeIndex, fieldIdx: 4 },
  ]);
  fill("tombstone", [
    ...find(),
    { op: "i32.const", value: 128 },
    { op: "struct.set", typeIdx: layouts.propEntry.typeIndex, fieldIdx: 2 },
    ...object(0),
    ...object(0),
    { op: "struct.get", typeIdx: layouts.object.typeIndex, fieldIdx: 2 },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "struct.set", typeIdx: layouts.object.typeIndex, fieldIdx: 2 },
    ...object(0),
    ...object(0),
    { op: "struct.get", typeIdx: layouts.object.typeIndex, fieldIdx: 3 },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "struct.set", typeIdx: layouts.object.typeIndex, fieldIdx: 3 },
  ]);
  fill("undefinedValue", [{ op: "global.get", index: tx.physicalIndex(undef) }, { op: "extern.convert_any" }]);
  keys.forEach((token, i) => {
    const key = requireNativeStringLiteral(tx, strings, "k" + i, "wtf16");
    if (key.kind !== "global") throw Error("expected literal global");
    tx.fillFunction(token, {
      locals: [],
      body: [{ op: "global.get", index: tx.physicalIndex(key.global) }, { op: "extern.convert_any" }],
    });
  });
  for (const token of [...Object.values(wrappers), ...keys, sameValue, pack.createDefault, pack.createNull])
    tx.defineExport(
      "export:" + token.key,
      token === pack.createDefault ? "createDefault" : token === pack.createNull ? "createNull" : token.object.name!,
      token,
    );
  tx.defineExport("export:symbol", "symbol", f.symbols.functions.box);
  tx.defineExport("export:error-tag", "errorTag", tag);
  tx.seal();
  const errorValues: TypeError[] = [];
  const imports = {
    prefix: { unused: () => {}, number: 17 },
    control: {
      isNumber: (v: unknown) => +(typeof v === "number"),
      isBoolean: (v: unknown) => +(typeof v === "boolean"),
      isBigInt: (v: unknown) => +(typeof v === "bigint"),
      number: (v: number) => v,
      boolean: (v: boolean) => +v,
      bigint: (v: bigint) => v,
      message: (i: number) => "descriptor error " + i,
      error: (message: string) => {
        const value = new TypeError(message);
        errorValues.push(value);
        return value;
      },
      method0,
    },
  };
  const bytes = emitBinary(f.module),
    exports = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports).exports;
  const runtime = {
    ...exports,
    key: (index: number) => (exports["key" + index] as () => object)(),
  } as unknown as ObjectWriteRuntime;
  return { ...f, bytes, runtime, errorValues };
}
