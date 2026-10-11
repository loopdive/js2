// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import {
  acceptPreparedIrProgram,
  acceptedPhysicalSetupPlan,
  emitAcceptedIrProgram,
} from "../src/ir/program-consumer.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { emitBinary } from "../src/emit/binary.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";
import type { RuntimeManifestPolicy } from "../src/ir/runtime-manifest.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { createEmptyModule } from "../src/ir/types.js";
import { nativeBooleanAbiBindings } from "../src/backend/wasmgc/program/native-primitive-boundary-abi.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { deriveNativeValueResourcePlan } from "../src/ir/program/native-value-resources.js";
import { reserveNativeStringLiteralTypes } from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  planNativeStringValuePhysical,
  reserveNativeStringValueResources,
  fillNativeStringValueResources,
} from "../src/backend/wasmgc/program/native-string-values.js";
import {
  reserveNativeBooleanResources,
  fillNativeBooleanResources,
} from "../src/backend/wasmgc/resources/native-booleans.js";

// Exact first-run fixture retained: arbitrary-any ToNumber remains a full-goal gap.
const ORIGINAL_NUMBER_READ_SOURCE = `export function box(value: boolean): any { return value; }
export function read(value: any): number { return +value; }`;
const SOURCE = "export function box(value: boolean): any { return value; }";
const policy: RuntimeManifestPolicy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  numberBoundary: { box: "unsupported", unbox: "native" },
  booleanBoundary: { box: "native", unbox: "native" },
};
function prepare(text = SOURCE, box: "native" | "host" | "unsupported" = "native") {
  const selected = { ...policy, booleanBoundary: { ...policy.booleanBoundary!, box } };
  return prepareWholeIrProgram({
    ...sourceInput({ "./entry.ts": text }),
    policy: selected,
    runtimePolicies: [selected],
    nativeStringValueProjection: "standalone-native",
  });
}
function oracle(source = SOURCE) {
  const exports: { box?: (value: boolean) => unknown; read?: (value: unknown) => number } = {};
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
      .outputText,
    { exports },
    { timeout: 1000 },
  );
  return exports as Required<typeof exports>;
}
/** Observation only: actual native classifier owners, separate from public source execution. */
function carrierObserver(program: PreparedIrProgram) {
  const projection = program.runtime[0]!,
    demands = collectNativeStringValueDemands(program, projection);
  const selected = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage: false });
  if (selected.kind !== "planned") throw new Error("observer has no actual value recipe");
  const valueRequirements = deriveNativeValueResourcePlan(program, projection, "native-string");
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const types = reserveNativeStringLiteralTypes(tx, selected.plan.key, false);
  const pack = reserveNativeStringValueResources(tx, { demands, plan: selected.plan, valueRequirements }, types);
  const number = pack.number!;
  const boolean = reserveNativeBooleanResources(
    tx,
    "observer:boolean",
    number.values,
    valueRequirements,
    number.dependencies,
  );
  tx.freezeReservations();
  fillNativeStringValueResources(tx, pack);
  fillNativeBooleanResources(tx, boolean);
  for (const [name, token] of Object.entries({
    isBoolean: boolean.isBoolean,
    booleanValue: boolean.unboxBoolean,
    number: number.values.functions.boxNumber,
  }))
    tx.defineExport("observer:" + name, name, token);
  tx.seal();
  return new WebAssembly.Instance(new WebAssembly.Module(emitBinary(module) as BufferSource)).exports as unknown as {
    isBoolean(value: unknown): number;
    booleanValue(value: unknown): number;
    number(value: number): unknown;
  };
}
beforeAll(() => vi.stubEnv("JS2WASM_IR_GVN", "0"));
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
afterAll(() => vi.unstubAllEnvs());

