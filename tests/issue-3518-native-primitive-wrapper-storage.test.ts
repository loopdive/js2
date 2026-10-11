// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../src/backend/wasmgc/resources/native-object-layouts.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
  nativeStringTypeKeys,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeSymbolCarrierResources,
  fillNativeSymbolCarrierResources,
} from "../src/backend/wasmgc/resources/native-symbol-carrier.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
} from "../src/backend/wasmgc/resources/native-bigint.js";
import {
  reserveBigIntOperands,
  fillBigIntOperands,
  bigintOperandValues,
} from "./helpers/native-bigint-carrier-fixture.js";
import {
  declareNativePrimitiveWrapperLayouts,
  reserveNativePrimitiveWrapperLayouts,
} from "../src/backend/wasmgc/resources/native-primitive-wrapper-layouts.js";
import {
  PRIMITIVE_WRAPPER_KINDS as kinds,
  PRIMITIVE_WRAPPER_DATA_FIELD,
  type PrimitiveWrapperKind,
} from "../src/runtime/wasmgc/values/primitive-wrapper-layouts.js";
import {
  buildPrimitiveWrapperAllocationDefinition,
  buildPrimitiveWrapperDataDefinition,
  type PrimitiveWrapperBodyBindings,
} from "../src/runtime/wasmgc/values/primitive-wrapper-bodies.js";
import { buildOrdinaryObjectCreateDefinition } from "../src/runtime/wasmgc/values/ordinary-object-storage-definitions.js";

import {
  declareNativePrimitiveWrapperStorageResources,
  reserveNativePrimitiveWrapperStorageResources,
  requireNativePrimitiveWrapperStorageReservations,
  fillNativePrimitiveWrapperStorageResources,
  requireCompletedNativePrimitiveWrapperStorage,
  nativePrimitiveWrapperStorageReservationInventory,
} from "../src/backend/wasmgc/resources/native-primitive-wrapper-storage.js";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" };
const texts = ["hello", "", "\ud83d\ude00", "\ud800"];

function prerequisites(offset = false, mutableLayout = false, mutableObject = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  if (offset)
    tx.reserveType("prefix", {
      kind: "rec",
      types: [
        { kind: "struct", name: "Prefix0", fields: [] },
        { kind: "struct", name: "Prefix1", fields: [{ name: "n", type: i32, mutable: false }] },
      ],
    });
  const prefix = offset ? tx.reserveFunction("prefix:fn", "prefix", { params: [], results: [] }) : undefined;
  const objectRequirements = { key: "objects", extensible: true as const };
  const originalObjectPlan = declareNativeObjectLayouts(objectRequirements);
  const objectPlan = mutableObject ? structuredClone(originalObjectPlan) : originalObjectPlan;
  const objects = reserveNativeObjectLayouts(tx, objectRequirements, objectPlan);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: offset,
    literals: texts.map((value) => ({ value, encoding: "wtf16" as const })),
  });
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const bigint = reserveNativeBigIntResources(tx, "bigint", declareNativeBigIntResources("bigint"));
  const layoutDependencies = { objects, objectPlan, strings, symbols };
  const declaredLayout = declareNativePrimitiveWrapperLayouts("wrappers", {
    object: objects.object.key,
    propMap: objects.propMap.key,
    anyString: nativeStringTypeKeys("strings").any,
    symbol: symbols.types.symbol.key,
  });
  const layoutPlan = mutableLayout ? structuredClone(declaredLayout) : declaredLayout;
  const layouts = reserveNativePrimitiveWrapperLayouts(tx, "wrappers", layoutPlan, layoutDependencies);
  const dependencies = { layouts, layoutPlan, layoutDependencies };
  return {
    module,
    tx,
    prefix,
    objects,
    objectPlan,
    strings,
    symbols,
    bigint,
    layouts,
    layoutPlan,
    layoutDependencies,
    dependencies,
  };
}

