// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { prepareSourceClosureInvocations } from "../src/ir/source-closure-invocation.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { deriveNativeObjectAccessRequirements } from "../src/ir/program/native-object-access-requirements.js";
import {
  planNativeInvocationRequirements,
  assertNativeInvocationRequirementsCurrent,
} from "../src/ir/program/native-invocation-requirements.js";
import {
  nativeInvocationGetterDispatch,
  requireNativeInvocationReservations,
  requireCompletedNativeInvocation,
  fillNativeInvocationResources,
  reserveNativeInvocationResources,
} from "../src/backend/wasmgc/resources/native-invocation.js";
import { bindNativeSourceClosureCallables } from "../src/backend/wasmgc/resources/native-source-closure-callables.js";
import { beginNativeSourceClosureEmission, bindNativeSourceClosureUnits } from "../src/ir/program-native-invocation.js";
import {
  GETTER_SOURCE,
  CALL_SOURCE,
  prepareGetterProgram,
  getterRequirements,
  getterInvocationFixture,
  freezeGetterInvocation,
  fillGetterInvocationDependencies,
  getterInvocationRuntime,
} from "./helpers/native-getter-invocation-fixture.js";

let original: PreparedIrProgram;
beforeAll(() => {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  original = prepareGetterProgram();
});
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
afterAll(() => vi.unstubAllEnvs());

function mutableProgram() {
  const projection = {
    ...original.runtime[0]!,
    prepared: {
      ...original.runtime[0]!.prepared,
      functions: structuredClone(original.runtime[0]!.prepared.functions),
    },
  };
  return {
    ...original,
    ir: { ...original.ir, functions: structuredClone(original.ir.functions) },
    allocations: structuredClone(original.allocations),
    runtime: [projection],
  };
}
function unchanged<T>(module: unknown, run: () => T): T {
  const before = structuredClone(module);
  const result = run();
  expect(module).toStrictEqual(before);
  return result;
}
function nativeOracle(source: string): (seed: number) => number {
  const exports: { run?: (seed: number) => number } = {};
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    { exports },
    { timeout: 1000 },
  );
  if (!exports.run) throw new Error("actual-source oracle lacks run");
  return exports.run;
}
function actualSourceInvocationPlans(text: string) {
  const input = sourceInput({ "./entry.ts": text });
  return prepareSourceClosureInvocations(input.checker, input.sourceFiles);
}

