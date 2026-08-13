// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4222 ES5 residual) A sized Array has a length but no own indexed
// properties. These tests cover the bounded, branded `new Array(n)` carrier;
// ordinary vectors remain dense and unchanged.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { compile, type CompileResult } from "../src/index.js";
import { analyzeSource } from "../src/checker/index.js";
import { scanForArrayHoles } from "../src/codegen/array-holes.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { createEmptyModule } from "../src/ir/types.js";
import { buildImports } from "../src/runtime.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";

type Target = "standalone" | "gc";

async function compileSource(
  source: string,
  target: Target,
  extra: { experimentalIR?: boolean; trackIrOutcomes?: boolean } = {},
): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "es5-array-new-filter-holes.ts",
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
    ...extra,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  return result;
}

async function run(source: string, target: Target): Promise<unknown> {
  const result = await compileSource(source, target);
  const imports = target === "standalone" ? {} : buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#4222 — new Array(n) holes are skipped by filter", () => {
  for (const target of ["standalone", "gc"] as const) {
    it(`visits explicit undefined but no never-assigned index (${target})`, async () => {
      expect(
        await run(
          `let callCount = 0;
          const source = new Array(4);
          source[1] = undefined;
          function callback(_value: unknown): boolean {
            callCount = callCount + 1;
            return false;
          }
          source.filter(callback);
          export function test(): number { return callCount; }`,
          target,
        ),
      ).toBe(1);
    });

    it(`keeps a growth gap absent and captures filter length once (${target})`, async () => {
      expect(
        await run(
          `const source = new Array(2);
          source[1] = 1;
          function callback(_value: unknown): boolean {
            source[20] = 2;
            return true;
          }
          const result = source.filter(callback);
          export function test(): number { return result.length; }`,
          target,
        ),
      ).toBe(1);
    });
  }
});

describe("#4222 — bounded sparse-carrier eligibility", () => {
  it("recognizes an ambient direct binding with direct stores and filter only", () => {
    const { sourceFile, checker } = analyzeSource(
      `let callCount = 0;
       const source = new Array(4);
       source[1] = undefined;
       function callback(_value: unknown): boolean { callCount = callCount + 1; return false; }
       source.filter(callback);
       export function test(): number { return callCount; }`,
      "es5-array-new-filter-holes-plan.ts",
    );
    const ctx = createCodegenContext(createEmptyModule(), checker);
    scanForArrayHoles(ctx, sourceFile);

    expect(ctx.holeyArrayDeclarations.size).toBe(1);
    expect(ctx.holeyArrayConstructorNodes.size).toBe(1);
    expect(ctx.holeyArrayFilterCallNodes.size).toBe(1);
  });

  it("recognizes the original-harness binding for the exact ES5 row", async () => {
    const raw = readFileSync("test262/test/built-ins/Array/prototype/filter/15.4.4.20-9-5.js", "utf8");
    const assembly = assembleOriginalHarness(raw, {});
    const { sourceFile, checker } = analyzeSource(assembly.primary.source, "original-harness-15.4.4.20-9-5.js", {
      allowJs: true,
      skipSemanticDiagnostics: true,
    });
    const ctx = createCodegenContext(createEmptyModule(), checker);
    scanForArrayHoles(ctx, sourceFile);

    expect(ctx.holeyArrayDeclarations.size).toBe(1);
    expect(ctx.holeyArrayConstructorNodes.size).toBe(1);
    expect(ctx.holeyArrayFilterCallNodes.size).toBe(1);

    const result = await compile(assembly.primary.source, {
      allowJs: true,
      fileName: "original-harness-15.4.4.20-9-5.js",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.wat).toContain("$__holey_array");
  });

  it("demotes an execution-reachable prototype or dynamic-code mutation", () => {
    for (const source of [
      `Array.prototype[0] = 1;
       const values = new Array(4);
       function keep(): boolean { return true; }
       values.filter(keep);`,
      `const values = new Array(4);
       function keep(): boolean { eval("Array.prototype[0] = 1"); return true; }
       values.filter(keep);`,
    ]) {
      const { sourceFile, checker } = analyzeSource(source, "es5-array-new-filter-holes-unsafe.ts");
      const ctx = createCodegenContext(createEmptyModule(), checker);
      scanForArrayHoles(ctx, sourceFile);

      expect(ctx.holeyArrayDeclarations.size).toBe(0);
      expect(ctx.holeyArrayConstructorNodes.size).toBe(0);
      expect(ctx.holeyArrayFilterCallNodes.size).toBe(0);
    }
  });
});

describe("#4222 — representation and IR ownership", () => {
  it("keeps a filter-free numeric buffer on the ordinary f64 vec", async () => {
    const result = await compileSource(
      `export function test(): number {
        const values = new Array(4);
        values[0] = 0.5;
        return values[0];
      }`,
      "standalone",
      { experimentalIR: false },
    );
    expect(result.wat).toContain("$__vec_f64");
    expect(result.wat).not.toContain("$__holey_array");
  });

  it("claims the bounded sparse route in standalone IR", async () => {
    const source = `export function test(): void {
      const keep = (): boolean => true;
      const values = new Array(4);
      values[1] = null;
      values.filter(keep);
    }`;
    const result = await compileSource(source, "standalone", {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(result.irCompiledFuncs ?? []).toContain("test");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.wat).toContain("$__holey_array");

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test: () => void }).test()).toBeUndefined();
  });
});
