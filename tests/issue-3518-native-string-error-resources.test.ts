// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { createEmptyModule, type Instr, type ValType } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeErrorResources,
  fillNativeErrorResources,
} from "../src/backend/wasmgc/resources/native-errors.js";
import { BUILTIN_TYPE_TAGS } from "../src/codegen/builtin-tags.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { registerNativeStringTypes } from "../src/codegen/registry/types.js";
import { nativeStringLiteralMaterialization } from "../src/codegen/native-string-literals.js";
import {
  nativeStringLiteralHash,
  planNativeStringLiteral,
} from "../src/runtime/wasmgc/values/string-literal-bodies.js";

const required = ["then", "Chaining cycle detected for promise", "TypeError"];
function reserve(values = required, utf8Storage = false) {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage,
    literals: values.map((value) => ({ value })),
  });
  return { module, tx, strings };
}
function legacy(utf8Storage = false) {
  // Only the fields read/written by the live legacy adapters. No frontend run.
  const ctx = {
    mod: createEmptyModule(),
    utf8Storage,
    nativeStrings: true,
    errorStructTypeIdx: -1,
    nativeStrDataTypeIdx: -1,
    anyStrTypeIdx: -1,
    nativeStrTypeIdx: -1,
    consStrTypeIdx: -1,
    hashedStrTypeIdx: -1,
    utf8StrDataTypeIdx: -1,
    utf8StrTypeIdx: -1,
    numImportGlobals: 0,
    numImportFuncs: 0,
    nativeStrLiteralGlobals: new Map(),
    nativeStrHelpers: new Map(),
    funcTypeCache: new Map(),
    funcMap: new Map(),
    stringGlobalMap: new Map(),
    stringLiteralMap: new Map(),
    stringLiteralValues: new Map(),
    stringLiteralCounter: 0,
  } as unknown as CodegenContext;
  registerNativeStringTypes(ctx);
  return ctx;
}

