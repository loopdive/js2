// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createEmptyModule } from "../../src/ir/types.js";
import { PhysicalModuleReservations, type FunctionReservation } from "../../src/wasm/physical/module-reservations.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import type { PreparedIrProgram } from "../../src/ir/program/prepared-contracts.js";
import type { IrUnitId } from "../../src/shared/contracts/ir-identity.js";
import { deriveNativeValueResourcePlan } from "../../src/ir/program/native-value-resources.js";
import { deriveNativeVectorResourcePlan } from "../../src/ir/program/native-vector-resources.js";
import { reserveNativeVectorTypes } from "../../src/backend/wasmgc/resources/native-vectors.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
  nativeStringLiteralReservationInventory,
} from "../../src/backend/wasmgc/resources/native-string-literals.js";
import { reserveNativeStringFlattenResources } from "../../src/backend/wasmgc/resources/native-string-flatten.js";
import { reserveNativeStringNumberResources } from "../../src/backend/wasmgc/resources/native-string-number.js";
import { reserveNativeValueResources } from "../../src/backend/wasmgc/resources/native-values.js";
import {
  declareNativeInvocationSubstrateResources,
  reserveNativeInvocationSubstrateResources,
  fillNativeInvocationSubstrateResources,
  requireCompletedNativeInvocationSubstrate,
  type NativeInvocationSubstrateReservations,
} from "../../src/backend/wasmgc/resources/native-invocation-substrate.js";
import {
  reserveNativeInvocationResources,
  fillNativeInvocationResources,
  requireCompletedNativeInvocation,
} from "../../src/backend/wasmgc/resources/native-invocation.js";
import {
  beginNativeSourceClosureEmission,
  fillPreparedPrimaryUnit,
  requireCompletedNativeSourceClosures,
} from "../../src/ir/program-native-invocation.js";
import { irUnitCallableBindingId } from "../../src/ir/core/callable-bindings.js";
import {
  getterRequirements,
  freezeGetterInvocation,
  fillGetterInvocationDependencies,
  getterResolver,
} from "./native-getter-invocation-fixture.js";
import { WasmGcEmitter } from "../../src/ir/backend/wasmgc-emitter.js";
import { emitBinary } from "../../src/emit/binary.js";

export const SUBSTRATE_SOURCE = `export function run(): number {
  const captured = 13;
  const fn = function(a: number, b: number): number { return captured + a * 10 + b; };
  const object = { get value() { return captured + 4; } };
  return fn.call(null, 2, 3, 4) + fn.apply(undefined, [4, 5, 6]) + object.value;
}`;

/** Actual producer plans; this stage has no source-closure type or callable owner. */
export function substrateFoundation(program: PreparedIrProgram, displaced = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const prefix = displaced
    ? {
        type: tx.reserveType("substrate-control:prefix-type", {
          kind: "rec",
          types: [
            { kind: "struct", name: "prefix-left", fields: [] },
            { kind: "struct", name: "prefix-right", fields: [{ name: "n", type: { kind: "i32" }, mutable: false }] },
          ],
        }),
        function: tx.reserveFunction("substrate-control:prefix-function", "prefix", { params: [], results: [] }),
        global: tx.reserveGlobal("substrate-control:prefix-global", "prefix", { kind: "i32" }, false),
        tag: tx.reserveTag(
          "substrate-control:prefix-tag",
          { params: [], results: [] },
          { kind: "defined", name: "prefix" },
        ),
      }
    : undefined;
  const projection = program.runtime[0]!;
  const valuePlan = deriveNativeValueResourcePlan(program, projection, "native-string");
  const vectorPlan = deriveNativeVectorResourcePlan({
    anchor: valuePlan.anchor,
    functions: projection.prepared.functions,
    abiEntries: program.abi.entries,
    policy: projection.prepared.manifest.policy,
    providers: projection.prepared.manifest.providers,
    backend: "wasmgc",
    target: "standalone",
  });
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "substrate-control:strings",
    utf8Storage: false,
    literals: ["", "TypeError", "Value is not callable"].map((value) => ({ value, encoding: "wtf16" as const })),
  });
  const vectors = reserveNativeVectorTypes(tx, vectorPlan);
  const requirements = { key: "substrate-control:shared" };
  const dependencies = { vectors, vectorPlan, strings };
  const plan = declareNativeInvocationSubstrateResources(
    requirements,
    vectors.base ? { vectorBaseKey: vectors.base.key } : {},
  );
  return {
    module,
    tx,
    prefix,
    program,
    projection,
    valuePlan,
    vectorPlan,
    strings,
    vectors,
    requirements,
    dependencies,
    plan,
  };
}
export function substrateFixture(program: PreparedIrProgram, displaced = false) {
  const f = substrateFoundation(program, displaced);
  const pack = reserveNativeInvocationSubstrateResources(f.tx, f.requirements, f.dependencies, f.plan);
  return { ...f, pack };
}
export function fillPrefix(f: ReturnType<typeof substrateFoundation>) {
  if (f.prefix) {
    f.tx.fillFunction(f.prefix.function, { locals: [], body: [] });
    f.tx.fillGlobal(f.prefix.global, [{ op: "i32.const", value: 29 }]);
  }
}
const ext = { kind: "externref" } as const,
  i32 = { kind: "i32" } as const;
