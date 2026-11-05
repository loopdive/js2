// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { indexNativeValueDefinitions } from "../src/ir/program/native-value-definitions.js";
import { deriveNativeObjectAccessRequirements } from "../src/ir/program/native-object-access-requirements.js";
import { deriveNativePrototypeRequirements } from "../src/ir/program/native-prototype-requirements.js";
import { irNativeAsyncCallableDeclaration } from "../src/ir/runtime/native-async-callables.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import { forEachPreparedIrInstruction } from "../src/ir/runtime/prepared-instructions.js";
import type { IrInstr } from "../src/ir/core/nodes.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
let original: ReturnType<typeof requireProgram>;
beforeAll(() => {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  original = requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({
        "./entry.ts": readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8"),
      }),
      policy,
      nativeStringValueProjection: "standalone-native",
      promiseDelayProjection: "standalone-native",
      asyncFamilyProjection: "standalone-native",
    }),
  );
});
afterAll(() => vi.unstubAllEnvs());
const ambiguous = (): never => {
  throw Error("duplicate in one representation");
};
function copied() {
  return structuredClone(original);
}
function stateCopy(program: typeof original, field: "asyncPlan" | "asyncRuntime") {
  const fn = program.runtime[0]!.prepared.functions.find((fn) => fn.name === "main")!;
  const representation = structuredClone(fn[field]!);
  Object.defineProperty(fn, field, { value: representation });
  const state = representation.states.find((state) => state.body.some((i) => i.kind === "call" && i.result !== null))!;
  return { fn, state, body: state.body as IrInstr[] };
}

