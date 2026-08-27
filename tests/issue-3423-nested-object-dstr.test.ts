/**
 * #3423 — nested object destructuring must preserve an undefined property
 * through a closed-struct f64 field, while an ordinary NaN remains a number.
 *
 * The source shape is the generated variable-declaration case: the nested
 * object load crosses the closed-struct property boundary before the binding
 * receives it. The two lanes use the same source so this guards both the host
 * property loader and the standalone lowering.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
var { w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: undefined, z: 7 } };
var { w: { n } } = { w: { n: NaN } };

export function test(): number {
  const missingBindings =
    (x === undefined ? 100 : 0) +
    (y === undefined ? 10 : 0) +
    (z === 7 ? 1 : 0);
  const ordinaryNaN = n !== undefined && n !== n;
  return missingBindings + (ordinaryNaN ? 1000 : 0);
}
`;

async function runStandalone(): Promise<number> {
  const result = await compile(SOURCE, {
    fileName: "issue-3423-nested-object-dstr.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, `standalone compile failed: ${result.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { test(): number }).test();
}

async function runHost(): Promise<number> {
  const result = await compile(SOURCE, {
    fileName: "issue-3423-nested-object-dstr.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, `host compile failed: ${result.errors?.[0]?.message}`).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool, {}) as WebAssembly.Imports & {
    setExports?: (exports: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary!, imports);
  imports.setExports?.(instance.exports);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return (instance.exports as { test(): number }).test();
}

describe("#3423 — nested object destructuring representation boundary", () => {
  it("standalone: preserves undefined and ordinary NaN", async () => {
    await expect(runStandalone()).resolves.toBe(1111);
  });

  it("host: preserves undefined and ordinary NaN", async () => {
    await expect(runHost()).resolves.toBe(1111);
  });
});
