// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const EXACT_DELAY = `
export function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}
`;

function terminalOutcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  if (!observed) throw new Error(`missing IR outcome for ${name}`);
  return observed;
}

async function compileTracked(source: string, optimize = false): Promise<CompileResult> {
  return compile(source, {
    fileName: "issue-4102-ir-promise-delay-closure-compile-once.ts",
    experimentalIR: true,
    trackFallbacks: true,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    optimize,
  });
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

async function settled<T>(value: T | Promise<T>, ms = 4000): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("delay result never settled")), ms);
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

describe("#4102 exact Promise-delay closure prepare-before-emit ownership", () => {
  it.each([false, true])("prepares the owner and both lifted closures once (optimize=%s)", async (optimize) => {
    const result = await compileTracked(EXACT_DELAY, optimize);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irFirstSkipped ?? []).toContain("delay");
    expect(result.irCompiledFuncs ?? []).toEqual(
      expect.arrayContaining(["delay", "delay__closure_0", "delay__closure_0__closure_1"]),
    );
    expect(terminalOutcome(result, "delay")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(terminalOutcome(result, "delay").preparedComponentId).toMatch(/^prepared-component:/);

    const exports = await instantiate(result);
    const delay = exports.delay as (ms: number, value: number) => Promise<number>;
    const slow = delay(15, 4102);
    const fast = delay(1, 2041);
    await expect(settled(fast)).resolves.toBe(2041);
    await expect(settled(slow)).resolves.toBe(4102);
  });

  it("keeps prepared closure indices valid when a direct-only body adds a later import", async () => {
    const result = await compileTracked(`
      ${EXACT_DELAY}
      export function directOnly(...values: number[]): number { return Date.now() + values.length; }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irFirstSkipped ?? []).toContain("delay");
    expect(terminalOutcome(result, "delay").preparedComponentId).toMatch(/^prepared-component:/);
    expect(terminalOutcome(result, "directOnly")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.imports.map((entry) => `${entry.module}.${entry.name}`)).toContain("env.__date_now");

    const exports = await instantiate(result);
    await expect(settled((exports.delay as (ms: number, value: number) => Promise<number>)(1, 99))).resolves.toBe(99);
  });

  it("leaves a near-miss Promise shape on direct ownership", async () => {
    const result = await compileTracked(`
      export function delay(ms: number, value: number): Promise<number> {
        return new Promise<number>((resolve) => setTimeout(() => resolve(value), ms));
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irFirstSkipped ?? []).not.toContain("delay");
    expect(result.irCompiledFuncs ?? []).not.toContain("delay");
    expect(terminalOutcome(result, "delay")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(terminalOutcome(result, "delay")).not.toHaveProperty("preparedComponentId");
  });
});
