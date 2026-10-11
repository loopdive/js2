// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  builtinFunctionFixture,
  builtinFunctionRuntime as compileBuiltinFunctionRuntime,
  builtinRequirements,
  completeBuiltinFunctionFixture,
  fillDescriptorDependencies,
} from "./helpers/native-builtin-functions.js";
import {
  declareNativeBuiltinFunctionResources,
  reserveNativeBuiltinFunctionResources,
  fillNativeBuiltinFunctionResources,
  requireNativeBuiltinFunctionReservations,
  requireCompletedNativeBuiltinFunctionKernel,
  nativeBuiltinFunctionSingletonBinding,
  nativeBuiltinFunctionReservationInventory,
} from "../src/backend/wasmgc/resources/native-builtin-functions.js";
import { requireNativeBuiltinFunctionRequests } from "../src/backend/wasmgc/resources/native-builtin-function-requests.js";
import {
  declareNativeArgumentVectorResources,
  reserveNativeArgumentVectorResources,
} from "../src/backend/wasmgc/resources/native-argument-vectors.js";
import { requireNativeSourceClosureTypes } from "../src/backend/wasmgc/resources/native-source-closures.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { NativeBuiltinFunctionRequirements } from "../src/backend/wasmgc/resources/native-builtin-function-requests.js";
import { requireNativeStringLiteral } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";
import { GETTER_SOURCE } from "./helpers/native-descriptor-fixture.js";
import * as captureLayouts from "../src/runtime/wasmgc/values/closure-capture-layouts.js";
import {
  buildArgumentVectorNewBody,
  buildArgumentVectorPushLocals,
  buildArgumentVectorPushBody,
} from "../src/runtime/wasmgc/values/argument-vector-bodies.js";
import {
  declareNativeObjectDescriptorResources,
  reserveNativeObjectDescriptorResources,
  fillNativeObjectDescriptorResources,
} from "../src/backend/wasmgc/resources/native-object-descriptors.js";
import { requireNativeStringCreateReservations } from "../src/backend/wasmgc/resources/native-string-create.js";
import { reserveBuiltinStringControl } from "./helpers/native-builtin-function-string-control.js";

