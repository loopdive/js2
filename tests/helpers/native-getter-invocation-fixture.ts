// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { prepareWholeIrProgram } from "../../src/ir/program-preparation.js";
import { analyzeMultiSource } from "../../src/checker/index.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../../src/ir/program-codec.js";
import type { PreparedIrProgram } from "../../src/ir/program/prepared-contracts.js";
import { requireProgram } from "./typed-program-fixtures.js";
import { planNativeSourceClosureRequirements } from "../../src/ir/program/native-source-closure-requirements.js";
import { deriveNativeObjectAccessRequirements } from "../../src/ir/program/native-object-access-requirements.js";
import { planNativeInvocationRequirements } from "../../src/ir/program/native-invocation-requirements.js";
import { createEmptyModule } from "../../src/ir/types.js";
import { PhysicalModuleReservations, type FunctionReservation } from "../../src/wasm/physical/module-reservations.js";
import { deriveNativeValueResourcePlan } from "../../src/ir/program/native-value-resources.js";
import { deriveNativeVectorResourcePlan } from "../../src/ir/program/native-vector-resources.js";
import { reserveNativeVectorTypes } from "../../src/backend/wasmgc/resources/native-vectors.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
} from "../../src/backend/wasmgc/resources/native-string-number.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
} from "../../src/backend/wasmgc/resources/native-values.js";
import {
  reserveNativeInvocationResources,
  nativeInvocationGetterDispatch,
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
import type { IrUnitId } from "../../src/shared/contracts/ir-identity.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import { WasmGcEmitter } from "../../src/ir/backend/wasmgc-emitter.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { IrLowerResolver } from "../../src/ir/backend/lower-contracts.js";
import {
  reserveNativeBooleanBoxResources,
  fillNativeBooleanBoxResources,
} from "../../src/backend/wasmgc/resources/native-booleans.js";

export const GETTER_SOURCE = `export function run(seed: number): number {
  const captured = seed;
  const object = { get value() { return captured + 4; } };
  return object.value;
}`;
export const CALL_SOURCE = `export function run(): number {
  const fn = function(value: number): number { return value + 3; };
  return fn.call(null, 7);
}`;
export function prepareGetterProgram(
  text = GETTER_SOURCE,
  decoded = false,
  entry = "./entry.ts",
  nativeBooleanBox = false,
): PreparedIrProgram {
  const source = analyzeMultiSource({ [entry]: text }, entry);
  const program = requireProgram(
    prepareWholeIrProgram({
      sourceFiles: source.sourceFiles,
      entrySource: source.entryFile,
      checker: source.checker,
      deferTopLevelInit: false,
      policy: {
        target: "standalone",
        backend: "wasmgc",
        numberBoundary: { box: "native", unbox: "native" },
        booleanBoundary: { box: nativeBooleanBox ? "native" : "unsupported", unbox: "native" },
        stringConst: { storage: "native" },
      },
    }),
  );
  return decoded ? decodePreparedIrProgram(encodePreparedIrProgram(program)) : program;
}
export function getterRequirements(program: PreparedIrProgram) {
  const projection = program.runtime[0]!;
  const source = planNativeSourceClosureRequirements(program, projection);
  if (!source) throw new Error("positive getter source lost its actual closure population");
  const access = deriveNativeObjectAccessRequirements(program, projection);
  const invocation = planNativeInvocationRequirements(source, { utf8Storage: false, objectAccess: access });
  return { program, projection, source, access, invocation };
}
export function getterInvocationFixture(program: PreparedIrProgram) {
  const input = getterRequirements(program);
  if (!input.invocation) throw new Error("positive getter source lost its invocation requirements");
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "getter-test:strings",
    utf8Storage: false,
    literals: ["", "TypeError", "Value is not callable"].map((value) => ({ value, encoding: "wtf16" as const })),
  });
  const flatten = reserveNativeStringFlattenResources(tx, "getter-test:flatten", strings);
  const valuePlan = deriveNativeValueResourcePlan(program, input.projection, "native-string");
  const scanner = reserveNativeStringNumberResources(tx, valuePlan, flatten);
  const valueDependencies = { strings: { kind: "native-string" as const, stringPack: strings, scanner } };
  const values = reserveNativeValueResources(tx, valuePlan, valueDependencies);
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
  const booleanBoxes =
    input.projection.prepared.manifest.policy.booleanBoundary.box === "native"
      ? reserveNativeBooleanBoxResources(
          tx,
          "getter-test:boolean-box",
          values,
          valuePlan,
          valueDependencies,
          "interned",
        )
      : undefined;
  const dependencies = {
    source: sourceOwner.types,
    values,
    valuePlan,
    valueDependencies,
    strings,
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
    "getter-test:exception",
    {
      params: [{ kind: "externref" }],
      results: [],
    },
    { kind: "defined", name: "__exn" },
  );
  return {
    ...input,
    invocation: input.invocation,
    module,
    tx,
    strings,
    flatten,
    scanner,
    values,
    valueDependencies,
    sourceOwner,
    dependencies,
    pack,
    slots,
    signatures,
    exception,
  };
}
export type GetterInvocationFixture = ReturnType<typeof getterInvocationFixture>;

