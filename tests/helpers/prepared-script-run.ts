// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Compile a script through the strict Prepared entry (`prepared-program-required`, standalone) and run its
// top-level code. The direct generators are mocked to throw, so a result can only come from the Prepared path.
import { expect, vi } from "vitest";
import * as gc from "../../src/codegen/index.js";
import * as linear from "../../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../../src/test262/test262-prepared-entry.js";

/**
 * The test262 worker's script options (`scripts/test262-worker.mjs`): the checker's semantic diagnostics are skipped,
 * so legal sloppy code it cannot type (an Annex B block function read outside its block) compiles as in CI.
 */
export const TEST262_SCRIPT = { skipSemanticDiagnostics: true, scriptGoal: true } as const;

export const preparedScriptOptions = (
  fileName = "test.js",
  overrides: Partial<Test262CompileOptions> = {},
): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName,
    ...(/\.m?js$/.test(fileName) ? { allowJs: true } : {}),
    ...overrides,
  }) as Test262CompileOptions;

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/**
 * Diagnostics the checker reports on legal sloppy script code that do not stop the compile: a read before the
 * first store, a repeated `var` whose declarators the checker types differently (`var x = 1; var x;`), (#7375) an
 * arithmetic operand of a non-number type (`x *= "3"`), and a comparison of types the checker sees as disjoint.
 */
const TOLERATED = new RegExp(
  [
    "Variable '\\w+' is used before being assigned\\.",
    "Subsequent variable declarations must have the same type\\. .*",
    "The (left|right)-hand side of an arithmetic operation must be of type 'any', 'number', 'bigint' or an enum type\\.",
    "This comparison appears to be unintentional because the types '\\w+' and '\\w+' have no overlap\\.",
  ]
    .map((pattern) => `^${pattern}$`)
    .join("|"),
);

/** Run `source`'s module-init: `returned`, or `threw` when it threw a Wasm exception. */
export async function runPreparedScript(
  source: string,
  fileName = "test.js",
  overrides: Partial<Test262CompileOptions> = {},
): Promise<"returned" | "threw"> {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  const result = await compile(source, preparedScriptOptions(fileName, overrides));
  expect(messages(result).filter((message) => !TOLERATED.test(message))).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    const exports = instantiatePreparedArtifact(result).instance.exports;
    (exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

/** The refusal messages of `source`, which must not compile. */
export async function preparedScriptRefusal(
  source: string,
  fileName = "test.js",
  overrides: Partial<Test262CompileOptions> = {},
): Promise<string> {
  const result = await compile(source, preparedScriptOptions(fileName, overrides));
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}
