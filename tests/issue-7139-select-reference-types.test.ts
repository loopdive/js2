// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { createIrSelectLowering } from "../src/ir/lowering/select.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { createEmptyModule, type Instr, type LocalDef, type ValType } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("7139-select-reference-types");
const physicalTypes: ValType[] = [
  { kind: "externref" },
  { kind: "ref_extern" },
  { kind: "funcref" },
  { kind: "eqref" },
  { kind: "anyref" },
  { kind: "ref", typeIdx: 0 },
  { kind: "ref_null", typeIdx: 0 },
];
for (const physical of physicalTypes)
  it(`uses the converter's ${physical.kind} slot and preserves reference identity`, () => {
    const logical = { kind: "string" } as const;
    const b = new IrFunctionBuilder(identities.next("choose"), [logical], true);
    const condition = b.addParam("condition", { kind: "val", val: { kind: "i32" } });
    const left = b.addParam("left", logical),
      right = b.addParam("right", logical);
    b.openBlock();
    const result = b.emitSelect(condition, left, right, logical);
    b.terminate({ kind: "return", values: [result] });
    const instruction = b.finish().blocks[0]!.instrs.find((instruction) => instruction.kind === "select")!;
    if (instruction.kind !== "select") throw Error("missing actual select instruction");
    const module = createEmptyModule(),
      emitter = new WasmGcEmitter();
    const locals: LocalDef[] = [],
      body: Instr[] = [];
    let conversions = 0;
    const lower = createIrSelectLowering(
      emitter,
      {
        backend: "wasmgc",
        convertType(type) {
          expect(type).toEqual(logical);
          conversions++;
          return [physical];
        },
      },
      (value, out) => emitter.emitLocalGet(value === condition ? 0 : value === left ? 1 : 2, out),
      (name, type) => {
        const index = 3 + locals.length;
        locals.push({ name, type });
        return index;
      },
    );
    lower(instruction, body);
    expect(conversions).toBe(1);
    expect(locals).toHaveLength(2);
    expect(locals.every(({ type }) => type.kind !== "ref" && type.kind !== "ref_extern")).toBe(true);
    module.types.push(
      { kind: "struct", name: "S", fields: [] },
      { kind: "func", params: [{ kind: "i32" }, physical, physical], results: [physical] },
      { kind: "func", params: [], results: [{ kind: "ref", typeIdx: 0 }] },
      { kind: "func", params: [], results: [{ kind: "i32" }] },
    );
    module.functions.push(
      { name: "run", typeIdx: 1, exported: true, locals, body },
      { name: "make", typeIdx: 2, exported: true, locals: [], body: [{ op: "struct.new", typeIdx: 0 }] },
      { name: "one", typeIdx: 3, exported: true, locals: [], body: [{ op: "i32.const", value: 1 }] },
      { name: "two", typeIdx: 3, exported: true, locals: [], body: [{ op: "i32.const", value: 2 }] },
    );
    for (const [index, name] of ["run", "make", "one", "two"].entries())
      module.exports.push({ name, desc: { kind: "func", index } });
    const compiled = new WebAssembly.Module(new Uint8Array(emitBinary(module)));
    expect(WebAssembly.Module.imports(compiled)).toEqual([]);
    const exports = new WebAssembly.Instance(compiled).exports;
    const run = exports.run as Function,
      make = exports.make as Function;
    const [a, c] =
      physical.kind === "funcref"
        ? [exports.one, exports.two]
        : physical.kind === "externref" || physical.kind === "ref_extern"
          ? [{}, {}]
          : [make(), make()];
    // Vitest's object inspector cannot traverse opaque WasmGC objects.
    expect(Object.is(a, c)).toBe(false);
    expect(Object.is(run(1, a, c), a)).toBe(true);
    expect(Object.is(run(0, a, c), c)).toBe(true);
    expect(Object.is(run(-1, a, c), a)).toBe(true);
    if (physical.kind !== "ref" && physical.kind !== "ref_extern") {
      expect(run(0, a, null)).toBeNull();
      expect(run(1, null, c)).toBeNull();
    }
  });