function cast(typeIdx: number): Instr[] {
  return [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.cast", typeIdx }];
}
function observers(
  f: ReturnType<typeof substrateFoundation>,
  pack: Pick<NativeInvocationSubstrateReservations, "arguments" | "errors">,
) {
  const { tx } = f,
    v = pack.arguments;
  const functions = {
    length: tx.reserveFunction("substrate-control:length", "length", { params: [ext], results: [i32] }),
    capacity: tx.reserveFunction("substrate-control:capacity", "capacity", { params: [ext], results: [i32] }),
    at: tx.reserveFunction("substrate-control:at", "at", { params: [ext, i32], results: [ext] }),
    errorTag: tx.reserveFunction("substrate-control:error-tag", "errorTag", { params: [ext], results: [i32] }),
    errorMessage: tx.reserveFunction("substrate-control:error-message", "errorMessage", {
      params: [ext],
      results: [ext],
    }),
    errorName: tx.reserveFunction("substrate-control:error-name", "errorName", { params: [ext], results: [ext] }),
    typeErrorName: tx.reserveFunction("substrate-control:type-error-name", "typeErrorName", {
      params: [],
      results: [ext],
    }),
  };
  return {
    functions,
    fill() {
      const data: Instr[] = [
        ...cast(v.carrier.typeIndex),
        { op: "struct.get", typeIdx: v.carrier.typeIndex, fieldIdx: 1 },
      ];
      tx.fillFunction(functions.length, {
        locals: [],
        body: [...cast(v.carrier.typeIndex), { op: "struct.get", typeIdx: v.carrier.typeIndex, fieldIdx: 0 }],
      });
      tx.fillFunction(functions.capacity, { locals: [], body: [...data, { op: "array.len" }] });
      tx.fillFunction(functions.at, {
        locals: [],
        body: [...data, { op: "local.get", index: 1 }, { op: "array.get", typeIdx: v.array.typeIndex }],
      });
      for (const [fieldIdx, fn] of [functions.errorTag, functions.errorMessage, functions.errorName].entries())
        tx.fillFunction(fn, {
          locals: [],
          body: [
            ...cast(pack.errors.type.typeIndex),
            { op: "struct.get", typeIdx: pack.errors.type.typeIndex, fieldIdx },
          ],
        });
      const name = requireNativeStringLiteral(tx, f.strings, "TypeError");
      tx.fillFunction(functions.typeErrorName, {
        locals: [],
        body:
          name.kind === "global"
            ? [{ op: "global.get", index: tx.physicalIndex(name.global) }, { op: "extern.convert_any" }]
            : [{ op: "call", funcIdx: name.function.handle }],
      });
      for (const [name, fn] of Object.entries({
        ...functions,
        newVector: v.newVector,
        push: v.push,
        newTypeError: pack.errors.newTypeError,
      }))
        tx.defineExport("substrate-control:export:" + name, name, fn);
    },
  };
}
export interface SubstrateRuntime {
  newVector(): unknown;
  push(vector: unknown, value: unknown): void;
  length(vector: unknown): number;
  capacity(vector: unknown): number;
  at(vector: unknown, index: number): unknown;
  newTypeError(message: unknown): unknown;
  errorTag(error: unknown): number;
  errorMessage(error: unknown): unknown;
  errorName(error: unknown): unknown;
  typeErrorName(): unknown;
}
function instantiate(f: ReturnType<typeof substrateFoundation>) {
  f.tx.seal();
  const compiled = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  if (WebAssembly.Module.imports(compiled).length)
    throw Error("native substrate control unexpectedly imports a provider");
  return new WebAssembly.Instance(compiled).exports;
}
export function substrateRuntime(f: ReturnType<typeof substrateFixture>): SubstrateRuntime {
  const control = observers(f, f.pack);
  f.tx.freezeReservations();
  fillPrefix(f);
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeInvocationSubstrateResources(f.tx, f.pack);
  requireCompletedNativeInvocationSubstrate(f.tx, f.pack, f.dependencies);
  control.fill();
  return instantiate(f) as unknown as SubstrateRuntime;
}

/** The shared owner is reserved BEFORE the authentic source closure owner. */
export function sourceSubstrateBase(program: PreparedIrProgram, borrowed = true, displaced = false) {
  const f = substrateFoundation(program, displaced),
    input = getterRequirements(program);
  if (!input.invocation) throw Error("actual selected source lost invocation requirements");
  const substrate = borrowed
    ? reserveNativeInvocationSubstrateResources(f.tx, f.requirements, f.dependencies, f.plan)
    : undefined;
  const flatten = reserveNativeStringFlattenResources(f.tx, "substrate-control:flatten", f.strings);
  const scanner = reserveNativeStringNumberResources(f.tx, f.valuePlan, flatten);
  const valueDependencies = { strings: { kind: "native-string" as const, stringPack: f.strings, scanner } };
  const values = reserveNativeValueResources(f.tx, f.valuePlan, valueDependencies);
  const sourceOwner = beginNativeSourceClosureEmission(f.tx, input.source, {
    vectors: f.vectors,
    vectorPlan: f.vectorPlan,
    strings: {
      types: nativeStringLiteralReservationInventory(f.tx, f.strings).typePack,
      key: "substrate-control:strings",
      utf8Storage: false,
    },
  });
  const dependencies = {
    source: sourceOwner.types,
    values,
    valuePlan: f.valuePlan,
    valueDependencies,
    strings: f.strings,
    vectors: f.vectors,
    vectorPlan: f.vectorPlan,
    ...(substrate ? { substrate } : {}),
  };
  return {
    ...f,
    ...input,
    invocation: input.invocation,
    substrate,
    flatten,
    scanner,
    values,
    valueDependencies,
    sourceOwner,
    dependencies,
  };
}
export function sourceSubstrateFixture(program: PreparedIrProgram, borrowed = true, displaced = false) {
  const f = sourceSubstrateBase(program, borrowed, displaced);
  const pack = reserveNativeInvocationResources(f.tx, f.invocation, f.dependencies);
  const slots = new Map<IrUnitId, FunctionReservation>(),
    signatures = new Map<IrUnitId, { params: ValType[]; results: ValType[] }>();
  for (const unit of f.source.units) {
    const shape = f.source.shapes.find((row) => row.id === unit.shapeId)!;
    const binding = f.sourceOwner.types.closures.signatures.find((row) => row.id === shape.signatureId)!.binding;
    const signature = {
      params: [{ kind: "ref" as const, typeIdx: binding.liftedSelfTypeIndex }, ...binding.info.paramTypes],
      results: binding.info.returnType ? [binding.info.returnType] : [],
    };
    const fn = f.projection.prepared.functions.find((row) => row.unitId === unit.unitId)!;
    slots.set(unit.unitId, f.tx.reserveFunction(irUnitCallableBindingId(unit.unitId), fn.name, signature));
    signatures.set(unit.unitId, signature);
  }
  const exception = f.tx.reserveTag(
    "substrate-control:exception",
    { params: [ext], results: [] },
    { kind: "defined", name: "__exn" },
  );
  return { ...f, pack, slots, signatures, exception };
}
export interface SourceSubstrateRuntime extends SubstrateRuntime {
  makeCall(capture: number): unknown;
  makeGetter(capture: number): unknown;
  call3(receiver: unknown, fn: unknown, a: number, b: number, c: number): number;
  apply3(receiver: unknown, fn: unknown, a: number, b: number, c: number): number;
  get(receiver: unknown, fn: unknown): number;
  callThrow(receiver: unknown, fn: unknown): unknown;
  currentThis: WebAssembly.Global;
  argc: WebAssembly.Global;
  extras: WebAssembly.Global;
  thrown: WebAssembly.Global;
  exception: WebAssembly.Tag;
}
function fillSourceFixture(f: ReturnType<typeof sourceSubstrateFixture>) {
  const { tx } = f,
    callables = freezeGetterInvocation(f);
  fillPrefix(f);
  fillGetterInvocationDependencies(f);
  if (f.substrate) fillNativeInvocationSubstrateResources(tx, f.substrate);
  fillNativeInvocationResources(tx, f.pack, callables, f.exception);
  const resolver = {
    ...getterResolver(f),
    ensureExnTag: () => tx.physicalIndex(f.exception),
    standardizedExceptions: () => false,
    nativeStrings: () => true,
    resolveString: (): ValType => ({ kind: "ref", typeIdx: f.strings.layout.anyStrTypeIdx }),
  };
  for (const [id, slot] of f.slots) {
    const fn = f.projection.prepared.functions.find((row) => row.unitId === id)!;
    fillPreparedPrimaryUnit(tx, fn, slot, f.signatures.get(id)!, resolver, "wasmgc", f.sourceOwner);
  }
  requireCompletedNativeSourceClosures(tx, f.sourceOwner);
  return resolver;
}
/** Genuine getter-only source throw, independent of call/apply's closed effect proof. */
export function throwingGetterSubstrateRuntime(f: ReturnType<typeof sourceSubstrateFixture>) {
  const { tx } = f,
    control = observers(f, f.pack),
    use = f.invocation.getterUses[0]!;
  const shape = f.source.shapes.find((row) => row.id === use.shapeId)!;
  if (shape.captures.length !== 1 || shape.captures[0]?.kind !== "string")
    throw Error("throw control requires the actual captured external string");
  const make = tx.reserveFunction("substrate-control:make-throwing-getter", "make", { params: [ext], results: [ext] });
  const run = tx.reserveFunction("substrate-control:throwing-getter", "run", { params: [ext, ext], results: [ext] });
  const emitter = new WasmGcEmitter(fillSourceFixture(f)),
    body: Instr[] = [];
  emitter.emitFuncRef(f.slots.get(use.liftedUnitId)!.handle, body);
  emitter.emitClosureArityOperand(0, body);
  body.push(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.strings.layout.anyStrTypeIdx },
  );
  emitter.emitClosureNew(f.sourceOwner.types.shapes.find((row) => row.id === use.shapeId)!.lowering, 1, body);
  emitter.emitToExternref(body);
  tx.fillFunction(make, { locals: [], body });
  tx.fillFunction(run, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: f.pack.methods.find((row) => row.arity === 0)!.function.handle },
    ],
  });
  requireCompletedNativeInvocation(tx, f.pack);
  control.fill();
  for (const [name, token] of Object.entries({ make, run, exception: f.exception, ...f.pack.globals }))
    tx.defineExport("substrate-control:throw-export:" + name, name, token);
  return instantiate(f) as unknown as SubstrateRuntime & {
    make(message: unknown): unknown;
    run(receiver: unknown, getter: unknown): unknown;
    currentThis: WebAssembly.Global;
    argc: WebAssembly.Global;
    extras: WebAssembly.Global;
    exception: WebAssembly.Tag;
  };
}
export function sourceSubstrateRuntime(f: ReturnType<typeof sourceSubstrateFixture>): SourceSubstrateRuntime {
  // The default owner exposes the same authenticated aliases; its completion is checked below.
  const control = observers(f, f.pack),
    { tx } = f;
  const selected = f.source.units.map((unit) => ({
    unit,
    fn: f.projection.prepared.functions.find((row) => row.unitId === unit.unitId)!,
  }));
  const call = selected.find((row) => f.signatures.get(row.unit.unitId)!.params.length === 3)!;
  const getter = f.invocation.getterUses[0]!;
  if (!call || !getter || !f.pack.applyVector) throw Error("actual source fixture lost call/apply/getter selection");
  for (const shapeId of [call.unit.shapeId, getter.shapeId]) {
    const captures = f.source.shapes.find((row) => row.id === shapeId)!.captures;
    if (captures.length !== 1 || captures[0]?.kind !== "val" || captures[0].val.kind !== "f64")
      throw Error("source observer requires the genuine one-f64 capture shape");
  }
  const makeCall = tx.reserveFunction("substrate-control:make-call", "makeCall", {
    params: [{ kind: "f64" }],
    results: [ext],
  });
  const makeGetter = tx.reserveFunction("substrate-control:make-getter", "makeGetter", {
    params: [{ kind: "f64" }],
    results: [ext],
  });
  const signature = {
    params: [ext, ext, { kind: "f64" as const }, { kind: "f64" as const }, { kind: "f64" as const }],
    results: [{ kind: "f64" as const }],
  };
  const call3 = tx.reserveFunction("substrate-control:call3", "call3", signature);
  const apply3 = tx.reserveFunction("substrate-control:apply3", "apply3", signature);
  const get = tx.reserveFunction("substrate-control:get", "get", { params: [ext, ext], results: [{ kind: "f64" }] });
  const callThrow = tx.reserveFunction("substrate-control:call-throw", "callThrow", {
    params: [ext, ext],
    results: [ext],
  });
  const thrown = tx.reserveGlobal("substrate-control:thrown", "thrown", ext, true);
  const emitter = new WasmGcEmitter(fillSourceFixture(f));
  for (const [fn, unitId, arity, shapeId] of [
    [makeCall, call.unit.unitId, 2, call.unit.shapeId],
    [makeGetter, getter.liftedUnitId, 0, getter.shapeId],
  ] as const) {
    const body: Instr[] = [];
    emitter.emitFuncRef(f.slots.get(unitId)!.handle, body);
    emitter.emitClosureArityOperand(arity, body);
    body.push({ op: "local.get", index: 0 });
    emitter.emitClosureNew(f.sourceOwner.types.shapes.find((row) => row.id === shapeId)!.lowering, 1, body);
    emitter.emitToExternref(body);
    tx.fillFunction(fn, { locals: [], body });
  }
  const args = [2, 3, 4].flatMap((index): Instr[] => [
    { op: "local.get", index },
    { op: "call", funcIdx: f.values.functions.boxNumber.handle },
  ]);
  const receiver: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
  ];
  tx.fillFunction(call3, {
    locals: [],
    body: [
      ...receiver,
      ...args,
      { op: "call", funcIdx: f.pack.methods.find((row) => row.arity === 3)!.function.handle },
      { op: "call", funcIdx: f.values.functions.unboxNumber.handle },
    ],
  });
  const input = f.vectors.layouts.find((row) => row.element === "externref")!;
  tx.fillFunction(apply3, {
    locals: [],
    body: [
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 3 },
      ...args,
      { op: "array.new_fixed", typeIdx: input.array.typeIndex, length: 3 },
      { op: "struct.new", typeIdx: input.carrier.typeIndex },
      { op: "call", funcIdx: f.pack.applyVector.handle },
      { op: "call", funcIdx: f.values.functions.unboxNumber.handle },
    ],
  });
  tx.fillFunction(get, {
    locals: [],
    body: [
      ...receiver,
      { op: "call", funcIdx: f.pack.methods.find((row) => row.arity === 0)!.function.handle },
      { op: "call", funcIdx: f.values.functions.unboxNumber.handle },
    ],
  });
  tx.fillGlobal(thrown, [{ op: "ref.null.extern" }]);
  tx.fillFunction(callThrow, {
    locals: [],
    body: [
      {
        op: "try",
        blockType: { kind: "val", type: ext },
        body: [...receiver, { op: "call", funcIdx: f.pack.methods.find((row) => row.arity === 0)!.function.handle }],
        catches: [
          {
            tagIdx: tx.physicalIndex(f.exception),
            body: [
              { op: "global.set", index: tx.physicalIndex(thrown) },
              { op: "global.get", index: tx.physicalIndex(thrown) },
              { op: "throw", tagIdx: tx.physicalIndex(f.exception) },
            ],
          },
        ],
      },
    ],
  });
  requireCompletedNativeInvocation(tx, f.pack);
  control.fill();
  for (const [name, token] of Object.entries({
    makeCall,
    makeGetter,
    call3,
    apply3,
    get,
    callThrow,
    thrown,
    exception: f.exception,
    ...f.pack.globals,
  }))
    tx.defineExport("substrate-control:source-export:" + name, name, token);
  return instantiate(f) as unknown as SourceSubstrateRuntime;
}
