// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  realmSourceFixture,
  reserveRealmSourceExecution,
  fillRealmSourceExecution,
  get,
  as,
  ext,
  f64,
} from "./native-realm-object-layouts.js";
import {
  declareNativeClassValues,
  reserveNativeClassValues,
  fillNativeClassValues,
  requireCompletedNativeClassValues,
} from "../../src/backend/wasmgc/resources/native-class-values.js";
import {
  CLASS_CONSTRUCT_CLOSURE_FIELD,
  CLASS_OBJECT_STATE_FIELD,
} from "../../src/runtime/wasmgc/values/class-constructor-layouts.js";
import { IrFunctionBuilder } from "../../src/ir/builder.js";
import { AllocSiteRegistry } from "../../src/ir/alloc-registry.js";
import { irRuntimeFuncRef, irUnitFuncRef, irUnitCallableBindingId } from "../../src/ir/core/callable-bindings.js";
import { createDerivedIrUnitId } from "../../src/shared/contracts/identity-values.js";
import { fillPreparedPrimaryUnit } from "../../src/ir/program-native-invocation.js";
import { emitBinary } from "../../src/emit/binary.js";

/** Constructed IR allocation control with genuine source captures; no class frontend admission claim. */
export function reserveClassValueFixture(displaced = false, decoded = false) {
  const f = realmSourceFixture(displaced, decoded, displaced),
    { tx, source } = f;
  const plan = declareNativeClassValues("class-values", source.types.closures.root.key, f.pack.types.state.key);
  const pack = reserveNativeClassValues(tx, "class-values", source.types, structuredClone(plan));
  const execution = reserveRealmSourceExecution(f);
  const parentId = f.program.ir.functions.find((row) => row.name === "makeCaptured")!.unitId;
  const callIdentity = {
    unitId: createDerivedIrUnitId({ parentId, role: "class-call-control", ordinal: 0 }),
    name: "classCallControl",
  };
  const callSignature = source.requirements.signatures[0]!.signature;
  const root = { kind: "ref" as const, typeIdx: source.types.closures.root.typeIndex };
  const stub = tx.reserveFunction(irUnitCallableBindingId(callIdentity.unitId), callIdentity.name, {
    params: [root, f64],
    results: [f64],
  });
  const identity = {
    unitId: createDerivedIrUnitId({ parentId, role: "class-allocation-control", ordinal: 0 }),
    name: "classAllocationControl",
  };
  const allocations = new AllocSiteRegistry();
  const builder = new IrFunctionBuilder(identity, [{ kind: "callable", signature: callSignature }], false, allocations);
  const construct = builder.addParam("construct", { kind: "closure", signature: callSignature }),
    parent = builder.addParam("parent", { kind: "val", val: ext }),
    properties = builder.addParam("properties", { kind: "val", val: ext });
  builder.openBlock();
  const value = builder.emitClassValueNew({
    callTarget: irUnitFuncRef(callIdentity),
    signature: callSignature,
    allocator: irRuntimeFuncRef("__class_value_new"),
    construct,
    parent,
    properties,
  });
  builder.terminate({ kind: "return", values: [value] });
  const fn = builder.finish();
  const signature = { params: [root, ext, ext], results: [ext] };
  const slot = tx.reserveFunction(irUnitCallableBindingId(identity.unitId), identity.name, signature);
  const allocate = tx.reserveFunction("class-control:allocate", "allocate", {
    params: [ext, ext, ext],
    results: [ext],
  });
  const invokeConstruct = tx.reserveFunction("class-control:construct", "invokeConstruct", {
    params: [ext, f64],
    results: [f64],
  });
  const state = tx.reserveFunction("class-control:state", "classState", { params: [ext], results: [ext] });
  const bag = tx.reserveFunction("class-control:bag", "bag", { params: [ext], results: [ext] });
  const arity = tx.reserveFunction("class-control:arity", "arity", { params: [ext], results: [{ kind: "i32" }] });
  return {
    f,
    pack,
    plan,
    execution,
    callIdentity,
    stub,
    fn,
    allocations,
    signature,
    slot,
    allocate,
    invokeConstruct,
    state,
    bag,
    arity,
  };
}
export function fillClassValueFixture(control: ReturnType<typeof reserveClassValueFixture>) {
  const { f, pack, execution, callIdentity, stub, fn, signature, slot, allocate, invokeConstruct, state, bag, arity } =
    control;
  const { tx, source } = f;
  tx.freezeReservations();
  tx.declareFunctionReference(stub);
  const sourceResolver = fillRealmSourceExecution(execution);
  fillNativeClassValues(tx, pack);
  tx.fillFunction(stub, { locals: [], body: [{ op: "f64.const", value: -99 }] });
  const resolver = {
    ...sourceResolver,
    resolveFunc(reference: Parameters<typeof sourceResolver.resolveFunc>[0]) {
      if (reference.binding.kind === "unit" && reference.binding.unitId === fn.unitId) return slot.handle;
      if (reference.binding.kind === "unit" && reference.binding.unitId === callIdentity.unitId) return stub.handle;
      if (reference.binding.kind === "runtime" && reference.binding.symbol === "__class_value_new")
        return pack.allocate.handle;
      return sourceResolver.resolveFunc(reference);
    },
  };
  fillPreparedPrimaryUnit(tx, fn, slot, signature, resolver, "wasmgc");
  tx.fillFunction(allocate, {
    locals: [],
    body: [...as(0, source.types.closures.root.typeIndex), get(1), get(2), { op: "call", funcIdx: slot.handle }],
  });
  tx.fillFunction(invokeConstruct, {
    locals: [],
    body: [
      ...as(0, pack.type.typeIndex),
      { op: "struct.get", typeIdx: pack.type.typeIndex, fieldIdx: CLASS_CONSTRUCT_CLOSURE_FIELD },
      { op: "extern.convert_any" },
      get(1),
      { op: "call", funcIdx: execution.call.handle },
    ],
  });
  for (const [token, typeIdx, fieldIdx, externalize] of [
    [state, pack.type.typeIndex, CLASS_OBJECT_STATE_FIELD, true],
    [bag, source.types.closures.root.typeIndex, 2, false],
    [arity, source.types.closures.root.typeIndex, 1, false],
  ] as const) {
    tx.fillFunction(token, {
      locals: [],
      body: [
        ...as(0, typeIdx),
        { op: "struct.get", typeIdx, fieldIdx },
        ...(externalize ? [{ op: "extern.convert_any" } as const] : []),
      ],
    });
  }
  for (const [name, token] of Object.entries({ allocate, invokeConstruct, classState: state, bag, arity }))
    tx.defineExport("class-control:export:" + name, name, token);
  requireCompletedNativeClassValues(tx, pack);
}
export function classValueRuntime(displaced = false, decoded = false) {
  const control = reserveClassValueFixture(displaced, decoded);
  fillClassValueFixture(control);
  control.f.tx.seal();
  const binary = emitBinary(control.f.module);
  const wasm = new WebAssembly.Module(binary as BufferSource);
  const exports = new WebAssembly.Instance(wasm, { control: { noop() {}, sentinel: 19 } }).exports as Record<
    string,
    (...args: any[]) => any
  >;
  return { ...control, wasm, exports };
}
