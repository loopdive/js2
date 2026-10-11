// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { getterRequirements, getterResolver } from "./native-getter-invocation-fixture.js";
import type { PreparedIrProgram } from "../../src/ir/program/prepared-contracts.js";
import { createEmptyModule } from "../../src/ir/types.js";
import { PhysicalModuleReservations, type FunctionReservation } from "../../src/wasm/physical/module-reservations.js";
import { collectNativeStringValueDemands } from "../../src/ir/program/native-string-value-demands.js";
import { deriveNativeValueResourcePlan } from "../../src/ir/program/native-value-resources.js";
import { deriveNativeVectorResourcePlan } from "../../src/ir/program/native-vector-resources.js";
import { reserveNativeVectorTypes } from "../../src/backend/wasmgc/resources/native-vectors.js";
import { reserveNativeStringLiteralTypes } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import {
  planNativeStringValuePhysical,
  reserveNativeStringValueResources,
  requireCompletedNativeStringValues,
} from "../../src/backend/wasmgc/program/native-string-values.js";
import {
  reserveNativeInvocationResources,
  nativeInvocationGetterDispatch,
  requireCompletedNativeInvocation,
} from "../../src/backend/wasmgc/resources/native-invocation.js";
import { beginNativeSourceClosureEmission } from "../../src/ir/program-native-invocation.js";
import { irUnitCallableBindingId } from "../../src/ir/core/callable-bindings.js";
import type { IrUnitId } from "../../src/shared/contracts/ir-identity.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import { WasmGcEmitter } from "../../src/ir/backend/wasmgc-emitter.js";
import { IrFunctionBuilder } from "../../src/ir/builder.js";
import { createTestIrFunctionIdentityFactory } from "./ir-identities.js";
import { lowerIrFunctionBody, wasmValueTypeConverter } from "../../src/ir/lower.js";
import { emitBinary } from "../../src/emit/binary.js";

/** Genuine producer demands select every value/string/Boolean dependency. */
export function getterResourceFixture(program: PreparedIrProgram) {
  const input = getterRequirements(program);
  if (!input.invocation) throw new Error("missing actual getter invocation");
  const demands = collectNativeStringValueDemands(program, input.projection);
  const selected = planNativeStringValuePhysical(
    demands,
    { representation: "native-string", utf8Storage: false },
    input.invocation,
  );
  if (selected.kind !== "planned") throw new Error(JSON.stringify(selected));
  const valuePlan = deriveNativeValueResourcePlan(program, input.projection, "native-string");
  const resourceInput = {
    demands,
    plan: selected.plan,
    valueRequirements: valuePlan,
    invocationRequirements: input.invocation,
  };
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const types = reserveNativeStringLiteralTypes(tx, selected.plan.key, false);
  const resources = reserveNativeStringValueResources(tx, resourceInput, types);
  if (!resources.number) throw new Error("getter missed its actual value owner");
  const { values, flatten, scanner, dependencies: valueDependencies, booleanBoxes } = resources.number;
  const vectorPlan = deriveNativeVectorResourcePlan({
    anchor: valuePlan.anchor,
    functions: input.projection.prepared.functions,
    abiEntries: program.abi.entries,
    policy: input.projection.prepared.manifest.policy,
    providers: input.projection.prepared.manifest.providers,
    backend: "wasmgc",
    target: "standalone",
  });
  const vectors = reserveNativeVectorTypes(tx, vectorPlan);
  const sourceOwner = beginNativeSourceClosureEmission(tx, input.source, { vectors, vectorPlan });
  const dependencies = {
    source: sourceOwner.types,
    values,
    valuePlan,
    valueDependencies,
    strings: resources.strings,
    vectors,
    vectorPlan,
    ...(booleanBoxes ? { booleanBoxes } : {}),
  };
  const pack = reserveNativeInvocationResources(tx, input.invocation, dependencies);
  const slots = new Map<IrUnitId, FunctionReservation>();
  const signatures = new Map<IrUnitId, { params: ValType[]; results: ValType[] }>();
  for (const unit of input.source.units) {
    const shape = input.source.shapes.find((row) => row.id === unit.shapeId)!;
    const binding = sourceOwner.types.closures.signatures.find((row) => row.id === shape.signatureId)!.binding;
    const signature = {
      params: [{ kind: "ref" as const, typeIdx: binding.liftedSelfTypeIndex }, ...binding.info.paramTypes],
      results: binding.info.returnType ? [binding.info.returnType] : [],
    };
    const fn = input.projection.prepared.functions.find((row) => row.unitId === unit.unitId)!;
    slots.set(unit.unitId, tx.reserveFunction(irUnitCallableBindingId(unit.unitId), fn.name, signature));
    signatures.set(unit.unitId, signature);
  }
  const exception = tx.reserveTag(
    "getter-resource:exception",
    { params: [{ kind: "externref" }], results: [] },
    { kind: "defined", name: "__exn" },
  );
  return {
    ...input,
    invocation: input.invocation,
    module,
    tx,
    resources,
    resourceInput,
    strings: resources.strings,
    values,
    flatten,
    scanner,
    valueDependencies,
    sourceOwner,
    dependencies,
    pack,
    slots,
    signatures,
    exception,
  };
}

