// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4208 S2 — update expressions replace their target with a Number.
 *
 * These cases are deliberately module-scoped: the ES5 Test262 files execute
 * the update from the script body, so the synthetic module initializer must
 * own the primitive cases through IR. Object carriers may still demote, but
 * they share the same update-retyped storage decision and must keep the
 * resulting Number rather than the initializer's object representation.
 */
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions, type CompileResult } from "../src/index.js";
import { collectUpdateRetypedModuleBindings } from "../src/ir/update-retyped-bindings.js";
import { ts } from "../src/ts-api.js";

type Lane = readonly [string, CompileOptions];

const LANES: readonly Lane[] = [
  ["gc", { experimentalIR: true, trackIrOutcomes: true }],
  [
    "standalone",
    {
      target: "standalone",
      experimentalIR: true,
      trackIrOutcomes: true,
      hostBridge: "always",
    },
  ],
];

async function compileProbe(
  body: string,
  options: CompileOptions,
  probeExpression = "__result ? 1 : 0",
): Promise<CompileResult> {
  const result = await compile(`${body}\nexport function probe(): number { return ${probeExpression}; }\n`, {
    ...options,
    allowJs: true,
    fileName: "issue-4208-update-to-number.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function runProbe(result: CompileResult): Promise<number> {
  const { instance } = await WebAssembly.instantiate(result.binary!, result.importObject ?? {});
  return (instance.exports as Record<string, () => number>).probe!();
}

function analyzeUpdateBindings(source: string): number {
  const fileName = "/repo/update.ts";
  const options: ts.CompilerOptions = { module: ts.ModuleKind.ESNext, noLib: true, target: ts.ScriptTarget.ES2022 };
  const host: ts.CompilerHost = {
    fileExists: (candidate) => candidate === fileName,
    readFile: (candidate) => (candidate === fileName ? source : undefined),
    getSourceFile: (candidate, languageVersion) =>
      candidate === fileName
        ? ts.createSourceFile(candidate, source, languageVersion, true, ts.ScriptKind.TS)
        : undefined,
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    getCanonicalFileName: (candidate) => candidate,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName)!;
  return collectUpdateRetypedModuleBindings(program.getTypeChecker(), sourceFile).size;
}

describe("#4208 S2 — update targets use dynamic storage and IR ToNumber", () => {
  it("marks every declaration that shares a sloppy var binding", () => {
    expect(analyzeUpdateBindings('var value = "1"; value++; var value = "3"; --value; export {};')).toBe(2);
  });

  for (const [lane, options] of LANES) {
    it(`${lane}: decrements a string target and IR-owns module init`, async () => {
      const result = await compileProbe('var value = "1"; value--; var __result = value === 0;', options);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(result.irOutcomes?.find((outcome) => outcome.displayName === "<module-init>")).toMatchObject({
        kind: "emitted",
      });
      expect(result.irCompiledFuncs ?? []).toContain("<module-init>");
      expect(await runProbe(result)).toBe(1);
    });

    it(`${lane}: increments a string target and stores the Number`, async () => {
      const result = await compileProbe('var value = "1"; ++value; var __result = value === 2;', options);
      expect(result.irCompiledFuncs ?? []).toContain("<module-init>");
      expect(await runProbe(result)).toBe(1);
    });

    it(`${lane}: retypes a Boolean target before strict equality`, async () => {
      const result = await compileProbe("var value = true; value--; var __result = value === 0;", options);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(result.irOutcomes?.find((outcome) => outcome.displayName === "<module-init>")).toMatchObject({
        kind: "emitted",
      });
      expect(result.irCompiledFuncs ?? []).toContain("<module-init>");
      expect(await runProbe(result)).toBe(1);
    });

    it(`${lane}: preserves the Number written over a Boolean wrapper`, async () => {
      const result = await compileProbe("var value = new Boolean(true); value++; var __result = value === 2;", options);
      expect(await runProbe(result)).toBe(1);
    });

    it(`${lane}: stores NaN after updating a plain object target`, async () => {
      const result = await compileProbe(
        "var value = {}; var previous = value--; var __result = previous !== previous && value !== value;",
        options,
      );
      expect(await runProbe(result)).toBe(1);
    });

    it(`${lane}: shares dynamic storage across sloppy var redeclarations`, async () => {
      const result = await compileProbe(
        'var value = "1"; value++; var first = value === 2; var value = "3"; --value; var __result = (first ? 1 : 0) + (value === 2 ? 2 : 0);',
        options,
        "__result",
      );
      expect(await runProbe(result)).toBe(3);
    });
  }
});