describe("C1-authenticated semantic getter invocation requirements", () => {
  it.each([false, true])("selects the real captured getter without fabricating .call uses, decoded=%s", (decoded) => {
    const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
    const f = getterRequirements(program),
      invocation = f.invocation!;
    expect(invocation).toBeDefined();
    expect(invocation.objectAccess).toBe(f.access);
    expect(invocation.uses).toEqual([]);
    expect(invocation.methodArities).toEqual([0]);
    expect(invocation.getterUses).toHaveLength(1);
    expect(invocation.gaps).toEqual([]);
    expect(f.access.gaps.some((gap) => gap.detail.includes("implicit-prototype companion"))).toBe(true);
    const use = invocation.getterUses[0]!,
      demand = f.access.getters[use.getterIndex]!;
    const allocation = f.source.allocations.find((row) => row.occurrence === use.allocationOccurrence)!;
    expect(allocation.liftedUnitId).toBe(use.liftedUnitId);
    expect(allocation.rawAllocationId).toBe(demand.rawAllocationId);
    expect(allocation.allocationId).toBe(demand.allocationId);
    expect(f.source.shapes.find((row) => row.id === use.shapeId)!.captures).toHaveLength(1);
    expect(() => assertNativeInvocationRequirementsCurrent(invocation)).not.toThrow();
  });
  it.each([false, true])(
    "retains an actual returned callable without declaring it a getter target, decoded=%s",
    (decoded) => {
      const program = prepareGetterProgram(
        `export function run() {
      const captured = 7;
      const object = { get value() { return function () { return captured; }; } };
      return object.value;
    }`,
        decoded,
      );
      const f = getterRequirements(program);
      expect(f.source.units).toHaveLength(2);
      expect(f.invocation!.getterUses).toHaveLength(1);
      expect(f.invocation!.gaps).toEqual([]);
      expect(f.access.getters[0]!.signature.returnType?.kind).toBe("callable");
      expect(new Set(f.invocation!.getterUses.map((row) => row.liftedUnitId)).size).toBe(1);
    },
  );
  it("retains distinct source allocations for same-signature getters", () => {
    const program = prepareGetterProgram(`export function run(seed: number) {
      const left = { get value() { return seed + 1; } };
      const right = { get value() { return seed + 9; } };
      return left.value + right.value;
    }`);
    const f = getterRequirements(program);
    expect(f.invocation!.getterUses).toHaveLength(2);
    expect(new Set(f.invocation!.getterUses.map((row) => row.liftedUnitId)).size).toBe(2);
    expect(new Set(f.access.getters.map((row) => row.allocationId)).size).toBe(2);
    expect(f.invocation!.methodArities).toEqual([0]);
  });
  it("does not turn a descriptor with no actual Get into invocation demand", () => {
    const f = getterRequirements(prepareGetterProgram(GETTER_SOURCE.replace("return object.value;", "return 7;")));
    expect(f.source.units).toHaveLength(1);
    expect(f.access.getters).toEqual([]);
    expect(f.invocation).toBeUndefined();
  });
  it("keeps actual source-call ABI uses independent of an empty C1 getter population", () => {
    const f = getterRequirements(prepareGetterProgram(CALL_SOURCE));
    expect(f.invocation!.uses.some((use) => use.kind === "method" && use.arity === 1)).toBe(true);
    expect(f.invocation!.getterUses).toEqual([]);
    expect(f.invocation!.methodArities).toEqual([1]);
  });
  it("rejects a copied C1 pack after the real issuer positive", () => {
    const f = getterRequirements(original);
    expect(() => assertNativeInvocationRequirementsCurrent(f.invocation!)).not.toThrow();
    expect(() =>
      planNativeInvocationRequirements(f.source, { utf8Storage: false, objectAccess: { ...f.access } }),
    ).toThrow(/unissued|detached/);
  });
  it("rejects a genuine foreign-program C1 pack even when serialized source bytes agree", () => {
    const f = getterRequirements(original),
      other = getterRequirements(decodePreparedIrProgram(encodePreparedIrProgram(original)));
    expect(encodePreparedIrProgram(other.program)).toBe(encodePreparedIrProgram(original));
    expect(() =>
      planNativeInvocationRequirements(f.source, { utf8Storage: false, objectAccess: other.access }),
    ).toThrow("different prepared program/projection/allocation owner");
  });
  it.each(["capture", "allocation", "Get receiver", "descriptor getter", "instruction identity"] as const)(
    "refuses stale actual %s provenance after the paired positive",
    (mutation) => {
      const f = getterRequirements(mutableProgram());
      expect(() => assertNativeInvocationRequirementsCurrent(f.invocation!)).not.toThrow();
      const demand = f.access.getters[0]!;
      const index =
        mutation === "Get receiver"
          ? demand.getOccurrence
          : mutation === "descriptor getter"
            ? demand.definitionOccurrence
            : demand.allocationOccurrence;
      const occurrence = f.source.demands.occurrences[index]!,
        instruction = occurrence.instruction;
      if (mutation === "instruction identity") {
        const buffer = f.source.demands.buffers[occurrence.bufferIndex]!;
        (buffer.instructions as unknown[])[occurrence.instructionIndex] = structuredClone(instruction);
      } else if (instruction.kind === "closure.new") {
        Object.assign(instruction, mutation === "capture" ? { captures: [] } : { alloc: undefined });
      } else if (instruction.kind === "call") {
        const args = [...instruction.args];
        args[2] = args[1]!;
        Object.assign(instruction, { args });
      } else throw new Error("mutation missed its actual positive instruction");
      expect(() => assertNativeInvocationRequirementsCurrent(f.invocation!)).toThrow();
    },
  );
  it("reports unsupported getter result conversion before physical reservation", () => {
    const f = getterRequirements(
      prepareGetterProgram(`export function run() {
      const object = { get value() { return true; } }; return object.value;
    }`),
    );
    expect(f.invocation!.getterUses).toHaveLength(1);
    expect(f.invocation!.gaps.some((gap) => gap.detail.includes("argument/result conversion"))).toBe(true);
  });
  it.each([false, true])(
    "unites real source-call and getter slots after proving the getter body, decoded=%s",
    (decoded) => {
      const text = `export function run() {
      const object = { get value() { return 7; } };
      const fn = function(value: number): number { return value + 3; };
      return fn.call(null, object.value);
    }`;
      expect(nativeOracle(text)(0)).toBe(10);
      expect(actualSourceInvocationPlans(text).size).toBe(1);
      const f = getterInvocationFixture(prepareGetterProgram(text, decoded));
      expect(f.invocation.gaps).toEqual([]);
      expect(f.invocation.uses.filter((row) => row.kind === "method")).toHaveLength(1);
      expect(f.invocation.getterUses).toHaveLength(1);
      expect(f.invocation.methodArities).toEqual([0, 1]);
      expect(f.access.gaps.some((gap) => gap.detail.includes("implicit-prototype companion"))).toBe(true);
      const selected = new Set([
        ...f.invocation.uses.flatMap((row) => (row.liftedUnitId ? [row.liftedUnitId] : [])),
        ...f.invocation.getterUses.map((row) => row.liftedUnitId),
      ]);
      expect(selected.size).toBe(2);
      const callables = freezeGetterInvocation(f);
      expect(new Set(callables.entries.map((row) => row.unitId))).toEqual(selected);
      for (const entry of callables.entries) expect(entry.slot).toBe(f.slots.get(entry.unitId));
      expect(nativeInvocationGetterDispatch(f.tx, f.pack, f.access)).toBe(
        f.pack.methods.find((row) => row.arity === 0)!.function,
      );
    },
  );
  it.each([
    ["unknown getter call", "return outside();", "declare function outside(): number;", ""],
    ["prototype mutation", "(Function.prototype as any).call = outside; return 7;", "declare const outside: any;", ""],
    ["numeric coercion hidden by assertions", "return +(input as unknown as number);", "", "input: any"],
    ["computed getter name", "return 7;", "", "", "get [key]", "const key = 'value';"],
    ["receiver alias", "return 7;", "", "", "get value", "", "const alias = object;"],
    ["receiver write", "return 7;", "", "", "get value", "", "(object as any).value = 4;"],
    ["unknown property read", "return 7;", "", "", "get value", "", "const other = (object as any).unknown;"],
    ["hidden nested call", "const hidden = () => outside(); return 7;", "declare function outside(): number;", ""],
  ])(
    "rejects %s instead of granting a getter syntax exemption",
    (_name, body, declarations, parameter, getter, prelude, use) => {
      const text = `${declarations}
      export function run(${parameter}) {
        ${prelude ?? ""}
        const object = { ${getter ?? "get value"}() { ${body} } };
        ${use ?? ""}
        const fn = function(value: number): number { return value + 3; };
        return fn.call(null, object.value);
      }`;
      expect(() => actualSourceInvocationPlans(text)).toThrow(/native closure invocation:/);
      expect(() => prepareGetterProgram(text)).toThrow(/unsupported/);
    },
  );
  it("rejects exporting a getter receiver beyond the closed source effect proof", () => {
    const text = `export const object = { get value(){ return 7; } };
      export function run(){
        const fn = function(value: number): number { return value + 3; };
        return fn.call(null, object.value);
      }`;
    expect(() => actualSourceInvocationPlans(text)).toThrow(/escapes|closed primordial/);
    expect(() => prepareGetterProgram(text)).toThrow(/unsupported/);
  });
});