function declaration(f: ReturnType<typeof prerequisites>, key = "storage", initialCapacity = 8) {
  return declareNativePrimitiveWrapperStorageResources(
    key,
    {
      anyString: nativeStringTypeKeys("strings").any,
      symbol: f.symbols.types.symbol.key,
    },
    initialCapacity,
  );
}
function fixture(offset = false, mutablePlan = false, mutableLayout = false, mutableObject = false) {
  const f = prerequisites(offset, mutableLayout, mutableObject);
  const declared = declaration(f, "storage", offset ? 16 : 8);
  const plan = mutablePlan ? structuredClone(declared) : declared;
  const pack = reserveNativePrimitiveWrapperStorageResources(f.tx, "storage", plan, f.dependencies);
  return { ...f, plan, pack };
}
type Fixture = ReturnType<typeof fixture>;
function current(f: Fixture) {
  return requireNativePrimitiveWrapperStorageReservations(f.tx, f.pack, f.plan, f.dependencies);
}
function completed(f: Fixture) {
  return requireCompletedNativePrimitiveWrapperStorage(f.tx, f.pack, f.plan, f.dependencies);
}
function fillDependencies(f: ReturnType<typeof prerequisites>) {
  if (f.prefix) f.tx.fillFunction(f.prefix, { locals: [], body: [] });
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeSymbolCarrierResources(f.tx, f.symbols);
  fillNativeBigIntResources(f.tx, f.bigint);
}
function complete(f = fixture()) {
  f.tx.freezeReservations();
  fillDependencies(f);
  fillNativePrimitiveWrapperStorageResources(f.tx, f.pack);
  completed(f);
  return f;
}
function populations(f: ReturnType<typeof prerequisites>) {
  return Object.fromEntries(
    Object.entries(f.module)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, [...(value as unknown[])]]),
  );
}
function unchanged(f: ReturnType<typeof prerequisites>, before: ReturnType<typeof populations>) {
  const after = populations(f);
  expect(Object.keys(after)).toEqual(Object.keys(before));
  for (const [key, rows] of Object.entries(before)) {
    expect(after[key]).toHaveLength(rows.length);
    expect(after[key]!.every((row, index) => Object.is(row, rows[index]))).toBe(true);
  }
}

