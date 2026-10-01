// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createEmptyModule } from "../../src/ir/types.js";
import { PhysicalModuleReservations, type FunctionReservation } from "../../src/wasm/physical/module-reservations.js";
import type { PreparedIrProgram } from "../../src/ir/program/prepared-contracts.js";
import type { IrUnitId } from "../../src/shared/contracts/ir-identity.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import type { IrLowerResolver } from "../../src/ir/backend/lower-contracts.js";
import { deriveNativeRealmRequirements } from "../../src/ir/program/native-realm-requirements.js";
import { deriveNativeVectorResourcePlan } from "../../src/ir/program/native-vector-resources.js";
import {
  prepareNativeProgramStringInput,
  reserveNativeProgramFoundation,
  reserveNativeRealmKernel,
  nativeRealmReservationInventory,
  fillNativeRealmResources,
  requireCompletedNativeRealmBootstrap,
} from "../../src/backend/wasmgc/program/native-realm.js";
import { fillNativeStringValueResources } from "../../src/backend/wasmgc/program/native-string-values.js";
import { requireNativeStringLiteral } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeInvocationResources,
  fillNativeInvocationResources,
  requireCompletedNativeInvocation,
} from "../../src/backend/wasmgc/resources/native-invocation.js";
import {
  beginNativeSourceClosureEmission,
  bindNativeSourceClosureUnits,
  nativeSourceClosureCallableBindings,
  nativeSourceClosureResolver,
  fillPreparedPrimaryUnit,
  requireCompletedNativeSourceClosures,
} from "../../src/ir/program-native-invocation.js";
import { irUnitCallableBindingId } from "../../src/ir/core/callable-bindings.js";
import { WasmGcEmitter } from "../../src/ir/backend/wasmgc-emitter.js";
import { emitBinary } from "../../src/emit/binary.js";
import { IrFunctionBuilder } from "../../src/ir/builder.js";
import { irIntrinsicFuncRef } from "../../src/ir/core/callable-bindings.js";
import { prepareTypedIrProgram } from "../../src/ir/program-prepare-ir.js";
import { sourcePacket, typedOptions, requireProgram } from "./typed-program-fixtures.js";

export const REALM_CALL_SOURCE = `export function run(): number {
  const captured = 13;
  const fn = function(a: number, b: number): number { return captured + a * 10 + b; };
  const first = fn.call(null, 2, 3);
  const second = fn.apply(undefined, [4, 5]);
  return first + second;
}`;
export const REALM_NO_SOURCE = `export function run(): number { return Number({}); }`;
export const REALM_THROW_SOURCE = `export function run(message: string): number {
  const object = { get value(): number { throw message; } };
  return object.value;
}`;
/** Constructed typed-IR backend control. This does not attest frontend admission of Object.create. */
export function prepareBackendRealmProgram(): PreparedIrProgram {
  const { packet } = sourcePacket({ "./entry.ts": "export function run(): number { return 7; }" });
  const original = packet.ir.functions.find((row) => row.name === "run")!;
  const builder = new IrFunctionBuilder(
    { unitId: original.unitId, name: original.name },
    original.resultTypes,
    original.exported,
  );
  builder.openBlock();
  builder.emitCall(irIntrinsicFuncRef("js.object.create-null"), [], { kind: "val", val: { kind: "externref" } });
  const result = builder.emitConst({ kind: "f64", value: 7 }, { kind: "val", val: { kind: "f64" } });
  builder.terminate({ kind: "return", values: [result] });
  const fn = builder.finish();
  const input = {
    ...packet,
    ir: { ...packet.ir, functions: packet.ir.functions.map((row) => (row === original ? fn : row)) },
  };
  const policy = {
    backend: "wasmgc",
    target: "standalone",
    numberBoundary: { box: "native", unbox: "native" },
    booleanBoundary: { box: "unsupported", unbox: "native" },
    stringConst: { storage: "native" },
  } as const;
  return requireProgram(prepareTypedIrProgram(input, { ...typedOptions, policy, runtimePolicies: [policy] }));
}
const ext = { kind: "externref" } as const,
  i32 = { kind: "i32" } as const;

