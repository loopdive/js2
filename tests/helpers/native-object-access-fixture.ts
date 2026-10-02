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
  requireCompletedNativeObjectLookup,
} from "../../src/backend/wasmgc/resources/native-object-access.js";
import { buildAnyValueType, buildUndefinedInitializer } from "../../src/runtime/wasmgc/values/primitive-layouts.js";
import { buildOrdinaryObjectGetDefinition } from "../../src/runtime/wasmgc/values/ordinary-object-access-bodies.js";

export const KEY_TEXTS = ["", "own", "missing", "ab", "!ab!", "0", "\ud800", "😀"];
export function objectLookupFixture(offset = false, utf8 = false, withControlledGet = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  if (offset) {
    tx.reserveType("prefix:type", { kind: "struct", name: "Prefix", fields: [] });
    tx.reserveFunctionImport("prefix:function", "prefix", "unused", { params: [], results: [] });
    tx.reserveGlobalImport("prefix:global", "prefix", "number", { kind: "i32" }, false);
  }
  // This import is a controlled pure-body operand, never a fabricated invocation pack.
  const dispatcher = withControlledGet
    ? tx.reserveFunctionImport("control:method0", "control", "method0", {
        params: [{ kind: "externref" }, { kind: "externref" }],
        results: [{ kind: "externref" }],
      })
    : undefined;
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: utf8,
    literals: KEY_TEXTS.map((value) => ({ value, encoding: "wtf16" as const })),
  });
  const flatten = reserveNativeStringFlattenResources(tx, "flatten", strings);
  const equality = reserveNativeStringEqualityResources(tx, "equality", flatten, true);
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const layoutRequirements = { key: "objects" },
    layoutPlan = declareNativeObjectLayouts(layoutRequirements);
  const layouts = reserveNativeObjectLayouts(tx, layoutRequirements, layoutPlan);
  const dependencies = { layouts, layoutPlan, strings, flatten, equality, symbols };
  const plan = declareNativeObjectLookupResources("reads", {
    object: layouts.object.key,
    propEntry: layouts.propEntry.key,
    nativeString: "strings:flat",
  });
  const pack = reserveNativeObjectLookupResources(tx, "reads", dependencies, plan);
  return {
    module,
    tx,
    strings,
    flatten,
    equality,
    symbols,
    layoutRequirements,
    layoutPlan,
    layouts,
    dependencies,
    plan,
    pack,
    dispatcher,
  };
}
export type ObjectLookupFixture = ReturnType<typeof objectLookupFixture>;
export function fillObjectLookupDependencies(f: ObjectLookupFixture): void {
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeStringFlattenResources(f.tx, f.flatten);
  fillNativeStringEqualityResources(f.tx, f.equality);
  fillNativeSymbolCarrierResources(f.tx, f.symbols);
}
export function completeObjectLookupFixture(f: ObjectLookupFixture): void {
  f.tx.freezeReservations();
  fillObjectLookupDependencies(f);
  fillNativeObjectLookupResources(f.tx, f.pack);
  requireCompletedNativeObjectLookup(f.tx, f.pack, f.dependencies);
}

export interface ObjectLookupRuntime {
  make(proto: object | null, flags: number): object;
  putAt(object: object, key: object, value: unknown, flags: number, getter: unknown, slot: number): void;
  setProto(object: object, proto: object | null): void;
  setFlags(object: object, flags: number): void;
  hash(key: object): number;
  has(object: object, key: object): number;
  get(object: object, key: object, receiver: unknown): [number, unknown];
  undefinedValue(): object;
  key(index: number): object;
  flatAB(): object;
  sliceAB(): object;
  ropeAB(): object;
  symbol(id: number): object;
}

