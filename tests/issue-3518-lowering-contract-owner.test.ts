// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as oldDynamic from "../src/ir/lowering-dynamic-scratch.js";
import * as dynamic from "../src/backend/wasmgc/lowering/dynamic-scratch.js";
import * as oldInt32 from "../src/ir/backend/wasm-int32-coercion.js";
import * as int32 from "../src/backend/wasmgc/lowering/wasm-int32-coercion.js";
import * as oldMinMax from "../src/ir/backend/wasm-math-minmax.js";
import * as minMax from "../src/backend/wasmgc/lowering/wasm-math-minmax.js";
import type { IrType } from "../src/ir/core/types.js";
import type { Instr, LocalDef, ValType } from "../src/wasm/model/instructions.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";

const repository = resolve(import.meta.dirname, "..");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const pairs = [
  {
    name: "dynamic scratch",
    implementation: "src/backend/wasmgc/lowering/dynamic-scratch.ts",
    bytes: 1346,
    sha256: "e70eaec584d4fca7d2d17f9ce496536626e7fb287cd018c91705ca12f6b5d609",
    routes: [
      ["../../../ir/core/types.js", "./nodes.js"],
      ["../../../wasm/model/instructions.js", "./types.js"],
    ],
  },
  {
    name: "integer coercion",
    implementation: "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",
    bytes: 3778,
    sha256: "23cf996416285cf8495c2c6977396c9c81eaf2af79d8c15f1c8d6ef6f05da2a0",
    routes: [["../../../wasm/model/instructions.js", "../types.js"]],
  },
  {
    name: "math min/max",
    implementation: "src/backend/wasmgc/lowering/wasm-math-minmax.ts",
    bytes: 1664,
    sha256: "76a3e201e5ed64e768963facfd87fdaedba31b0bcbd3b73300eb647237c4f822",
    routes: [["../../../wasm/model/instructions.js", "../types.js"]],
  },
] as const;

describe("three Wasm lowering helper owners", () => {
  it.each([
    ["dynamic scratch", oldDynamic.createIrDynamicScratchLocals, dynamic.createIrDynamicScratchLocals],
    ["integer coercion", oldInt32.emitWasmInt32Coercion, int32.emitWasmInt32Coercion],
    ["clz32", oldInt32.emitWasmMathClz32, int32.emitWasmMathClz32],
    ["imul", oldInt32.emitWasmMathImul, int32.emitWasmMathImul],
    ["math min/max", oldMinMax.emitWasmMathMinMax, minMax.emitWasmMathMinMax],
  ])("preserves the actual %s function identity", (_name, legacy, canonical) => {
    expect(legacy).toBe(canonical);
  });

  it("preserves public scratch and operation type contracts", () => {
    expectTypeOf<oldDynamic.IrDynamicScratchLocals>().toEqualTypeOf<dynamic.IrDynamicScratchLocals>();
    expectTypeOf<oldInt32.WasmInt32CoercionScratch>().toEqualTypeOf<int32.WasmInt32CoercionScratch>();
    expectTypeOf<oldMinMax.WasmMathMinMaxScratch>().toEqualTypeOf<minMax.WasmMathMinMaxScratch>();
    expectTypeOf<oldMinMax.WasmMathMinMaxOperation>().toEqualTypeOf<minMax.WasmMathMinMaxOperation>();
  });

  it.each(pairs)("recovers the complete pinned $name donor through only canonical imports", (pair) => {
    const current = readFileSync(resolve(repository, pair.implementation), "utf8");
    let original = current;
    for (const [after, before] of pair.routes) {
      expect(original.split(`"${after}"`)).toHaveLength(2);
      original = original.replace(`"${after}"`, `"${before}"`);
    }
    expect(Buffer.byteLength(original)).toBe(pair.bytes);
    expect(sha256(original)).toBe(pair.sha256);
    let replay = original;
    for (const [after, before] of pair.routes) replay = replay.replace(`"${before}"`, `"${after}"`);
    expect(replay).toBe(current);
    const imports = current.split("\n").filter((line) => line.startsWith("import "));
    expect(imports.length).toBe(pair.routes.length);
    expect(imports.every((line) => line.startsWith("import type "))).toBe(true);
  });
});