export function freezeGetterInvocation(f: GetterInvocationFixture) {
  f.tx.freezeReservations();
  bindNativeSourceClosureUnits(f.tx, f.sourceOwner, f.slots);
  return nativeSourceClosureCallableBindings(f.tx, f.sourceOwner, f.invocation);
}
export function fillGetterInvocationDependencies(f: GetterInvocationFixture): void {
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeStringFlattenResources(f.tx, f.flatten);
  fillNativeStringNumberResources(f.tx, f.scanner);
  fillNativeValueResources(f.tx, f.values, f.valueDependencies);
  if (f.dependencies.booleanBoxes) fillNativeBooleanBoxResources(f.tx, f.dependencies.booleanBoxes);
}
export function getterResolver(f: GetterInvocationFixture): IrLowerResolver {
  return {
    ...nativeSourceClosureResolver(f.tx, f.sourceOwner),
    resolveFunc(reference): number {
      if (reference.binding.kind === "unit") {
        const slot = f.slots.get(reference.binding.unitId);
        if (slot) return slot.handle;
      }
      throw new Error("unowned callable in actual getter control: " + reference.name);
    },
    resolveGlobal(): number {
      throw new Error("unexpected global in actual getter control");
    },
    resolveType(): number {
      throw new Error("unexpected nominal type in actual getter control");
    },
    internFuncType(type: { params: ValType[]; results: ValType[] }): number {
      return f.tx.internFunctionType(type.params, type.results);
    },
  };
}
export function fillActualGetterUnits(f: GetterInvocationFixture): void {
  const resolver = getterResolver(f);
  for (const [id, slot] of f.slots) {
    const fn = f.projection.prepared.functions.find((row) => row.unitId === id)!;
    fillPreparedPrimaryUnit(f.tx, fn, slot, f.signatures.get(id)!, resolver, "wasmgc", f.sourceOwner);
  }
  requireCompletedNativeSourceClosures(f.tx, f.sourceOwner);
}

/** Source-body dispatch control. Full ordinary-object Get is separately composed by its real owner. */
export function getterInvocationRuntime(f: GetterInvocationFixture) {
  const method = nativeInvocationGetterDispatch(f.tx, f.pack, f.access);
  const getter = f.invocation.getterUses[0]!;
  const shape = f.sourceOwner.types.shapes.find((row) => row.id === getter.shapeId)!;
  const captureTypes = f.source.shapes.find((row) => row.id === getter.shapeId)!.captures;
  if (captureTypes.length !== 1 || captureTypes[0]?.kind !== "val" || captureTypes[0].val.kind !== "f64")
    throw new Error("control requires the actual one-f64 captured source getter");
  const make = f.tx.reserveFunction("getter-test:make", "make", {
    params: [{ kind: "f64" }],
    results: [{ kind: "externref" }],
  });
  const run = f.tx.reserveFunction("getter-test:run", "run", {
    params: [{ kind: "externref" }, { kind: "externref" }],
    results: [{ kind: "f64" }],
  });
  const callables = freezeGetterInvocation(f);
  fillGetterInvocationDependencies(f);
  fillNativeInvocationResources(f.tx, f.pack, callables, f.exception);
  fillActualGetterUnits(f);
  const emitter = new WasmGcEmitter(getterResolver(f)),
    body: Instr[] = [];
  emitter.emitFuncRef(f.slots.get(getter.liftedUnitId)!.handle, body);
  emitter.emitClosureArityOperand(0, body);
  body.push({ op: "local.get", index: 0 });
  emitter.emitClosureNew(shape.lowering, 1, body);
  emitter.emitToExternref(body);
  f.tx.fillFunction(make, { locals: [], body });
  f.tx.fillFunction(run, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: method.handle },
      { op: "call", funcIdx: f.values.functions.unboxNumber.handle },
    ],
  });
  requireCompletedNativeInvocation(f.tx, f.pack);
  for (const [name, token] of Object.entries({ make, run }))
    f.tx.defineExport("getter-test:export:" + name, name, token);
  f.tx.seal();
  const compiled = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  if (WebAssembly.Module.imports(compiled).length)
    throw new Error("getter dispatch control unexpectedly imports a provider");
  return new WebAssembly.Instance(compiled).exports as unknown as {
    make(capture: number): unknown;
    run(receiver: unknown, getter: unknown): number;
  };
}
