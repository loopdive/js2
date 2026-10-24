// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { createIrSelectLowering } from "../src/ir/lowering/select.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { createEmptyModule, type Instr, type LocalDef } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("7139-select-eager"),
  external = { kind: "val", val: { kind: "externref" } } as const;
for (const throws of [false, true])
  it(`executes helper-level operand calls eagerly before the condition, throws=${throws}`, async () => {
    const b = new IrFunctionBuilder(identities.next("choose"), [external], true);
    const condition = b.addParam("condition", { kind: "val", val: { kind: "i32" } }),
      left = b.addParam("left", external),
      right = b.addParam("right", external);
    b.openBlock();
    const result = b.emitSelect(condition, left, right, external);
    b.terminate({ kind: "return", values: [result] });
    const instruction = b.finish().blocks[0]!.instrs.find((instruction) => instruction.kind === "select")!;
    if (instruction.kind !== "select") throw Error("missing actual select instruction");
    const module = createEmptyModule();
    module.types.push(
      { kind: "func", name: "operand", params: [{ kind: "externref" }], results: [{ kind: "externref" }] },
      { kind: "func", name: "condition", params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
      {
        kind: "func",
        name: "choose",
        params: [{ kind: "i32" }, { kind: "externref" }, { kind: "externref" }],
        results: [{ kind: "externref" }],
      },
      { kind: "func", name: "payload", params: [{ kind: "externref" }], results: [] },
    );
    module.globals.push({ name: "order", type: { kind: "i32" }, mutable: true, init: [{ op: "i32.const", value: 0 }] });
    module.tags.push({ name: "payload", typeIdx: 3 });
    const trace = (digit: number): Instr[] => [
      { op: "global.get", index: 0 },
      { op: "i32.const", value: 10 },
      { op: "i32.mul" },
      { op: "i32.const", value: digit },
      { op: "i32.add" },
      { op: "global.set", index: 0 },
    ];
    module.functions.push(
      { name: "left", typeIdx: 0, exported: false, locals: [], body: [...trace(1), { op: "local.get", index: 0 }] },
      {
        name: "right",
        typeIdx: 0,
        exported: false,
        locals: [],
        body: [...trace(2), { op: "local.get", index: 0 }, ...(throws ? [{ op: "throw" as const, tagIdx: 0 }] : [])],
      },
      {
        name: "condition",
        typeIdx: 1,
        exported: false,
        locals: [],
        body: [...trace(3), { op: "local.get", index: 0 }],
      },
    );
    const locals: LocalDef[] = [],
      body: Instr[] = [],
      emitter = new WasmGcEmitter();
    const lower = createIrSelectLowering(
      emitter,
      { backend: "wasmgc", convertType: () => [{ kind: "externref" as const }] },
      (value, out) => {
        const local = value === condition ? 0 : value === left ? 1 : 2;
        out.push(
          { op: "local.get", index: local },
          { op: "call", funcIdx: value === left ? 0 : value === right ? 1 : 2 },
        );
      },
      (name, type) => {
        const index = 3 + locals.length;
        locals.push({ name, type });
        return index;
      },
    );
    lower(instruction, body);
    expect(body.filter((instruction) => instruction.op === "call").map((instruction) => instruction.funcIdx)).toEqual([
      0, 1, 2,
    ]);
    expect(body.at(-1)?.op).toBe("if");
    module.functions.push({ name: "choose", typeIdx: 2, exported: true, locals, body });
    module.exports.push(
      { name: "choose", desc: { kind: "func", index: 3 } },
      { name: "order", desc: { kind: "global", index: 0 } },
      { name: "payload", desc: { kind: "tag", index: 0 } },
    );
    const binary = new Uint8Array(emitBinary(module));
    const compiled = new WebAssembly.Module(binary);
    expect(WebAssembly.Module.imports(compiled)).toEqual([]);
    const exports = new WebAssembly.Instance(compiled).exports,
      run = exports.choose as Function,
      order = exports.order as WebAssembly.Global,
      tag = exports.payload as WebAssembly.Tag;
    for (const condition of [0, 1]) {
      const a = {},
        b = {};
      order.value = 0;
      if (throws) {
        let error: unknown;
        try {
          run(condition, a, b);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(WebAssembly.Exception);
        expect((error as WebAssembly.Exception).is(tag)).toBe(true);
        expect((error as WebAssembly.Exception).getArg(tag, 0)).toBe(b);
        expect(order.value).toBe(12);
      } else {
        expect(run(condition, a, b)).toBe(condition ? a : b);
        expect(order.value).toBe(123);
      }
    }
  });
