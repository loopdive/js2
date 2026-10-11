// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
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
  PRIMITIVE_WRAPPER_KINDS as kinds,
  PRIMITIVE_WRAPPER_DATA_FIELD,
  type PrimitiveWrapperKind,
} from "../src/runtime/wasmgc/values/primitive-wrapper-layouts.js";
import {
  declareNativePrimitiveWrapperLayouts,
  reserveNativePrimitiveWrapperLayouts,
  requireNativePrimitiveWrapperLayouts,
} from "../src/backend/wasmgc/resources/native-primitive-wrapper-layouts.js";

const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" };
function prerequisite(offset = false, extensible = true) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  if (offset) tx.reserveType("prefix", { kind: "struct", name: "Prefix", fields: [] });
  const requirements = { key: "objects", ...(extensible ? { extensible: true as const } : {}) };
  const objectPlan = declareNativeObjectLayouts(requirements),
    objects = reserveNativeObjectLayouts(tx, requirements, objectPlan);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: offset,
    literals: [{ value: "hello", encoding: "wtf16" }],
  });
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const dependencies = { objects, objectPlan, strings, symbols };
  const keys = {
    object: objects.object.key,
    propMap: objects.propMap.key,
    anyString: nativeStringTypeKeys("strings").any,
    symbol: symbols.types.symbol.key,
  };
  const plan = declareNativePrimitiveWrapperLayouts("wrappers", keys);
  return { module, tx, dependencies, keys, plan, requirements };
}
function fixture(offset = false) {
  const f = prerequisite(offset);
  const plan = structuredClone(f.plan);
  const pack = reserveNativePrimitiveWrapperLayouts(f.tx, "wrappers", plan, f.dependencies);
  return { ...f, plan, pack };
}
const current = (f: ReturnType<typeof fixture>) =>
  requireNativePrimitiveWrapperLayouts(f.tx, f.pack, f.plan, f.dependencies);

/** Test-only constructors exercise the layouts; they are not issued ToObject providers. */
function runtime(offset: boolean) {
  const f = fixture(offset),
    { tx, dependencies: d } = f;
  const bigint = reserveNativeBigIntResources(tx, "bigint", declareNativeBigIntResources("bigint"));
  const operands = reserveBigIntOperands(tx);
  const payloadType = (kind: PrimitiveWrapperKind): ValType =>
    kind === "Boolean" ? i32 : kind === "Number" ? { kind: "f64" } : ext;
  const constructors = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      tx.reserveFunction("new:" + kind, "new" + kind, { params: [payloadType(kind)], results: [ext] }),
    ]),
  );
  const readers = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      tx.reserveFunction("read:" + kind, "read" + kind, { params: [ext], results: [payloadType(kind)] }),
    ]),
  );
  const predicates = Object.fromEntries(
    kinds.map((kind) => [kind, tx.reserveFunction("is:" + kind, "is" + kind, { params: [ext], results: [i32] })]),
  );
  const empty = tx.reserveFunction("empty", "empty", { params: [ext], results: [i32] });
  const string = tx.reserveFunction("string", "string", { params: [], results: [ext] });
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, d.strings);
  fillNativeSymbolCarrierResources(tx, d.symbols);
  fillNativeBigIntResources(tx, bigint);
  fillBigIntOperands(tx, bigint, operands);
  const literal = requireNativeStringLiteral(tx, d.strings, "hello", "wtf16");
  tx.fillFunction(string, {
    locals: [],
    body: [
      literal.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(literal.global) }
        : { op: "call", funcIdx: literal.function.handle },
      { op: "extern.convert_any" },
    ],
  });
  for (const kind of kinds) {
    const typeIdx = f.pack.types[kind].typeIndex;
    const cast: Instr[] =
      kind === "String" || kind === "Symbol"
        ? [
            { op: "any.convert_extern" },
            {
              op: "ref.cast",
              typeIdx: kind === "String" ? d.strings.layout.anyStrTypeIdx : d.symbols.types.symbol.typeIndex,
            },
          ]
        : [];
    tx.fillFunction(constructors[kind]!, {
      locals: [],
      body: [
        { op: "ref.null", typeIdx: d.objects.object.typeIndex },
        { op: "i32.const", value: 8 },
        { op: "array.new_default", typeIdx: d.objects.propMap.typeIndex },
        ...[0, 0, 0, 0].map((value): Instr => ({ op: "i32.const", value })),
        { op: "local.get", index: 0 },
        ...cast,
        { op: "struct.new", typeIdx },
        { op: "extern.convert_any" },
      ],
    });
    tx.fillFunction(readers[kind]!, {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx },
        { op: "struct.get", typeIdx, fieldIdx: PRIMITIVE_WRAPPER_DATA_FIELD },
        ...(cast.length ? [{ op: "extern.convert_any" } as Instr] : []),
      ],
    });
    tx.fillFunction(predicates[kind]!, {
      locals: [],
      body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx }],
    });
    tx.defineExport("export:new:" + kind, "new" + kind, constructors[kind]!);
    tx.defineExport("export:read:" + kind, "read" + kind, readers[kind]!);
    tx.defineExport("export:is:" + kind, "is" + kind, predicates[kind]!);
  }
  const object = d.objects.object.typeIndex;
  const asObject: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: object },
  ];
  tx.fillFunction(empty, {
    locals: [],
    body: [
      ...asObject,
      { op: "struct.get", typeIdx: object, fieldIdx: 2 },
      { op: "i32.eqz" },
      ...Array.from({ length: 8 }, (_, index): Instr[] => [
        ...structuredClone(asObject),
        { op: "struct.get", typeIdx: object, fieldIdx: 1 },
        { op: "i32.const", value: index },
        { op: "array.get", typeIdx: d.objects.propMap.typeIndex },
        { op: "ref.is_null" },
        { op: "i32.and" },
      ]).flat(),
    ],
  });
  tx.defineExport("export:empty", "empty", empty);
  tx.defineExport("export:string", "string", string);
  tx.defineExport("export:symbol", "symbol", d.symbols.functions.box);
  for (const [name, fn] of Object.entries(operands)) tx.defineExport("export:" + name, name, fn);
  current(f);
  tx.seal();
  current(f);
  const bytes = emitBinary(f.module),
    wasm = new WebAssembly.Module(bytes as BufferSource);
  return { f, bytes, wasm, api: new WebAssembly.Instance(wasm).exports as Record<string, (...args: any[]) => any> };
}