const population = (f: ReturnType<typeof builtinFunctionFixture>) => [
  f.module.types.length,
  f.module.functions.length,
  f.module.globals.length,
  f.module.tags.length,
];
// Yield after synchronous owner checks so Vitest can acknowledge worker reports.
afterEach(async () => await setImmediate());
const compiled = new Map<string, ReturnType<typeof compileBuiltinFunctionRuntime>>();
function builtinFunctionRuntime(offset = false, controls = false) {
  const key = offset + ":" + controls;
  let result = compiled.get(key);
  if (!result) {
    result = compileBuiltinFunctionRuntime(offset, controls);
    compiled.set(key, result);
  }
  return { ...result, runtime: result.instantiate() };
}
function typeError(run: () => unknown, tag: WebAssembly.Tag): WebAssembly.Exception {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WebAssembly.Exception);
  expect((caught as WebAssembly.Exception).is(tag)).toBe(true);
  return caught as WebAssembly.Exception;
}
describe.each([false, true])("native builtin function objects; displaced=%s", (offset) => {
  it("executes the real callable prototype with one authentic common root and no imports", () => {
    const { runtime: r, fixture: f, compiled, keyTexts } = builtinFunctionRuntime(offset),
      kernel = f.kernel!;
    expect(WebAssembly.Module.imports(compiled)).toEqual([]);
    expect(f.sourceRequirements.units.length).toBeGreaterThan(0);
    expect(f.source.types.closures).toBe(f.kernelDependencies.closures);
    expect(f.closurePlan.requirements.requests.slice(0, -f.requests.requests.length).map((row) => row.id)).toEqual(
      f.sourceRequirements.signatures.map((row) => row.id),
    );
    expect(
      f.requests.requests
        .filter((row) => row.kind === "signature")
        .every((row) => row.allocationMode === "support" && row.minimumArgumentCount === undefined),
    ).toBe(true);
    expect(f.closures.root.object.kind).toBe("struct");
    if (f.closures.root.object.kind !== "struct") throw Error("root lost");
    expect(f.closures.root.object.fields).toHaveLength(3);
    const [first, second] = kernel.entries;
    expect(first!.metadata.type.typeIndex).not.toBe(second!.metadata.type.typeIndex);
    expect(first!.type.typeIndex).not.toBe(first!.metadata.metadata.id);
    for (const entry of kernel.entries) {
      expect(entry.type.object.kind).toBe("struct");
      if (entry.type.object.kind !== "struct" || entry.metadata.type.object.kind !== "struct")
        throw Error("layout lost");
      expect(entry.type.object.fields.slice(0, 5)).toEqual(entry.metadata.type.object.fields);
      expect(entry.type.object.fields).toHaveLength(8);
      expect(entry.type.object.superTypeIdx).toBe(entry.metadata.type.typeIndex);
      expect(entry.type.object.final).toBe(true);
      expect(entry.metadata.signature.info.paramTypes).toHaveLength(2);
      expect(entry.lifted.object.typeIdx).toBe(entry.metadata.signature.liftedFuncTypeIndex);
    }
    expect(r.state.value).toBe(0);
    const fp = r.functionPrototype();
    expect(r.state.value).toBe(2);
    expect(r.realmReady.value).toBe(0);
    for (const text of ["", "length", "name"]) {
      const binding = requireNativeStringLiteral(f.tx, f.strings, text);
      expect(binding.kind).toBe("global");
      if (binding.kind !== "global") throw Error("expected actual small literal global");
      expect(binding.global.object.type).toEqual({
        kind: "ref",
        typeIdx: offset ? f.strings.layout.utf8StrTypeIdx : f.strings.layout.nativeStrTypeIdx,
      });
      expect(r.isUtf8String(r.key(keyTexts.indexOf(text)))).toBe(Number(offset));
    }
    expect(r.isUtf8String(r.initialName(fp))).toBe(Number(offset));
    expect(r.functionPrototype()).toBe(fp);
    expect(r.match(fp)).toBe(1);
    expect(r.match(r.throwTypeError())).toBe(2);
    expect(r.header(fp)).toEqual([0, first!.metadata.metadata.id]);
    expect(r.arity(fp)).toBe(0);
    expect(r.getPrototypeOf(fp)).toBe(r.objectPrototype());
    expect(r.getPrototypeOf(r.throwTypeError())).toBe(fp);
    expect(Object.is(r.bag(fp), r.objectPrototype())).toBe(false);
    expect(Object.is(r.bag(fp), fp)).toBe(false);
    expect(r.objectProto(r.bag(fp))).toBeNull();
    expect(r.objectProto(r.objectPrototype())).toBeNull();
    expect(r.objectFlags(r.bag(fp)) & 128).toBe(128);
    expect(r.method0(fp, null)).toBe(r.undefinedValue());
    expect(r.method3(fp, 7, 1, 2, 3)).toBe(r.undefinedValue());
    expect(r.sourceCall(r.sourceValue())).toBe(7);
    expect(r.match(r.sourceValue())).toBe(0);
    expect(nativeBuiltinFunctionSingletonBinding(f.tx, kernel, "%Function.prototype%")).toBe(
      nativeBuiltinFunctionSingletonBinding(f.tx, kernel, "functionPrototype"),
    );
    expect(nativeBuiltinFunctionReservationInventory(f.tx, kernel).gaps.length).toBeGreaterThan(0);
  });
  it("seeds real length/name descriptors in order and keeps InitialName independent", () => {
    const { runtime: r, keyTexts } = builtinFunctionRuntime(offset);
    const key = (text: string) => r.key(keyTexts.indexOf(text)),
      fp = r.functionPrototype();
    const ownKeys = () => {
      const list = r.ownKeys(fp);
      return Array.from({ length: r.vectorLength(list) }, (_, i) => r.vectorAt(list, i));
    };
    expect(ownKeys()).toEqual([key("length"), key("name")]);
    expect(r.ownDescriptor(fp, key("length")).slice(0, 2)).toEqual([1, 4]);
    expect(r.unboxNumber(r.ownDescriptor(fp, key("length"))[2])).toBe(0);
    expect(r.ownDescriptor(fp, key("name")).slice(0, 3)).toEqual([1, 4, key("")]);
    expect(r.hasOwn(fp, key("prototype"))).toBe(0);
    expect(r.deleteOwn(fp, key("length"))).toBe(1);
    expect(r.deleteOwn(fp, key("length"))).toBe(1);
    expect(ownKeys()).toEqual([key("name")]);
    expect(r.defineData(fp, key("length"), r.boxNumber(17), 191)).toBe(fp);
    expect(ownKeys()).toEqual([key("name"), key("length")]);
    expect(r.unboxNumber(r.getOwn(fp, key("length"), fp)[1])).toBe(17);
    expect(r.arity(fp)).toBe(0);
    r.defineData(fp, key("name"), null, 191);
    expect(r.getOwn(fp, key("name"), fp)).toEqual([1, null]);
    expect(r.initialName(fp)).toBe(key(""));
    r.defineAccessor(fp, key("name"), r.undefinedValue(), r.undefinedValue(), 822);
    expect(r.getOwn(fp, key("name"), fp)).toEqual([1, r.undefinedValue()]);
    expect(r.initialName(fp)).toBe(key(""));
    expect(r.method1(fp, null, 99)).toBe(r.undefinedValue());
  });
  it("keeps descriptor presence, mutation flags, own writes and getter absence exact", () => {
    const { runtime: r, keyTexts } = builtinFunctionRuntime(offset);
    const key = (text: string) => r.key(keyTexts.indexOf(text)),
      fp = r.functionPrototype(),
      u = r.undefinedValue();
    expect(r.writeOwn(fp, key("name"), 42)).toBe(0);
    typeError(() => r.writeOwnStrict(fp, key("name"), 42), r.exception);
    r.defineData(fp, key("value"), u, 191);
    expect(r.getOwn(fp, key("value"), fp)).toEqual([1, u]);
    expect(r.getOwn(fp, key("missing"), fp)).toEqual([0, u]);
    r.defineAccessor(fp, key("value"), u, u, 822);
    expect(r.ownDescriptor(fp, key("value")).slice(0, 2)).toEqual([1, 14]);
    expect(r.getOwn(fp, key("value"), 33)).toEqual([1, u]);
    r.defineAccessor(fp, key("value"), r.throwTypeError(), u, 822);
    expect(r.hasOwn(fp, key("value"))).toBe(1);
    expect(r.has(fp, key("value"))).toBe(1);
    typeError(() => r.getOwn(fp, key("value"), 33), r.exception);
    r.defineData(fp, key("value"), 12, 191);
    expect(r.writeOwn(fp, key("value"), 13)).toBe(1);
    expect(r.getOwn(fp, key("value"), null)).toEqual([1, 13]);
    r.defineAttributes(fp, key("value"), 32);
    expect(r.deleteOwn(fp, key("value"))).toBe(0);
    typeError(() => r.defineAttributes(fp, key("value"), 36), r.exception);
    r.preventExtensions(fp);
    expect(r.isExtensible(fp)).toBe(0);
    typeError(() => r.defineData(fp, key("missing"), null, 191), r.exception);
    r.defineData(fp, key("value"), 14, 128);
    expect(r.getOwn(fp, key("value"), null)).toEqual([1, 14]);
    expect(r.initialName(fp)).toBe(key(""));
  });
  it("retains key order through growth, tombstones, numeric indices and Symbols", () => {
    const { runtime: r, keyTexts } = builtinFunctionRuntime(offset);
    const key = (text: string) => r.key(keyTexts.indexOf(text)),
      fp = r.functionPrototype(),
      a = r.symbol(701),
      b = r.symbol(702);
    const names = Array.from({ length: 24 }, (_, i) => "added" + i);
    r.defineData(fp, b, 1, 191);
    for (const name of [...names, "4294967295", "00", "2147483648", "2", "4294967294", "0"])
      r.defineData(fp, key(name), name, 191);
    r.defineData(fp, a, 2, 191);
    for (const name of ["added0", "added5", "added23"]) {
      expect(r.deleteOwn(fp, key(name))).toBe(1);
      r.defineData(fp, key(name), null, 191);
    }
    const list = r.ownKeys(fp);
    expect(Array.from({ length: r.vectorLength(list) }, (_, i) => r.vectorAt(list, i))).toEqual([
      ...[
        "0",
        "2",
        "2147483648",
        "4294967294",
        "length",
        "name",
        ...names.filter((n) => !["added0", "added5", "added23"].includes(n)),
        "4294967295",
        "00",
        "added0",
        "added5",
        "added23",
      ].map(key),
      b,
      a,
    ]);
  });
  it("walks actual prototypes, shadows with undefined, refuses unresolved gaps and checks cycles", () => {
    const { runtime: r, keyTexts } = builtinFunctionRuntime(offset);
    const key = (text: string) => r.key(keyTexts.indexOf(text)),
      fp = r.functionPrototype(),
      thrower = r.throwTypeError(),
      u = r.undefinedValue(),
      op = r.objectPrototype();
    r.ordinaryDefineData(op, key("value"), 44, 191);
    expect(r.get(thrower, key("value"), 123)).toEqual([1, 44]);
    r.defineData(fp, key("value"), u, 191);
    expect(r.get(thrower, key("value"), null)).toEqual([1, u]);
    r.defineAccessor(fp, key("value"), u, u, 822);
    expect(r.get(thrower, key("value"), "receiver")).toEqual([1, u]);
    expect(r.get(thrower, key("missing"), null)).toEqual([2, u]);
    expect(r.has(thrower, key("missing"))).toBe(2);
    expect(r.get({}, key("missing"), null)).toEqual([3, u]);
    expect(r.get(r.createDefault(), key("missing"), null)).toEqual([2, u]);
    expect(r.setPrototypeOf(fp, thrower)).toBe(0);
    expect(r.getPrototypeOf(fp)).toBe(op);
    expect(r.setPrototypeOf(fp, {})).toBe(3);
    expect(r.setPrototypeOf(fp, r.createDefault())).toBe(2);
    expect(r.getPrototypeOf(fp)).toBe(op);
    expect(r.setPrototypeOf(fp, null)).toBe(1);
    expect(r.get(fp, key("missing"), fp)).toEqual([0, u]);
    r.preventExtensions(fp);
    expect(r.setPrototypeOf(fp, null)).toBe(1);
    expect(r.setPrototypeOf(fp, op)).toBe(0);
  });
  it("rejects cloned and foreign singleton objects and preserves the original abrupt reference/tag", () => {
    const { runtime: r, instantiate, keyTexts } = builtinFunctionRuntime(offset),
      foreign = instantiate();
    const fp = r.functionPrototype(),
      clone = r.clone(fp),
      vector = r.newVector();
    expect(r.match(clone)).toBe(0);
    expect(r.match(foreign.functionPrototype())).toBe(0);
    expect(Object.is(r.realmIdentity(), foreign.realmIdentity())).toBe(false);
    for (const mode of [1, 2, 3]) {
      const forged = r.forge(fp, mode);
      expect(r.match(forged)).toBe(0);
      typeError(() => r.call(forged, null, vector), r.exception);
      typeError(() => r.directEntry(forged, null, vector), r.exception);
    }
    expect(r.match(r.bareMetadata())).toBe(0);
    typeError(() => r.call(r.bareMetadata(), null, vector), r.exception);
    typeError(() => r.call(clone, null, vector), r.exception);
    typeError(() => r.directEntry(clone, null, vector), r.exception);
    typeError(() => r.call(foreign.functionPrototype(), null, vector), r.exception);
    typeError(() => r.construct(fp, null, vector), r.exception);
    const error = typeError(() => r.catchRethrow(r.throwTypeError(), null, vector), r.exception);
    expect(error.getArg(r.exception, 0)).toBe(r.thrown.value);
    expect(r.state.value).toBe(2);
    expect(r.realmReady.value).toBe(0);
    expect(r.method0(fp, r.undefinedValue())).toBe(r.undefinedValue());
    expect(r.isExtensible(r.throwTypeError())).toBe(0);
    for (const index of ["length", "name"]) {
      const key = r.key(keyTexts.indexOf(index));
      expect(r.ownDescriptor(r.throwTypeError(), key).slice(0, 2)).toEqual([1, 0]);
      expect(r.deleteOwn(r.throwTypeError(), key)).toBe(0);
    }
  });
  it("observes exact receivers, argc, omission and ordered extras through uninstalled native controls", () => {
    const { runtime: r, keyTexts } = builtinFunctionRuntime(offset, true);
    const control = r.controlValue(),
      u = r.undefinedValue(),
      vector = r.newVector();
    expect(r.match(control)).toBe(0);
    expect(r.header(control)[0]).toBe(7);
    expect(r.unboxNumber(r.controlLength())).toBe(2);
    const receivers = [null, u, {}, 37, -0, "receiver", true, undefined];
    for (const receiver of receivers) {
      r.controlMode.value = 0;
      expect(r.controlCall(control, receiver, vector)).toBe(receiver);
      expect(r.controlReceiver.value).toBe(receiver);
      expect(r.controlVector.value).toBe(vector);
    }
    r.controlMode.value = 1;
    expect(r.controlMethod0(control, null)).toBe(u);
    expect(r.controlMethod3(control, null, u, 2, 3)).toBe(u);
    r.controlMode.value = 3;
    expect(r.unboxNumber(r.controlMethod0(control, null))).toBe(0);
    const explicit = r.newVector();
    r.push(explicit, u);
    expect(r.unboxNumber(r.controlCall(control, null, explicit))).toBe(1);
    r.controlMode.value = 2;
    const a = {},
      b = null,
      c = u;
    const complete = r.controlMethod3(control, 8, a, b, c) as object;
    expect(r.vectorLength(complete)).toBe(3);
    expect([0, 1, 2].map((index) => r.vectorAt(complete, index))).toEqual([a, b, c]);
    const extras = r.newVector();
    for (let i = 0; i < 21; i++) r.push(extras, i);
    expect(r.controlCall(control, null, extras)).toBe(extras);
    expect(Array.from({ length: 21 }, (_, i) => r.vectorAt(extras, i))).toEqual(
      Array.from({ length: 21 }, (_, i) => i),
    );
    r.ordinaryDefineData(r.controlBag(), r.key(keyTexts.indexOf("length")), r.boxNumber(99), 128);
    expect(r.unboxNumber(r.controlLength())).toBe(99);
    expect(r.header(control)[0]).toBe(7);
    expect(r.controlCall(control, null, extras)).toBe(extras);
    expect(r.controlEntered.value).toBeGreaterThan(0);
    expect(r.realmReady.value).toBe(0);
  });
  it("keeps original operands across native recursion, inherited getter reentry and abrupt controls", () => {
    const { runtime: r, keyTexts } = builtinFunctionRuntime(offset, true);
    const control = r.controlValue(),
      fp = r.functionPrototype(),
      thrower = r.throwTypeError(),
      u = r.undefinedValue();
    const value = r.key(keyTexts.indexOf("value")),
      receiver = {},
      marker = {},
      vector = r.newVector();
    r.push(vector, r.boxNumber(4));
    r.push(vector, marker);
    r.controlMode.value = 4;
    const before = Number(r.controlEntered.value);
    expect(r.controlCall(control, receiver, vector)).toBe(marker);
    expect(Number(r.controlEntered.value) - before).toBe(5);
    expect(r.vectorAt(vector, 1)).toBe(marker);
    r.defineAccessor(fp, value, control, u, 822);
    // The production dispatcher explicitly retains this unowned getter as a gap.
    expect(r.get(thrower, value, receiver)).toEqual([3, u]);
    expect(r.has(thrower, value)).toBe(1);
    r.controlMode.value = 5;
    expect(r.controlGet(thrower, value, receiver)).toEqual([1, receiver]);
    expect(r.controlMode.value).toBe(5);
    for (const original of [null, u, 19]) expect(r.controlGet(thrower, value, original)).toEqual([1, original]);
    const abrupt = r.newVector(),
      original = {};
    r.push(abrupt, original);
    r.controlMode.value = 6;
    const error = typeError(() => r.controlCatch(control, receiver, abrupt), r.exception);
    expect(error.getArg(r.exception, 0)).toBe(original);
    expect(r.controlThrown.value).toBe(original);
    expect(r.controlReceiver.value).toBe(receiver);
    expect(r.controlVector.value).toBe(abrupt);
    r.controlMode.value = 0;
    expect(r.controlCall(control, receiver, vector)).toBe(receiver);
    expect(r.method0(fp, null)).toBe(u);
  });
});