describe("native literal and TypeError resources (literal-only family)", () => {
  it("executes exact UTF16 strings and all six TypeError fields", () => {
    const { module, tx, strings } = reserve();
    const errors = reserveNativeErrorResources(
      tx,
      { key: "errors" },
      { strings, typeErrorTag: BUILTIN_TYPE_TAGS.TypeError },
    );
    const ext: ValType = { kind: "externref" },
      i32: ValType = { kind: "i32" };
    const fields = [0, 1, 2, 3, 4, 5].map((field) =>
      tx.reserveFunction(`field:${field}`, `field${field}`, {
        params: [ext],
        results: [field === 0 || field === 4 ? i32 : ext],
      }),
    );
    const char = tx.reserveFunction("char", "char", { params: [ext, i32], results: [i32] });
    const length = tx.reserveFunction("length", "length", { params: [ext], results: [i32] });
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, strings);
    fillNativeErrorResources(tx, errors);
    fields.forEach((fn, fieldIdx) =>
      tx.fillFunction(fn, {
        locals: [],
        body: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: errors.type.typeIndex },
          { op: "struct.get", typeIdx: errors.type.typeIndex, fieldIdx },
        ],
      }),
    );
    const flat: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: strings.layout.nativeStrTypeIdx },
    ];
    tx.fillFunction(char, {
      locals: [],
      body: [
        ...flat,
        { op: "struct.get", typeIdx: strings.layout.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "local.get", index: 1 },
        { op: "array.get_u", typeIdx: strings.layout.nativeStrDataTypeIdx },
      ],
    });
    tx.fillFunction(length, {
      locals: [],
      body: [...flat, { op: "struct.get", typeIdx: strings.layout.nativeStrTypeIdx, fieldIdx: 0 }],
    });
    for (const fn of [...fields, char, length, errors.newTypeError])
      tx.defineExport(`export:${fn.key}`, fn.object.name, fn);
    strings.literals.forEach((row, index) => {
      if (row.kind !== "global") throw new Error("expected fixed literal");
      tx.defineExport(`literal:${index}`, `literal${index}`, row.global);
    });
    tx.seal();
    const binary = emitBinary(module);
    expect(WebAssembly.validate(binary)).toBe(true);
    const api = new WebAssembly.Instance(new WebAssembly.Module(binary)).exports as Record<string, any>;
    const read = (value: unknown) =>
      Array.from({ length: api.length(value) }, (_, i) => String.fromCharCode(api.char(value, i))).join("");
    required.forEach((text, index) => expect(read(api[`literal${index}`].value)).toBe(text));
    const message = api.literal1.value;
    const error = api.__new_TypeError(message);
    expect(api.field0(error)).toBe(-11);
    expect(api.field1(error)).toBe(message);
    expect(read(api.field2(error))).toBe("TypeError");
    expect(api.field3(error)).toBeNull();
    expect(api.field4(error)).toBe(-1);
    expect(api.field5(error)).toBeNull();
  });

  it("preserves UTF8 evidence, UTF16 overflow fallback and hash semantics", () => {
    const { strings } = reserve([], true);
    const selected = planNativeStringLiteral(strings.layout, true, "😀", "utf8-guaranteed");
    expect(selected.kind).toBe("global");
    if (selected.kind !== "global") throw new Error("expected global");
    expect(selected.key).toBe("u8:😀");
    expect(selected.init.slice(0, 2)).toEqual([
      { op: "i32.const", value: 2 },
      { op: "i32.const", value: 4 },
    ]);
    expect(planNativeStringLiteral(strings.layout, true, "€".repeat(4000), "utf8-guaranteed")).toMatchObject({
      key: `u16:${"€".repeat(4000)}`,
    });
    expect(() => planNativeStringLiteral(strings.layout, true, "\ud800", "utf8-guaranteed")).toThrow(/surrogate/);
    // Independent BigInt arithmetic oracle avoids sharing the Math.imul implementation.
    let hash = 2166136261n;
    for (const unit of [116n, 104n, 101n, 110n]) hash = ((hash ^ unit) * 16777619n) & 0xffffffffn;
    expect(nativeStringLiteralHash("then")).toBe(Number(BigInt.asIntN(32, hash | 0x80000000n)));
  });

  it("executes a UTF8 literal and an oversized rope with a split surrogate pair", () => {
    const value = "x".repeat(9999) + "😀" + "end";
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const strings = reserveNativeStringLiteralResources(tx, {
      key: "strings",
      utf8Storage: true,
      literals: [{ value: "😀", encoding: "utf8-guaranteed" }, { value }],
    });
    const ctx = legacy(true);
    nativeStringLiteralMaterialization(ctx, "😀", "utf8-guaranteed");
    nativeStringLiteralMaterialization(ctx, value);
    const probe = tx.reserveFunction("probe", "probe", { params: [], results: [{ kind: "i32" }] });
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, strings);
    const utf8 = strings.literals[0]!,
      rope = strings.literals[1]!;
    if (utf8.kind !== "global" || rope.kind !== "callable") throw new Error("wrong materializations");
    const l = strings.layout;
    // Return 1 only if actual stored bytes, UTF16 length, and both rope leaves match.
    const checks: Instr[][] = [
      [
        { op: "global.get", index: tx.physicalIndex(utf8.global) },
        { op: "struct.get", typeIdx: l.utf8StrTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 2 },
        { op: "i32.eq" },
      ],
      ...[240, 159, 152, 128].map((byte, index): Instr[] => [
        { op: "global.get", index: tx.physicalIndex(utf8.global) },
        { op: "struct.get", typeIdx: l.utf8StrTypeIdx, fieldIdx: 3 },
        { op: "i32.const", value: index },
        { op: "array.get_u", typeIdx: l.utf8StrDataTypeIdx },
        { op: "i32.const", value: byte },
        { op: "i32.eq" },
      ]),
      [
        { op: "call", funcIdx: rope.function.handle },
        { op: "struct.get", typeIdx: l.anyStrTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: value.length },
        { op: "i32.eq" },
      ],
      ...[
        [1, 9999, 0xd83d],
        [2, 0, 0xde00],
      ].map(([fieldIdx, index, unit]): Instr[] => [
        { op: "call", funcIdx: rope.function.handle },
        { op: "ref.cast", typeIdx: l.consStrTypeIdx },
        { op: "struct.get", typeIdx: l.consStrTypeIdx, fieldIdx: fieldIdx! },
        { op: "ref.cast", typeIdx: l.nativeStrTypeIdx },
        { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "i32.const", value: index! },
        { op: "array.get_u", typeIdx: l.nativeStrDataTypeIdx },
        { op: "i32.const", value: unit! },
        { op: "i32.eq" },
      ]),
    ];
    tx.fillFunction(probe, {
      locals: [],
      body: checks.flatMap((check, index) => (index === 0 ? check : [...check, { op: "i32.and" }])),
    });
    tx.defineExport("export:probe", "probe", probe);
    tx.seal();
    expect(module.globals).toEqual(ctx.mod.globals);
    const binary = emitBinary(module);
    expect(WebAssembly.validate(binary)).toBe(true);
    const api = new WebAssembly.Instance(new WebAssembly.Module(binary)).exports;
    expect((api.probe as () => number)()).toBe(1);
  });

  it("rejects absent TypeError name and cross-module Error packs", () => {
    const absent = reserve(["then"]);
    expect(() =>
      reserveNativeErrorResources(
        absent.tx,
        { key: "errors" },
        { strings: absent.strings, typeErrorTag: BUILTIN_TYPE_TAGS.TypeError },
      ),
    ).toThrow(/missing literal/);
    const a = reserve(),
      b = reserve();
    const errors = reserveNativeErrorResources(
      a.tx,
      { key: "errors" },
      { strings: a.strings, typeErrorTag: BUILTIN_TYPE_TAGS.TypeError },
    );
    b.tx.freezeReservations();
    expect(() => fillNativeErrorResources(b.tx, errors)).toThrow(/foreign/);
  });

  it("rejects a text label on a foreign or fabricated literal pack", () => {
    const a = reserve(),
      b = reserve();
    expect(() => requireNativeStringLiteral(a.tx, b.strings, "then")).toThrow(/foreign/);
    expect(() => requireNativeStringLiteral(a.tx, { ...a.strings }, "then")).toThrow(/forged/);
    expect(() => requireNativeStringLiteral(a.tx, a.strings, "absent")).toThrow(/missing literal/);
  });

  it("rejects a stale layout", () => {
    const { tx, strings } = reserve();
    const type = strings.types[4]!.object;
    if (type.kind !== "struct") throw new Error("expected hash struct");
    type.fields[3]!.mutable = false;
    expect(() => tx.freezeReservations()).toThrow(/altered/);
  });

  it("rejects missing literal fill and altered completed initializer", () => {
    const a = reserve();
    a.tx.freezeReservations();
    expect(() => a.tx.seal()).toThrow(/missing global fill/);
    const b = reserve();
    b.tx.freezeReservations();
    fillNativeStringLiteralResources(b.tx, b.strings);
    const row = b.strings.literals[0]!;
    if (row.kind !== "global") throw new Error("expected global");
    row.global.object.init[0] = { op: "i32.const", value: 99 };
    expect(() => b.tx.seal()).toThrow(/altered/);
  });

  it("rejects missing error fill, wrong target, duplicate fill and wrong tag", () => {
    const a = reserve();
    const error = reserveNativeErrorResources(
      a.tx,
      { key: "errors" },
      { strings: a.strings, typeErrorTag: BUILTIN_TYPE_TAGS.TypeError },
    );
    a.tx.freezeReservations();
    fillNativeStringLiteralResources(a.tx, a.strings);
    expect(() => fillNativeErrorResources(a.tx, { ...error, newTypeError: {} as never })).toThrow(/forged/);
    expect(() => a.tx.seal()).toThrow(/missing function fill/);
    const b = reserve();
    b.tx.freezeReservations();
    fillNativeStringLiteralResources(b.tx, b.strings);
    expect(() => fillNativeStringLiteralResources(b.tx, b.strings)).toThrow(/duplicate/);
    const c = reserve();
    expect(() =>
      reserveNativeErrorResources(c.tx, { key: "errors" }, { strings: c.strings, typeErrorTag: -10 as -11 }),
    ).toThrow(/incorrect TypeError tag/);
  });
});