/** Real storage owner/carriers; these explicitly supplied test prototypes are not intrinsic providers. */
function runtime(offset: boolean) {
  const f = fixture(offset);
  const { module, tx, objects, strings, symbols, bigint, layouts, plan, pack, dependencies } = f;
  const operands = reserveBigIntOperands(tx);
  const initialCapacity = offset ? 16 : 8;
  const bindings = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      {
        kind,
        objectTypeIdx: objects.object.typeIndex,
        propMapTypeIdx: objects.propMap.typeIndex,
        wrapperTypeIdx: layouts.types[kind].typeIndex,
        initialCapacity,
        ...(kind === "String" ? { anyStrTypeIdx: strings.layout.anyStrTypeIdx } : {}),
        ...(kind === "Symbol" ? { symbolTypeIdx: symbols.types.symbol.typeIndex } : {}),
      },
    ]),
  ) as Record<PrimitiveWrapperKind, PrimitiveWrapperBodyBindings>;
  const definitions = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      {
        allocation: buildPrimitiveWrapperAllocationDefinition(bindings[kind]),
        read: buildPrimitiveWrapperDataDefinition(bindings[kind]),
      },
    ]),
  ) as Record<
    PrimitiveWrapperKind,
    {
      allocation: ReturnType<typeof buildPrimitiveWrapperAllocationDefinition>;
      read: ReturnType<typeof buildPrimitiveWrapperDataDefinition>;
    }
  >;
  const constructors = pack.allocation,
    readers = pack.read;
  // JS-facing test adapters preserve the internal typed payload ABI.
  const exportedConstructors = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      kind === "String" || kind === "Symbol"
        ? tx.reserveFunction("bridge:new:" + kind, "bridgeNew" + kind, { params: [ext, ext], results: [ext] })
        : constructors[kind]!,
    ]),
  );
  const exportedReaders = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      kind === "String" || kind === "Symbol"
        ? tx.reserveFunction("bridge:read:" + kind, "bridgeRead" + kind, { params: [ext], results: [ext] })
        : readers[kind]!,
    ]),
  );
  const observers = Object.fromEntries(
    ["prototype", "map", "header", "empty", "capacity"].map((name) => [
      name,
      tx.reserveFunction(name, name, { params: [ext], results: [name === "prototype" || name === "map" ? ext : i32] }),
    ]),
  );
  const prototype = tx.reserveFunction("createPrototype", "createPrototype", { params: [], results: [ext] });
  const mark = tx.reserveFunction("mark", "mark", { params: [ext], results: [] });
  const literals = texts.map((_, i) =>
    tx.reserveFunction("literal:" + i, "string" + i, { params: [], results: [ext] }),
  );
  tx.freezeReservations();
  fillDependencies(f);
  fillNativePrimitiveWrapperStorageResources(tx, pack);
  fillBigIntOperands(tx, bigint, operands);
  tx.fillFunction(
    prototype,
    buildOrdinaryObjectCreateDefinition(
      { objectTypeIdx: objects.object.typeIndex, propMapTypeIdx: objects.propMap.typeIndex, initialCapacity },
      "null",
    ),
  );
  for (const [i, text] of texts.entries()) {
    const literal = requireNativeStringLiteral(tx, strings, text, "wtf16");
    tx.fillFunction(literals[i]!, {
      locals: [],
      body: [
        literal.kind === "global"
          ? { op: "global.get", index: tx.physicalIndex(literal.global) }
          : { op: "call", funcIdx: literal.function.handle },
        { op: "extern.convert_any" },
      ],
    });
    tx.defineExport("export:string:" + i, "string" + i, literals[i]!);
  }
  for (const kind of kinds) {
    if (kind === "String" || kind === "Symbol") {
      const payload = definitions[kind].allocation.params[1]!;
      if (payload.kind !== "ref") throw Error("expected native reference payload");
      tx.fillFunction(exportedConstructors[kind]!, {
        locals: [],
        body: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: payload.typeIdx },
          { op: "call", funcIdx: constructors[kind]!.handle },
        ],
      });
      tx.fillFunction(exportedReaders[kind]!, {
        locals: [],
        body: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: readers[kind]!.handle },
          { op: "extern.convert_any" },
        ],
      });
    }
    tx.defineExport("export:new:" + kind, "new" + kind, exportedConstructors[kind]!);
    tx.defineExport("export:read:" + kind, "read" + kind, exportedReaders[kind]!);
  }
  const asObject = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objects.object.typeIndex },
  ];
  const propertyMap = (): Instr[] => [
    ...asObject(),
    { op: "struct.get", typeIdx: objects.object.typeIndex, fieldIdx: 1 },
  ];
  for (const [name, fieldIdx] of [
    ["prototype", 0],
    ["map", 1],
  ] as const)
    tx.fillFunction(observers[name]!, {
      locals: [],
      body: [
        ...asObject(),
        { op: "struct.get", typeIdx: objects.object.typeIndex, fieldIdx },
        { op: "extern.convert_any" },
      ],
    });
  tx.fillFunction(observers.header!, {
    locals: [],
    body: [
      ...[2, 3, 4, 5].flatMap((fieldIdx, index): Instr[] => [
        ...asObject(),
        { op: "struct.get", typeIdx: objects.object.typeIndex, fieldIdx },
        ...(index ? [{ op: "i32.or" } as Instr] : []),
      ]),
      { op: "i32.eqz" },
    ],
  });
  tx.fillFunction(observers.capacity!, { locals: [], body: [...propertyMap(), { op: "array.len" }] });
  tx.fillFunction(observers.empty!, {
    locals: [],
    body: [
      { op: "i32.const", value: 1 },
      ...Array.from({ length: initialCapacity }, (_, index): Instr[] => [
        ...propertyMap(),
        { op: "i32.const", value: index },
        { op: "array.get", typeIdx: objects.propMap.typeIndex },
        { op: "ref.is_null" },
        { op: "i32.and" },
      ]).flat(),
    ],
  });
  tx.fillFunction(mark, {
    locals: [],
    body: [
      ...propertyMap(),
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: literals[0]!.handle },
      { op: "any.convert_extern" },
      { op: "i32.const", value: 77 },
      { op: "ref.i31" },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "ref.null", typeIdx: objects.object.typeIndex },
      { op: "ref.null", typeIdx: objects.object.typeIndex },
      { op: "struct.new", typeIdx: objects.propEntry.typeIndex },
      { op: "array.set", typeIdx: objects.propMap.typeIndex },
      ...asObject(),
      { op: "i32.const", value: 1 },
      { op: "struct.set", typeIdx: objects.object.typeIndex, fieldIdx: 2 },
    ],
  });
  for (const [name, fn] of Object.entries({
    ...observers,
    createPrototype: prototype,
    mark,
    symbol: symbols.functions.box,
    ...operands,
  }))
    tx.defineExport("export:" + name, name, fn);
  requireCompletedNativePrimitiveWrapperStorage(tx, pack, plan, dependencies);
  tx.seal();
  requireCompletedNativePrimitiveWrapperStorage(tx, pack, plan, dependencies);
  const bytes = emitBinary(module),
    wasm = new WebAssembly.Module(bytes as BufferSource);
  const api = new WebAssembly.Instance(wasm).exports as Record<string, (...args: any[]) => any>;
  const readerPositions = Object.fromEntries(
    kinds.map((kind) => [kind, module.functions.indexOf(readers[kind]!.object)]),
  );
  return {
    module,
    tx,
    pack,
    layouts,
    plan,
    dependencies,
    definitions,
    bindings,
    readerPositions,
    initialCapacity,
    bytes,
    wasm,
    api,
  };
}

function payload(r: ReturnType<typeof runtime>, kind: PrimitiveWrapperKind): unknown {
  if (kind === "Boolean") return 1;
  if (kind === "Number") return -0;
  if (kind === "String") return r.api.string0!();
  if (kind === "Symbol") return r.api.symbol!(3);
  return r.api.wide96high!();
}