export function realmInput(program: PreparedIrProgram, utf8Storage = false) {
  const projection = program.runtime[0]!;
  const requirements = deriveNativeRealmRequirements(program, projection);
  if (!requirements) throw Error("actual control program has no selected realm demand");
  // Deliberately omit the optional invocation argument: the helper must retain its actual derived issuer.
  const input = prepareNativeProgramStringInput(program, projection, { utf8Storage }, undefined, requirements);
  if (!input || "kind" in input || !input.valueRequirements)
    throw Error("realm string preparation: " + JSON.stringify(input));
  const vectorPlan = deriveNativeVectorResourcePlan({
    anchor: input.valueRequirements.anchor,
    functions: program.ir.functions,
    abiEntries: program.abi.entries,
    policy: projection.prepared.manifest.policy,
    providers: projection.prepared.manifest.providers,
    backend: "wasmgc",
    target: "standalone",
  });
  return { program, projection, requirements, input, vectorPlan };
}
export function realmFoundation(program: PreparedIrProgram, utf8Storage = false, displaced = false) {
  const data = realmInput(program, utf8Storage),
    module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const prefix = displaced
    ? {
        type: tx.reserveType("realm-control:prefix-type", {
          kind: "rec",
          types: [
            { kind: "struct", name: "prefix-left", fields: [] },
            { kind: "struct", name: "prefix-right", fields: [{ name: "n", type: i32, mutable: false }] },
          ],
        }),
        function: tx.reserveFunction("realm-control:prefix-function", "prefix", { params: [], results: [] }),
        global: tx.reserveGlobal("realm-control:prefix-global", "prefix", i32, false),
        tag: tx.reserveTag(
          "realm-control:prefix-tag",
          { params: [], results: [] },
          { kind: "defined", name: "prefix" },
        ),
      }
    : undefined;
  const foundation = reserveNativeProgramFoundation(
    tx,
    data.vectorPlan,
    data.input.plan.literalRequirements,
    data.input,
  );
  if (!foundation.realm || !foundation.earlyStrings || !foundation.stringTypes)
    throw Error("selected realm foundation missing");
  return { ...data, module, tx, prefix, foundation, realm: foundation.realm, strings: foundation.earlyStrings };
}
export function realmSource(f: ReturnType<typeof realmFoundation>) {
  const { tx, requirements, foundation, realm, input } = f;
  const source = requirements.source
    ? beginNativeSourceClosureEmission(
        tx,
        requirements.source,
        {
          vectors: foundation.vectorTypes,
          vectorPlan: f.vectorPlan,
          strings: {
            types: foundation.stringTypes!,
            key: foundation.stringTypes!.key,
            utf8Storage: foundation.stringTypes!.utf8Storage,
          },
        },
        realm.requests,
      )
    : undefined;
  const slots = new Map<IrUnitId, FunctionReservation>(),
    signatures = new Map<IrUnitId, { params: ValType[]; results: ValType[] }>();
  for (const unit of requirements.source?.units ?? []) {
    const shape = requirements.source!.shapes.find((row) => row.id === unit.shapeId)!;
    const binding = source!.types.closures.signatures.find((row) => row.id === shape.signatureId)!.binding;
    const signature = {
      params: [{ kind: "ref" as const, typeIdx: binding.liftedSelfTypeIndex }, ...binding.info.paramTypes],
      results: binding.info.returnType ? [binding.info.returnType] : [],
    };
    const fn = f.projection.prepared.functions.find((row) => row.unitId === unit.unitId)!;
    slots.set(unit.unitId, tx.reserveFunction(irUnitCallableBindingId(unit.unitId), fn.name, signature));
    signatures.set(unit.unitId, signature);
  }
  const number = f.strings.number!;
  const invocation =
    source && input.invocationRequirements
      ? reserveNativeInvocationResources(tx, input.invocationRequirements, {
          source: source.types,
          values: number.values,
          valuePlan: input.valueRequirements!,
          valueDependencies: number.dependencies,
          strings: f.strings.strings,
          vectors: foundation.vectorTypes,
          vectorPlan: f.vectorPlan,
          substrate: realm.substrate,
          ...(number.booleanBoxes ? { booleanBoxes: number.booleanBoxes } : {}),
        })
      : undefined;
  return { ...f, source, slots, signatures, invocation };
}
export function realmFixture(program: PreparedIrProgram, utf8Storage = false, displaced = false) {
  const f = realmSource(realmFoundation(program, utf8Storage, displaced));
  const kernel = reserveNativeRealmKernel(f.tx, f.realm, f.source?.types);
  return { ...f, kernel };
}
export type RealmFixture = ReturnType<typeof realmFixture>;
export function fillRealmFixture(f: RealmFixture) {
  const { tx } = f;
  tx.freezeReservations();
  if (f.source) bindNativeSourceClosureUnits(tx, f.source, f.slots);
  if (f.prefix) {
    tx.fillFunction(f.prefix.function, { locals: [], body: [] });
    tx.fillGlobal(f.prefix.global, [{ op: "i32.const", value: 29 }]);
  }
  fillNativeStringValueResources(tx, f.strings);
  fillNativeRealmResources(tx, f.realm);
  if (f.invocation && f.source)
    fillNativeInvocationResources(
      tx,
      f.invocation,
      nativeSourceClosureCallableBindings(tx, f.source, f.input.invocationRequirements!),
      f.kernel.exception,
    );
  const resolver: IrLowerResolver = {
    ...(f.source ? nativeSourceClosureResolver(tx, f.source) : {}),
    resolveFunc(reference) {
      if (reference.binding.kind === "unit") {
        const slot = f.slots.get(reference.binding.unitId);
        if (slot) return slot.handle;
      }
      throw Error("unowned source-control callable: " + reference.name);
    },
    resolveGlobal: () => {
      throw Error("unexpected source-control global");
    },
    resolveType: () => {
      throw Error("unexpected source-control nominal type");
    },
    internFuncType: (type) => tx.internFunctionType(type.params, type.results),
    ensureExnTag: () => tx.physicalIndex(f.kernel.exception),
    standardizedExceptions: () => false,
    nativeStrings: () => true,
    resolveString: () => ({ kind: "ref", typeIdx: f.strings.strings.layout.anyStrTypeIdx }),
  };
  for (const [id, slot] of f.slots) {
    const fn = f.projection.prepared.functions.find((row) => row.unitId === id)!;
    fillPreparedPrimaryUnit(tx, fn, slot, f.signatures.get(id)!, resolver, "wasmgc", f.source);
  }
  if (f.source) requireCompletedNativeSourceClosures(tx, f.source);
  if (f.invocation) requireCompletedNativeInvocation(tx, f.invocation);
  requireCompletedNativeRealmBootstrap(tx, f.realm);
  return resolver;
}
export interface RealmRuntime {
  functionPrototype(): unknown;
  throwTypeError(): unknown;
  objectPrototype(): unknown;
  getPrototypeOf(fn: unknown): unknown;
  match(fn: unknown): number;
  method0(fn: unknown, receiver: unknown): unknown;
  method3(fn: unknown, receiver: unknown, a: unknown, b: unknown, c: unknown): unknown;
  undefinedValue(): unknown;
  newVector(): unknown;
  key(): unknown;
  isUtf8(value: unknown): number;
  make(capture: unknown): unknown;
  get(receiver: unknown, fn: unknown): unknown;
  currentThis: WebAssembly.Global;
  argc: WebAssembly.Global;
  extras: WebAssembly.Global;
  state: WebAssembly.Global;
  realmReady: WebAssembly.Global;
  exception: WebAssembly.Tag;
}
/** Actual lifted source-body and bootstrap controls; this is not public provider acceptance. */
export function realmRuntime(f: RealmFixture, getter: "number" | "throw" | undefined = undefined) {
  const { tx, kernel } = f;
  const controls = {
    undefinedValue: tx.reserveFunction("realm-control:undefined", "undefinedValue", { params: [], results: [ext] }),
    key: tx.reserveFunction("realm-control:key", "key", { params: [], results: [ext] }),
    isUtf8: tx.reserveFunction("realm-control:is-utf8", "isUtf8", { params: [ext], results: [i32] }),
  };
  const sourceControls = getter
    ? {
        make: tx.reserveFunction("realm-control:make", "make", {
          params: [getter === "number" ? { kind: "f64" } : ext],
          results: [ext],
        }),
        get: tx.reserveFunction("realm-control:get", "get", {
          params: [ext, ext],
          results: [getter === "number" ? { kind: "f64" } : ext],
        }),
      }
    : undefined;
  const inventory = nativeRealmReservationInventory(tx, f.realm);
  const resolver = fillRealmFixture(f),
    strings = f.strings.strings,
    values = f.strings.number!.values;
  tx.fillFunction(controls.undefinedValue, {
    locals: [],
    body: [{ op: "global.get", index: tx.physicalIndex(values.globals.undefined) }, { op: "extern.convert_any" }],
  });
  const literal = requireNativeStringLiteral(tx, strings, "name");
  tx.fillFunction(controls.key, {
    locals: [],
    body:
      literal.kind === "global"
        ? [{ op: "global.get", index: tx.physicalIndex(literal.global) }, { op: "extern.convert_any" }]
        : [{ op: "call", funcIdx: literal.function.handle }],
  });
  tx.fillFunction(controls.isUtf8, {
    locals: [],
    body:
      strings.layout.utf8StrTypeIdx >= 0
        ? [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: strings.layout.utf8StrTypeIdx },
          ]
        : [{ op: "i32.const", value: 0 }],
  });
  if (sourceControls) {
    const use = f.input.invocationRequirements!.getterUses[0]!;
    const shape = f.requirements.source!.shapes.find((row) => row.id === use.shapeId)!;
    if (
      shape.captures.length !== 1 ||
      (getter === "number"
        ? shape.captures[0]?.kind !== "val" || shape.captures[0].val.kind !== "f64"
        : shape.captures[0]?.kind !== "string")
    )
      throw Error("control lacks its actual canonical source capture");
    const emitter = new WasmGcEmitter(resolver),
      body: Instr[] = [];
    emitter.emitFuncRef(f.slots.get(use.liftedUnitId)!.handle, body);
    emitter.emitClosureArityOperand(0, body);
    body.push({ op: "local.get", index: 0 });
    if (getter === "throw")
      body.push({ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: strings.layout.anyStrTypeIdx });
    emitter.emitClosureNew(f.source!.types.shapes.find((row) => row.id === use.shapeId)!.lowering, 1, body);
    emitter.emitToExternref(body);
    tx.fillFunction(sourceControls.make, { locals: [], body });
    tx.fillFunction(sourceControls.get, {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: f.invocation!.methods.find((row) => row.arity === 0)!.function.handle },
        ...(getter === "number" ? [{ op: "call" as const, funcIdx: values.functions.unboxNumber.handle }] : []),
      ],
    });
  }
  for (const [name, token] of Object.entries({
    ...controls,
    ...sourceControls,
    functionPrototype: kernel.entries.find((row) => row.id === "function-prototype")!.getter,
    throwTypeError: kernel.entries.find((row) => row.id === "throw-type-error")!.getter,
    objectPrototype: kernel.functions.objectPrototype,
    getPrototypeOf: kernel.functions.getPrototypeOf,
    match: kernel.functions.match,
    method0: kernel.functions.method0,
    method3: kernel.functions.method3,
    state: kernel.globals.state,
    realmReady: kernel.globals.realmReady,
    exception: kernel.exception,
    newVector: f.realm.substrate.arguments.newVector,
    ...(f.invocation ? f.invocation.globals : {}),
  }))
    tx.defineExport("realm-control:export:" + name, name, token);
  tx.seal();
  const compiled = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  if (WebAssembly.Module.imports(compiled).length) throw Error("realm control unexpectedly imports a provider");
  return { compiled, inventory, runtime: new WebAssembly.Instance(compiled).exports as unknown as RealmRuntime };
}
