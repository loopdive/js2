// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import type { Instr } from "../src/wasm/model/instructions.js";
import { emitBinary } from "../src/emit/binary.js";
import { buildAnyValueType, buildUndefinedInitializer } from "../src/runtime/wasmgc/values/primitive-layouts.js";
import { requireNativeStringLiteral } from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  buildOwnPropertyBody,
  buildPropertyIsEnumerableBody,
} from "../src/runtime/wasmgc/values/own-property-bodies.js";
import { objectLookupFixture, completeObjectLookupFixture } from "./helpers/native-object-access-fixture.js";
/** Genuine lookup/layout/string owners execute underneath the extracted kernels.
 * No claim is made for unselected late carriers or a completed prototype provider. */
function runtime() {
  const f = objectLookupFixture(),
    { tx, layouts, pack, strings } = f;
  const extern = { kind: "externref" } as const,
    i32 = { kind: "i32" } as const;
  const any = tx.reserveType("control:undefined-type", buildAnyValueType());
  const undefinedGlobal = tx.reserveGlobal(
    "control:undefined",
    "undefined",
    { kind: "ref", typeIdx: any.typeIndex },
    false,
  );
  const undefinedValue = tx.reserveFunction("control:undefined-value", "undefinedValue", {
    params: [],
    results: [extern],
  });
  const make = tx.reserveFunction("control:make", "make", { params: [extern, i32], results: [extern] });
  const putAt = tx.reserveFunction("control:put", "putAt", {
    params: [extern, extern, extern, i32, extern, i32],
    results: [],
  });
  const key = tx.reserveFunction("control:key", "key", { params: [], results: [extern] });
  const own = tx.reserveFunction("control:own", "own", { params: [extern, extern], results: [i32] });
  const enumerable = tx.reserveFunction("control:enum", "enumerable", { params: [extern, extern], results: [i32] });
  completeObjectLookupFixture(f);
  tx.fillGlobal(undefinedGlobal, buildUndefinedInitializer(any.typeIndex));
  tx.fillFunction(undefinedValue, {
    locals: [],
    body: [{ op: "global.get", index: tx.physicalIndex(undefinedGlobal) }, { op: "extern.convert_any" }],
  });
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

  const literal = requireNativeStringLiteral(tx, strings, "own", "wtf16");
  if (literal.kind !== "global") throw Error("expected authentic flat literal");
  tx.fillFunction(key, {
    locals: [],
    body: [{ op: "global.get", index: tx.physicalIndex(literal.global) }, { op: "extern.convert_any" }],
  });
  tx.fillFunction(own, {
    locals: [{ name: "any", type: { kind: "anyref" } }],
    body: buildOwnPropertyBody({
      objectTypeIdx: layouts.object.typeIndex,
      findOwnIdx: pack.findOwn.handle,
      nonObjectArm: { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    }),
  });
  tx.fillFunction(enumerable, {
    locals: [
      { name: "any", type: { kind: "anyref" } },
      { name: "e", type: { kind: "ref_null", typeIdx: layouts.propEntry.typeIndex } },
    ],
    body: buildPropertyIsEnumerableBody({
      objectTypeIdx: layouts.object.typeIndex,
      propEntryTypeIdx: layouts.propEntry.typeIndex,
      findOwnIdx: pack.findOwn.handle,
      enumerableFlag: 2,
    }),
  });
  for (const token of [make, putAt, key, own, enumerable, undefinedValue])
    tx.defineExport("export:" + token.key, token.object.name!, token);
  tx.defineExport("export:hash", "hash", pack.hash);
  tx.seal();
  const compiled = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  return new WebAssembly.Instance(compiled).exports as unknown as {
    make(p: unknown, flags: number): unknown;
    putAt(o: unknown, k: unknown, v: unknown, f: number, g: unknown, slot: number): void;
    key(): unknown;
    own(o: unknown, k: unknown): number;
    enumerable(o: unknown, k: unknown): number;
    undefinedValue(): unknown;
    hash(k: unknown): number;
  };
}
describe("actual eager own-property Wasm kernels", () => {
  it.each(["null", "undefined", "accessor"] as const)(
    "keeps %s-valued own presence separate from enumerability and tombstones",
    (kind) => {
      const r = runtime(),
        key = r.key(),
        object = r.make(null, 128),
        slot = r.hash(key) & 7;
      expect(r.own(object, key)).toBe(0);
      const value = kind === "undefined" ? r.undefinedValue() : null;
      // A host function in the getter slot would throw if any predicate invoked it.
      const getter = () => {
        throw Error("own query invoked getter");
      };
      r.putAt(object, key, value, kind === "accessor" ? 8 : 0, getter, slot);
      expect(r.own(object, key)).toBe(1);
      expect(r.enumerable(object, key)).toBe(0);
      r.putAt(object, key, value, (kind === "accessor" ? 8 : 0) | 2, getter, slot);
      expect(r.own(object, key)).toBe(1);
      expect(r.enumerable(object, key)).toBe(1);
      r.putAt(object, key, value, 128, getter, slot);
      expect(r.own(object, key)).toBe(0);
      expect(r.enumerable(object, key)).toBe(0);
    },
  );
  it("never follows an explicit parent for either own query", () => {
    const r = runtime(),
      key = r.key(),
      parent = r.make(null, 128);
    r.putAt(parent, key, null, 2, null, r.hash(key) & 7);
    const child = r.make(parent, 0);
    expect(r.own(parent, key)).toBe(1);
    expect(r.enumerable(parent, key)).toBe(1);
    expect(r.own(child, key)).toBe(0);
    expect(r.enumerable(child, key)).toBe(0);
  });
  it.each([null, {}, () => 0])("retains absent-helper behavior for non-Object receiver %s", (receiver) => {
    const r = runtime(),
      key = r.key();
    expect(r.own(receiver, key)).toBe(0);
    expect(r.enumerable(receiver, key)).toBe(0);
  });
});