type ScratchLocal = LocalDef & { readonly logicalType: IrType };
const orders = [
  ["tag", "toNumber", "instanceofTag"],
  ["tag", "instanceofTag", "toNumber"],
  ["toNumber", "tag", "instanceofTag"],
  ["toNumber", "instanceofTag", "tag"],
  ["instanceofTag", "tag", "toNumber"],
  ["instanceofTag", "toNumber", "tag"],
] as const;

describe("dynamic scratch allocation semantics", () => {
  it.each(orders.map((order) => [order.join(" -> "), order] as const))(
    "allocates lazily in first-use order %s",
    (_name, order) => {
      const carrier: ValType = { kind: "i64" };
      const existing: ScratchLocal = {
        name: "existing",
        type: { kind: "f64" },
        logicalType: { kind: "val", val: { kind: "f64" } },
      };
      const locals = [existing];
      const legacyLocals = [existing];
      const scratch = dynamic.createIrDynamicScratchLocals(3, locals);
      const legacy = oldDynamic.createIrDynamicScratchLocals(3, legacyLocals);
      expect(locals).toEqual([existing]);
      for (const [ordinal, method] of order.entries()) {
        expect(method === "tag" ? scratch.tag(carrier) : scratch[method]()).toBe(4 + ordinal);
        expect(method === "tag" ? legacy.tag(carrier) : legacy[method]()).toBe(4 + ordinal);
        const type: ValType =
          method === "tag" ? carrier : method === "toNumber" ? { kind: "externref" } : { kind: "i32" };
        const name =
          method === "tag"
            ? "$dyn_tag_scratch"
            : method === "toNumber"
              ? `__tmp_${1 + ordinal}`
              : "$instanceof_tag_scratch";
        expect(locals[1 + ordinal]).toEqual({ name, type, logicalType: { kind: "val", val: type } });
        expect(locals).toEqual(legacyLocals);
      }
      expect(locals[0]).toBe(existing);
      expect(legacyLocals[0]).toBe(existing);
      const unrelated: ScratchLocal = {
        name: "unrelated",
        type: { kind: "i32" },
        logicalType: { kind: "val", val: { kind: "i32" } },
      };
      locals.push(unrelated);
      for (const [ordinal, method] of order.entries()) {
        expect(method === "tag" ? scratch.tag({ kind: "i32" }) : scratch[method]()).toBe(4 + ordinal);
      }
      expect(locals).toHaveLength(5);
      expect(locals.at(-1)).toBe(unrelated);
      expect(locals[1 + order.indexOf("tag")!]!.type).toBe(carrier);
    },
  );

  it("uses current external local length without sharing cached state across factories", () => {
    const a: ScratchLocal[] = [],
      b: ScratchLocal[] = [];
    const first = dynamic.createIrDynamicScratchLocals(2, a),
      second = dynamic.createIrDynamicScratchLocals(7, b);
    a.push({ name: "external", type: { kind: "i32" }, logicalType: { kind: "val", val: { kind: "i32" } } });
    expect(first.toNumber()).toBe(3);
    expect(a[1]!.name).toBe("__tmp_1");
    expect(second.instanceofTag()).toBe(7);
    expect(second.toNumber()).toBe(8);
    expect(first.instanceofTag()).toBe(4);
    expect(first.toNumber()).toBe(3);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(2);
    expect(a[1]).not.toBe(b[1]);
  });
});

