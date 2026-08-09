// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileDeclarations, collectDeclarations } from "../src/codegen/declarations.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import type { CodegenOptions } from "../src/codegen/context/types.js";
import { compile, type CompileResult } from "../src/index.js";
import { supportsIrBackendTargetCapability, type IrBackendTargetProfile } from "../src/ir/backend/legality.js";
import { compileIrPathFunctions } from "../src/ir/integration.js";
import { collectModuleInitPopulation } from "../src/ir/module-init.js";
import { evaluateIrOutcomePolicy, type IrObservedOutcome, type IrPreparationFailure } from "../src/ir/outcomes.js";
import type { IrSelection } from "../src/ir/select.js";
import { createEmptyModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

function typedSource(source: string): { sourceFile: ts.SourceFile; checker: ts.TypeChecker } {
  const fileName = "issue-3529-module-init.ts";
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const baseHost = ts.createCompilerHost(options, true);
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    getSourceFile: (name, languageVersion, ...rest) =>
      name === fileName ? sourceFile : baseHost.getSourceFile(name, languageVersion, ...rest),
    writeFile: () => {},
  };
  const program = ts.createProgram([fileName], options, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

function forceModuleInitIntegration(
  source: string,
  mutateContext?: (ctx: ReturnType<typeof createCodegenContext>) => void,
) {
  const { sourceFile, checker } = typedSource(source);
  const ctx = createCodegenContext(createEmptyModule(), checker);
  collectDeclarations(ctx, sourceFile);
  compileDeclarations(ctx, sourceFile);
  mutateContext?.(ctx);
  const selection: IrSelection = {
    funcs: new Set(),
    moduleInit: { stmtCount: collectModuleInitPopulation(sourceFile).length, reason: null },
  };
  return compileIrPathFunctions(ctx, sourceFile, selection);
}

function forceFunctionIntegration(source: string, functionName: string, options: CodegenOptions) {
  const { sourceFile, checker } = typedSource(source);
  const ctx = createCodegenContext(createEmptyModule(), checker, options);
  collectDeclarations(ctx, sourceFile);
  compileDeclarations(ctx, sourceFile);
  const selection: IrSelection = { funcs: new Set([functionName]) };
  return compileIrPathFunctions(ctx, sourceFile, selection);
}

function terminal(result: CompileResult, displayName: string): IrObservedOutcome {
  const outcome = result.irOutcomes?.find((candidate) => candidate.displayName === displayName);
  expect(outcome).toBeDefined();
  return outcome!;
}

function expectPreparationPolicy(outcome: IrPreparationFailure, hybridReady: boolean): void {
  const observed: IrObservedOutcome = {
    key: "issue-3529-preflight",
    file: "issue-3529-preflight.ts",
    unitKind: "function",
    displayName: "preflight",
    ordinal: 0,
    line: 1,
    column: 1,
    backend: "wasmgc",
    target: "gc",
    legacyBodyEmitted: true,
    irBodyEmitted: false,
    ...outcome,
  };
  expect(evaluateIrOutcomePolicy([observed], "hybrid").ready).toBe(hybridReady);
  expect(evaluateIrOutcomePolicy([observed], "ir-only").ready).toBe(false);
}

describe("#3529 P4 integration and backend preflight", () => {
  it.each([
    ["gc host", { backend: "wasmgc", target: "gc", allowHostImports: true } satisfies IrBackendTargetProfile, true],
    ["strict gc", { backend: "wasmgc", target: "gc", allowHostImports: false } satisfies IrBackendTargetProfile, false],
    [
      "standalone",
      { backend: "wasmgc", target: "standalone", allowHostImports: false } satisfies IrBackendTargetProfile,
      false,
    ],
    ["wasi", { backend: "wasmgc", target: "wasi", allowHostImports: false } satisfies IrBackendTargetProfile, false],
    [
      "linear backend",
      { backend: "linear", target: "linear", allowHostImports: true } satisfies IrBackendTargetProfile,
      false,
    ],
  ])("preflights the host Date snapshot capability for %s", (_label, profile, expected) => {
    expect(supportsIrBackendTargetCapability(profile, "host-date-snapshot")).toBe(expected);
  });

  it.each([
    ["standalone", { standalone: true }],
    ["wasi", { wasi: true }],
    ["strict no-host", { strictNoHostImports: true }],
  ] satisfies readonly (readonly [string, CodegenOptions])[])(
    "rejects a stale host-Date claim during %s resolve preflight",
    (_label, options) => {
      const report = forceFunctionIntegration(
        "export function snap(): number { return new Date().getFullYear(); }",
        "snap",
        options,
      );
      expect(report.compiled).toEqual([]);
      expect(report.errors).toEqual([
        expect.objectContaining({
          func: "snap",
          outcome: expect.objectContaining({
            kind: "unsupported",
            stage: "resolve",
            code: "late-preparation-unsupported",
          }),
        }),
      ]);
      expectPreparationPolicy(report.errors[0]!.outcome, true);
    },
  );

  it.each([
    ["top-level destructuring", "const [value] = [1];"],
    ["unsupported legacy storage", 'const label = "value";'],
  ])("types the deliberate module-init %s exit", (_label, source) => {
    const report = forceModuleInitIntegration(source);
    expect(report.compiled).toEqual([]);
    expect(report.errors).toEqual([
      expect.objectContaining({
        func: "<module-init>",
        outcome: expect.objectContaining({
          kind: "unsupported",
          stage: "build",
          code: "module-init-legacy-coupling",
        }),
      }),
    ]);
    expectPreparationPolicy(report.errors[0]!.outcome, true);
  });

  it("keeps a missing promised legacy module global as an Invariant", () => {
    const report = forceModuleInitIntegration("let value: number = 1;", (ctx) => {
      const index = ctx.mod.globals.findIndex((global) => global.name === "__mod_value");
      expect(index).toBeGreaterThanOrEqual(0);
      ctx.mod.globals.splice(index, 1);
    });
    expect(report.errors).toEqual([
      expect.objectContaining({
        func: "<module-init>",
        outcome: expect.objectContaining({ kind: "invariant", stage: "build", code: "unknown-global-ref" }),
      }),
    ]);
    expectPreparationPolicy(report.errors[0]!.outcome, false);
  });

  it("keeps a promised legacy module-global ABI contradiction as an Invariant", () => {
    const report = forceModuleInitIntegration("let value: number = 1;", (ctx) => {
      const global = ctx.mod.globals.find((candidate) => candidate.name === "__mod_value");
      expect(global).toBeDefined();
      global!.type = { kind: "i32" };
    });
    expect(report.errors).toEqual([
      expect.objectContaining({
        func: "<module-init>",
        outcome: expect.objectContaining({
          kind: "invariant",
          stage: "build",
          code: "abi-type-index-mismatch",
        }),
      }),
    ]);
    expectPreparationPolicy(report.errors[0]!.outcome, false);
  });

  it("records a predictable final host-Date provider collision before integration", async () => {
    const result = await compile(
      `
        function Date_new(): number { return 1; }
        export function snap(): number { return new Date().getFullYear(); }
      `,
      { fileName: "issue-3529-date-provider.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const outcome = terminal(result, "snap");
    expect(outcome).toMatchObject({
      kind: "unsupported",
      stage: "resolve",
      code: "late-preparation-unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(evaluateIrOutcomePolicy(result.irOutcomes ?? [], "hybrid").ready).toBe(true);
    expect(evaluateIrOutcomePolicy(result.irOutcomes ?? [], "ir-only").ready).toBe(false);
  });
});
