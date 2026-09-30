// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { decodePreparedIrProgram } from "../../src/ir/program-codec.js";
import { deriveNativeObjectAccessRequirements } from "../../src/ir/program/native-object-access-requirements.js";
import {
  reserveNativeBooleanResources,
  fillNativeBooleanResources,
} from "../../src/backend/wasmgc/resources/native-booleans.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
} from "../../src/backend/wasmgc/resources/native-bigint.js";
import {
  declareNativeObjectSameValueResources,
  reserveNativeObjectSameValueResources,
  fillNativeObjectSameValueResources,
} from "../../src/backend/wasmgc/resources/native-object-same-value.js";
import {
  reserveNativeErrorResources,
  fillNativeErrorResources,
} from "../../src/backend/wasmgc/resources/native-errors.js";
import { reserveNativeClosureResources } from "../../src/backend/wasmgc/resources/native-closures.js";
import { buildBuiltinClosureValueInstrs } from "../../src/runtime/wasmgc/values/closure-layouts.js";
import {
  NATIVE_OBJECT_DESCRIPTOR_LITERALS,
  declareNativeObjectDescriptorResources,
  reserveNativeObjectDescriptorResources,
  fillNativeObjectDescriptorResources,
  requireCompletedNativeStringDefinitions,
} from "../../src/backend/wasmgc/resources/native-object-descriptors.js";
import { fillNativeStringCreateResources } from "../../src/backend/wasmgc/resources/native-string-create.js";
import {
  stringCreateFixture,
  fillStringCreateDependencyPhases,
  stringCreateRuntimePhases,
  type StringCreateFixture,
  type StringCreateRuntime,
} from "./native-string-create-fixture.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";

const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" },
  f64: ValType = { kind: "f64" };
const get = (index: number): Instr => ({ op: "local.get", index });
export function stringDefineSource() {
  // Actual prepareWholeIrProgram output for the original getter source, not hand-assembled flags.
  const program = decodePreparedIrProgram(
    readFileSync(new URL("../fixtures/issue-3518-string-define-program.codec.txt", import.meta.url), "utf8"),
  );
  return { program, additionalLiterals: ["TypeError", ...NATIVE_OBJECT_DESCRIPTOR_LITERALS] };
}
function reserveDefinition(f: StringCreateFixture, selected = true) {
  const { tx } = f;
  const access = deriveNativeObjectAccessRequirements(f.program, f.program.runtime[0]!);
  const booleans = reserveNativeBooleanResources(tx, "booleans", f.values, f.valuePlan, f.valueDependencies);
  const bigintPlan = declareNativeBigIntResources("bigints"),
    bigints = reserveNativeBigIntResources(tx, "bigints", bigintPlan);
  const sameValueDependencies = {
    values: f.values,
    valuePlan: f.valuePlan,
    valueDependencies: f.valueDependencies,
    booleans,
    bigints,
    bigintPlan,
    strings: f.strings,
    flatten: f.flatten,
    equality: f.equality,
  };
  const sameValue = reserveNativeObjectSameValueResources(
    tx,
    "same-value",
    sameValueDependencies,
    declareNativeObjectSameValueResources("same-value"),
  );
  const errorRequirements = { key: "errors" },
    errorDependencies = { strings: f.strings, typeErrorTag: -11 };
  const errors = reserveNativeErrorResources(tx, errorRequirements, errorDependencies);
  const closures = reserveNativeClosureResources(tx, {
    key: "closures",
    startingClosureCounter: 0,
    referenceTypes: [],
    requests: [{ kind: "signature", id: "getter", params: [], results: [f64], allocationMode: "ordinary" }],
  });
  const dependencies = {
    access,
    storage: f.storage,
    storageDependencies: f.storageDependencies,
    sameValue,
    sameValueDependencies,
    errors,
    errorRequirements,
    errorDependencies,
    closures,
    ...(selected ? { stringOwn: { pack: f.pack, dependencies: f.dependencies } } : {}),
  };
  const plan = declareNativeObjectDescriptorResources("descriptors"),
    descriptors = reserveNativeObjectDescriptorResources(tx, "descriptors", dependencies, plan);
  const exception = tx.reserveTag("exception", { params: [ext], results: [] }, { kind: "defined", name: "exception" });
  return {
    ...f,
    access,
    booleans,
    bigintPlan,
    bigints,
    sameValueDependencies,
    sameValue,
    errors,
    errorRequirements,
    errorDependencies,
    closures,
    descriptorDependencies: dependencies,
    descriptorPlan: plan,
    descriptors,
    exception,
  };
}
export function stringDefineFixture(utf8 = false, shifted = false, selected = true) {
  return reserveDefinition(stringCreateFixture(utf8, shifted, 2, false, stringDefineSource()), selected);
}
export type StringDefineFixture = ReturnType<typeof stringDefineFixture>;
function* fillDefinitionPhases(f: StringDefineFixture): Generator<string, void> {
  fillNativeBooleanResources(f.tx, f.booleans);
  yield "native booleans";
  fillNativeBigIntResources(f.tx, f.bigints);
  yield "native bigints";
  fillNativeObjectSameValueResources(f.tx, f.sameValue);
  yield "native SameValue";
  fillNativeErrorResources(f.tx, f.errors);
  yield "native errors";
  fillNativeObjectDescriptorResources(f.tx, f.descriptors, f.exception);
  yield "String definition bodies";
}
export function* completeStringDefineFixturePhases(f = stringDefineFixture()) {
  yield "reserved definition fixture";
  f.tx.freezeReservations();
  yield "frozen reservations";
  yield* fillStringCreateDependencyPhases(f);
  fillNativeStringCreateResources(f.tx, f.create);
  yield "completed String constructor";
  yield* fillDefinitionPhases(f);
  return f;
}
export function completeStringDefineFixture(f = stringDefineFixture()) {
  const phases = completeStringDefineFixturePhases(f);
  let step = phases.next();
  while (!step.done) step = phases.next();
  return step.value;
}