describe("actual native Boolean boundary through the public consumer", () => {
  for (const decoded of [false, true])
    for (const utf8Storage of [false, true])
      it(`executes the source Boolean box with a branded carrier observer, decoded=${decoded}, utf8=${utf8Storage}`, () => {
        const original = requireProgram(prepare());
        const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
        const accepted = acceptPreparedIrProgram(program, { ...replayOptions("wasmgc", "standalone"), utf8Storage });
        if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
        const demands = collectNativeStringValueDemands(program, accepted.runtime);
        const box = demands.intrinsics.filter(
          (row) =>
            row.instruction.id === "js.boolean.box" &&
            demands.buffers[demands.occurrences[row.occurrence]!.bufferIndex]!.view === "projection",
        );
        expect(box).toHaveLength(1);
        expect(box[0]!.instruction.provider).toMatchObject({
          kind: "callable",
          target: { binding: { kind: "runtime", symbol: "__box_boolean" } },
        });
        const plan = acceptedPhysicalSetupPlan(accepted);
        expect(plan.nativeInvocation).toBeUndefined();
        expect(plan.nativeStrings?.resources).toMatchObject({
          mode: "number-boundary",
          booleans: { boxMode: "interned", unbox: false },
        });
        const emitted = emitAcceptedIrProgram(accepted);
        expect(emitted.module.imports).toEqual([]);
        const module = new WebAssembly.Module(emitBinary(emitted.module) as BufferSource);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const native = oracle();
        const observer = carrierObserver(program);
        expect(observer.isBoolean(observer.number(1))).toBe(0);
        expect(observer.isBoolean(observer.number(0))).toBe(0);
        for (let instance = 0; instance < 2; instance++) {
          const exports = new WebAssembly.Instance(module).exports as unknown as ReturnType<typeof oracle>;
          for (const value of [true, false, false, true]) {
            expect(typeof native.box(value)).toBe("boolean");
            expect(observer.isBoolean(exports.box(value))).toBe(1);
            expect(observer.booleanValue(exports.box(value)) === 1).toBe(native.box(value));
          }
          const trueBox = exports.box(true),
            falseBox = exports.box(false);
          expect(trueBox === exports.box(true)).toBe(true);
          expect(falseBox === exports.box(false)).toBe(true);
          expect(trueBox === falseBox).toBe(false);
        }
      });
  it.each([false, true])("selects values for boxing without a numeric source demand, decoded=%s", (decoded) => {
    const original = requireProgram(prepare("export function box(value: boolean): any { return value; }"));
    const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
    const accepted = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
    if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
    const demands = collectNativeStringValueDemands(program, accepted.runtime);
    expect(demands.intrinsics.filter((row) => row.instruction.id.startsWith("js.number."))).toEqual([]);
    expect(acceptedPhysicalSetupPlan(accepted).nativeStrings?.resources.mode).toBe("number-boundary");
    const emitted = emitAcceptedIrProgram(accepted);
    const compiled = new WebAssembly.Module(emitBinary(emitted.module) as BufferSource);
    expect(WebAssembly.Module.imports(compiled)).toEqual([]);
    const box = new WebAssembly.Instance(compiled).exports.box as (value: boolean) => unknown;
    expect(box(true) === box(false)).toBe(false);
  });
  it("preserves disabled boxing as a preparation refusal", () => {
    const result = prepare(SOURCE, "unsupported");
    expect(result.kind).toBe("unsupported");
    if (result.kind === "prepared") throw new Error("disabled boxing unexpectedly prepared");
    expect(result.detail).toMatch(/boolean.*box|box.*unsupported/i);
  });
  it("does not materialize the host provider as a native box", () => {
    const program = requireProgram(prepare(SOURCE, "host"));
    const result = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "accepted") expect(result.detail).toMatch(/boolean|provider|host/i);
  });
  it("retains the original dynamic unary-plus fixture as an unresolved source contract", () => {
    const native = oracle(ORIGINAL_NUMBER_READ_SOURCE);
    expect(native.read(native.box(true))).toBe(1);
    expect(native.read(native.box(false))).toBe(0);
    const result = prepare(ORIGINAL_NUMBER_READ_SOURCE);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "prepared") throw new Error("review actual dynamic ToNumber support before closing this gap");
    expect(result.detail).toMatch(/unsupported type.*read/);
    expect(result.sourceFile).toBe("entry.ts");
  });

  it("binds the canonical plain-i32 BOX ABI without erasing the source Boolean brand", () => {
    const program = requireProgram(prepare());
    expect(program.ir.functions.find((fn) => fn.name === "box")!.params[0]!.type).toEqual({
      kind: "val",
      val: { kind: "i32", boolean: true },
    });
    const provider = program.runtime[0]!.prepared.providers.get("js.boolean.box")!;
    expect(provider.signature!.params).toEqual([{ kind: "val", val: { kind: "i32" } }]);
    const accepted = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
    if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
    const plan = acceptedPhysicalSetupPlan(accepted).nativeStrings!;
    const declarations = plan.resources.declarations.filter(
      (row) => JSON.stringify(row.role) === '["values","box-boolean"]',
    );
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toMatchObject({
      space: "function",
      signature: { params: [{ kind: "i32" }], results: [{ kind: "externref" }] },
    });
    expect(plan.bindings.filter((row) => row.resourceKey === declarations[0]!.key)).toHaveLength(1);
  });

  it.each(["branded-i32", "f64"] as const)(
    "refuses a forged %s canonical BOX parameter before reservation",
    (carrier) => {
      const original = requireProgram(prepare());
      const old = original.runtime[0]!,
        runtime = old.prepared;
      const canonical = runtime.providers.get("js.boolean.box")!;
      const forged = {
        ...canonical,
        signature: {
          ...canonical.signature!,
          params: [
            carrier === "f64"
              ? { kind: "val" as const, val: { kind: "f64" as const } }
              : { kind: "val" as const, val: { kind: "i32" as const, boolean: true as const } },
          ],
        },
      };
      const providers = new Map(runtime.providers);
      providers.set("js.boolean.box", forged);
      const projection = {
        ...old,
        prepared: {
          ...runtime,
          providers,
          manifest: {
            ...runtime.manifest,
            providers: runtime.manifest.providers.map((row) => (row.id === canonical.id ? forged : row)),
          },
        },
      };
      const program = { ...original, runtime: [projection] };
      const demands = collectNativeStringValueDemands(program, projection);
      const selected = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage: false });
      if (selected.kind !== "planned") throw new Error("actual source BOX demand did not select a plan");
      const input = {
        demands,
        plan: selected.plan,
        invocationRequirements: selected.invocationRequirements,
        valueRequirements: deriveNativeValueResourcePlan(program, projection, "native-string"),
      };
      expect(() => nativeBooleanAbiBindings(input, 0)).toThrow(/native Boolean ABI: manifest provider differs/);
    },
  );
});
