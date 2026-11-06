// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7106) Compile a test262 body behind the original harness (assert.js +
// sta.js) on standalone, the way the conformance runner does, and inspect or
// run its `<module-init>` unit. Shared by the #7106 module-init tests.
import { expect } from "vitest";

import { compile } from "../../src/index.js";
import { assembleOriginalHarness } from "../test262-original-harness.js";
import { parseMeta } from "../test262-runner.js";

export type HarnessCompileResult = Awaited<ReturnType<typeof compile>>;

/** The assembled script: harness prefix plus `body`, exactly as the runner compiles it. */
export function assembleHarnessBody(body: string): string {
  const source = `/*---\ndescription: harness module-init probe\n---*/\n${body}`;
  return assembleOriginalHarness(source, parseMeta(source) as never).primary.source;
}

export async function compileHarnessBody(body: string): Promise<HarnessCompileResult> {
  return compile(assembleHarnessBody(body), {
    fileName: "test.js",
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    deferTopLevelInit: true,
  });
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