describe("native SSA definitions retain async representation boundaries", () => {
  it.each(["missing-plan", "missing-runtime", "foreign-plan"] as const)(
    "does not traverse an unauthenticated executable attachment: %s",
    (mutation) => {
      const selected = original.runtime[0]!.prepared.functions.find((fn) => fn.name === "main")!;
      const fn = {
        ...selected,
        ...(mutation === "missing-runtime" ? { asyncRuntime: undefined } : {}),
        ...(mutation === "missing-plan" ? { asyncPlan: undefined } : {}),
        ...(mutation === "foreign-plan" ? { asyncPlan: structuredClone(selected.asyncPlan) } : {}),
      };
      const visit = vi.fn();
      expect(() => forEachPreparedIrInstruction(fn, visit)).toThrow("IR async runtime attachment");
      expect(visit).not.toHaveBeenCalled();
    },
  );

  it("visits both ordinary branches with their containing block", () => {
    const program = requireProgram(
      prepareWholeIrProgram({
        ...sourceInput({
          "./entry.ts":
            "function leaf(n:number):number{if(n<=1)return 1;return n*leaf(n-1);} export function run(n:number):number{if(n>0){return leaf(n);}else{return leaf(-n);}}",
        }),
        policy,
      }),
    );
    const fn = program.runtime[0]!.prepared.functions.find((fn) => fn.name === "run")!;
    const calls: IrInstr[] = [];
    forEachPreparedIrInstruction(fn, (instruction, block) => {
      expect(fn.blocks).toContain(block);
      if (instruction.kind === "call" && instruction.target.name === "leaf") calls.push(instruction);
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toBe(calls[1]);
  });

  it.each([false, true])(
    "selects the real clock projection independently of its retained plan, decoded=%s",
    (decoded) => {
      const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
      const demands = collectNativeStringValueDemands(program, program.runtime[0]!);
      const owner = demands.owners.find((owner) => owner.programFunction.name === "main")!;
      const semantic = indexNativeValueDefinitions(demands, owner.unitId, "projection", ambiguous, "semantic");
      const execution = indexNativeValueDefinitions(demands, owner.unitId, "projection", ambiguous, "execution");
      const clocks = [...semantic.definitions.values()].filter(
        (row) =>
          row.instruction.kind === "call" &&
          irNativeAsyncCallableDeclaration(row.instruction.target)?.feature === "async.native.clock-zero",
      );
      expect(clocks).toHaveLength(4);
      for (const row of clocks) {
        const current = execution.definitions.get(row.instruction.result!)!;
        expect(current.instruction.kind).toBe("const");
        expect(current.instruction).toMatchObject({ value: { kind: "f64", value: 0 }, result: row.instruction.result });
        expect(demands.buffers[demands.occurrences[row.occurrence]!.bufferIndex]!.root.kind).toBe("async-plan");
        expect(demands.buffers[demands.occurrences[current.occurrence]!.bufferIndex]!.root.kind).toBe("async-runtime");
        expect(current.occurrence).not.toBe(row.occurrence);
      }
      const access = deriveNativeObjectAccessRequirements(program, program.runtime[0]!);
      expect(access.uses).toEqual([]);
      expect(access.demands.occurrences.length).toBeGreaterThan(200);
      const prototypes = deriveNativePrototypeRequirements(access);
      expect(prototypes.uses).toEqual([]);
      expect(prototypes.access).toBe(access);
      const acceptance = acceptPreparedIrProgram(program, {
        ...replayOptions("wasmgc", "standalone"),
        numberFormat: { integerBeforeScratch: true },
      });
      expect(acceptance.kind).toBe("unsupported");
      if (acceptance.kind !== "unsupported") throw Error("native async composition remains incomplete");
      expect(acceptance.detail).toContain("native Promise inventory");
      expect(acceptance.detail).toContain("references runtime callable __ir_promise_delay_native");
      expect(acceptance.detail).toContain("references runtime callable __ir_async_promise_all_native");
      expect(acceptance.detail).not.toContain("references intrinsic callable async.clock.snapshot");
    },
  );

  it.each(["asyncPlan", "asyncRuntime"] as const)(
    "rejects duplicate definitions inside %s without conflating its peer",
    (field) => {
      const program = copied(),
        { fn, body } = stateCopy(program, field);
      const instruction = body.find((i) => i.result !== null)!;
      body.push({ ...instruction });
      const demands = collectNativeStringValueDemands(program, program.runtime[0]!);
      const representation = field === "asyncPlan" ? "semantic" : "execution";
      expect(() => indexNativeValueDefinitions(demands, fn.unitId, "projection", ambiguous, representation)).toThrow(
        "duplicate in one representation",
      );
      expect(() =>
        indexNativeValueDefinitions(
          demands,
          fn.unitId,
          "projection",
          ambiguous,
          representation === "semantic" ? "execution" : "semantic",
        ),
      ).not.toThrow();
      expect(() => deriveNativeObjectAccessRequirements(program, program.runtime[0]!)).toThrow(
        "ambiguous prepared SSA definition",
      );
    },
  );

  it.each([false, true])("retains real property operations after await, decoded=%s", (decoded) => {
    const prepared = requireProgram(
      prepareWholeIrProgram({
        ...sourceInput({
          "./entry.ts":
            "export async function run(n:number):Promise<number>{await n;const o={get x(){return n;}};return o.x;}",
        }),
        policy: { ...policy, numberBoundary: { box: "native", unbox: "native" } },
        nativeStringValueProjection: "standalone-native",
      }),
    );
    const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(prepared)) : prepared;
    const access = deriveNativeObjectAccessRequirements(program, program.runtime[0]!);
    const prototypes = deriveNativePrototypeRequirements(access);
    expect(access.uses.map((use) => use.feature)).toEqual([
      "js.object.create-default",
      "js.object.define-accessor",
      "js.object.get",
    ]);
    expect(prototypes.uses.map((use) => use.feature)).toEqual(access.uses.map((use) => use.feature));
    expect(prototypes.builtins.map((builtin) => builtin.name)).toEqual(["Object"]);
    // Frame-loaded receivers still need a separate flow proof; no async execution is certified here.
    expect(prototypes.gaps.some((gap) => gap.detail.includes("provenance"))).toBe(true);
  });

  // Mutations of actual prepared state records: these do not assert frontend support or emission.
  it.each(["asyncPlan", "asyncRuntime", "both"] as const)("refuses an unpaired ordinary operation in %s", (field) => {
    const program = copied();
    for (const selected of field === "both" ? (["asyncPlan", "asyncRuntime"] as const) : [field]) {
      const { body } = stateCopy(program, selected);
      const at = body.findIndex((i) => i.kind === "call" && i.result !== null);
      const call = body[at]!;
      if (call.kind !== "call") throw Error("missing real call");
      body[at] = { ...call, target: irIntrinsicFuncRef("js.object.create-null"), args: [] };
    }
    expect(() => deriveNativeObjectAccessRequirements(program, program.runtime[0]!)).toThrow(
      "property operation population differs",
    );
  });

  it("rejects a runtime attachment detached from its semantic plan", () => {
    const program = copied(),
      { fn } = stateCopy(program, "asyncRuntime");
    Reflect.deleteProperty(fn, "asyncPlan");
    const demands = collectNativeStringValueDemands(program, program.runtime[0]!);
    expect(() => indexNativeValueDefinitions(demands, fn.unitId, "projection", ambiguous)).toThrow(
      "runtime states lack their semantic plan",
    );
  });
});