describe("issued method-zero reservation and actual source-body dispatch", () => {
  it("returns the same owned slot before and after the sole reservation freeze without certifying completion", () => {
    const f = getterInvocationFixture(original);
    const token = unchanged(f.module, () => nativeInvocationGetterDispatch(f.tx, f.pack, f.access));
    expect(token).toBe(f.pack.methods.find((row) => row.arity === 0)!.function);
    expect(requireNativeInvocationReservations(f.tx, f.pack, f.invocation)).toBe(f.pack);
    expect(requireNativeInvocationReservations(f.tx, f.pack, f.invocation, f.dependencies)).toBe(f.pack);
    expect(() => requireCompletedNativeInvocation(f.tx, f.pack)).toThrow("incomplete selected source-invocation");
    const callables = freezeGetterInvocation(f);
    expect(callables.entries).toHaveLength(1);
    expect(callables.entries[0]!.slot).toBe(f.slots.get(f.invocation.getterUses[0]!.liftedUnitId));
    expect(unchanged(f.module, () => nativeInvocationGetterDispatch(f.tx, f.pack, f.access))).toBe(token);
  });
  it("requires the exact C1 issuer identity even for a second genuine identical selection", () => {
    const f = getterInvocationFixture(original);
    const other = deriveNativeObjectAccessRequirements(original, original.runtime[0]!);
    expect(other.getters).toEqual(f.access.getters);
    expect(() => nativeInvocationGetterDispatch(f.tx, f.pack, other)).toThrow("foreign expected object-access");
  });
  it("refuses a copied invocation pack", () => {
    const f = getterInvocationFixture(original);
    expect(() => nativeInvocationGetterDispatch(f.tx, { ...f.pack }, f.access)).toThrow("foreign or copied");
  });
  it("refuses a foreign ledger", () => {
    const f = getterInvocationFixture(original),
      other = getterInvocationFixture(original);
    expect(() => nativeInvocationGetterDispatch(other.tx, f.pack, f.access)).toThrow("foreign or copied");
  });
  it("refuses substituted expected invocation requirements", () => {
    const f = getterInvocationFixture(original);
    expect(() => requireNativeInvocationReservations(f.tx, f.pack, { ...f.invocation })).toThrow(
      "substituted expected",
    );
  });
  it("refuses copied expected dependencies even when all their issued resources are identical", () => {
    const f = getterInvocationFixture(original);
    expect(requireNativeInvocationReservations(f.tx, f.pack, f.invocation, f.dependencies)).toBe(f.pack);
    const before = structuredClone(f.module);
    expect(() => requireNativeInvocationReservations(f.tx, f.pack, f.invocation, { ...f.dependencies })).toThrow(
      "substituted expected invocation dependencies",
    );
    expect(f.module).toStrictEqual(before);
  });
  it("refuses another real source closure root issued on the same ledger", () => {
    const f = getterInvocationFixture(original);
    const other = getterRequirements(prepareGetterProgram(GETTER_SOURCE, false, "./other.ts"));
    const source = beginNativeSourceClosureEmission(f.tx, other.source, {
      vectors: f.dependencies.vectors,
      vectorPlan: f.dependencies.vectorPlan,
    });
    const dependencies = { ...f.dependencies, source: source.types };
    const pack = reserveNativeInvocationResources(f.tx, other.invocation!, dependencies);
    expect(requireNativeInvocationReservations(f.tx, pack, other.invocation!, dependencies)).toBe(pack);
    expect(source.types.closures.root === f.dependencies.source.closures.root).toBe(false);
    expect(source.types.closures.signatures[0]!.binding.info.paramTypes).toEqual(
      f.dependencies.source.closures.signatures[0]!.binding.info.paramTypes,
    );
    const before = structuredClone(f.module);
    expect(() => requireNativeInvocationReservations(f.tx, f.pack, f.invocation, dependencies)).toThrow(
      "substituted expected invocation dependencies",
    );
    expect(f.module).toStrictEqual(before);
  });
  it("does not lend source-call method zero authority when there is no getter demand", () => {
    const f = getterInvocationFixture(prepareGetterProgram(CALL_SOURCE));
    expect(f.invocation.getterUses).toEqual([]);
    expect(() => nativeInvocationGetterDispatch(f.tx, f.pack, f.access)).toThrow("no issued semantic getter demand");
  });
  it.each(["function", "global", "dependency"] as const)("refuses changed %s ownership/layout", (kind) => {
    const f = getterInvocationFixture(original);
    expect(nativeInvocationGetterDispatch(f.tx, f.pack, f.access)).toBeDefined();
    if (kind === "function") f.pack.methods[0]!.function.object.name += "changed";
    if (kind === "global") f.pack.globals.argc.object.mutable = false;
    if (kind === "dependency") f.dependencies.source = { ...f.sourceOwner.types };
    expect(() => nativeInvocationGetterDispatch(f.tx, f.pack, f.access)).toThrow();
  });
  it("refuses a same-signature function with a different original slot key", () => {
    const f = getterInvocationFixture(original),
      id = f.invocation.getterUses[0]!.liftedUnitId;
    f.slots.set(id, f.tx.reserveFunction("other:slot", "borrowed", f.signatures.get(id)!));
    f.tx.freezeReservations();
    expect(() => bindNativeSourceClosureCallables(f.tx, f.sourceOwner.types, f.slots, f.invocation)).toThrow(
      "original function slot",
    );
  });
  it("refuses callable bindings issued for a different selection before filling invocation bodies", () => {
    const f = getterInvocationFixture(original);
    const other = planNativeInvocationRequirements(f.source, { utf8Storage: false, objectAccess: f.access })!;
    f.tx.freezeReservations();
    bindNativeSourceClosureUnits(f.tx, f.sourceOwner, f.slots);
    const callables = bindNativeSourceClosureCallables(f.tx, f.sourceOwner.types, f.slots, other);
    fillGetterInvocationDependencies(f);
    const before = structuredClone(f.module);
    expect(() => fillNativeInvocationResources(f.tx, f.pack, callables, f.exception)).toThrow(
      "selected callable requirements differ",
    );
    expect(f.module).toStrictEqual(before);
  });
  it("requires actual lifted body completion after the canonical dispatcher fill", () => {
    const f = getterInvocationFixture(original),
      callables = freezeGetterInvocation(f);
    fillGetterInvocationDependencies(f);
    fillNativeInvocationResources(f.tx, f.pack, callables, f.exception);
    expect(() => requireCompletedNativeInvocation(f.tx, f.pack)).toThrow("missing function fill");
  });
  it.each([false, true])("executes the genuine captured getter body through its issued slot, decoded=%s", (decoded) => {
    const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
    const f = getterInvocationFixture(program),
      runtime = getterInvocationRuntime(f),
      expected = nativeOracle(GETTER_SOURCE);
    expect(f.invocation.uses).toEqual([]);
    const first = runtime.make(13),
      second = runtime.make(57);
    expect(first === second).toBe(false);
    expect(runtime.run({ receiver: 1 }, first)).toBe(expected(13));
    expect(runtime.run(null, second)).toBe(expected(57));
    expect(runtime.run(undefined, first)).toBe(expected(13));
    expect(() => requireCompletedNativeInvocation(f.tx, f.pack)).not.toThrow();
  });
});