for (const offset of [false, true])
  describe("actual private wrapper layouts, shifted=" + offset, () => {
    let r: ReturnType<typeof runtime>;
    beforeAll(() => {
      r = runtime(offset);
    });
    it("instantiates without imports and attests types only", () => {
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.f.pack.completionScope).toBe("primitive-wrapper-types-only");
    });
    it.each(kinds)("keeps %s distinct from all other wrapper brands and primitive payloads", (kind) => {
      const payloads = {
        Boolean: 1,
        Number: -0,
        String: r.api.string!(),
        Symbol: r.api.symbol!(3),
        BigInt: r.api.wide96one!(),
      };
      const payload = payloads[kind],
        object = r.api["new" + kind]!(payload),
        second = r.api["new" + kind]!(payload);
      expect(Object.is(object, second)).toBe(false);
      expect(Object.is(object, payload)).toBe(false);
      expect(Object.is(r.api["read" + kind]!(object), payload)).toBe(true);
      expect(r.api.empty!(object)).toBe(1);
      for (const other of kinds) {
        expect(r.api["is" + other]!(object)).toBe(Number(kind === other));
        expect(r.api["is" + other]!(payload)).toBe(0);
      }
    });
    it.each(Object.keys(bigintOperandValues))(
      "retains exact native BigInt carrier %s without truncation/reboxing",
      (name) => {
        const payload = r.api[name]!();
        expect(Object.is(r.api.readBigInt!(r.api.newBigInt!(payload)), payload)).toBe(true);
      },
    );
    it.each([NaN, Infinity, -Infinity, -0, 0, 1.5])("preserves Number payload %s", (value) => {
      expect(Object.is(r.api.readNumber!(r.api.newNumber!(value)), value)).toBe(true);
    });
  });

