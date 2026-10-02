// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { buildBoxBooleanType, buildBoxNumberType } from "../src/runtime/wasmgc/values/primitive-layouts.js";
import {
  buildBigIntPrimitiveType,
  buildBoxBigIntBody,
  buildTypeofBigIntBody,
} from "../src/runtime/wasmgc/values/bigint-primitive-bodies.js";

// Independent exact signed donor spans, not regenerated from the extracted builders.
const donor = {
  commit: "7de4c2f421416b8b521dda0b0c777da140ed81df",
  path: "src/codegen/registry/imports.ts",
  sourceSha256: "143a0f5cdc03fa58704b467ea180576913a104080d064011d7caed60f14f378c",
  spans: [
    {
      name: "layout",
      text: '  ctx.mod.types.push({\n    kind: "struct",\n    name: "$BigInt",\n    fields: [{ name: "value", type: { kind: "i64", bigint: true }, mutable: false }],\n  });',
      sha256: "4c9464ff6358ead9029bbcdeab0e349c3d0ee558701843b066cb76cccf4d625b",
    },
    {
      name: "box",
      text: '  registerNative("__box_bigint", i64ToExternref, [\n    { op: "local.get", index: 0 },\n    { op: "struct.new", typeIdx: bigIntStructIdx },\n    { op: "extern.convert_any" },\n  ]);',
      sha256: "306045c9e0b2ff920cf1a8a7fbc96a32aeeb07a49f8b5b44bf74976cdfc20b46",
    },
    {
      name: "typeof",
      text: '  registerNative("__typeof_bigint", externrefToI32, [\n    { op: "local.get", index: 0 },\n    { op: "ref.is_null" },\n    {\n      op: "if",\n      blockType: { kind: "empty" },\n      then: [{ op: "i32.const", value: 0 }, { op: "return" }],\n    },\n    { op: "local.get", index: 0 },\n    { op: "any.convert_extern" },\n    { op: "ref.test", typeIdx: bigIntStructIdx },\n  ]);',
      sha256: "22128c1515fe2599a8ac1995ef8747d9e25a3d72a7c0738c126b3f06ff57cc77",
    },
  ],
} as const;

function donorDefinitions(index: number) {
  let layout: unknown;
  const bodies = new Map<string, unknown>();
  const ctx = {
    mod: {
      types: {
        push(value: unknown) {
          layout = value;
        },
      },
    },
  };
  const registerNative = (name: string, _signature: unknown, body: unknown) => bodies.set(name, body);
  // Execute only the three independently pinned literal registrations.
  for (const span of donor.spans) {
    expect(createHash("sha256").update(span.text).digest("hex")).toBe(span.sha256);
    new Function("ctx", "registerNative", "bigIntStructIdx", "i64ToExternref", "externrefToI32", span.text)(
      ctx,
      registerNative,
      index,
      null,
      null,
    );
  }
  return { layout, box: bodies.get("__box_bigint"), typeOf: bodies.get("__typeof_bigint") };
}

describe("signed-i64 BigInt primitive donor", () => {
  it.each([0, 17, 103])("preserves exact donor definitions at relocated type %i", (index) => {
    const original = donorDefinitions(index);
    expect(buildBigIntPrimitiveType()).toEqual(original.layout);
    expect(buildBoxBigIntBody(index)).toEqual(original.box);
    expect(buildTypeofBigIntBody(index)).toEqual(original.typeOf);
  });
  it("returns independent mutable instruction and layout graphs", () => {
    const first = buildBigIntPrimitiveType();
    first.fields[0]!.mutable = true;
    expect(buildBigIntPrimitiveType()).toEqual(donorDefinitions(0).layout);
    const body = buildBoxBigIntBody(0);
    body.pop();
    expect(buildBoxBigIntBody(0)).toEqual(donorDefinitions(0).box);
  });
});

// Actual body execution; these test reservations confer no prepared-program authority.
function execute() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const bigint = tx.reserveType("control:bigint", buildBigIntPrimitiveType());
  const boolean = tx.reserveType("control:boolean", buildBoxBooleanType());
  const number = tx.reserveType("control:number", buildBoxNumberType());
  const ext = { kind: "externref" } as const,
    i64 = { kind: "i64", bigint: true } as const;
  const box = tx.reserveFunction("control:box", "box", { params: [i64], results: [ext] });
  const read = tx.reserveFunction("control:read", "read", { params: [ext], results: [i64] });
  const isBigInt = tx.reserveFunction("control:isBigInt", "isBigInt", { params: [ext], results: [{ kind: "i32" }] });
  const boxBoolean = tx.reserveFunction("control:boxBoolean", "boxBoolean", {
    params: [{ kind: "i32" }],
    results: [ext],
  });
  const boxNumber = tx.reserveFunction("control:boxNumber", "boxNumber", { params: [{ kind: "f64" }], results: [ext] });
  tx.freezeReservations();
  tx.fillFunction(box, { locals: [], body: buildBoxBigIntBody(bigint.typeIndex) });
  tx.fillFunction(isBigInt, { locals: [], body: buildTypeofBigIntBody(bigint.typeIndex) });
  // Test observer reads the actual stored payload, without adding production unbox semantics.
  tx.fillFunction(read, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: bigint.typeIndex },
      { op: "struct.get", typeIdx: bigint.typeIndex, fieldIdx: 0 },
    ],
  });
  for (const [token, type] of [
    [boxBoolean, boolean],
    [boxNumber, number],
  ] as const)
    tx.fillFunction(token, {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.new", typeIdx: type.typeIndex },
        { op: "extern.convert_any" },
      ],
    });
  for (const [name, token] of Object.entries({ box, read, isBigInt, boxBoolean, boxNumber }))
    tx.defineExport("export:" + name, name, token);
  expect(tx.seal().completedFunctions).toBe(5);
  const compiled = new WebAssembly.Module(emitBinary(module) as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  return new WebAssembly.Instance(compiled).exports as unknown as {
    box(value: bigint): unknown;
    read(value: unknown): bigint;
    isBigInt(value: unknown): number;
    boxBoolean(value: number): unknown;
    boxNumber(value: number): unknown;
  };
}
let instance: ReturnType<typeof execute> | undefined;
const actual = () => (instance ??= execute());
describe("signed-i64 BigInt primitive Wasm execution", () => {
  it.each([-(1n << 63n), -1n, 0n, 1n, (1n << 63n) - 1n])("preserves signed payload %s", (value) => {
    const x = actual(),
      carrier = x.box(value);
    expect(x.isBigInt(carrier)).toBe(1);
    expect(x.read(carrier)).toBe(value);
  });
  it.each([null, undefined, {}, true, false, 0, 1, "1", 1n])("refuses foreign carrier %s", (value) => {
    expect(actual().isBigInt(value)).toBe(0);
  });
  it.each([0, 1])("distinguishes native Boolean and number carriers %i", (value) => {
    const x = actual();
    expect(x.isBigInt(x.boxBoolean(value))).toBe(0);
    expect(x.isBigInt(x.boxNumber(value))).toBe(0);
  });
});