/** Issued key/lookup owner plus a separately labelled Get body with controlled invocation. */
export function objectLookupRuntime(
  method0: (receiver: unknown, callee: unknown) => unknown = () => {
    throw new Error("unexpected getter invocation");
  },
  offset = false,
  utf8 = false,
  mutateGet?: (body: Instr[]) => Instr[],
) {
  const f = objectLookupFixture(offset, utf8, true),
    { tx, layouts, pack, strings } = f;
  const extern: ValType = { kind: "externref" },
    i32: ValType = { kind: "i32" };
  const anyType = tx.reserveType("control:undefined-type", buildAnyValueType());
  const undefinedGlobal = tx.reserveGlobal(
    "control:undefined",
    "control_undefined",
    { kind: "ref", typeIdx: anyType.typeIndex },
    false,
  );
  const make = tx.reserveFunction("control:make", "make", { params: [extern, i32], results: [extern] });
  const putAt = tx.reserveFunction("control:put", "putAt", {
    params: [extern, extern, extern, i32, extern, i32],
    results: [],
  });
  const setProto = tx.reserveFunction("control:set-proto", "setProto", { params: [extern, extern], results: [] });
  const setFlags = tx.reserveFunction("control:set-flags", "setFlags", { params: [extern, i32], results: [] });
  const has = tx.reserveFunction("control:has", "has", { params: [extern, extern], results: [i32] });
  const get = tx.reserveFunction("control:get", "get", { params: [extern, extern, extern], results: [i32, extern] });
  const getBody = tx.reserveFunction("control:get-body", "get_body", {
    params: [{ kind: "ref", typeIdx: layouts.object.typeIndex }, extern, extern],
    results: [i32, extern],
  });
  const undefinedValue = tx.reserveFunction("control:undefined-value", "undefinedValue", {
    params: [],
    results: [extern],
  });
  const keys = KEY_TEXTS.map((_, i) =>
    tx.reserveFunction("control:key:" + i, "key" + i, { params: [], results: [extern] }),
  );
  const variants = ["flatAB", "sliceAB", "ropeAB"].map((name) =>
    tx.reserveFunction("control:" + name, name, { params: [], results: [extern] }),
  );
  completeObjectLookupFixture(f);
  tx.fillGlobal(undefinedGlobal, buildUndefinedInitializer(anyType.typeIndex));
  const object = (index: number): Instr[] => [
    { op: "local.get", index },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: layouts.object.typeIndex },
  ];
  const nullableObject = (index: number): Instr[] => [
    { op: "local.get", index },
    { op: "any.convert_extern" },
    { op: "ref.cast_null", typeIdx: layouts.object.typeIndex },
  ];
  tx.fillFunction(make, {
    locals: [],
    body: [
      ...nullableObject(0),
      { op: "i32.const", value: 8 },
      { op: "array.new_default", typeIdx: layouts.propMap.typeIndex },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "struct.new", typeIdx: layouts.object.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(putAt, {
    locals: [],
    body: [
      ...object(0),
      { op: "struct.get", typeIdx: layouts.object.typeIndex, fieldIdx: 1 },
      { op: "local.get", index: 5 },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "local.get", index: 3 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 4 },
      { op: "any.convert_extern" },
      { op: "ref.null", typeIdx: -18 },
      { op: "struct.new", typeIdx: layouts.propEntry.typeIndex },
      { op: "array.set", typeIdx: layouts.propMap.typeIndex },
    ],
  });
  tx.fillFunction(setProto, {
    locals: [],
    body: [...object(0), ...nullableObject(1), { op: "struct.set", typeIdx: layouts.object.typeIndex, fieldIdx: 0 }],
  });
  tx.fillFunction(setFlags, {
    locals: [],
    body: [
      ...object(0),
      { op: "local.get", index: 1 },
      { op: "struct.set", typeIdx: layouts.object.typeIndex, fieldIdx: 4 },
    ],
  });
  tx.fillFunction(has, {
    locals: [],
    body: [...object(0), { op: "local.get", index: 1 }, { op: "call", funcIdx: pack.has.handle }],
  });
  const definition = buildOrdinaryObjectGetDefinition({
    propEntryTypeIdx: layouts.propEntry.typeIndex,
    lookupIdx: pack.lookup.handle,
    getterDispatchIdx: f.dispatcher!.handle,
    undefinedGlobalIdx: tx.physicalIndex(undefinedGlobal),
  });
  tx.fillFunction(getBody, { ...definition, body: mutateGet ? mutateGet(definition.body) : definition.body });
  tx.fillFunction(get, {
    locals: [],
    body: [
      ...object(0),
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: getBody.handle },
    ],
  });
  tx.fillFunction(undefinedValue, {
    locals: [],
    body: [{ op: "global.get", index: tx.physicalIndex(undefinedGlobal) }, { op: "extern.convert_any" }],
  });
  const literal = (text: string): Instr[] => {
    const binding = requireNativeStringLiteral(tx, strings, text, "wtf16");
    if (binding.kind !== "global") throw new Error("expected small literal global");
    return [{ op: "global.get", index: tx.physicalIndex(binding.global) }];
  };
  keys.forEach((token, index) =>
    tx.fillFunction(token, { locals: [], body: [...literal(KEY_TEXTS[index]!), { op: "extern.convert_any" }] }),
  );
  for (const [index, text, start] of [
    [0, "ab", 0],
    [1, "!ab!", 1],
  ] as const)
    tx.fillFunction(variants[index]!, {
      locals: [],
      body: [
        { op: "i32.const", value: 2 },
        { op: "i32.const", value: start },
        ...literal(text),
        { op: "struct.get", typeIdx: strings.layout.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "struct.new", typeIdx: strings.layout.nativeStrTypeIdx },
        { op: "extern.convert_any" },
      ],
    });
  tx.fillFunction(variants[2]!, {
    locals: [],
    body: [
      { op: "i32.const", value: 2 },
      ...literal("ab"),
      ...literal(""),
      { op: "struct.new", typeIdx: strings.layout.consStrTypeIdx },
      { op: "extern.convert_any" },
    ],
  });
  for (const token of [make, putAt, setProto, setFlags, has, get, undefinedValue, ...keys, ...variants])
    tx.defineExport("export:" + token.key, token.object.name!, token);
  tx.defineExport("export:hash", "hash", pack.hash);
  tx.defineExport("export:symbol", "symbol", f.symbols.functions.box);
  tx.seal();
  const bytes = emitBinary(f.module),
    compiled = new WebAssembly.Module(bytes);
  const exports = new WebAssembly.Instance(compiled, { prefix: { unused: () => {}, number: 19 }, control: { method0 } })
    .exports;
  const runtime = {
    ...exports,
    key: (index: number) => (exports["key" + index] as () => object)(),
  } as unknown as ObjectLookupRuntime;
  return { ...f, bytes, runtime };
}
