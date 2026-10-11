// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  GETTER_SOURCE,
  prepareGetterProgram,
  freezeGetterInvocation,
  fillActualGetterUnits,
} from "./helpers/native-getter-invocation-fixture.js";
import {
  getterResourceFixture,
  reserveGetterResourceObservers,
  fillGetterResourceObservers,
  getterResourceRuntime,
} from "./helpers/native-getter-resource-fixture.js";
import {
  planNativeStringValuePhysical,
  reserveNativeStringValueResources,
  nativeStringValueReservationInventory,
  fillNativeStringValueResources,
} from "../src/backend/wasmgc/program/native-string-values.js";
import { fillNativeInvocationResources } from "../src/backend/wasmgc/resources/native-invocation.js";
import { nativeBooleanAbiBindings } from "../src/backend/wasmgc/program/native-primitive-boundary-abi.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { reserveNativeStringLiteralTypes } from "../src/backend/wasmgc/resources/native-string-literals.js";

const BOOLEAN = `export function run() { const object = { get value() { return true; } }; return object.value; }`;
const CALLABLE = `export function run() { const captured = 7; const object = { get value() { return function () { return captured; }; } }; return object.value; }`;
const cases = [
  { kind: "number", source: GETTER_SOURCE },
  { kind: "boolean", source: BOOLEAN },
  { kind: "false", source: BOOLEAN.replace("return true", "return false") },
  { kind: "callable", source: CALLABLE },
] as const;
function oracle(source: string) {
  const exports: { run?: (seed: number) => unknown } = {};
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
      .outputText,
    { exports },
    { timeout: 1000 },
  );
  if (!exports.run) throw new Error("missing source oracle");
  return exports.run(7);
}
beforeAll(() => vi.stubEnv("JS2WASM_IR_GVN", "0"));
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
afterAll(() => vi.unstubAllEnvs());

/** Each genuine lifecycle phase retains the existing 35-second bound. */
function describeSetupStages(stages: readonly { name: string; run: () => void }[], tests: () => void): void {
  const [stage, ...remaining] = stages;
  if (!stage) {
    tests();
    return;
  }
  describe(stage.name, () => {
    beforeAll(stage.run, 35_000);
    describeSetupStages(remaining, tests);
  });
}

