// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { resolveIrDynamicCarrierType } from "../src/codegen/any-helpers.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { addFuncType, getOrRegisterRefCellType } from "../src/codegen/registry/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { irDynamic, irVal, type IrType } from "../src/ir/nodes.js";
import { createEmptyModule } from "../src/ir/types.js";
import { lowerPreparedClosureSupportType } from "../src/ir/prepared-closure-support.js";
import type { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-1058-dynamic-cell");

it.each([false, true])("preserves shared dynamic cells with the canonical carrier (native=%s)", (native) => {
  const ctx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, { fast: native, nativeStrings: native });
  const dynamic = irDynamic();
  const carrier = resolveIrDynamicCarrierType(ctx);
  expect(lowerPreparedClosureSupportType(ctx, dynamic)).toEqual(carrier);
  const boxed: IrType = { kind: "boxed", inner: dynamic };
  const writer = new IrFunctionBuilder(identities.next("write"), [dynamic], false);
  const captured = writer.addParam("captured", boxed);
  const replacement = writer.addParam("replacement", dynamic);
  writer.openBlock();
  writer.emitRefCellSet(captured, replacement);
  writer.terminate({ kind: "return", values: [writer.emitRefCellGet(captured, dynamic)] });
  const writeFn = writer.finish();
  const writeHandle = mintDefinedFunc(ctx);
  const resolver: IrLowerResolver = {
    resolveFunc: (ref) => {
      if (ref.name === "write") return writeHandle;
      throw new Error("unexpected call");
    },
    resolveGlobal: () => {
      throw new Error("unexpected global");
    },
    resolveType: () => {
      throw new Error("unexpected type");
    },
    internFuncType: (type) => addFuncType(ctx, type.params, type.results),
    resolveDynamic: () => carrier,
    resolveRefCell: (inner) => ({ typeIdx: getOrRegisterRefCellType(ctx, inner), fieldIdx: 0 }),
  };
  pushDefinedFunc(ctx, writeHandle, lowerIrFunctionToWasm(writeFn, resolver).func);
  const reader = new IrFunctionBuilder(identities.next("run"), [dynamic, dynamic], true);
  const initial = reader.addParam("initial", dynamic);
  const next = reader.addParam("next", dynamic);
  reader.openBlock();
  const cell = reader.emitTypedRefCellNew(initial, dynamic);
  const before = reader.emitRefCellGet(cell, dynamic);
  reader.emitCall(irUnitFuncRef(writeFn), [cell, next], dynamic);
  reader.terminate({ kind: "return", values: [before, reader.emitRefCellGet(cell, dynamic)] });
  const handle = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, handle, lowerIrFunctionToWasm(reader.finish(), resolver).func);
  ctx.mod.exports.push({ name: "run", desc: { kind: "func", index: handle } });
  if (native) {
    expect(ctx.undefinedGlobalIdx).toBeDefined();
    const getter = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, getter, {
      name: "undefinedValue",
      typeIdx: addFuncType(ctx, [], [carrier]),
      locals: [],
      exported: true,
      body: [{ op: "global.get", index: ctx.undefinedGlobalIdx! }],
    });
    ctx.mod.exports.push({ name: "undefinedValue", desc: { kind: "func", index: getter } });
  }
  const module = new WebAssembly.Module(emitBinary(ctx.mod));
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = new WebAssembly.Instance(module, {}).exports;
  const run = exports.run as (a: unknown, b: unknown) => unknown[];
  if (native) {
    const undefinedValue = (exports.undefinedValue as () => unknown)();
    expect(undefinedValue).not.toBeNull();
    const first = run(undefinedValue, null);
    expect(first[0]).toBe(undefinedValue);
    expect(first[1]).toBeNull();
    const second = run(null, undefinedValue);
    expect(second[0]).toBeNull();
    expect(second[1]).toBe(undefinedValue);
    return;
  }
  const map = new Map([[1, 42]]);
  expect(run(undefined, map)).toEqual([undefined, map]);
  expect(run(map, undefined)).toEqual([map, undefined]);
  expect(run(17, "changed")).toEqual([17, "changed"]);
  expect(run(null, false)).toEqual([null, false]);
});

it("rejects a mismatched logical cell initializer", () => {
  const builder = new IrFunctionBuilder(identities.next("invalid"), [], false);
  builder.openBlock();
  const value = builder.emitConst({ kind: "f64", value: 1 }, irVal({ kind: "f64" }));
  expect(() => builder.emitTypedRefCellNew(value, irDynamic())).toThrow(/logical payload type/);
});
