// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createEmptyModule } from "../../src/ir/types.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-object-layouts.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
  nativeStringLiteralReservationInventory,
  nativeStringTypeKeys,
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
  requireCompletedNativeStringOwnDescriptors,
} from "../../src/backend/wasmgc/resources/native-string-exotic-own-descriptors.js";
import { buildOrdinaryObjectLookupDefinition } from "../../src/runtime/wasmgc/values/ordinary-object-access-bodies.js";

const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" };
const get = (index: number): Instr => ({ op: "local.get", index });
export const EXOTIC_TEXTS = [
  "",
  "a",
  "😀",
  "é😀\ud800\0",
  "0123456789",
  "ppé😀\ud800\0qq",
  "length",
  "own",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "2147483647",
  "2147483648",
  "4294967294",
  "4294967295",
  "9007199254740991",
  "99999999999",
  "00",
  "01",
  "-0",
  "-1",
  "1.0",
  "1e0",
  "NaN",
  "Infinity",
  " ",
  "１",
  "1\0",
];

/** Real layouts/strings/lookup; no source/frontend preparation or host semantic imports. */
export function stringExoticFixture(utf8 = false, shifted = false, mutablePlan = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const prefix = shifted ? tx.reserveFunction("prefix:function", "prefix", { params: [], results: [] }) : undefined;
  const prefixGlobal = shifted ? tx.reserveGlobal("prefix:global", "prefix", i32, false) : undefined;
  if (shifted) {
    tx.reserveType("prefix:type", { kind: "struct", name: "Prefix", fields: [] });
  }
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: utf8,
    literals: [...EXOTIC_TEXTS.map((value) => ({ value })), { value: "ppé😀\ud800\0qq", encoding: "wtf16" as const }],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "flatten", strings);
  const equality = reserveNativeStringEqualityResources(tx, "equality", flatten, true);
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const objectPlan = declareNativeObjectLayouts({ key: "objects", extensible: true });
  const objects = reserveNativeObjectLayouts(tx, { key: "objects", extensible: true }, objectPlan);
  const lookupDependencies = { layouts: objects, layoutPlan: objectPlan, strings, flatten, equality, symbols };
  const lookup = reserveNativeObjectLookupResources(
    tx,
    "lookup",
    lookupDependencies,
    declareNativeObjectLookupResources("lookup", {
      object: objects.object.key,
      propEntry: objects.propEntry.key,
      nativeString: "strings:flat",
    }),
  );
  const storageDependencies = { lookup, lookupDependencies };
  const storage = reserveNativeObjectStorageResources(
    tx,
    "storage",
    storageDependencies,
    declareNativeObjectStorageResources("storage", objects.object.key),
  );
  const layoutDependencies = { objects, objectPlan, strings, symbols };
  const layoutPlan = declareNativePrimitiveWrapperLayouts("wrappers", {
    object: objects.object.key,
    propMap: objects.propMap.key,
    anyString: "strings:any",
    symbol: symbols.types.symbol.key,
  });
  const layouts = reserveNativePrimitiveWrapperLayouts(tx, "wrappers", layoutPlan, layoutDependencies);
  const wrapperDependencies = { layouts, layoutPlan, layoutDependencies };
  const wrapperPlan = declareNativePrimitiveWrapperStorageResources(
    "wrapper-storage",
    { anyString: "strings:any", symbol: symbols.types.symbol.key },
    8,
  );
  const wrappers = reserveNativePrimitiveWrapperStorageResources(
    tx,
    "wrapper-storage",
    wrapperPlan,
    wrapperDependencies,
  );
  const dependencies = { layouts, layoutPlan, layoutDependencies, lookup, lookupDependencies };
  const declared = declareNativeStringOwnDescriptorResources("exotic", {
    object: objects.object.key,
    propEntry: objects.propEntry.key,
  });
  const plan = mutablePlan ? structuredClone(declared) : declared;
  const pack = reserveNativeStringOwnDescriptorResources(tx, "exotic", plan, dependencies);
  const inventory = nativeStringLiteralReservationInventory(tx, strings),
    keys = nativeStringTypeKeys("strings");
  const type = (key: string) => inventory.typePack.types.find((row) => row.key === key)!.typeIndex;
  return {
    module,
    tx,
    prefix,
    prefixGlobal,
    shifted,
    strings,
    flatten,
    equality,
    symbols,
    objectPlan,
    objects,
    lookupDependencies,
    lookup,
    storage,
    storageDependencies,
    layouts,
    layoutPlan,
    layoutDependencies,
    wrapperPlan,
    wrapperDependencies,
    wrappers,
    dependencies,
    plan,
    pack,
    anyString: type(keys.any),
    flatString: type(keys.flat),
    consString: type(keys.cons),
    dataString: type(keys.data),
  };
}
export type StringExoticFixture = ReturnType<typeof stringExoticFixture>;
export function fillStringExoticDependencies(f: StringExoticFixture): void {
  if (f.prefix) f.tx.fillFunction(f.prefix, { locals: [], body: [] });
  if (f.prefixGlobal) f.tx.fillGlobal(f.prefixGlobal, [{ op: "i32.const", value: 123 }]);
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeStringFlattenResources(f.tx, f.flatten);
  fillNativeStringEqualityResources(f.tx, f.equality);
  fillNativeSymbolCarrierResources(f.tx, f.symbols);
  fillNativeObjectLookupResources(f.tx, f.lookup);
  fillNativeObjectStorageResources(f.tx, f.storage);
  fillNativePrimitiveWrapperStorageResources(f.tx, f.wrappers);
}
export function completeStringExoticFixture(f = stringExoticFixture()) {
  f.tx.freezeReservations();
  fillStringExoticDependencies(f);
  fillNativeStringOwnDescriptorResources(f.tx, f.pack);
  requireCompletedNativeStringOwnDescriptors(f.tx, f.pack, f.dependencies);
  return f;
}
export interface StringExoticRuntime {
  text(index: number): object;
  createRoot(): object;
  createWithPrototype(proto: object): object;
  make(proto: object, payload: object): object;
  payload(wrapper: object): object;
  boolean(proto: object): object;
  symbol(): object;
  arrayIndex(key: unknown): bigint;
  own(object: object, key: unknown): [number, unknown];
  inherited(object: object, key: unknown): [number, unknown];
  put(object: object, key: object, value: unknown, flags: number, sequence: number): void;
  count(object: object): number;
  codeUnit(string: unknown, index: number): number;
  length(string: unknown): number;
  rope(left: object, right: object): object;
  slice(): object;
}
export function stringExoticRuntime(utf8 = false, shifted = false) {
  const f = stringExoticFixture(utf8, shifted),
    { tx } = f;
  const objectRef: ValType = { kind: "ref", typeIdx: f.objects.object.typeIndex };
  const lookup = tx.reserveFunction("observer:lookup", "observer_lookup", {
    params: [objectRef, ext],
    results: [i32, { kind: "ref_null", typeIdx: f.objects.propEntry.typeIndex }],
  });
  const signatures: Record<string, { params: ValType[]; results: ValType[] }> = {
    text: { params: [i32], results: [ext] },
    make: { params: [ext, ext], results: [ext] },
    payload: { params: [ext], results: [ext] },
    boolean: { params: [ext], results: [ext] },
    symbol: { params: [], results: [ext] },
    createWithPrototype: { params: [ext], results: [ext] },
    put: { params: [ext, ext, ext, i32, i32], results: [] },
    own: { params: [ext, ext], results: [i32, ext] },
    inherited: { params: [ext, ext], results: [i32, ext] },
    count: { params: [ext], results: [i32] },
    codeUnit: { params: [ext, i32], results: [i32] },
    length: { params: [ext], results: [i32] },
    rope: { params: [ext, ext], results: [ext] },
    slice: { params: [], results: [ext] },
  };
  const observers = Object.fromEntries(
    Object.entries(signatures).map(([name, signature]) => [
      name,
      tx.reserveFunction("observer:" + name, name, signature),
    ]),
  );
  tx.freezeReservations();
  fillStringExoticDependencies(f);
  fillNativeStringOwnDescriptorResources(tx, f.pack);
  requireCompletedNativeStringOwnDescriptors(tx, f.pack, f.dependencies);
  const object = (index: number): Instr[] => [
    get(index),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.objects.object.typeIndex },
  ];
  const string = (index: number): Instr[] => [
    get(index),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.anyString },
  ];
  const literal = (value: string, encoding?: "wtf16"): Instr[] => {
    const binding = requireNativeStringLiteral(tx, f.strings, value, encoding);
    return binding.kind === "global"
      ? [{ op: "global.get", index: tx.physicalIndex(binding.global) }]
      : [{ op: "call", funcIdx: binding.function.handle }];
  };
  tx.fillFunction(
    lookup,
    buildOrdinaryObjectLookupDefinition({
      objectTypeIdx: f.objects.object.typeIndex,
      propEntryTypeIdx: f.objects.propEntry.typeIndex,
      findOwnIdx: f.pack.findOwn.handle,
    }),
  );
  tx.fillFunction(observers.text!, {
    locals: [],
    body: [
      ...EXOTIC_TEXTS.flatMap((text, index): Instr[] => [
        get(0),
        { op: "i32.const", value: index },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...literal(text), { op: "extern.convert_any" }, { op: "return" }],
        },
      ]),
      { op: "unreachable" },
    ],
  });
  tx.fillFunction(observers.make!, {
    locals: [],
    body: [get(0), ...string(1), { op: "call", funcIdx: f.wrappers.allocation.String.handle }],
  });
  tx.fillFunction(observers.payload!, {
    locals: [],
    body: [get(0), { op: "call", funcIdx: f.wrappers.read.String.handle }, { op: "extern.convert_any" }],
  });
  tx.fillFunction(observers.boolean!, {
    locals: [],
    body: [get(0), { op: "i32.const", value: 1 }, { op: "call", funcIdx: f.wrappers.allocation.Boolean.handle }],
  });
  tx.fillFunction(observers.symbol!, {
    locals: [],
    body: [
      { op: "i32.const", value: 32 },
      { op: "call", funcIdx: f.symbols.functions.box.handle },
    ],
  });
  tx.fillFunction(observers.createWithPrototype!, {
    locals: [],
    body: [...object(0), { op: "call", funcIdx: f.storage.createWithPrototype.handle }],
  });
  tx.fillFunction(observers.put!, {
    locals: [],
    body: [
      ...object(0),
      get(1),
      get(2),
      { op: "any.convert_extern" },
      get(3),
      get(4),
      { op: "call", funcIdx: f.storage.insert.handle },
    ],
  });
  for (const role of ["own", "inherited"] as const) {
    const entry = 2,
      status = 3;
    tx.fillFunction(observers[role]!, {
      locals: [
        { name: "entry", type: { kind: "ref_null", typeIdx: f.objects.propEntry.typeIndex } },
        { name: "status", type: i32 },
      ],
      body: [
        ...object(0),
        get(1),
        { op: "call", funcIdx: role === "own" ? f.pack.findOwn.handle : lookup.handle },
        { op: "local.set", index: entry },
        ...(role === "inherited" ? [{ op: "local.set", index: status } as Instr] : []),
        get(entry),
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: -1 }, { op: "ref.null.extern" }, { op: "return" }],
        },
        get(entry),
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: f.objects.propEntry.typeIndex, fieldIdx: 2 },
        get(entry),
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: f.objects.propEntry.typeIndex, fieldIdx: 1 },
        { op: "extern.convert_any" },
      ],
    });
  }
  tx.fillFunction(observers.count!, {
    locals: [],
    body: [...object(0), { op: "struct.get", typeIdx: f.objects.object.typeIndex, fieldIdx: 2 }],
  });
  tx.fillFunction(observers.length!, {
    locals: [],
    body: [...string(0), { op: "struct.get", typeIdx: f.anyString, fieldIdx: 0 }],
  });
  tx.fillFunction(observers.codeUnit!, {
    locals: [{ name: "flat", type: { kind: "ref", typeIdx: f.flatString } }],
    body: [
      ...string(0),
      { op: "call", funcIdx: f.flatten.flatten.handle },
      { op: "local.set", index: 2 },
      get(2),
      { op: "struct.get", typeIdx: f.flatString, fieldIdx: 2 },
      get(2),
      { op: "struct.get", typeIdx: f.flatString, fieldIdx: 1 },
      get(1),
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: f.dataString },
    ],
  });
  tx.fillFunction(observers.rope!, {
    locals: [],
    body: [
      ...string(0),
      { op: "struct.get", typeIdx: f.anyString, fieldIdx: 0 },
      ...string(1),
      { op: "struct.get", typeIdx: f.anyString, fieldIdx: 0 },
      { op: "i32.add" },
      ...string(0),
      ...string(1),
      { op: "struct.new", typeIdx: f.consString },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(observers.slice!, {
    locals: [],
    body: [
      { op: "i32.const", value: 5 },
      { op: "i32.const", value: 2 },
      ...literal("ppé😀\ud800\0qq", "wtf16"),
      { op: "struct.get", typeIdx: f.flatString, fieldIdx: 2 },
      { op: "struct.new", typeIdx: f.flatString },
      { op: "extern.convert_any" },
    ],
  });
  for (const [name, token] of Object.entries({
    ...observers,
    arrayIndex: f.pack.arrayIndex,
    createRoot: f.storage.createNull,
  }))
    tx.defineExport("export:" + name, name, token);
  const bytes = emitBinary(f.module),
    module = new WebAssembly.Module(bytes as BufferSource);
  if (WebAssembly.Module.imports(module).length) throw Error("String exotic fixture has host imports");
  return { fixture: f, bytes, runtime: new WebAssembly.Instance(module).exports as unknown as StringExoticRuntime };
}
