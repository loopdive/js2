// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7415 — the Prepared path validated the same prepared program in full 8 times per compile. Through
// `assertSettledPreparedIrProgram`, a program that can no longer change is now validated once (#7354 Perf settled
// verdict); a program that can still change is validated in full at every use, and `assertPreparedIrProgram` itself
// is unchanged.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { assertPreparedIrProgram } from "../src/ir/program/validation.js";
import { assertSettledPreparedIrProgram } from "../src/ir/program/settled-validation.js";
import { isImmutablePreparedIrValue } from "../src/ir/program/settled-verdict.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";

const population = vi.hoisted(() => ({ checks: 0 }));
vi.mock("../src/ir/program/population.js", async (original) => {
  const actual = await original<typeof import("../src/ir/program/population.js")>();
  return {
    ...actual,
    assertPreparedIrProgramPopulation: (...args: Parameters<typeof actual.assertPreparedIrProgramPopulation>) => {
      population.checks++;
      return actual.assertPreparedIrProgramPopulation(...args);
    },
  };
});

function populationChecks(program: PreparedIrProgram, uses: number, assert = assertSettledPreparedIrProgram) {
  const before = population.checks;
  for (let use = 0; use < uses; use++) assert(program);
  return population.checks - before;
}

/** Full validations of `program` over `uses` calls, counted in population checks per full validation. */
function fullChecks(program: PreparedIrProgram, uses: number, assert = assertSettledPreparedIrProgram) {
  return populationChecks(program, uses, assert) / populationChecks(program, 1, assertPreparedIrProgram);
}

let program: PreparedIrProgram;
beforeAll(() => {
  program = requireProgram(prepareTypedIrProgram(sourcePacket().packet, typedOptions));
});

describe("#7415 one full validation per unchangeable prepared program", () => {
  it("validates a genuine prepared program, which can no longer change, once", () => {
    expect(isImmutablePreparedIrValue(program)).toBe(true);
    const fresh = requireProgram(prepareTypedIrProgram(sourcePacket().packet, typedOptions));
    expect(fullChecks(fresh, 5)).toBe(1);
  });

  it("validates a program that can still change at every use, and refuses a later mutation", () => {
    const open = { ...program } as { -readonly [K in keyof PreparedIrProgram]: PreparedIrProgram[K] };
    expect(fullChecks(open, 3)).toBe(3);
    open.sealed = false as never;
    expect(() => assertSettledPreparedIrProgram(open)).toThrow(/not a complete prepared program/);
  });

  it("leaves assertPreparedIrProgram itself validating in full at every call", () => {
    assertSettledPreparedIrProgram(program);
    expect(fullChecks(program, 3, assertPreparedIrProgram)).toBe(3);
  });

  it("re-validates a settled program after a shared prototype gains a field", () => {
    assertSettledPreparedIrProgram(program);
    const prototype = Object.prototype as { programProbe7415?: unknown };
    prototype.programProbe7415 = 1;
    try {
      expect(fullChecks(program, 1)).toBe(1);
    } finally {
      Reflect.deleteProperty(prototype, "programProbe7415");
    }
  });
});
