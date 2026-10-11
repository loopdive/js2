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
  requireNativePrimitiveWrapperLayouts,
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

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" };
const texts = ["hello", "", "\ud83d\ude00", "\ud800"];

/** Real issued carriers/layouts; the test-created prototypes are not intrinsic providers. */
function runtime(offset: boolean) {
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
  const objectPlan = declareNativeObjectLayouts(objectRequirements),
    objects = reserveNativeObjectLayouts(tx, objectRequirements, objectPlan);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: offset,
    literals: texts.map((value) => ({ value, encoding: "wtf16" as const })),
  });
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const bigint = reserveNativeBigIntResources(tx, "bigint", declareNativeBigIntResources("bigint"));
  const operands = reserveBigIntOperands(tx);
  const dependencies = { objects, objectPlan, strings, symbols };
  const plan = declareNativePrimitiveWrapperLayouts("wrappers", {
    object: objects.object.key,
    propMap: objects.propMap.key,
    anyString: nativeStringTypeKeys("strings").any,
    symbol: symbols.types.symbol.key,
  });
  const pack = reserveNativePrimitiveWrapperLayouts(tx, "wrappers", plan, dependencies);
  const initialCapacity = offset ? 16 : 8;
  const bindings = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      {
        kind,
        objectTypeIdx: objects.object.typeIndex,
        propMapTypeIdx: objects.propMap.typeIndex,
        wrapperTypeIdx: pack.types[kind].typeIndex,
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
  const constructors = Object.fromEntries(
    kinds.map((kind) => [kind, tx.reserveFunction("new:" + kind, "new" + kind, definitions[kind].allocation)]),
  );
  const readers = Object.fromEntries(
    kinds.map((kind) => [kind, tx.reserveFunction("read:" + kind, "read" + kind, definitions[kind].read)]),
  );
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
  if (prefix) tx.fillFunction(prefix, { locals: [], body: [] });
  fillNativeStringLiteralResources(tx, strings);
  fillNativeSymbolCarrierResources(tx, symbols);
  fillNativeBigIntResources(tx, bigint);
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
    tx.fillFunction(constructors[kind]!, definitions[kind].allocation);
    tx.fillFunction(readers[kind]!, definitions[kind].read);
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
  requireNativePrimitiveWrapperLayouts(tx, pack, plan, dependencies);
  tx.seal();
  requireNativePrimitiveWrapperLayouts(tx, pack, plan, dependencies);
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
  describe("actual wrapper allocation, shifted=" + offset, () => {
    let r: ReturnType<typeof runtime>;
    beforeAll(() => {
      r = runtime(offset);
    });
    it("instantiates complete real bodies without imports", () => {
      expect(WebAssembly.validate(r.bytes as BufferSource)).toBe(true);
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.pack.completionScope).toBe("primitive-wrapper-types-only");
      expect(requireNativePrimitiveWrapperLayouts(r.tx, r.pack, r.plan, r.dependencies)).toBe(r.pack);
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
      const typeIdx = r.pack.types[kind].typeIndex;
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
      expect(requireNativePrimitiveWrapperLayouts(r.tx, r.pack, r.plan, r.dependencies)).toBe(r.pack);
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

function binding(kind: PrimitiveWrapperKind): PrimitiveWrapperBodyBindings {
  return {
    kind,
    objectTypeIdx: 0,
    propMapTypeIdx: 1,
    wrapperTypeIdx: 2,
    initialCapacity: 8,
    ...(kind === "String" ? { anyStrTypeIdx: 3 } : {}),
    ...(kind === "Symbol" ? { symbolTypeIdx: 4 } : {}),
  } as PrimitiveWrapperBodyBindings;
}
const builders = [buildPrimitiveWrapperAllocationDefinition, buildPrimitiveWrapperDataDefinition];
describe("strict pure construction bindings", () => {
  it.each(kinds)("accepts copied %s construction data and detaches output from later input changes", (kind) => {
    const source = binding(kind),
      copy = structuredClone(source);
    for (const build of builders) expect(build(copy)).toStrictEqual(build(source));
    const definition = buildPrimitiveWrapperAllocationDefinition(copy),
      before = structuredClone(definition);
    (copy as any).objectTypeIdx = 99;
    (copy as any).wrapperTypeIdx = 98;
    expect(definition).toStrictEqual(before);
  });
  for (const kind of kinds) {
    for (const key of Object.keys(binding(kind))) {
      it(`rejects missing ${kind}.${key} in both recipes`, () => {
        const bad = binding(kind);
        Reflect.deleteProperty(bad, key);
        for (const build of builders) expect(() => build(bad)).toThrow();
      });
    }
  }
  it.each([null, undefined, [], 1, "bindings", () => binding("Boolean")].map((value, index) => ({ value, index })))(
    "rejects a non-record binding $index",
    ({ value: bad }) => {
      for (const build of builders) expect(() => build(bad as never)).toThrow("data record");
    },
  );
  it.each(["Other", "boolean", "", null, 1])("rejects unknown kind %s", (kind) => {
    for (const build of builders)
      expect(() => build({ ...binding("Boolean"), kind } as never)).toThrow("unknown wrapper kind");
  });
  it.each([-1, 0.5, NaN, Infinity, 0x100000000, "1", undefined])("rejects malformed coordinate %s", (value) => {
    for (const key of ["objectTypeIdx", "propMapTypeIdx", "wrapperTypeIdx", "anyStrTypeIdx"]) {
      for (const build of builders)
        expect(() => build({ ...binding("String"), [key]: value } as never)).toThrow("invalid type coordinate");
    }
  });
  it.each([0, -1, 3, 0.5, NaN, Infinity, 0x80000000, "8", undefined])(
    "rejects malformed initial capacity %s",
    (initialCapacity) => {
      for (const build of builders)
        expect(() => build({ ...binding("Number"), initialCapacity } as never)).toThrow("positive power of two");
    },
  );
  it.each(["objectTypeIdx", "propMapTypeIdx", "anyStrTypeIdx"])("rejects wrapper-coordinate alias with %s", (key) => {
    const bad = { ...binding("String"), [key]: 2 };
    for (const build of builders) expect(() => build(bad as never)).toThrow("aliased type coordinates");
  });
  it.each(["unknown", "inherited", "getter", "symbol-key", "class-instance", "wrong-payload-binding"])(
    "rejects %s without invoking accessors",
    (variant) => {
      let bad: any = binding("String");
      const getter = vi.fn(() => 3);
      if (variant === "unknown") bad.extra = true;
      if (variant === "inherited")
        bad = Object.assign(Object.create({ anyStrTypeIdx: 3 }), {
          kind: "String",
          objectTypeIdx: 0,
          propMapTypeIdx: 1,
          wrapperTypeIdx: 2,
          initialCapacity: 8,
        });
      if (variant === "getter") Object.defineProperty(bad, "anyStrTypeIdx", { get: getter });
      if (variant === "symbol-key") bad[Symbol("extra")] = true;
      if (variant === "class-instance") bad = Object.assign(new (class Bindings {})(), bad);
      if (variant === "wrong-payload-binding") {
        Reflect.deleteProperty(bad, "anyStrTypeIdx");
        bad.symbolTypeIdx = 3;
      }
      for (const build of builders) expect(() => build(bad)).toThrow();
      expect(getter).not.toHaveBeenCalled();
    },
  );
  it("accepts null-prototype own-data bindings and never falls back to inherited data descriptors", () => {
    const source = binding("Symbol"),
      plain = Object.assign(Object.create(null), source);
    for (const build of builders) expect(build(plain)).toStrictEqual(build(source));
    const getter = vi.fn(() => 4);
    Object.defineProperty(plain, "symbolTypeIdx", { get: getter });
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "value");
    const failures: unknown[] = [];
    try {
      Object.defineProperty(Object.prototype, "value", { value: 4, configurable: true });
      for (const build of builders) {
        try {
          build(plain);
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      Reflect.deleteProperty(Object.prototype, "value");
      if (original) Object.defineProperty(Object.prototype, "value", original);
    }
    expect(failures).toHaveLength(builders.length);
    for (const failure of failures) expect(String(failure)).toContain("non-data binding");
    expect(getter).not.toHaveBeenCalled();
  });
});
