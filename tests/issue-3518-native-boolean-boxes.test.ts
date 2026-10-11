// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boxBooleanBody } from "../src/codegen/interned-boolean-boxes.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
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
  reserveNativeBooleanBoxResources,
  fillNativeBooleanBoxResources,
  requireNativeBooleanBoxReservations,
  requireCompletedNativeBooleanBoxes,
} from "../src/backend/wasmgc/resources/native-booleans.js";

const donorText = readFileSync(new URL("./fixtures/issue-3518-boolean-box-donor.ts.txt", import.meta.url), "utf8");
// Complete source at signed f52f6ae020d6d5ddb07e69a3b18811a5b4f86c24.
const donorHash = "cfa0a087b17b87d162458532b80892ca684860b0e34ea9742765eceb1f96c806";
function donor(text = donorText) {
  if (createHash("sha256").update(text).digest("hex") !== donorHash) throw Error("Boolean boxing donor mismatch");
  const js = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(
    "process",
    js.replace("export function boxBooleanBody", "function boxBooleanBody") + "\nreturn boxBooleanBody;",
  )(process) as typeof boxBooleanBody;
}
afterEach(() => vi.unstubAllEnvs());
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
function reserve(mode: "interned" | "allocating" = "interned") {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const plan = requirements(),
    dependencies = { strings: { kind: "absent" } } as const;
  const values = reserveNativeValueResources(tx, plan, dependencies);
  const readers = reserveNativeBooleanResources(tx, "read", values, plan, dependencies);
  const pack = reserveNativeBooleanBoxResources(tx, "box", values, plan, dependencies, mode);
  return { module, tx, plan, dependencies, values, readers, pack };
}
function fill(s = reserve()) {
  s.tx.freezeReservations();
  fillNativeValueResources(s.tx, s.values, s.dependencies);
  fillNativeBooleanResources(s.tx, s.readers);
  fillNativeBooleanBoxResources(s.tx, s.pack);
  return s;
}
function complete(s: ReturnType<typeof reserve>) {
  return requireCompletedNativeBooleanBoxes(s.tx, s.pack, s.values, s.plan, s.dependencies);
}
function execute(mode: "interned" | "allocating") {
  const s = fill(reserve(mode));
  for (const [name, token] of Object.entries({
    box: s.pack.boxBoolean,
    read: s.readers.unboxBoolean,
    isBoolean: s.readers.isBoolean,
  }))
    s.tx.defineExport("export:" + name, name, token);
  expect(complete(s)).toBe(s.pack);
  expect(s.tx.seal().completedFunctions).toBe(6);
  const wasm = new WebAssembly.Module(emitBinary(s.module) as BufferSource);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  const exports = new WebAssembly.Instance(wasm).exports as unknown as {
    box(value: number): unknown;
    read(value: unknown): number;
    isBoolean(value: unknown): number;
  };
  return { s, exports };
}