for (const offset of [false, true])
  describe("issued wrapper storage execution, shifted=" + offset, () => {
    let r: ReturnType<typeof runtime>;
    beforeAll(() => {
      r = runtime(offset);
    });
    it("instantiates complete real bodies without imports", () => {
      expect(WebAssembly.validate(r.bytes as BufferSource)).toBe(true);
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.pack.completionScope).toBe("primitive-wrapper-storage");
      expect(requireCompletedNativePrimitiveWrapperStorage(r.tx, r.pack, r.plan, r.dependencies)).toBe(r.pack);
    });
    it.each(kinds)(
      "allocates fresh %s wrappers/maps with the supplied prototype and immutable private payload",
      (kind) => {
        const prototype = r.api.createPrototype!(),
          value = payload(r, kind);
        const first = r.api["new" + kind]!(prototype, value),
          second = r.api["new" + kind]!(prototype, value);
        expect(Object.is(first, second)).toBe(false);
        expect(Object.is(first, prototype)).toBe(false);
        expect(Object.is(first, value)).toBe(false);
        expect(Object.is(r.api.map!(first), r.api.map!(second))).toBe(false);
        expect(Object.is(r.api.map!(first), r.api.map!(prototype))).toBe(false);
        for (const wrapper of [first, second]) {
          expect(Object.is(r.api.prototype!(wrapper), prototype)).toBe(true);
          expect(Object.is(r.api["read" + kind]!(wrapper), value)).toBe(true);
          expect(r.api.header!(wrapper)).toBe(1);
          expect(r.api.empty!(wrapper)).toBe(1);
          expect(r.api.capacity!(wrapper)).toBe(r.initialCapacity);
        }
        r.api.mark!(first);
        expect(r.api.empty!(first)).toBe(0);
        expect(r.api.header!(first)).toBe(0);
        expect(r.api.empty!(second)).toBe(1);
        expect(r.api.header!(second)).toBe(1);
        expect(r.api.empty!(prototype)).toBe(1);
        expect(Object.is(r.api["read" + kind]!(first), value)).toBe(true);
        expect(Object.is(r.api.prototype!(first), prototype)).toBe(true);
      },
    );
    it.each(kinds)("takes the %s prototype from each call and accepts real ordinary subtypes as prototypes", (kind) => {
      const one = r.api.createPrototype!(),
        two = r.api.createPrototype!(),
        value = payload(r, kind);
      const a = r.api["new" + kind]!(one, value),
        b = r.api["new" + kind]!(two, value);
      expect(Object.is(r.api.prototype!(a), one)).toBe(true);
      expect(Object.is(r.api.prototype!(b), two)).toBe(true);
      expect(Object.is(r.api.prototype!(b), one)).toBe(false);
      const nested = r.api["new" + kind]!(a, value);
      expect(Object.is(r.api.prototype!(nested), a)).toBe(true);
      expect(Object.is(r.api.map!(nested), r.api.map!(a))).toBe(false);
    });
    it.each(kinds)("refuses nullish, primitive and host-object prototypes for %s rather than substituting", (kind) => {
      const value = payload(r, kind);
      for (const bad of [null, undefined, 0, "Object.prototype", {}, r.api.string0!(), r.api.symbol!(1), r.api.zero!()])
        expect(() => r.api["new" + kind]!(bad, value)).toThrow();
    });
    it.each(kinds)("private %s reads reject other brands and primitive carriers", (kind) => {
      const prototype = r.api.createPrototype!();
      const value = payload(r, kind),
        good = r.api["new" + kind]!(prototype, value);
      expect(Object.is(r.api["read" + kind]!(good), value)).toBe(true);
      for (const other of kinds) {
        if (other !== kind)
          expect(() => r.api["read" + kind]!(r.api["new" + other]!(prototype, payload(r, other)))).toThrow(
            WebAssembly.RuntimeError,
          );
        expect(() => r.api["read" + kind]!(payload(r, other))).toThrow(WebAssembly.RuntimeError);
      }
      expect(() => r.api["read" + kind]!(prototype)).toThrow(WebAssembly.RuntimeError);
      expect(() => r.api["read" + kind]!(null)).toThrow(WebAssembly.RuntimeError);
    });
    it.each(kinds)("actual Wasm rejects writing the immutable %s private slot", (kind) => {
      const changed = structuredClone(r.module),
        index = r.readerPositions[kind]!;
      const typeIdx = r.layouts.types[kind].typeIndex;
      const asWrapper: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx },
      ];
      changed.functions[index]!.body = [
        ...asWrapper,
        ...structuredClone(asWrapper),
        { op: "struct.get", typeIdx, fieldIdx: PRIMITIVE_WRAPPER_DATA_FIELD },
        { op: "struct.set", typeIdx, fieldIdx: PRIMITIVE_WRAPPER_DATA_FIELD },
        ...changed.functions[index]!.body,
      ];
      const bytes = emitBinary(changed);
      expect(WebAssembly.validate(bytes as BufferSource)).toBe(false);
      expect(() => new WebAssembly.Module(bytes as BufferSource)).toThrow(/immutable/);
      expect(requireCompletedNativePrimitiveWrapperStorage(r.tx, r.pack, r.plan, r.dependencies)).toBe(r.pack);
    });
    it.each([0, 1])("preserves Boolean payload %s", (value) => {
      expect(r.api.readBoolean!(r.api.newBoolean!(r.api.createPrototype!(), value))).toBe(value);
    });
    it.each([NaN, Infinity, -Infinity, -0, 0, 1.5, -1.5, Number.MIN_VALUE, Number.MAX_VALUE])(
      "preserves Number payload %s bit semantics",
      (value) => {
        expect(Object.is(r.api.readNumber!(r.api.newNumber!(r.api.createPrototype!(), value)), value)).toBe(true);
      },
    );
    it.each(texts.map((text, index) => ({ text, index })))(
      "preserves native String identity $index ($text)",
      ({ index }) => {
        const value = r.api["string" + index]!();
        expect(Object.is(r.api.readString!(r.api.newString!(r.api.createPrototype!(), value)), value)).toBe(true);
      },
    );
    it.each([1, 3, 15])("preserves actual canonical Symbol identity %s", (id) => {
      const value = r.api.symbol!(id);
      expect(Object.is(r.api.readSymbol!(r.api.newSymbol!(r.api.createPrototype!(), value)), value)).toBe(true);
    });
    it.each(Object.keys(bigintOperandValues))("preserves complete BigInt carrier identity %s", (name) => {
      const value = r.api[name]!();
      expect(Object.is(r.api.readBigInt!(r.api.newBigInt!(r.api.createPrototype!(), value)), value)).toBe(true);
    });
    it.each(["String", "Symbol"] as const)("enforces the nonnull native %s payload type", (kind) => {
      const prototype = r.api.createPrototype!();
      const other = kind === "String" ? r.api.symbol!(1) : r.api.string0!();
      for (const value of [null, undefined, {}, prototype, other])
        expect(() => r.api["new" + kind]!(prototype, value)).toThrow();
    });
  });