function binary(params: number, result: ValType, locals: LocalDef[], body: Instr[]): Uint8Array {
  const module = createEmptyModule();
  module.types.push({
    kind: "func",
    params: Array.from({ length: params }, () => ({ kind: "f64" })),
    results: [result],
  });
  module.functions.push({ name: "invoke", typeIdx: 0, locals, body, exported: true });
  module.exports.push({ name: "invoke", desc: { kind: "func", index: 0 } });
  return emitBinary(module);
}
async function instantiate(bytes: Uint8Array): Promise<(...values: number[]) => number> {
  const instance = await WebAssembly.instantiate(new WebAssembly.Module(Uint8Array.from(bytes)), {});
  return instance.exports.invoke as (...values: number[]) => number;
}
const scratch: int32.WasmInt32CoercionScratch = { bits: 3, exponent: 4, significand: 5, magnitude: 6 };
const intEdges = [
  0,
  -0,
  NaN,
  Infinity,
  -Infinity,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  0.999,
  -0.999,
  3.9,
  -3.9,
  -1,
  2 ** 31 - 1,
  -(2 ** 31),
  2 ** 31,
  -(2 ** 31) - 1,
  2 ** 32 - 1,
  2 ** 32,
  2 ** 32 + 1,
  -(2 ** 32),
  -(2 ** 32) - 1,
  2 ** 63,
  2 ** 63 + 2048,
  2 ** 64 + 4096,
  2 ** 65 + 8192,
  -(2 ** 64) - 4096,
  2 ** 80,
  1e20,
  -1e20,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
] as const;
const imulPairs = [
  [NaN, 1],
  [Infinity, -3],
  [-Infinity, 7],
  [-0, 7],
  [0, -7],
  [-3.9, 5.9],
  [3.9, -5.9],
  [-1, 2],
  [0xffff_ffff, 2],
  [0x8000_0000, 2],
  [0x7fff_ffff, 0x7fff_ffff],
  [0xffff_ffff, 0xffff_ffff],
  [2 ** 32 + 1, 2 ** 32 + 1],
  [-(2 ** 32) - 1, 3],
  [2 ** 63 + 2048, 3],
  [2 ** 64 + 4096, 5],
  [2 ** 65 + 8192, -7],
  [2 ** 80, 11],
  [1e20, -13],
  [Number.MAX_VALUE, 17],
  [-Number.MAX_VALUE, -17],
] as const;

type IntegerMode = "coercion" | "clz32" | "imul";
function integerBody(owner: typeof int32, mode: IntegerMode): Instr[] {
  const body: Instr[] = [{ op: "nop" }, { op: "local.get", index: 0 }];
  if (mode === "imul") {
    body.push({ op: "local.get", index: 1 });
    owner.emitWasmMathImul(body, scratch, 7);
  } else if (mode === "clz32") owner.emitWasmMathClz32(body, scratch);
  else owner.emitWasmInt32Coercion(body, scratch);
  return body;
}
function integerBinary(owner: typeof int32, mode: IntegerMode) {
  const params = mode === "imul" ? 2 : 1;
  const locals: LocalDef[] = Array.from({ length: (mode === "imul" ? 8 : 7) - params }, (_, i) => ({
    name: `scratch_${i}`,
    type: { kind: "i64" },
  }));
  if (mode === "imul") locals[7 - params] = { name: "rhs", type: { kind: "i32" } };
  return binary(params, { kind: mode === "coercion" ? "i32" : "f64" }, locals, integerBody(owner, mode));
}

describe("exact emitted integer operations", () => {
  it.each(["coercion", "clz32", "imul"] as const)(
    "preserves the complete %s instruction tree and emitted binary",
    (mode) => {
      expect(integerBody(int32, mode)).toEqual(integerBody(oldInt32, mode));
      expect(integerBinary(int32, mode)).toEqual(integerBinary(oldInt32, mode));
      const body = integerBody(int32, mode);
      expect(body[0]).toEqual({ op: "nop" });
      if (mode === "clz32") expect(body.slice(-2)).toEqual([{ op: "i32.clz" }, { op: "f64.convert_i32_s" }]);
      if (mode === "imul")
        expect(body.slice(-3)).toEqual([{ op: "local.get", index: 7 }, { op: "i32.mul" }, { op: "f64.convert_i32_s" }]);
    },
  );
  it("retains independent bit decomposition constants, scratch indices and sign branches", () => {
    const out: Instr[] = [];
    int32.emitWasmInt32Coercion(out, scratch);
    expect(out.slice(0, 10)).toEqual([
      { op: "i64.reinterpret_f64" },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "i64.const", value: 52n },
      { op: "i64.shr_u" },
      { op: "i64.const", value: 0x7ffn },
      { op: "i64.and" },
      { op: "i64.const", value: 1023n },
      { op: "i64.sub" },
      { op: "local.set", index: 4 },
    ]);
    expect(out.at(-1)).toEqual({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }, { op: "local.get", index: 6 }, { op: "i32.wrap_i64" }, { op: "i32.sub" }],
      else: [{ op: "local.get", index: 6 }, { op: "i32.wrap_i64" }],
    });
    expect(out).toContainEqual({ op: "i64.const", value: 83n });
    expect(out).toContainEqual({ op: "i64.const", value: 0xfffffffffffffn });
    expect(out).toContainEqual({ op: "i64.const", value: 0x10000000000000n });
  });
  it("executes exact signed and unsigned low32 patterns through real Wasm", async () => {
    const invoke = await instantiate(integerBinary(int32, "coercion"));
    for (const value of intEdges) {
      expect(invoke(value), `signed ${String(value)}`).toBe(value | 0);
      expect(invoke(value) >>> 0, `unsigned ${String(value)}`).toBe(value >>> 0);
    }
  });
  it("executes clz32 wide numeric edges through real Wasm", async () => {
    const invoke = await instantiate(integerBinary(int32, "clz32"));
    for (const value of intEdges) expect(invoke(value), String(value)).toBe(Math.clz32(value));
  });
  it("executes imul operand coercion and modulo multiplication through real Wasm", async () => {
    const invoke = await instantiate(integerBinary(int32, "imul"));
    for (const [left, right] of imulPairs) {
      const actual = invoke(left, right);
      expect(actual, `${left},${right}`).toBe(Math.imul(left, right));
      if (actual === 0) expect(Object.is(actual, -0)).toBe(false);
    }
  });
});