describe("issued wrapper layout authority", () => {
  it.each(["remove", "reorder", "replace", "append"])("refuses canonical brand-list mutation: %s", (change) => {
    const before = ["Boolean", "Number", "String", "Symbol", "BigInt"];
    expect(Object.isFrozen(kinds)).toBe(true);
    expect(() => {
      const writable = kinds as unknown as string[];
      if (change === "remove") writable.pop();
      if (change === "reorder") writable.reverse();
      if (change === "replace") writable[0] = "Other";
      if (change === "append") writable.push("Other");
    }).toThrow(TypeError);
    expect(kinds).toEqual(before);
    const f = fixture();
    expect(Object.keys(f.pack.types)).toEqual(before);
    expect(current(f)).toBe(f.pack);
  });

  it.each(["key", "extensible"])("refuses inherited descriptor value pollution for %s", (field) => {
    let reads = 0,
      failure: unknown;
    const requirements = { key: "objects", extensible: true as const };
    Object.defineProperty(requirements, field, {
      configurable: true,
      get() {
        reads++;
        return field === "key" ? "objects" : true;
      },
    });
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, "value");
    try {
      Object.defineProperty(Object.prototype, "value", {
        value: field === "key" ? "objects" : true,
        configurable: true,
      });
      try {
        declareNativeObjectLayouts(requirements);
      } catch (error) {
        failure = error;
      }
    } finally {
      Reflect.deleteProperty(Object.prototype, "value");
      if (prior) Object.defineProperty(Object.prototype, "value", prior);
    }
    expect(reads).toBe(0);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/non-data resource key|explicit true data field/);
  });
  it("refuses the unchanged final ordinary layout before appending", () => {
    const f = prerequisite(false, false),
      before = f.module.types.slice();
    expect(() => reserveNativePrimitiveWrapperLayouts(f.tx, "wrappers", f.plan, f.dependencies)).toThrow(
      "extensible root",
    );
    expect(f.module.types).toEqual(before);
  });
  it.each(["copy", "foreign ledger", "copied plan", "copied dependencies"])("refuses %s", (variant) => {
    const f = fixture();
    expect(() =>
      requireNativePrimitiveWrapperLayouts(
        variant === "foreign ledger" ? prerequisite().tx : f.tx,
        variant === "copy" ? { ...f.pack } : f.pack,
        variant === "copied plan" ? structuredClone(f.plan) : f.plan,
        variant === "copied dependencies" ? { ...f.dependencies } : f.dependencies,
      ),
    ).toThrow();
  });
  it.each(["parent", "payload", "mutable", "missing brand", "reordered"])(
    "refuses a %s plan before appending",
    (variant) => {
      const f = prerequisite(),
        plan = structuredClone(f.plan) as any;
      if (variant === "parent") plan.declarations[0].shape.parent.typeKey = f.keys.propMap;
      if (variant === "payload") plan.declarations[0].shape.fields[6].type = { kind: "externref" };
      if (variant === "mutable") plan.declarations[0].shape.fields[6].mutable = true;
      if (variant === "missing brand") plan.declarations.pop();
      if (variant === "reordered") plan.declarations.reverse();
      const before = f.module.types.slice();
      expect(() => reserveNativePrimitiveWrapperLayouts(f.tx, "wrappers", plan, f.dependencies)).toThrow(
        "substituted declaration plan",
      );
      expect(f.module.types).toEqual(before);
    },
  );
  it("refuses a duplicate last wrapper key without reserving earlier brands", () => {
    const f = prerequisite();
    f.tx.reserveType("wrappers:BigInt", { kind: "struct", name: "Unrelated", fields: [] });
    const before = f.module.types.slice();
    expect(() => reserveNativePrimitiveWrapperLayouts(f.tx, "wrappers", f.plan, f.dependencies)).toThrow("duplicate");
    expect(f.module.types).toEqual(before);
  });
  it("refuses a foreign Symbol owner before reserving any wrapper", () => {
    const f = prerequisite(),
      other = prerequisite();
    const before = f.module.types.slice();
    expect(() =>
      reserveNativePrimitiveWrapperLayouts(f.tx, "wrappers", f.plan, {
        ...f.dependencies,
        symbols: other.dependencies.symbols,
      }),
    ).toThrow();
    expect(f.module.types).toEqual(before);
  });
  it("rejects actual issued payload-field mutation", () => {
    const f = fixture(),
      definition = f.pack.types.Boolean.object;
    if (definition.kind !== "struct") throw Error("fixture");
    definition.fields[6]!.mutable = true;
    expect(() => current(f)).toThrow();
  });
  it("refuses reservation after the ledger freezes", () => {
    const f = prerequisite();
    f.tx.freezeReservations();
    expect(() => reserveNativePrimitiveWrapperLayouts(f.tx, "wrappers", f.plan, f.dependencies)).toThrow(
      "reservation phase",
    );
  });
  it("detects mutated payload shape after issue", () => {
    const f = fixture();
    const row = f.plan.declarations[0]!;
    if (row.space !== "type" || row.shape.kind !== "struct") throw Error("fixture");
    (row.shape.fields[6] as any).mutable = true;
    expect(() => current(f)).toThrow("changed declaration plan");
  });
  it("detects changed explicit root requirements", () => {
    const f = fixture();
    Reflect.deleteProperty(f.requirements, "extensible");
    expect(() => current(f)).toThrow("stale layout requirements");
  });
  it("refuses a dependency getter without invoking it", () => {
    const f = prerequisite();
    let reads = 0;
    const dependencies = {
      ...f.dependencies,
      get symbols() {
        reads++;
        return f.dependencies.symbols;
      },
    };
    expect(() => reserveNativePrimitiveWrapperLayouts(f.tx, "wrappers", f.plan, dependencies)).toThrow(
      "own data fields",
    );
    expect(reads).toBe(0);
  });
});
