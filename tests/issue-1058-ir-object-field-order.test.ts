// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { BytecodeEmitter, BytecodeTypeConverter } from "../src/ir/backend/bytecode-emitter.js";
import { runSink } from "../src/ir/backend/bytecode-vm.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { lowerIrFunctionBody, lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { irVal, type IrObjectShape } from "../src/ir/nodes.js";
import { createEmptyModule, type ValType } from "../src/ir/types.js";
import type { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-1058-ir-object-field-order");

function lowerObject(order: readonly number[], mixed: boolean, effects = false, mutate = false) {
  const aType: ValType = { kind: "i32" };
  const zType: ValType = mixed ? { kind: "f64" } : { kind: "i32" };
  const shape: IrObjectShape = {
    fields: [
      { name: "a", type: irVal(aType) },
      { name: "z", type: irVal(zType) },
    ],
  };
  const ctx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, {});
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "PhysicalObject",
    fields:
      order[0] === 0
        ? [
            { name: "a", type: aType, mutable: true },
            { name: "z", type: zType, mutable: true },
          ]
        : [
            { name: "z", type: zType, mutable: true },
            { name: "a", type: aType, mutable: true },
          ],
  });
  const counter = ctx.mod.globals.length;
  ctx.mod.globals.push({ name: "counter", type: aType, mutable: true, init: [{ op: "i32.const", value: 0 }] });
  const next = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, next, {
    name: "next",
    typeIdx: addFuncType(ctx, [], [aType]),
    locals: [],
    exported: false,
    body: [
      { op: "global.get", index: counter },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "global.set", index: counter },
      { op: "global.get", index: counter },
    ],
  });
  const resolver: IrLowerResolver = {
    resolveFunc: (ref) => {
      if (ref.name === "next") return next;
      throw new Error("unexpected call");
    },
    resolveGlobal: () => {
      throw new Error("unexpected global");
    },
    resolveType: () => {
      throw new Error("unexpected type");
    },
    internFuncType: (type) => addFuncType(ctx, type.params, type.results),
    resolveObject: () => ({ typeIdx, fieldIdx: (name) => order[name === "a" ? 0 : 1]! }),
  };
  const b = new IrFunctionBuilder(identities.next("run"), [irVal(aType), irVal(zType)], true);
  const a = b.addParam("a", irVal(aType));
  const z = b.addParam("z", irVal(zType));
  b.openBlock();
  const values = effects
    ? [b.emitCall(irRuntimeFuncRef("next"), [], irVal(aType))!, b.emitCall(irRuntimeFuncRef("next"), [], irVal(zType))!]
    : [a, z];
  const object = b.emitObjectNew(shape, values);
  if (mutate) b.emitObjectSet(object, "a", b.emitConst({ kind: "i32", value: 99 }, irVal(aType)));
  b.terminate({
    kind: "return",
    values: [b.emitObjectGet(object, "a", irVal(aType)), b.emitObjectGet(object, "z", irVal(zType))],
  });
  const { func } = lowerIrFunctionToWasm(b.finish(), resolver);
  const handle = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, handle, func);
  ctx.mod.exports.push({ name: "run", desc: { kind: "func", index: handle } });
  return emitBinary(ctx.mod);
}

it.each([false, true])("constructs an explicit reversed IR layout (mixed types=%s)", (mixed) => {
  const module = new WebAssembly.Module(lowerObject([1, 0], mixed));
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const run = new WebAssembly.Instance(module, {}).exports.run as (a: number, z: number) => number[];
  expect(run(17, mixed ? 23.5 : 23)).toEqual([17, mixed ? 23.5 : 23]);
});

it.each([false, true])("keeps canonical construction working (mixed types=%s)", (mixed) => {
  const module = new WebAssembly.Module(lowerObject([0, 1], mixed));
  const run = new WebAssembly.Instance(module, {}).exports.run as (a: number, z: number) => number[];
  expect(run(17, mixed ? 23.5 : 23)).toEqual([17, mixed ? 23.5 : 23]);
});

it.each([false, true])("preserves effect order and field mutation in a reversed layout (mutate=%s)", (mutate) => {
  const module = new WebAssembly.Module(lowerObject([1, 0], false, true, mutate));
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const run = new WebAssembly.Instance(module, {}).exports.run as (a: number, z: number) => number[];
  expect(run(0, 0)).toEqual([mutate ? 99 : 1, 2]);
  expect(run(0, 0)).toEqual([mutate ? 99 : 3, 4]);
});

it.each([
  [0, 0],
  [-1, 0],
  [2, 0],
  [0.5, 0],
  [NaN, 0],
])("rejects non-permutation field indexes %j", (...order) => {
  expect(() => lowerObject(order, false)).toThrow(/object layout.*permutation/);
});

it.each(["a", "z"])("honors reversed construction order in the bytecode VM for %s", (name) => {
  const type = irVal({ kind: "f64" });
  const shape = {
    fields: [
      { name: "a", type },
      { name: "z", type },
    ],
  };
  const b = new IrFunctionBuilder(identities.next("bytecode"), [type], true);
  const a = b.addParam("a", type);
  const z = b.addParam("z", type);
  b.openBlock();
  const object = b.emitObjectNew(shape, [a, z]);
  b.terminate({ kind: "return", values: [b.emitObjectGet(object, name, type)] });
  const unused = (): never => {
    throw new Error("unexpected resolver operation");
  };
  const resolver: IrLowerResolver = {
    resolveFunc: unused,
    resolveGlobal: unused,
    resolveType: unused,
    internFuncType: unused,
    resolveObject: () => ({ typeIdx: 0, fieldIdx: (field) => (field === "a" ? 1 : 0) }),
  };
  const lowered = lowerIrFunctionBody(b.finish(), resolver, new BytecodeEmitter(), new BytecodeTypeConverter());
  expect(runSink(lowered.body, [17, 23])).toBe(name === "a" ? 17 : 23);
});
