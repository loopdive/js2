// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

const SOURCE = `
export function run(input: number): number {
  const add = (value: number = 2, bonus: number = 3): number => input + value + bonus;
  return add() + add(undefined, 4) + add(5);
}
`;

function outcome(result: CompileResult): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter((candidate) => candidate.displayName === "run");
  expect(observed).toHaveLength(1);
  return observed[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

describe("#3522 closure default-parameter ownership", () => {
  it.each(TARGETS)("prepares a numeric constant-default suffix in the %s lane", async (target) => {
    const direct = await compile(SOURCE, {
      fileName: `closure-default-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
      prepared = await compile(SOURCE, {
        fileName: `closure-default-prepared-${target}.ts`,
        emitWat: true,
        experimentalIR: true,
        optimize: true,
        target,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(10)).toBe(49);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0"]));
    expect(prepared.wat).toContain("i64.reinterpret_f64");
    expect(prepared.wat).toContain("i64.eq");
    expect(prepared.wat).toContain("call_ref");
    expect(prepared.wat).toMatch(/ref\.func \d+\s+i32\.const 0\s+ref\.null extern\s+local\.get \d+\s+struct\.new \d+/);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it("keeps effectful defaults direct until their evaluation order is represented", async () => {
    const source = `
      export function run(input: number): number {
        const add = (value: number = input): number => value + 2;
        return add();
      }
    `;
    const result = await compile(source, {
      fileName: "closure-effectful-default-direct.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({ legacyBodyEmitted: true, irBodyEmitted: false });
  });
});
