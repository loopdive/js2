// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — §9.1.1.4.18 CreateGlobalFunctionBinding: a SCRIPT's top-level
 * function declarations are own properties of the global object.
 *
 * We never implemented this. `globalThis.f` resolved (identifier lowering finds
 * the function) but the BINDING did not exist, so every reflective probe
 * answered false. That is 19 of the 50 standalone harness failures:
 * `asyncHelpers.js` gates `asyncTest` on
 * `Object.prototype.hasOwnProperty.call(globalThis, "$DONE")` and throws
 * "asyncTest called without async flag" when it is absent.
 *
 * Standalone/WASI only for now — the host lane's `globalThis` is the embedder's
 * object, which the test262 runner also seeds itself.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string): Promise<{ wat: string }> {
  const result = (await compile(source, {
    target: "standalone",
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as never)) as { success: boolean; errors: { line: number; message: string }[]; wat?: string };
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  return { wat: result.wat ?? "" };
}

describe("#4394 — script top-level functions bind on the global object", () => {
  it("seeds each top-level function name onto the standalone global object", async () => {
    const { wat } = await compileStandalone(`
function $DONE(err) { return err; }
function helper() { return 7; }
helper();
`);
    // The seeds are string-constant keys handed to __defineProperty_value.
    // Under nativeStrings there is no string_constants import to assert on, so
    // check the native global object and the define call are both wired.
    expect(wat).toContain("__native_globalThis");
    expect(wat).toContain("__defineProperty_value");
  });

  it("does not seed for an ES module", async () => {
    // In a module the top-level declarations live in the module environment
    // record and are deliberately NOT global-object properties.
    const { wat } = await compileStandalone(`
export function helper() { return 7; }
helper();
`);
    expect(wat).not.toContain("__global_fn_binding_obj");
  });

  it("emits no seeding block when the script declares no functions", async () => {
    const { wat } = await compileStandalone(`
const x: number = 1;
export function main(): number { return x; }
`);
    expect(wat).not.toContain("__global_fn_binding_obj");
  });
});
