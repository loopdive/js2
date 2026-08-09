// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3592 RC1 — a bare top-level `throw` statement must actually execute.
 *
 * `compileDeclarations` had a `ThrowStatement` arm gated on `ctx.wasi` (#2968),
 * so in the JS-host and standalone lanes a top-level `throw` was collected into
 * NOTHING: it emitted no code, `__module_init` ran to completion, and a test262
 * file whose only statement is `throw new Test262Error(...)` scored **pass**.
 * A silent wrong answer in every non-WASI lane, measured 2026-07-25.
 *
 * The exposed corpus is exactly the 40 test262 files carrying a top-level
 * ThrowStatement; the exhaustive A/B over them was +5 / −0 in BOTH lanes.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Compile + instantiate + run `__module_init`; true when it threw. */
async function initThrows(source: string, target?: "standalone"): Promise<boolean> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "toplevel-throw.js",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildImports(result.imports, { console }, result.stringPool) as Record<string, unknown> & {
    setExports?: (e: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports);
  const init = (instance.exports as Record<string, unknown>).__module_init;
  expect(typeof init, "a module whose only statement is `throw` must still export __module_init").toBe("function");
  try {
    (init as () => void)();
    return false;
  } catch {
    return true;
  }
}

describe("#3592 RC1 — top-level throw is not silently dropped", () => {
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "host";

    it(`[${lane}] a bare top-level throw reaches the host`, async () => {
      expect(await initThrows(`throw new Error("boom");`, target)).toBe(true);
    });

    it(`[${lane}] a top-level throw after other statements reaches the host`, async () => {
      expect(await initThrows(`var seen = 1;\nseen = seen + 1;\nthrow new Error("boom");`, target)).toBe(true);
    });

    it(`[${lane}] a throw-free module still runs to completion`, async () => {
      expect(await initThrows(`var seen = 1;\nseen = seen + 1;`, target)).toBe(false);
    });
  }
});