describe("genuine getter demands join native values before reservation", () => {
  for (const decoded of [false, true])
    for (const row of cases) {
      let f: ReturnType<typeof getterResourceFixture>;
      let observers: ReturnType<typeof reserveGetterResourceObservers>;
      let callables: ReturnType<typeof freezeGetterInvocation>;
      let runtime: ReturnType<typeof getterResourceRuntime>;
      describeSetupStages(
        [
          {
            name: `prepared and reserved ${row.kind}, decoded=${decoded}`,
            run: () => {
              f = getterResourceFixture(prepareGetterProgram(row.source, decoded, "./entry.ts", true));
            },
          },
          {
            name: "authenticated reservation inventory and retained public refusal",
            run: () => {
              expect(f.invocation.uses).toEqual([]);
              expect(f.invocation.getterUses).toHaveLength(1);
              expect(f.resourceInput.invocationRequirements).toBe(f.invocation);
              expect(f.invocation.objectAccess).toBe(f.access);
              expect(f.resources.number!.values).toBe(f.dependencies.values);
              expect(f.resources.number!.dependencies).toBe(f.dependencies.valueDependencies);
              expect(f.resourceInput.plan.mode).toBe("number-boundary");
              expect(f.resourceInput.plan.literalRequirements.literals.map((item) => item.value)).toEqual(
                expect.arrayContaining(["", "TypeError", "Value is not callable"]),
              );
              const inventory = nativeStringValueReservationInventory(f.tx, f.resources);
              expect(inventory.map(({ key, space }) => ({ key, space }))).toEqual(
                f.resourceInput.plan.declarations.map(({ key, space }) => ({ key, space })),
              );
              expect(new Set(inventory.map((item) => item.reservation)).size).toBe(inventory.length);
              if (row.kind === "boolean" || row.kind === "false") {
                expect(f.resources.number!.booleanBoxes).toBe(f.dependencies.booleanBoxes);
                expect(f.resourceInput.plan.booleans).toEqual({ boxMode: "interned", unbox: true });
                const binding = nativeBooleanAbiBindings(f.resourceInput, 0);
                expect(binding).toHaveLength(1);
                expect(binding[0]!.reference.binding).toEqual({ kind: "runtime", symbol: "__unbox_boolean" });
              } else expect(f.resourceInput.plan.booleans).toBeUndefined();
              const publicAcceptance = acceptPreparedIrProgram(f.program, replayOptions("wasmgc", "standalone"));
              expect(publicAcceptance.kind).toBe("unsupported");
              if (publicAcceptance.kind !== "accepted")
                expect(publicAcceptance.detail).toMatch(/js\.object\.|object|prototype/);
              expect(f.access.gaps.some((gap) => gap.detail.includes("implicit-prototype companion"))).toBe(true);
            },
          },
          {
            name: "frozen real invocation and observer reservations",
            run: () => {
              observers = reserveGetterResourceObservers(f);
              callables = freezeGetterInvocation(f);
            },
          },
          {
            name: "filled native value bodies",
            run: () => fillNativeStringValueResources(f.tx, f.resources),
          },
          {
            name: "filled native invocation bodies",
            run: () => fillNativeInvocationResources(f.tx, f.pack, callables, f.exception),
          },
          {
            name: "lowered and filled actual source getter bodies",
            run: () => fillActualGetterUnits(f),
          },
          {
            name: "filled observer bodies",
            run: () => fillGetterResourceObservers(f, observers),
          },
          {
            name: "authenticated completion and emitted module",
            run: () => {
              runtime = getterResourceRuntime(f, observers);
            },
          },
        ],
        () => {
          it(`selects and executes actual ${row.kind} getter dependencies without source calls, decoded=${decoded}`, () => {
            const expected = oracle(row.source);
            const closure = runtime.make(...(row.kind === "number" || row.kind === "callable" ? [7] : []));
            for (let repeat = 0; repeat < 2; repeat++) {
              const value = runtime.get(closure);
              if (row.kind === "number") expect(runtime.number(value)).toBe(expected);
              else if (row.kind === "callable") expect(runtime.invoke(value)).toBe((expected as () => number)());
              else {
                expect(runtime.isBoolean(value)).toBe(1);
                expect(runtime.booleanValue(value)).toBe(expected ? 1 : 0);
              }
            }
          });
        },
      );
    }
  it.each([false, true])("refuses implicit getter boxing when native policy is disabled, decoded=%s", (decoded) => {
    const program = prepareGetterProgram(BOOLEAN, decoded);
    const demands = collectNativeStringValueDemands(program, program.runtime[0]!);
    const result = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage: false });
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "planned" && result.kind !== "none") {
      expect(result.detail).toMatch(/explicit native Boolean boxing policy/);
      expect(result.unitId).toBeDefined();
      expect(result.location).toBeDefined();
    }
  });
  it.each(["absent", "copied", "foreign", "recipe"] as const)(
    "rejects %s authority before adding reservations",
    (mutation) => {
      const f = getterResourceFixture(prepareGetterProgram(BOOLEAN, false, "./entry.ts", true));
      const module = createEmptyModule(),
        tx = new PhysicalModuleReservations(module);
      const types = reserveNativeStringLiteralTypes(tx, f.resourceInput.plan.key, false);
      const input = { ...f.resourceInput };
      if (mutation === "absent") Object.assign(input, { invocationRequirements: undefined });
      else if (mutation === "copied") input.invocationRequirements = { ...f.invocation };
      else if (mutation === "foreign")
        input.invocationRequirements = getterResourceFixture(
          prepareGetterProgram(BOOLEAN, true, "./entry.ts", true),
        ).invocation;
      else input.plan = { ...input.plan, booleans: { unbox: true } };
      const before = structuredClone(module);
      expect(() => reserveNativeStringValueResources(tx, input, types)).toThrow(
        /invocation|demand|owner|plan|unissued|copied/,
      );
      expect(module).toEqual(before);
    },
  );
  it("refuses a raw Boolean projection even with a real unrelated getter", () => {
    const original = prepareGetterProgram(BOOLEAN, false, "./entry.ts", true);
    const program = {
      ...original,
      ir: { ...original.ir, functions: structuredClone(original.ir.functions) },
      runtime: original.runtime.map((projection) => ({
        ...projection,
        prepared: { ...projection.prepared, functions: structuredClone(projection.prepared.functions) },
      })),
    };
    let changed = 0;
    for (const functions of [program.ir.functions, program.runtime[0]!.prepared.functions])
      for (const fn of functions)
        for (const block of fn.blocks) {
          const create = block.instrs.find(
            (instruction) =>
              instruction.kind === "call" &&
              instruction.target.binding.kind === "intrinsic" &&
              instruction.target.binding.symbol === "js.object.create-default",
          );
          for (const instruction of block.instrs)
            if (
              instruction.kind === "intrinsic" &&
              instruction.id === "js.boolean.unbox" &&
              create?.result !== null &&
              create?.result !== undefined
            ) {
              instruction.args = [create.result];
              changed++;
            }
        }
    expect(changed).toBe(2);
    const result = planNativeStringValuePhysical(collectNativeStringValueDemands(program, program.runtime[0]!), {
      representation: "native-string",
      utf8Storage: false,
    });
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "planned" && result.kind !== "none")
      expect(result.detail).toMatch(/exact keyed Get result proof/);
  });
});