describe("authenticated wrapper storage lifecycle", () => {
  it("declares and issues exactly ten canonical slots with explicit limited scope", () => {
    const f = fixture(true);
    const inventory = nativePrimitiveWrapperStorageReservationInventory(f.tx, f.pack, f.plan, f.dependencies);
    expect(f.pack.completionScope).toBe("primitive-wrapper-storage");
    for (const value of [f.pack, f.pack.allocation, f.pack.read, inventory, inventory.functions, inventory.plan])
      expect(Object.isFrozen(value)).toBe(true);
    expect(inventory.functions).toHaveLength(10);
    expect(inventory.plan.declarations).toHaveLength(10);
    expect(inventory.plan.reservationSteps).toHaveLength(10);
    expect(inventory.plan.initialCapacity).toBe(16);
    expect(Object.is(inventory.layouts, f.layouts)).toBe(true);
    const payloads = {
      Boolean: { kind: "i32" },
      Number: { kind: "f64" },
      BigInt: { kind: "externref" },
      String: { kind: "ref", typeKey: nativeStringTypeKeys("strings").any },
      Symbol: { kind: "ref", typeKey: f.symbols.types.symbol.key },
    };
    for (const [i, kind] of kinds.entries()) {
      expect(inventory.plan.declarations[i * 2]).toMatchObject({
        key: `storage:${kind}:allocation`,
        space: "function",
        signature: { params: [ext, payloads[kind]], results: [ext] },
      });
      expect(inventory.plan.declarations[i * 2 + 1]).toMatchObject({
        key: `storage:${kind}:read`,
        space: "function",
        signature: { params: [ext], results: [payloads[kind]] },
      });
      expect(Object.is(inventory.functions[i * 2], f.pack.allocation[kind])).toBe(true);
      expect(Object.is(inventory.functions[i * 2 + 1], f.pack.read[kind])).toBe(true);
    }
    expect(Object.is(current(f), f.pack)).toBe(true);
    complete(f);
    expect(f.tx.physicalIndex(f.pack.allocation.Boolean)).toBeGreaterThan(0);
    expect(Object.is(completed(f), f.pack)).toBe(true);
    f.tx.seal();
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  it.each(["owner", "ledger", "plan", "dependencies"] as const)(
    "refuses copied/foreign %s after a positive",
    (role) => {
      const f = fixture();
      current(f);
      expect(() =>
        requireNativePrimitiveWrapperStorageReservations(
          role === "ledger" ? prerequisites().tx : f.tx,
          role === "owner" ? { ...f.pack } : f.pack,
          role === "plan" ? structuredClone(f.plan) : f.plan,
          role === "dependencies" ? { ...f.dependencies } : f.dependencies,
        ),
      ).toThrow(
        role === "plan"
          ? "declaration plan"
          : role === "dependencies"
            ? "dependency identity"
            : "foreign or copied owner",
      );
      expect(Object.is(current(f), f.pack)).toBe(true);
    },
  );

  it.each(["layouts", "layoutPlan", "layoutDependencies", "ledger"] as const)(
    "preflights authentic %s without allocation",
    (role) => {
      const f = prerequisites(),
        other = role === "ledger" ? prerequisites() : f;
      const bad =
        role === "ledger"
          ? other.dependencies
          : {
              ...f.dependencies,
              ...(role === "layouts" ? { layouts: { ...f.layouts } } : {}),
              ...(role === "layoutPlan" ? { layoutPlan: structuredClone(f.layoutPlan) } : {}),
              ...(role === "layoutDependencies" ? { layoutDependencies: { ...f.layoutDependencies } } : {}),
            };
      const before = populations(f),
        plan = declaration(f);
      expect(() => reserveNativePrimitiveWrapperStorageResources(f.tx, "storage", plan, bad)).toThrow();
      unchanged(f, before);
      const pack = reserveNativePrimitiveWrapperStorageResources(f.tx, "storage", plan, f.dependencies);
      expect(Object.is(requireNativePrimitiveWrapperStorageReservations(f.tx, pack, plan, f.dependencies), pack)).toBe(
        true,
      );
    },
  );

  it.each(["layouts", "layoutPlan", "layoutDependencies"] as const)("refuses changed borrowed %s identity", (role) => {
    const f = fixture();
    current(f);
    const original = f.dependencies[role];
    Object.defineProperty(f.dependencies, role, { value: { ...original }, configurable: true, writable: true });
    expect(() => current(f)).toThrow("changed dependency identity");
    Object.defineProperty(f.dependencies, role, { value: original });
    expect(Object.is(current(f), f.pack)).toBe(true);
  });

  it.each(["storage", "wrapper", "object"] as const)(
    "refuses a changed borrowed %s declaration after a positive",
    (role) => {
      const f = fixture(false, true, true, true);
      current(f);
      const plan = role === "storage" ? f.plan : role === "wrapper" ? f.layoutPlan : f.objectPlan;
      Object.defineProperty(plan.declarations[0]!, "role", { value: ["changed"] });
      expect(() => current(f)).toThrow(/changed|stale/);
    },
  );

  it.each(["layout", "payload", "prototype-root"] as const)(
    "preflights a mutated %s before allocating any slot",
    (role) => {
      const f = prerequisites();
      const type =
        role === "layout"
          ? f.layouts.types.Number.object
          : role === "payload"
            ? f.symbols.types.symbol.object
            : f.objects.object.object;
      if (type.kind !== "struct") throw Error("expected actual struct");
      type.fields.at(-1)!.mutable = !type.fields.at(-1)!.mutable;
      const before = populations(f);
      expect(() =>
        reserveNativePrimitiveWrapperStorageResources(f.tx, "storage", declaration(f), f.dependencies),
      ).toThrow();
      unchanged(f, before);
    },
  );

  it.each(["first", "last"] as const)("preflights the %s key collision before any append", (where) => {
    const f = prerequisites(),
      plan = declaration(f);
    f.tx.reserveFunction(where === "first" ? "storage:Boolean:allocation" : "storage:BigInt:read", "collision", {
      params: [],
      results: [],
    });
    const before = populations(f);
    expect(() => reserveNativePrimitiveWrapperStorageResources(f.tx, "storage", plan, f.dependencies)).toThrow(
      "duplicate planned resource key",
    );
    unchanged(f, before);
  });

  it.each(["name", "signature", "omitted", "extra", "steps", "payload-key"] as const)(
    "rejects substituted %s in the complete declaration plan",
    (change) => {
      const f = prerequisites(),
        good = declaration(f),
        bad = structuredClone(good);
      const first = bad.declarations[0]!;
      if (first.space !== "function") throw Error("expected real function declaration");
      if (change === "name") Object.defineProperty(first, "name", { value: "wrong" });
      if (change === "signature")
        Object.defineProperty(first, "signature", { value: { params: [ext], results: [ext] } });
      if (change === "omitted") (bad.declarations as unknown[]).pop();
      if (change === "extra") (bad.declarations as unknown[]).push({ ...first, key: "extra" });
      if (change === "steps") (bad.reservationSteps as unknown[]).reverse();
      if (change === "payload-key") {
        const row = bad.declarations[4]!;
        if (row.space !== "function") throw Error("expected String declaration");
        Object.defineProperty(row.signature.params[1]!, "typeKey", { value: f.symbols.types.symbol.key });
      }
      const before = populations(f);
      expect(() => reserveNativePrimitiveWrapperStorageResources(f.tx, "storage", bad, f.dependencies)).toThrow(
        "substituted declaration plan",
      );
      unchanged(f, before);
      expect(reserveNativePrimitiveWrapperStorageResources(f.tx, "storage", good, f.dependencies).read.BigInt.key).toBe(
        "storage:BigInt:read",
      );
    },
  );

  it.each([0, -1, 3, 1.5, NaN, Infinity, 0x80000000])("rejects invalid capacity %s without allocation", (value) => {
    const f = prerequisites(),
      bad = structuredClone(declaration(f));
    Object.defineProperty(bad, "initialCapacity", { value });
    const before = populations(f);
    expect(() => reserveNativePrimitiveWrapperStorageResources(f.tx, "storage", bad, f.dependencies)).toThrow(
      "invalid initial capacity",
    );
    unchanged(f, before);
  });

  it.each(["missing", "inherited", "getter"] as const)(
    "rejects %s dependency data without executing an accessor",
    (mode) => {
      const f = prerequisites(),
        getter = vi.fn(() => f.layouts);
      const bad = { ...f.dependencies };
      Reflect.deleteProperty(bad, "layouts");
      if (mode === "inherited") Object.setPrototypeOf(bad, { layouts: f.layouts });
      if (mode === "getter") Object.defineProperty(bad, "layouts", { get: getter });
      const before = populations(f);
      expect(() => reserveNativePrimitiveWrapperStorageResources(f.tx, "storage", declaration(f), bad)).toThrow(
        "missing or non-data field layouts",
      );
      expect(getter).not.toHaveBeenCalled();
      unchanged(f, before);
    },
  );

  it("rejects borrowed dependencies changed into getters without running them", () => {
    const f = fixture();
    current(f);
    const getter = vi.fn(() => f.layouts);
    Object.defineProperty(f.dependencies, "layouts", { get: getter });
    expect(() => current(f)).toThrow("missing or non-data field layouts");
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects accessor capacity and signature data before allocation without invoking them", () => {
    for (const field of ["capacity", "signature"] as const) {
      const f = prerequisites(),
        bad = structuredClone(declaration(f)),
        getter = vi.fn();
      if (field === "capacity") Object.defineProperty(bad, "initialCapacity", { get: getter });
      else Object.defineProperty(bad.declarations[0]!, "signature", { get: getter });
      const before = populations(f);
      expect(() => reserveNativePrimitiveWrapperStorageResources(f.tx, "storage", bad, f.dependencies)).toThrow();
      expect(getter).not.toHaveBeenCalled();
      unchanged(f, before);
    }
  });

  it("accepts an equal construction-plan copy but binds only that exact identity", () => {
    const f = fixture(false, true);
    current(f);
    expect(Object.isFrozen(f.plan)).toBe(false);
    expect(() =>
      requireNativePrimitiveWrapperStorageReservations(f.tx, f.pack, structuredClone(f.plan), f.dependencies),
    ).toThrow("declaration plan");
    expect(Object.is(current(f), f.pack)).toBe(true);
  });

  it("refuses reserve after freeze without appending resources", () => {
    const f = prerequisites();
    f.tx.freezeReservations();
    const before = populations(f);
    expect(() =>
      reserveNativePrimitiveWrapperStorageResources(f.tx, "storage", declaration(f), f.dependencies),
    ).toThrow("invalid reservation phase");
    unchanged(f, before);
  });

  it("refuses premature fill and completion while preserving all empty reservations", () => {
    const f = fixture(),
      before = populations(f);
    expect(() => fillNativePrimitiveWrapperStorageResources(f.tx, f.pack)).toThrow("invalid phase");
    expect(() => completed(f)).toThrow("missing canonical fill");
    unchanged(f, before);
    for (const kind of kinds)
      for (const role of ["allocation", "read"] as const) expect(f.pack[role][kind].object.body).toEqual([]);
    complete(f);
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  it("requires its canonical fill after the real carrier dependencies complete", () => {
    const f = fixture();
    f.tx.freezeReservations();
    fillDependencies(f);
    expect(() => completed(f)).toThrow("missing canonical fill");
    fillNativePrimitiveWrapperStorageResources(f.tx, f.pack);
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  it("does not grant completion to an externally filled identical first body", () => {
    const f = fixture();
    f.tx.freezeReservations();
    fillDependencies(f);
    f.tx.fillFunction(
      f.pack.allocation.Boolean,
      buildPrimitiveWrapperAllocationDefinition({
        kind: "Boolean",
        initialCapacity: 8,
        objectTypeIdx: f.tx.physicalIndex(f.objects.object),
        propMapTypeIdx: f.tx.physicalIndex(f.objects.propMap),
        wrapperTypeIdx: f.tx.physicalIndex(f.layouts.types.Boolean),
      }),
    );
    expect(() => completed(f)).toThrow("missing canonical fill");
    expect(() => fillNativePrimitiveWrapperStorageResources(f.tx, f.pack)).toThrow("duplicate function fill");
    expect(f.tx.state).toBe("failed");
    expect(() => completed(f)).toThrow("failed");
  });

  it("rejects duplicate canonical fill while preserving all completed bodies", () => {
    const f = complete();
    const bodies = kinds.flatMap((kind) => [f.pack.allocation[kind].object.body, f.pack.read[kind].object.body]);
    expect(() => fillNativePrimitiveWrapperStorageResources(f.tx, f.pack)).toThrow("duplicate canonical fill");
    expect(
      kinds
        .flatMap((kind) => [f.pack.allocation[kind].object.body, f.pack.read[kind].object.body])
        .every((body, i) => Object.is(body, bodies[i])),
    ).toBe(true);
    expect(Object.is(completed(f), f.pack)).toBe(true);
  });

  for (const kind of kinds)
    for (const role of ["allocation", "read"] as const) {
      it(`rejects a changed completed ${kind} ${role} body`, () => {
        const f = complete();
        completed(f);
        f.pack[role][kind].object.body.push({ op: "nop" });
        expect(() => completed(f)).toThrow("altered completed function");
      });
    }

  it.each(["name", "signature", "slot", "type"] as const)(
    "refuses changed completed %s without a cached verdict",
    (role) => {
      const f = complete();
      completed(f);
      if (role === "name") f.pack.allocation.Number.object.name = "changed";
      if (role === "signature") f.pack.allocation.Number.object.typeIdx = f.pack.read.Boolean.object.typeIdx;
      if (role === "slot")
        f.module.functions[f.module.functions.indexOf(f.pack.read.Number.object)] = { ...f.pack.read.Number.object };
      if (role === "type") {
        const type = f.layouts.types.Number.object;
        if (type.kind !== "struct") throw Error("expected Number wrapper struct");
        type.fields[6]!.mutable = true;
      }
      expect(() => completed(f)).toThrow();
    },
  );

  it("refuses a changed completed real carrier body through live ledger verification", () => {
    const f = complete();
    completed(f);
    f.symbols.functions.box.object.body.push({ op: "nop" });
    expect(() => completed(f)).toThrow("altered completed function");
  });

  it("refuses changed nested prerequisite identities after a positive", () => {
    const f = fixture();
    current(f);
    f.layoutDependencies.strings = { ...f.strings };
    expect(() => current(f)).toThrow("changed dependency identity");
  });

  it("rejects a foreign fill ledger without changing either transaction", () => {
    const f = fixture(),
      other = fixture(),
      a = populations(f),
      b = populations(other);
    expect(() => fillNativePrimitiveWrapperStorageResources(other.tx, f.pack)).toThrow("foreign or copied owner");
    unchanged(f, a);
    unchanged(other, b);
    expect(Object.is(current(f), f.pack)).toBe(true);
    expect(Object.is(current(other), other.pack)).toBe(true);
  });

  it("cannot substitute same-signature foreign tokens through the frozen maps", () => {
    const f = complete(),
      other = complete();
    completed(f);
    completed(other);
    expect(Reflect.set(f.pack.allocation, "Number", other.pack.allocation.Number)).toBe(false);
    expect(Reflect.set(f.pack, "read", other.pack.read)).toBe(false);
    const forged = { ...f.pack, allocation: { ...f.pack.allocation, Number: other.pack.allocation.Number } };
    expect(() => requireCompletedNativePrimitiveWrapperStorage(f.tx, forged, f.plan, f.dependencies)).toThrow(
      "foreign or copied owner",
    );
    expect(Object.is(completed(f), f.pack)).toBe(true);
    expect(Object.is(completed(other), other.pack)).toBe(true);
  });
});
