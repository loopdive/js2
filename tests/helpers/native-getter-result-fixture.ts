// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  getterResolver,
  freezeGetterInvocation,
  fillGetterInvocationDependencies,
  fillActualGetterUnits,
  type GetterInvocationFixture,
} from "./native-getter-invocation-fixture.js";
import {
  nativeInvocationGetterDispatch,
  fillNativeInvocationResources,
  requireCompletedNativeInvocation,
} from "../../src/backend/wasmgc/resources/native-invocation.js";
import {
  reserveNativeBooleanResources,
  fillNativeBooleanResources,
} from "../../src/backend/wasmgc/resources/native-booleans.js";
import { WasmGcEmitter } from "../../src/ir/backend/wasmgc-emitter.js";
import { IrFunctionBuilder } from "../../src/ir/builder.js";
import { createTestIrFunctionIdentityFactory } from "./ir-identities.js";
import { lowerIrFunctionBody, wasmValueTypeConverter } from "../../src/ir/lower.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { Instr } from "../../src/wasm/model/instructions.js";

/** Actual source getter/lifted bodies through C2; C1's full public Get is composed separately. */
export function getterResultRuntime(f: GetterInvocationFixture) {
  const demand = f.access.getters[f.invocation.getterUses[0]!.getterIndex]!,
    use = f.invocation.getterUses[0]!,
    shape = f.sourceOwner.types.shapes.find((row) => row.id === use.shapeId)!;
  const captures = f.source.shapes.find((row) => row.id === use.shapeId)!.captures;
  if (captures.some((type) => type.kind !== "val" || type.val.kind !== "f64"))
    throw new Error("result control requires the actual zero/f64 capture layout");
  const make = f.tx.reserveFunction("getter-result:make", "make", {
    params: captures.map(() => ({ kind: "f64" as const })),
    results: [{ kind: "externref" }],
  });
  const get = f.tx.reserveFunction("getter-result:get", "get", {
    params: [{ kind: "externref" }],
    results: [{ kind: "externref" }],
  });
  const bool = reserveNativeBooleanResources(
    f.tx,
    "getter-result:booleans",
    f.values,
    f.dependencies.valuePlan,
    f.valueDependencies,
  );
  const resultType = demand.signature.returnType;
  const invoke =
    resultType?.kind === "callable"
      ? f.tx.reserveFunction("getter-result:invoke", "invoke", {
          params: [{ kind: "externref" }],
          results: [{ kind: "f64" }],
        })
      : undefined;
  const callables = freezeGetterInvocation(f);
  fillGetterInvocationDependencies(f);
  fillNativeBooleanResources(f.tx, bool);
  fillNativeInvocationResources(f.tx, f.pack, callables, f.exception);
  fillActualGetterUnits(f);
  const resolver = getterResolver(f),
    emitter = new WasmGcEmitter(resolver),
    body: Instr[] = [];
  emitter.emitFuncRef(f.slots.get(use.liftedUnitId)!.handle, body);
  emitter.emitClosureArityOperand(0, body);
  captures.forEach((_, index) => body.push({ op: "local.get", index }));
  emitter.emitClosureNew(shape.lowering, captures.length, body);
  emitter.emitToExternref(body);
  f.tx.fillFunction(make, { locals: [], body });
  f.tx.fillFunction(get, {
    locals: [],
    body: [
      { op: "ref.null.extern" },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: nativeInvocationGetterDispatch(f.tx, f.pack, f.access).handle },
    ],
  });
  if (invoke && resultType?.kind === "callable") {
    const builder = new IrFunctionBuilder(createTestIrFunctionIdentityFactory("getter-result").next("invoke"), [
      { kind: "val", val: { kind: "f64" } },
    ]);
    const value = builder.addParam("value", resultType);
    builder.openBlock();
    const result = builder.emitClosureCall(value, [], resultType.signature.returnType);
    if (result === null) throw new Error("returned callable lost its numeric result");
    builder.terminate({ kind: "return", values: [result] });
    const lowered = lowerIrFunctionBody(
      builder.finish(),
      resolver,
      emitter,
      wasmValueTypeConverter("wasmgc", resolver, "invoke"),
    );
    f.tx.fillFunction(invoke, lowered);
  }
  requireCompletedNativeInvocation(f.tx, f.pack);
  const exports = {
    make,
    get,
    isBoolean: bool.isBoolean,
    booleanValue: bool.unboxBoolean,
    ...(invoke ? { invoke } : {}),
  };
  for (const [name, token] of Object.entries(exports)) f.tx.defineExport("getter-result:export:" + name, name, token);
  f.tx.seal();
  const module = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  if (WebAssembly.Module.imports(module).length) throw new Error("result control imported a provider");
  return new WebAssembly.Instance(module).exports as unknown as {
    make(...captures: number[]): unknown;
    get(getter: unknown): unknown;
    invoke(value: unknown): number;
    isBoolean(value: unknown): number;
    booleanValue(value: unknown): number;
  };
}
