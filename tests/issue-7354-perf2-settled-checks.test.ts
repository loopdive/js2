// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 Perf2 — the currentness checks that re-derived the whole program at every string emit settle once their
// input can no longer change (`src/ir/program/settled-verdict.ts`). These tests pin the staleness half: input that
// can still change is re-checked at every use, a failed check never settles, and a shared-prototype change re-runs
// a settled check.
import { describe, expect, it } from "vitest";
import {
  checkUnlessSettled,
  PreparedIrSettledChecks,
  settledAtIssue,
  type PreparedIrSettlement,
} from "../src/ir/program/settled-verdict.js";
import {
  assertNativeValueResourcePlan,
  deriveNativeValueResourcePlan,
} from "../src/ir/program/native-value-resources.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { readFileSync } from "node:fs";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import {
  assertNativeNumberFormatRequirementsCurrent,
  deriveNativeNumberFormatRequirements,
} from "../src/ir/program/native-number-format-requirements.js";
import {
  assertNativeObjectAccessRequirementsCurrent,
  deriveNativeObjectAccessRequirements,
} from "../src/ir/program/native-object-access-requirements.js";

function counted(holder: PreparedIrSettlement, input: unknown, uses: number): number {
  let runs = 0;
  for (let use = 0; use < uses; use++) checkUnlessSettled(holder, input, () => void runs++);
  return runs;
}

describe("#7354 Perf2 — a settled verdict", () => {
  it("checks frozen input once and input that can still change at every use", () => {
    expect(counted({ settled: undefined }, Object.freeze({ a: Object.freeze([1]) }), 4)).toBe(1);
    expect(counted({ settled: undefined }, Object.freeze({ a: [1] }), 4)).toBe(4);
  });

  it("does not settle a check that failed", () => {
    const holder: PreparedIrSettlement = { settled: undefined };
    const input = Object.freeze({});
    expect(() =>
      checkUnlessSettled(holder, input, () => {
        throw new Error("stale");
      }),
    ).toThrow("stale");
    expect(counted(holder, input, 2)).toBe(1);
  });

  it("re-runs a settled check after a shared prototype changes", () => {
    const holder: PreparedIrSettlement = { settled: undefined };
    const input = Object.freeze({});
    expect(counted(holder, input, 2)).toBe(1);
    Object.defineProperty(Array.prototype, "perf2Probe", { value: 1, configurable: true });
    try {
      expect(counted(holder, input, 2)).toBe(1);
    } finally {
      Reflect.deleteProperty(Array.prototype, "perf2Probe");
    }
    expect(counted(holder, input, 2)).toBe(1);
  });

  it("settles at issue only input that can no longer change", () => {
    const frozen = Object.freeze([Object.freeze({})]),
      mutable = Object.freeze([{}]);
    expect(counted(settledAtIssue(frozen), frozen, 3)).toBe(0);
    expect(counted(settledAtIssue(mutable), mutable, 3)).toBe(3);
  });

  it("keeps one verdict per input object", () => {
    const checks = new PreparedIrSettledChecks<object>();
    const runs: string[] = [];
    const first = Object.freeze({}),
      second = Object.freeze({});
    for (const input of [first, second, first, second])
      checks.check(input, () => runs.push(input === first ? "1" : "2"));
    expect(runs).toEqual(["1", "2"]);
  });
});

describe("#7354 Perf2 — the native value plan's currentness", () => {
  const policy = { backend: "wasmgc", target: "standalone" } as const;
  function prepare() {
    const source = prepareIrProgramSources({
      ...sourceInput({ "./entry.ts": "export function main(value: number): number { return value; }" }),
      policy,
    });
    if (source.kind !== "prepared") throw Error(source.detail);
    const program = requireProgram(
      prepareTypedIrProgram(captureTypedIrProgramInput(source), { ...typedOptions, policy, runtimePolicies: [policy] }),
    );
    return { program, projection: program.runtime[0]! };
  }

  it("refuses a mutable source changed after issue, at every later use", () => {
    const { program, projection } = prepare();
    const mutable = { ...program };
    const plan = deriveNativeValueResourcePlan(mutable, projection, "primitive-only");
    assertNativeValueResourcePlan(plan);
    const entry = program.inventory.sources.find((source) => source.kind === "entry")!;
    mutable.inventory = {
      ...program.inventory,
      sources: [{ ...entry, id: `${entry.id}?` }],
    } as typeof program.inventory;
    expect(() => assertNativeValueResourcePlan(plan)).toThrow("stale selected native value requirements");
    expect(() => assertNativeValueResourcePlan(plan)).toThrow("stale selected native value requirements");
  });

  it("accepts the plan of a frozen program at every use", () => {
    const { program, projection } = prepare();
    const plan = deriveNativeValueResourcePlan(program, projection, "primitive-only");
    for (let use = 0; use < 3; use++) expect(() => assertNativeValueResourcePlan(plan)).not.toThrow();
  });
});

// A program the formatter and object-access derivations accept (the #3518 formatter fixture).
function asyncExample(): PreparedIrProgram {
  const source = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
  return requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({ "./entry.ts": source }),
      policy: {
        backend: "wasmgc",
        target: "standalone",
        stringConst: { storage: "native" },
        stringConcat: { concat: "native" },
      },
      promiseDelayProjection: "standalone-native",
      asyncFamilyProjection: "standalone-native",
    }),
  );
}
/** A shallow copy, so the derivations below read a program that can still change. */
const changeable = (program: PreparedIrProgram) =>
  ({ ...program }) as { -readonly [K in keyof PreparedIrProgram]: PreparedIrProgram[K] };

describe("#7354 Perf2 — formatter and object-access currentness over a program that can still change", () => {
  it("refuses formatter requirements after their program changed, at every later use", () => {
    const program = changeable(asyncExample());
    const input = { program, projection: program.runtime[0]!, integerBeforeScratch: false };
    const requirements = deriveNativeNumberFormatRequirements(input)!;
    assertNativeNumberFormatRequirementsCurrent(input, requirements);
    program.ir = { ...program.ir, functions: [] };
    expect(() => assertNativeNumberFormatRequirementsCurrent(input, requirements)).toThrow(
      "missing complete owner population",
    );
    expect(() => assertNativeNumberFormatRequirementsCurrent(input, requirements)).toThrow(
      "missing complete owner population",
    );
  });

  it("refuses object-access requirements after their program changed, at every later use", () => {
    const program = changeable(asyncExample());
    const requirements = deriveNativeObjectAccessRequirements(program, program.runtime[0]!);
    assertNativeObjectAccessRequirementsCurrent(requirements);
    program.ir = { ...program.ir, functions: [] };
    expect(() => assertNativeObjectAccessRequirementsCurrent(requirements)).toThrow("borrowed source changed");
    expect(() => assertNativeObjectAccessRequirementsCurrent(requirements)).toThrow("borrowed source changed");
  });
});