export interface StringDefineRuntime extends StringCreateRuntime {
  defineData(object: object, key: object, value: unknown, mask: number): void;
  defineAccessor(object: object, key: object, getter: unknown, setter: unknown, mask: number): void;
  defineAttributes(object: object, key: object, mask: number): void;
  undefinedValue(): object;
  freshChar(codeUnit: number): object;
  closure(): object;
  errorTag(error: object): number;
  errorName(error: object): object;
  errorMessage(error: object): object;
  ordinaryHas(object: object, key: object): number;
  setFlags(object: object, flags: number): void;
  sameValue(a: unknown, b: unknown): number;
  exception: WebAssembly.Tag;
}
export function* stringDefineRuntimePhases(utf8 = false, shifted = false) {
  let fixture: StringDefineFixture | undefined;
  const result = yield* stringCreateRuntimePhases(utf8, shifted, 2, stringDefineSource(), (base) => {
    const f = reserveDefinition(base);
    fixture = f;
    const tx = f.tx,
      objectType = f.objects.object.typeIndex;
    const signatures: Record<string, { params: ValType[]; results: ValType[] }> = {
      undefinedValue: { params: [], results: [ext] },
      freshChar: { params: [i32], results: [ext] },
      closure: { params: [], results: [ext] },
      errorTag: { params: [ext], results: [i32] },
      errorName: { params: [ext], results: [ext] },
      errorMessage: { params: [ext], results: [ext] },
      ordinaryHas: { params: [ext, ext], results: [i32] },
      setFlags: { params: [ext, i32], results: [] },
    };
    const observers = Object.fromEntries(
      Object.entries(signatures).map(([name, signature]) => [
        name,
        tx.reserveFunction("define-observer:" + name, name, signature),
      ]),
    );
    const getter = f.closures.signatures[0]!.binding;
    const lifted = tx.reserveFunction("define-observer:lifted", "lifted", {
      params: [{ kind: "ref", typeIdx: f.closures.root.typeIndex }],
      results: [f64],
    });
    return function* () {
      yield* fillDefinitionPhases(f);
      requireCompletedNativeStringDefinitions(tx, f.descriptors, f.descriptorDependencies);
      const fill = (name: string, body: Instr[]) => tx.fillFunction(observers[name]!, { locals: [], body });
      const object = (index: number): Instr[] => [
        get(index),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: objectType },
      ];
      fill("undefinedValue", [
        { op: "global.get", index: tx.physicalIndex(f.values.globals.undefined) },
        { op: "extern.convert_any" },
      ]);
      fill("freshChar", [
        { op: "i32.const", value: 1 },
        { op: "i32.const", value: 0 },
        get(0),
        { op: "array.new_fixed", typeIdx: f.dataString, length: 1 },
        { op: "struct.new", typeIdx: f.flatString },
        { op: "extern.convert_any" },
      ]);
      tx.fillFunction(lifted, { locals: [], body: [{ op: "f64.const", value: 7 }] });
      tx.declareFunctionReference(lifted);
      fill("closure", [
        ...buildBuiltinClosureValueInstrs(getter.type.typeIndex, lifted.handle, 0, false),
        { op: "extern.convert_any" },
      ]);
      for (const [name, fieldIdx] of [
        ["errorTag", 0],
        ["errorMessage", 1],
        ["errorName", 2],
      ] as const)
        fill(name, [
          get(0),
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: f.errors.type.typeIndex },
          { op: "struct.get", typeIdx: f.errors.type.typeIndex, fieldIdx },
        ]);
      fill("ordinaryHas", [
        ...object(0),
        get(1),
        { op: "call", funcIdx: f.lookup.findOwn.handle },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
      ]);
      fill("setFlags", [...object(0), get(1), { op: "struct.set", typeIdx: objectType, fieldIdx: 4 }]);
      const exports = { ...observers, ...f.descriptors, sameValue: f.sameValue.sameValue, exception: f.exception };
      for (const [name, token] of Object.entries(exports)) tx.defineExport("define-export:" + name, name, token);
    };
  });
  if (!fixture) throw Error("missing issued definition fixture");
  return { ...result, f: fixture, runtime: result.runtime as StringDefineRuntime };
}

export function stringDefineRuntime(...args: Parameters<typeof stringDefineRuntimePhases>) {
  const phases = stringDefineRuntimePhases(...args);
  let step = phases.next();
  while (!step.done) step = phases.next();
  return step.value;
}