describe("review regression controls for native builtin dependencies", () => {
  it.each(["new-body", "new-locals", "push-body", "push-locals"] as const)(
    "refuses externally filled argument-vector %s before filling its kernel",
    (role) => {
      const f = builtinFunctionFixture(),
        p = f.kernel!,
        v = f.argumentsPack;
      f.tx.freezeReservations();
      fillDescriptorDependencies(f);
      fillNativeObjectDescriptorResources(f.tx, f.pack, p.exception);
      const extra = { name: "unowned", type: { kind: "i32" as const } };
      f.tx.fillFunction(v.newVector, {
        locals: role === "new-locals" ? [extra] : [],
        body: role === "new-body" ? [{ op: "ref.null.extern" }] : buildArgumentVectorNewBody(v.layout),
      });
      f.tx.fillFunction(v.push, {
        locals: [...buildArgumentVectorPushLocals(v.layout), ...(role === "push-locals" ? [extra] : [])],
        body: role === "push-body" ? [] : buildArgumentVectorPushBody(v.layout),
      });
      expect(() => fillNativeBuiltinFunctionResources(f.tx, p)).toThrow(
        "native builtin functions: noncanonical argument-vector " +
          (role.startsWith("new") ? "new" : "push") +
          " definition",
      );
      expect(p.globals.state.object.init).toEqual([]);
      expect(p.entries[0]!.algorithm.object.body).toEqual([]);
    },
  );
  it.each([false, true])(
    "refuses extensible Object dependencies before allocation; StringOwn selected=%s",
    (selected) => {
      const f = builtinFunctionFixture(false, false, undefined, true),
        control = reserveBuiltinStringControl(f, true);
      expect(requireNativeStringCreateReservations(f.tx, control.create, control.createDependencies)).toBe(
        control.create,
      );
      const descriptorDependencies = selected
        ? { ...f.dependencies, stringOwn: { pack: control.own, dependencies: control.ownDependencies } }
        : f.dependencies;
      const descriptors = selected
        ? reserveNativeObjectDescriptorResources(
            f.tx,
            "selected-string-descriptors",
            descriptorDependencies,
            declareNativeObjectDescriptorResources("selected-string-descriptors"),
          )
        : f.pack;
      const dependencies = { ...f.kernelDependencies, descriptors, descriptorDependencies },
        before = population(f);
      expect(() => reserveNativeBuiltinFunctionResources(f.tx, dependencies)).toThrow(
        "native builtin functions: extensible ordinary carrier requires heterogeneous prototype dispatch",
      );
      expect(population(f)).toEqual(before);
    },
  );
  it("refuses a genuine same-ledger StringCreate carrier without hiding its virtual own property", () => {
    const { runtime: r, compiled, keyTexts } = compileBuiltinFunctionRuntime(false, false, true),
      key = (text: string) => r.key(keyTexts.indexOf(text)),
      string = r.stringMake(null, key("x")),
      zero = key("0"),
      fp = r.functionPrototype(),
      anchor = r.getPrototypeOf(fp),
      u = r.undefinedValue();
    expect(WebAssembly.Module.imports(compiled)).toEqual([]);
    expect(r.stringStoredHas(string, zero)).toBe(0);
    expect(r.stringOwnHas(string, zero)).toBe(1);
    expect(r.stringSameValue(r.stringOwnValue(string, zero), key("x"))).toBe(1);
    expect(r.get(string, zero, fp)).toEqual([3, u]);
    expect(r.has(string, zero)).toBe(3);
    expect(r.setPrototypeOf(fp, string)).toBe(3);
    expect(Object.is(r.getPrototypeOf(fp), anchor)).toBe(true);
    const ordinary = r.createNull();
    r.ordinaryDefineData(ordinary, zero, 17, 191);
    expect(r.setPrototypeOf(fp, ordinary)).toBe(1);
    expect(r.get(fp, zero, fp)).toEqual([1, 17]);
    expect(r.has(fp, zero)).toBe(1);
    expect(r.setPrototypeOf(fp, string)).toBe(3);
    expect(Object.is(r.getPrototypeOf(fp), ordinary)).toBe(true);
    expect(r.realmReady.value).toBe(0);
  }, 60_000);
});
describe("native builtin issuer authentication", () => {
  it("admits genuine immutable captures and refuses a future mutable-capture provider", () => {
    const policy = {
      backend: "wasmgc",
      target: "standalone",
      numberBoundary: { box: "unsupported", unbox: "native" },
      stringConst: { storage: "native" },
    } as const;
    const prepared = prepareWholeIrProgram({
      ...sourceInput({
        "./entry.ts":
          GETTER_SOURCE +
          `
        export function capture(seed: number) {
          const saved = seed * 2;
          return function nested(value: number): number { return saved + value; };
        }`,
      }),
      policy,
      runtimePolicies: [policy],
      nativeStringValueProjection: "standalone-native",
    });
    if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
    const selected = { program: prepared.program, projection: prepared.program.runtime[0]! };
    const positive = builtinFunctionFixture(false, false, selected);
    const captures = positive.source.types.shapes.filter(
      (row) => row.type.object.kind === "struct" && row.type.object.fields.length > 3,
    );
    expect(captures.length).toBeGreaterThan(0);
    expect(requireNativeSourceClosureTypes(positive.tx, positive.source.types, positive.sourceRequirements)).toBe(
      positive.source.types,
    );
    for (const row of captures) {
      if (row.type.object.kind !== "struct") throw Error("missing issued source capture");
      expect(row.type.object.fields.slice(3).every((field) => !field.mutable)).toBe(true);
    }
    // Fault injection changes the actual pure layout provider, never the source
    // requirement plan. A future mutable capture cannot silently widen admission.
    const original = captureLayouts.createClosureCaptureType;
    const unsafe = vi.spyOn(captureLayouts, "createClosureCaptureType").mockImplementation((...args) => {
      const shape = original(...args);
      shape.fields[3]!.mutable = true;
      return shape;
    });
    try {
      expect(() => builtinFunctionFixture(false, false, selected)).toThrow(
        "source capture layout may overlap the mutable builtin metadata family",
      );
    } finally {
      unsafe.mockRestore();
    }
    expect(requireNativeSourceClosureTypes(positive.tx, positive.source.types, positive.sourceRequirements)).toBe(
      positive.source.types,
    );
  });
  it("rejects copied packs, foreign ledgers, wrong dependencies and aliases", () => {
    const f = builtinFunctionFixture(),
      p = f.kernel!;
    expect(requireNativeBuiltinFunctionReservations(f.tx, p, f.kernelDependencies)).toBe(p);
    expect(() => requireNativeBuiltinFunctionReservations(f.tx, { ...p }, f.kernelDependencies)).toThrow(/copied/);
    expect(() =>
      requireNativeBuiltinFunctionReservations(
        new PhysicalModuleReservations(createEmptyModule()),
        p,
        f.kernelDependencies,
      ),
    ).toThrow(/foreign/);
    expect(() => requireNativeBuiltinFunctionReservations(f.tx, p, { ...f.kernelDependencies })).toThrow(
      /foreign expected/,
    );
    expect(() => requireNativeBuiltinFunctionRequests(f.tx, { ...f.requests })).toThrow(/copied/);
    expect(() => nativeBuiltinFunctionSingletonBinding(f.tx, p, "unknown")).toThrow(/unknown/);
    expect(() => requireNativeSourceClosureTypes(f.tx, { ...f.source.types }, f.sourceRequirements)).toThrow(/copied/);
  });
  it("refuses a late resource collision before reserving a partial kernel", () => {
    const probe = builtinFunctionFixture();
    const last = nativeBuiltinFunctionReservationInventory(probe.tx, probe.kernel!).keys.at(-1)!;
    const f = builtinFunctionFixture(false, false);
    f.tx.reserveFunction(last, "collision", { params: [], results: [] });
    const before = population(f);
    expect(() => reserveNativeBuiltinFunctionResources(f.tx, f.kernelDependencies)).toThrow(/key|duplicate|collision/);
    expect(population(f)).toEqual(before);
  });
  it("rejects stale requirements and forged closure inputs without allocating", () => {
    const f = builtinFunctionFixture(false, false),
      before = population(f);
    expect(() =>
      reserveNativeBuiltinFunctionResources(f.tx, {
        ...f.kernelDependencies,
        closures: { ...f.closures },
      }),
    ).toThrow(/copied|foreign/);
    expect(() =>
      reserveNativeBuiltinFunctionResources(f.tx, {
        ...f.kernelDependencies,
        closurePlan: { ...f.closurePlan, requirements: { ...f.closurePlan.requirements, requests: [] } },
      }),
    ).toThrow(/plan|declaration|changed|mismatch/);
    (f.requirements as { key: string }).key += ":stale";
    expect(() => requireNativeBuiltinFunctionRequests(f.tx, f.requests)).toThrow("stale builtin requirements");
    expect(() => requireNativeSourceClosureTypes(f.tx, f.source.types, f.sourceRequirements)).toThrow(
      "stale builtin requirements",
    );
    expect(population(f)).toEqual(before);
  });
  it("does not certify externally filled bodies or singleton globals", () => {
    const f = builtinFunctionFixture(),
      p = f.kernel!;
    f.tx.freezeReservations();
    f.tx.fillFunction(p.entries[0]!.algorithm, { locals: [], body: [{ op: "ref.null.extern" }] });
    f.tx.fillGlobal(p.entries[0]!.singleton, [{ op: "ref.null", typeIdx: p.entries[0]!.type.typeIndex }]);
    expect(() => requireCompletedNativeBuiltinFunctionKernel(f.tx, p, f.kernelDependencies)).toThrow(
      "missing canonical builtin fill",
    );
    expect(() => f.tx.fillFunction(p.entries[0]!.algorithm, { locals: [], body: [] })).toThrow(
      "duplicate function fill builtins:function-prototype:algorithm",
    );
  });
  it.each(["signature", "layout", "singleton"] as const)("detects a changed reserved %s", (role) => {
    const f = builtinFunctionFixture(),
      p = f.kernel!,
      entry = p.entries[0]!;
    f.tx.freezeReservations();
    if (role === "signature") entry.lifted.object.typeIdx = entry.getter.object.typeIdx;
    if (role === "layout") {
      if (entry.type.object.kind !== "struct") throw Error("missing subtype");
      entry.type.object.fields[6]!.mutable = true;
    }
    if (role === "singleton") entry.singleton.object.type = { kind: "externref" };
    expect(() => requireNativeBuiltinFunctionReservations(f.tx, p, f.kernelDependencies)).toThrow(/altered|changed/);
  });
  it("refuses invalid names, lengths, bodies, aliases and coercion callbacks without allocation", () => {
    const f = builtinFunctionFixture(false, false),
      before = population(f);
    let invoked = 0;
    const badKey = {
      toString() {
        invoked++;
        return "bad";
      },
    };
    for (const change of [
      { initialLength: Infinity },
      { initialName: { symbol: "x" } },
      { behavior: "observer" },
      { constructible: true },
      { aliases: ["duplicate", "duplicate"] },
    ]) {
      const requirement = builtinRequirements();
      const mutated = {
        ...requirement,
        intrinsics: [{ ...requirement.intrinsics[0]!, ...change }, requirement.intrinsics[1]!],
      } as NativeBuiltinFunctionRequirements;
      expect(() => declareNativeBuiltinFunctionResources(f.tx, mutated, f.requestDependencies)).toThrow();
    }
    expect(() =>
      declareNativeBuiltinFunctionResources(
        f.tx,
        { ...builtinRequirements(), key: badKey } as unknown as NativeBuiltinFunctionRequirements,
        f.requestDependencies,
      ),
    ).toThrow();
    expect(invoked).toBe(0);
    expect(population(f)).toEqual(before);
  });
  it("pins enumerable vector roles and rejects hidden replacements and accessor inputs", () => {
    const f = builtinFunctionFixture(false, false);
    const otherPlan = declareNativeArgumentVectorResources(
      { key: "other-arguments" },
      { vectorBaseKey: f.argumentsPack.vectorBase.key },
    );
    const other = reserveNativeArgumentVectorResources(
      f.tx,
      { key: "other-arguments" },
      { vectorBase: f.argumentsPack.vectorBase },
      otherPlan,
    );
    expect(requireNativeBuiltinFunctionRequests(f.tx, f.requests)).toBe(f.requests);
    const hidden = { strings: f.strings };
    Object.defineProperties(hidden, {
      arguments: { value: f.argumentsPack, writable: true },
      argumentPlan: { value: f.argumentPlan, writable: true },
    });
    expect(() =>
      declareNativeBuiltinFunctionResources(f.tx, builtinRequirements(), hidden as typeof f.requestDependencies),
    ).toThrow(/non-data/);
    Object.defineProperties(hidden, { arguments: { value: other }, argumentPlan: { value: otherPlan } });
    expect(() =>
      declareNativeBuiltinFunctionResources(f.tx, builtinRequirements(), hidden as typeof f.requestDependencies),
    ).toThrow(/non-data/);
    let read = 0;
    const getter = {
      ...f.requestDependencies,
      get arguments() {
        read++;
        return other;
      },
    };
    expect(() => declareNativeBuiltinFunctionResources(f.tx, builtinRequirements(), getter)).toThrow(/non-data/);
    expect(read).toBe(0);
    f.requestDependencies.arguments = other;
    f.requestDependencies.argumentPlan = otherPlan;
    expect(() => requireNativeBuiltinFunctionRequests(f.tx, f.requests)).toThrow(/identities/);
    expect(() => requireNativeSourceClosureTypes(f.tx, f.source.types, f.sourceRequirements)).toThrow(/identities/);
  });
  it.each(["body", "global", "layout"] as const)(
    "requires canonical completion and detects post-fill %s mutation",
    (role) => {
      const f = builtinFunctionFixture(),
        p = f.kernel!;
      expect(() => requireCompletedNativeBuiltinFunctionKernel(f.tx, p, f.kernelDependencies)).toThrow(/canonical/);
      completeBuiltinFunctionFixture(f);
      expect(requireCompletedNativeBuiltinFunctionKernel(f.tx, p, f.kernelDependencies)).toBe(p);
      expect(() => fillNativeBuiltinFunctionResources(f.tx, p)).toThrow(/duplicate/);
      if (role === "body") {
        p.entries[0]!.algorithm.object.body.push({ op: "nop" });
        expect(() => requireCompletedNativeBuiltinFunctionKernel(f.tx, p, f.kernelDependencies)).toThrow(
          "physical module reservations: altered completed function builtins:function-prototype:algorithm",
        );
      } else if (role === "global") {
        p.entries[0]!.singleton.object.init.push({ op: "nop" });
        expect(() => requireCompletedNativeBuiltinFunctionKernel(f.tx, p, f.kernelDependencies)).toThrow(
          "physical module reservations: altered completed global builtins:function-prototype:singleton",
        );
      } else {
        const shape = p.entries[0]!.type.object;
        if (shape.kind !== "struct") throw Error("missing authentic builtin layout");
        shape.fields[6]!.mutable = true;
        expect(() => requireCompletedNativeBuiltinFunctionKernel(f.tx, p, f.kernelDependencies)).toThrow(
          /physical module reservations: altered (type descriptor builtins:function-prototype:type|reserved type definition\/signature)/,
        );
      }
    },
  );
});
