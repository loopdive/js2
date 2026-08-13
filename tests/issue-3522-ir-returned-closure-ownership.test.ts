// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

const SOURCE = `
function make(offset: number): (value: number) => number {
  return (value: number): number => value + offset;
}
export function run(input: number): number {
  const add = make(2);
  return add(input);
}
`;

const VAR_BOUND_SOURCE = `
function makeAdder(offset: number): (value: number) => number {
  return (value: number): number => value + offset;
}
export function run(input: number): number {
  var add = makeAdder(2);
  return add(input);
}
`;

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  expect(observed, `terminal outcome count for ${name}`).toHaveLength(1);
  return observed[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

function importLabels(result: CompileResult): string[] {
  return result.imports.map((entry) => `${entry.module}::${entry.name}`).sort();
}

function expectNoNewImports(prepared: CompileResult, direct: CompileResult, target: (typeof TARGETS)[number]): void {
  const preparedImports = importLabels(prepared);
  const directImports = importLabels(direct);
  expect(preparedImports.filter((label) => !directImports.includes(label))).toEqual([]);
  expect(preparedImports.length).toBeLessThanOrEqual(directImports.length);
  if (target === "standalone") {
    expect(preparedImports).toEqual(directImports);
    expect(preparedImports).toEqual([]);
  }
}

describe("#3522 returned closure ownership", () => {
  it.each(TARGETS)("prepares a returned captured closure and its caller in the %s lane", async (target) => {
    const direct = await compile(SOURCE, {
      fileName: `returned-closure-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      emitWat: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "make,make__closure_0,run";
      prepared = await compile(SOURCE, {
        fileName: `returned-closure-prepared-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        optimize: true,
        emitWat: true,
        target,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(42);
    }
    const make = outcome(prepared, "make");
    const run = outcome(prepared, "run");
    for (const observed of [make, run]) {
      expect(observed).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
    }
    expect(make.preparedComponentId).toBe(run.preparedComponentId);
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["make", "make__closure_0", "run"]));
    expect(prepared.wat).toContain("call_ref");
    expect(prepared.wat).not.toContain("__call_m_");
    expectNoNewImports(prepared, direct, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it("does not treat a shadowed factory call as a top-level returned-callable proof", async () => {
    const source = `
      function make(offset: number): (value: number) => number {
        return (value: number): number => value + offset;
      }
      export function run(input: number): number {
        const make = (offset: number): number => offset + input;
        const add = make(2);
        return add;
      }
    `;
    const result = await compile(source, {
      fileName: "returned-closure-shadowed-factory.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result, "run")).toMatchObject({ kind: "emitted", irBodyEmitted: true });
  });

  it.each(TARGETS)("keeps a var-bound returned closure in one prepared %s component", async (target) => {
    const direct = await compile(VAR_BOUND_SOURCE, {
      fileName: `returned-closure-var-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "makeAdder,makeAdder__closure_0,run";
      prepared = await compile(VAR_BOUND_SOURCE, {
        fileName: `returned-closure-var-prepared-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        optimize: true,
        target,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(42);
    }
    const makeAdder = outcome(prepared, "makeAdder");
    const run = outcome(prepared, "run");
    for (const observed of [makeAdder, run]) {
      expect(observed).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
    }
    expect(makeAdder.preparedComponentId).toBe(run.preparedComponentId);
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(
      expect.arrayContaining(["makeAdder", "makeAdder__closure_0", "run"]),
    );
    expectNoNewImports(prepared, direct, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });
});