const minMaxScratch: minMax.WasmMathMinMaxScratch = { left: 4, right: 2 };
function minMaxBody(owner: typeof minMax, operation: minMax.WasmMathMinMaxOperation): Instr[] {
  const out: Instr[] = [{ op: "nop" }, { op: "local.get", index: 0 }, { op: "local.get", index: 1 }];
  owner.emitWasmMathMinMax(out, minMaxScratch, operation);
  return out;
}
function minMaxBinary(owner: typeof minMax, operation: minMax.WasmMathMinMaxOperation) {
  return binary(
    2,
    { kind: "f64" },
    Array.from({ length: 3 }, (_, i) => ({ name: `tmp_${i}`, type: { kind: "f64" } })),
    minMaxBody(owner, operation),
  );
}
const minMaxEdges = [
  [3, 7],
  [7, 3],
  [-5, -2],
  [-2, -5],
  [-Infinity, 1],
  [Infinity, -1],
  [NaN, 1],
  [1, NaN],
  [NaN, NaN],
  [0, -0],
  [-0, 0],
  [-0, -0],
  [0, 0],
  [Number.MAX_VALUE, -Number.MAX_VALUE],
] as const;

describe("exact emitted min/max operations", () => {
  it.each(["f64.min", "f64.max"] as const)("preserves %s complete opcodes, operand order and binary", (operation) => {
    const body = minMaxBody(minMax, operation);
    expect(body).toEqual(minMaxBody(oldMinMax, operation));
    expect(minMaxBinary(minMax, operation)).toEqual(minMaxBinary(oldMinMax, operation));
    expect(body.slice(3, 8)).toEqual([
      { op: "local.set", index: 2 },
      { op: "local.set", index: 4 },
      { op: "local.get", index: 4 },
      { op: "local.get", index: 4 },
      { op: "f64.ne" },
    ]);
    expect(body[8]).toEqual({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "local.get", index: 4 }],
      else: [
        { op: "local.get", index: 2 },
        { op: "local.get", index: 2 },
        { op: "f64.ne" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [{ op: "local.get", index: 2 }],
          else: [{ op: "local.get", index: 4 }, { op: "local.get", index: 2 }, { op: operation }],
        },
      ],
    });
  });
  it.each(["f64.min", "f64.max"] as const)(
    "executes %s NaN, infinity and signed-zero edges through real Wasm",
    async (operation) => {
      const invoke = await instantiate(minMaxBinary(minMax, operation));
      for (const [left, right] of minMaxEdges) {
        const expected = operation === "f64.min" ? Math.min(left, right) : Math.max(left, right);
        const actual = invoke(left, right);
        if (Number.isNaN(expected)) expect(Number.isNaN(actual)).toBe(true);
        else expect(Object.is(actual, expected), `${left},${right}`).toBe(true);
      }
    },
  );
});
