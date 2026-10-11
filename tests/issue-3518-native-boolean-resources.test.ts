// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { deriveNativeValueResourcePlan } from "../src/ir/program/native-value-resources.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
} from "../src/backend/wasmgc/resources/native-values.js";
import {
  reserveNativeBooleanResources,
  fillNativeBooleanResources,
  requireNativeBooleanReservations,
  requireCompletedNativeBooleans,
} from "../src/backend/wasmgc/resources/native-booleans.js";

let cached: ReturnType<typeof deriveNativeValueResourcePlan> | undefined;
function requirements() {
  if (cached) return cached;
  const policy = { backend: "wasmgc", target: "standalone" } as const;
  const source = prepareIrProgramSources({
    ...sourceInput({ "./entry.ts": "export function main(value: number): number { return value; }" }),
    policy,
  });
  if (source.kind !== "prepared") throw Error(source.detail);
  const program = requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(source), { ...typedOptions, policy, runtimePolicies: [policy] }),
  );
  return (cached = deriveNativeValueResourcePlan(program, program.runtime[0]!, "primitive-only"));
}
function reserve() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const plan = requirements(),
    dependencies = { strings: { kind: "absent" } } as const;
  const values = reserveNativeValueResources(tx, plan, dependencies);
  const pack = reserveNativeBooleanResources(tx, "control:boolean", values, plan, dependencies);
  return { module, tx, plan, dependencies, values, pack };
}
function fill() {
  const s = reserve();
  s.tx.freezeReservations();
  fillNativeValueResources(s.tx, s.values, s.dependencies);
  fillNativeBooleanResources(s.tx, s.pack);
  return s;
}
describe("native Boolean issued resource owner", () => {
  it("executes both functions using the actual primitive owner's Boolean layout", () => {
    const s = reserve();
    const box = s.tx.reserveFunction("control:box", "box", {
      params: [{ kind: "i32" }],
      results: [{ kind: "externref" }],
    });
    s.tx.freezeReservations();
    fillNativeValueResources(s.tx, s.values, s.dependencies);
    fillNativeBooleanResources(s.tx, s.pack);
    s.tx.fillFunction(box, {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "struct.new", typeIdx: s.values.types.boxedBoolean.typeIndex },
        { op: "extern.convert_any" },
      ],
    });
    for (const [name, token] of Object.entries({ box, ...s.pack })) s.tx.defineExport("export:" + name, name, token);
    expect(requireCompletedNativeBooleans(s.tx, s.pack, s.values, s.plan, s.dependencies)).toBe(s.pack);
    expect(s.tx.seal().completedFunctions).toBe(6);
    const compiled = new WebAssembly.Module(emitBinary(s.module) as BufferSource);
    expect(WebAssembly.Module.imports(compiled)).toEqual([]);
    const x = new WebAssembly.Instance(compiled).exports as unknown as {
      box(x: number): unknown;
      isBoolean(x: unknown): number;
      unboxBoolean(x: unknown): number;
    };
    for (const value of [0, 1]) {
      const boxed = x.box(value);
      expect(x.isBoolean(boxed)).toBe(1);
      expect(x.unboxBoolean(boxed)).toBe(value);
    }
    expect(x.isBoolean(null)).toBe(0);
  });
  it("refuses a cloned owner", () => {
    const s = reserve();
    expect(() => requireNativeBooleanReservations(s.tx, { ...s.pack }, s.values, s.plan, s.dependencies)).toThrow(
      "foreign",
    );
  });
  it("refuses a foreign ledger", () => {
    const s = reserve(),
      other = reserve();
    expect(() => fillNativeBooleanResources(other.tx, s.pack)).toThrow("foreign");
  });
  it("refuses substituted dependencies", () => {
    const s = reserve();
    expect(() =>
      requireNativeBooleanReservations(s.tx, s.pack, s.values, s.plan, { strings: { kind: "absent" } }),
    ).toThrow("substituted");
  });
  it("refuses substituted value ownership", () => {
    const s = reserve(),
      other = reserve();
    expect(() => requireNativeBooleanReservations(s.tx, s.pack, other.values, s.plan, s.dependencies)).toThrow(
      "substituted",
    );
  });
  it("does not complete while only reserved", () => {
    const s = reserve();
    expect(() => requireCompletedNativeBooleans(s.tx, s.pack, s.values, s.plan, s.dependencies)).toThrow("incomplete");
  });
  it("requires completed primitive dependency bodies", () => {
    const s = reserve();
    s.tx.freezeReservations();
    expect(() => fillNativeBooleanResources(s.tx, s.pack)).toThrow("incomplete");
  });
  it("refuses a second fill", () => {
    const s = fill();
    expect(() => fillNativeBooleanResources(s.tx, s.pack)).toThrow();
  });
  it("refuses borrowed primitive tokens before reserving Boolean functions", () => {
    const s = reserve();
    expect(() => reserveNativeBooleanResources(s.tx, "other", { ...s.values }, s.plan, s.dependencies)).toThrow(
      "foreign",
    );
  });
  it("refuses externally prefilled helper bodies", () => {
    const s = reserve();
    s.tx.freezeReservations();
    fillNativeValueResources(s.tx, s.values, s.dependencies);
    s.tx.fillFunction(s.pack.isBoolean, { locals: [], body: [{ op: "i32.const", value: 1 }] });
    expect(() => requireCompletedNativeBooleans(s.tx, s.pack, s.values, s.plan, s.dependencies)).toThrow("incomplete");
    expect(() => fillNativeBooleanResources(s.tx, s.pack)).toThrow("duplicate");
  });
  it("rejects changed canonical Boolean layout before dependent reservation", () => {
    const s = reserve(),
      type = s.values.types.boxedBoolean.object;
    if (type.kind !== "struct") throw Error("missing Boolean struct");
    type.fields[0]!.mutable = true;
    expect(() => reserveNativeBooleanResources(s.tx, "other", s.values, s.plan, s.dependencies)).toThrow("altered");
  });
  it("rejects changed emitted Boolean body on completion", () => {
    const s = fill();
    s.pack.isBoolean.object.body[0] = { op: "i32.const", value: 1 };
    expect(() => requireCompletedNativeBooleans(s.tx, s.pack, s.values, s.plan, s.dependencies)).toThrow("altered");
  });
});
