// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { lowerIrFunctionToWasm } from "../src/ir/backend/wasm-lowering.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { createEmptyModule, type Instr, type FuncTypeDef } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("7139-select-preservation");
for (const kind of ["f64", "i32"] as const)
  for (const backend of ["wasmgc", "linear"] as const)
    it(`preserves the exact original numeric select body, locals and bytes: ${kind}, ${backend}`, async () => {
      const type = { kind: "val", val: { kind } } as const;
      const builder = new IrFunctionBuilder(identities.next("choose"), [type], true);
      const cond = builder.addParam("condition", { kind: "val", val: { kind: "i32" } }),
        a = builder.addParam("a", type),
        b = builder.addParam("b", type);
      builder.openBlock();
      const result = builder.emitSelect(cond, a, b, type);
      builder.terminate({ kind: "return", values: [result] });
      const module = createEmptyModule();
      const resolver = {
        resolveFunc: () => {
          throw Error("unexpected function resolution");
        },
        resolveGlobal: () => {
          throw Error("unexpected global resolution");
        },
        resolveType: () => {
          throw Error("unexpected type resolution");
        },
        internFuncType: (definition: FuncTypeDef) => {
          const index = module.types.length;
          module.types.push(definition);
          return index;
        },
      };
      const lowered = lowerIrFunctionToWasm(
        builder.finish(),
        resolver,
        backend === "wasmgc" ? new WasmGcEmitter(resolver) : new LinearEmitter(),
      );
      const expected: Instr[] = [
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 0 },
        { op: "select" },
        { op: "return" },
      ];
      expect(lowered.func.body).toEqual(expected);
      expect(lowered.func.locals).toEqual([]);
      module.functions.push(lowered.func);
      module.exports.push({ name: "choose", desc: { kind: "func", index: 0 } });
      const bytes = new Uint8Array(emitBinary(module));
      const golden = { ...module, functions: [{ ...lowered.func, body: expected, locals: [] }] };
      expect(bytes).toEqual(emitBinary(golden));
      const run = (await WebAssembly.instantiate(bytes, {})).instance.exports.choose as Function;
      expect(run(1, 123, 456)).toBe(123);
      expect(run(0, 123, 456)).toBe(456);
    });