describe("native Boolean BOX preserves the signed legacy recipe", () => {
  for (const mode of ["interned", "allocating"] as const)
    for (const imported of [0, 7])
      for (const defined of [0, 3])
        it(`${mode}: complete donor body/globals with ${imported} imports and ${defined} preceding globals`, () => {
          vi.stubEnv("JS2WASM_INTERNED_BOOL_BOXES", mode === "allocating" ? "0" : "1");
          const context = () =>
            ({
              numImportGlobals: imported,
              mod: {
                globals: Array.from({ length: defined }, (_, index) => ({
                  name: "prior" + index,
                  type: { kind: "i32" },
                  mutable: false,
                  init: [{ op: "i32.const", value: index }],
                })),
              },
            }) as unknown as CodegenContext;
          const before = context(),
            after = context();
          expect(boxBooleanBody(after, 17)).toEqual(donor()(before, 17));
          expect(after.mod.globals).toEqual(before.mod.globals);
          expect(after.mod.globals.slice(defined).map((x) => x.name)).toEqual(
            mode === "interned" ? ["__box_boolean_true", "__box_boolean_false"] : [],
          );
        });
  it("rejects a changed signed donor", () => {
    expect(donor()).toBeTypeOf("function");
    expect(() => donor(donorText.replace("carrier(1)", "carrier(0)"))).toThrow("donor mismatch");
  });
  for (const mode of ["interned", "allocating"] as const) {
    it(`${mode}: actual owner emits exactly the donor globals and function body`, () => {
      vi.stubEnv("JS2WASM_INTERNED_BOOL_BOXES", mode === "allocating" ? "0" : "1");
      const s = fill(reserve(mode));
      const priorCount = s.module.globals.length - s.pack.globals.length;
      const ctx = {
        numImportGlobals: 0,
        mod: { globals: s.module.globals.slice(0, priorCount) },
      } as unknown as CodegenContext;
      expect(s.pack.boxBoolean.object.body).toEqual(donor()(ctx, s.values.types.boxedBoolean.typeIndex));
      expect(s.module.globals).toEqual(ctx.mod.globals);
    });
    it(`${mode}: executes canonical values, carrier identity and noncanonical i32 behavior`, () => {
      const { s, exports: x } = execute(mode);
      expect(s.pack.globals).toHaveLength(mode === "interned" ? 2 : 0);
      for (const value of [0, 1, 2, -1]) {
        const boxed = x.box(value);
        expect(x.isBoolean(boxed)).toBe(1);
        expect(x.read(boxed)).toBe(mode === "interned" ? Number(value !== 0) : value);
      }
      const firstTrue = x.box(1),
        secondTrue = x.box(1);
      const firstFalse = x.box(0),
        secondFalse = x.box(0);
      expect(firstTrue === secondTrue).toBe(mode === "interned");
      expect(firstFalse === secondFalse).toBe(mode === "interned");
      expect(firstFalse === firstTrue).toBe(false);
    });
  }
  it("native explicit mode ignores the legacy ambient switch", () => {
    vi.stubEnv("JS2WASM_INTERNED_BOOL_BOXES", "0");
    expect(execute("interned").s.pack.globals).toHaveLength(2);
  });
  it("freezes the public reservation pack and global list", () => {
    const s = reserve();
    expect(Object.isFrozen(s.pack)).toBe(true);
    expect(Object.isFrozen(s.pack.globals)).toBe(true);
  });
  it("rejects a cloned pack", () => {
    const s = reserve();
    expect(() => requireNativeBooleanBoxReservations(s.tx, { ...s.pack }, s.values, s.plan, s.dependencies)).toThrow(
      "foreign",
    );
  });
  it("rejects a foreign ledger", () => {
    const s = reserve(),
      other = reserve();
    expect(() => fillNativeBooleanBoxResources(other.tx, s.pack)).toThrow("foreign");
  });
  it("rejects substituted dependencies", () => {
    const s = reserve();
    expect(() =>
      requireNativeBooleanBoxReservations(s.tx, s.pack, s.values, s.plan, { strings: { kind: "absent" } }),
    ).toThrow("substituted");
  });
  it("rejects a borrowed primitive owner", () => {
    const s = reserve(),
      other = reserve();
    expect(() => requireNativeBooleanBoxReservations(s.tx, s.pack, other.values, s.plan, s.dependencies)).toThrow(
      "substituted",
    );
  });
  it("rejects a cloned issued plan", () => {
    const s = reserve();
    expect(() => requireNativeBooleanBoxReservations(s.tx, s.pack, s.values, { ...s.plan }, s.dependencies)).toThrow(
      "substituted",
    );
  });
  it("rejects an invalid explicit mode before mutation", () => {
    const s = reserve();
    const before = [s.module.functions.length, s.module.globals.length, s.module.types.length];
    expect(() =>
      reserveNativeBooleanBoxResources(s.tx, "other", s.values, s.plan, s.dependencies, "ambient" as "interned"),
    ).toThrow("mode");
    expect([s.module.functions.length, s.module.globals.length, s.module.types.length]).toEqual(before);
  });
  it("rejects a non-string key before resource acquisition", () => {
    const s = reserve();
    const before = [s.module.functions.length, s.module.globals.length, s.module.types.length];
    expect(() =>
      reserveNativeBooleanBoxResources(s.tx, 42 as unknown as string, s.values, s.plan, s.dependencies, "interned"),
    ).toThrow("key");
    expect([s.module.functions.length, s.module.globals.length, s.module.types.length]).toEqual(before);
  });
  it("requires completion of the primitive dependency", () => {
    const s = reserve();
    s.tx.freezeReservations();
    expect(() => fillNativeBooleanBoxResources(s.tx, s.pack)).toThrow("incomplete");
    expect(s.pack.boxBoolean.object.body).toEqual([]);
  });
  it("requires producer completion rather than a filled body", () => {
    const s = reserve();
    s.tx.freezeReservations();
    fillNativeValueResources(s.tx, s.values, s.dependencies);
    s.tx.fillFunction(s.pack.boxBoolean, { locals: [], body: [{ op: "ref.null.extern" }] });
    expect(() => complete(s)).toThrow("incomplete");
  });
  it("refuses a second fill", () => {
    const s = fill();
    expect(() => fillNativeBooleanBoxResources(s.tx, s.pack)).toThrow("duplicate");
  });
  it("rejects altered completed body", () => {
    const s = fill();
    complete(s);
    s.pack.boxBoolean.object.body[0] = { op: "i32.const", value: 0 };
    expect(() => complete(s)).toThrow("altered");
  });
  for (const part of ["init", "mutable", "type"] as const)
    it(`rejects altered completed ${part} of Boolean singleton`, () => {
      const s = fill();
      complete(s);
      const g = s.pack.globals[0]!.object;
      if (part === "init") g.init[0] = { op: "i32.const", value: 0 };
      if (part === "mutable") g.mutable = true;
      if (part === "type") g.type = { kind: "externref" };
      expect(() => complete(s)).toThrow("altered");
    });
  it("rejects a changed primitive layout before reservation", () => {
    const s = reserve();
    const t = s.values.types.boxedBoolean.object;
    if (t.kind !== "struct") throw Error("missing Boolean type");
    t.fields[0]!.mutable = true;
    expect(() => reserveNativeBooleanBoxResources(s.tx, "other", s.values, s.plan, s.dependencies, "interned")).toThrow(
      "altered",
    );
  });
  it("preflights all resource keys before adding any resource", () => {
    const s = reserve();
    s.tx.reserveGlobal("other:false", "conflict", { kind: "i32" }, false);
    const before = [s.module.functions.length, s.module.globals.length, s.module.types.length];
    expect(() =>
      reserveNativeBooleanBoxResources(s.tx, "other", s.values, s.plan, s.dependencies, "interned"),
    ).toThrow();
    expect([s.module.functions.length, s.module.globals.length, s.module.types.length]).toEqual(before);
  });
});