/** Reserve the real observer functions before the invocation transaction freezes. */
export function reserveGetterResourceObservers(f: ReturnType<typeof getterResourceFixture>) {
  const use = f.invocation.getterUses[0]!,
    getter = f.access.getters[use.getterIndex]!;
  const shape = f.sourceOwner.types.shapes.find((row) => row.id === use.shapeId)!;
  const captures = f.source.shapes.find((row) => row.id === use.shapeId)!.captures;
  if (captures.some((type) => type.kind !== "val" || type.val.kind !== "f64"))
    throw new Error("unsupported observer capture");
  const make = f.tx.reserveFunction("getter-resource:make", "make", {
    params: captures.map(() => ({ kind: "f64" as const })),
    results: [{ kind: "externref" }],
  });
  const get = f.tx.reserveFunction("getter-resource:get", "get", {
    params: [{ kind: "externref" }],
    results: [{ kind: "externref" }],
  });
  const invoke =
    getter.signature.returnType?.kind === "callable"
      ? f.tx.reserveFunction("getter-resource:invoke", "invoke", {
          params: [{ kind: "externref" }],
          results: [{ kind: "f64" }],
        })
      : undefined;
  const method = nativeInvocationGetterDispatch(f.tx, f.pack, f.access);
  return { use, getter, shape, captures, make, get, invoke, method };
}

export function fillGetterResourceObservers(
  f: ReturnType<typeof getterResourceFixture>,
  observers: ReturnType<typeof reserveGetterResourceObservers>,
): void {
  const { use, getter, shape, captures, make, get, invoke, method } = observers;
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
    body: [{ op: "ref.null.extern" }, { op: "local.get", index: 0 }, { op: "call", funcIdx: method.handle }],
  });
  if (invoke && getter.signature.returnType?.kind === "callable") {
    const builder = new IrFunctionBuilder(createTestIrFunctionIdentityFactory("getter-resource").next("invoke"), [
      { kind: "val", val: { kind: "f64" } },
    ]);
    const value = builder.addParam("value", getter.signature.returnType);
    builder.openBlock();
    const result = builder.emitClosureCall(value, [], getter.signature.returnType.signature.returnType);
    if (result === null) throw new Error("missing callable result");
    builder.terminate({ kind: "return", values: [result] });
    f.tx.fillFunction(
      invoke,
      lowerIrFunctionBody(builder.finish(), resolver, emitter, wasmValueTypeConverter("wasmgc", resolver, "invoke")),
    );
  }
}

/** Completes and emits actual source-body dispatch; this does not implement public ordinary Get. */
export function getterResourceRuntime(
  f: ReturnType<typeof getterResourceFixture>,
  observers: ReturnType<typeof reserveGetterResourceObservers>,
) {
  const { make, get, invoke } = observers;
  requireCompletedNativeInvocation(f.tx, f.pack);
  requireCompletedNativeStringValues(f.tx, f.resources);
  const booleans = f.resources.number!.booleans;
  for (const [name, token] of Object.entries({
    make,
    get,
    number: f.values.functions.unboxNumber,
    ...(invoke ? { invoke } : {}),
    ...(booleans ? { isBoolean: booleans.isBoolean, booleanValue: booleans.unboxBoolean } : {}),
  }))
    f.tx.defineExport("getter-resource:export:" + name, name, token);
  f.tx.seal();
  const module = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  if (WebAssembly.Module.imports(module).length) throw new Error("unexpected imported provider");
  return new WebAssembly.Instance(module).exports as unknown as {
    make(...captures: number[]): unknown;
    get(getter: unknown): unknown;
    number(value: unknown): number;
    invoke(value: unknown): number;
    isBoolean(value: unknown): number;
    booleanValue(value: unknown): number;
  };
}
