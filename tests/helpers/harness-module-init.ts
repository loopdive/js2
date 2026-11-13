// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7106) Compile a test262 body behind the original harness (assert.js +
// sta.js), the way the conformance runner does, and inspect or run its
// `<module-init>` unit. Shared by the #7106 module-init tests.
import { expect } from "vitest";

import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";
import { assembleOriginalHarness } from "../test262-original-harness.js";
import { parseMeta } from "../test262-runner.js";
import type { Target } from "./ambient-intrinsic-probe.js";

export type HarnessCompileResult = Awaited<ReturnType<typeof compile>>;

/** The assembled script: harness prefix plus `body`, exactly as the runner compiles it. */
export function assembleHarnessBody(body: string): string {
  const source = `/*---\ndescription: harness module-init probe\n---*/\n${body}`;
  return assembleOriginalHarness(source, parseMeta(source) as never).primary.source;
}

const HARNESS_OPTIONS = {
  fileName: "test.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

export async function compileHarnessBody(body: string): Promise<HarnessCompileResult> {
  return compile(assembleHarnessBody(body), { ...HARNESS_OPTIONS, target: "standalone" });
}

/** `body` behind the harness on `target` (`undefined` is the gc lane); a claim is never withdrawn after the fact. */
export async function compileHarnessOn(
  target: Target,
  body: string,
  fileName: string = HARNESS_OPTIONS.fileName,
): Promise<HarnessCompileResult> {
  const result = await compile(assembleHarnessBody(body), {
    ...HARNESS_OPTIONS,
    fileName,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

/**
 * Run `<module-init>` on `target` (an assert failure throws) and report whether
 * the IR claimed it; each of `emittedUnits` must have been emitted by the IR.
 */
export async function runHarnessOn(
  target: Target,
  body: string,
  fileName?: string,
  emittedUnits: readonly string[] = [],
): Promise<boolean> {
  const result = await compileHarnessOn(target, body, fileName);
  for (const name of emittedUnits) {
    const outcome = result.irOutcomes?.find((unit) => unit.displayName === name);
    expect(outcome, `${name}: ${JSON.stringify(outcome)}`).toMatchObject({ irBodyEmitted: true, kind: "emitted" });
  }
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as () => void)();
  return moduleInit(result)?.irBodyEmitted === true;
}

export function moduleInit(result: HarnessCompileResult) {
  return (result.irOutcomes ?? []).find((outcome) => outcome.unitKind === "module-init");
}

/** Require a clean compile with no post-claim IR error, then run `__module_init`. */
export async function runModuleInit(result: HarnessCompileResult): Promise<void> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as () => void)();
}
