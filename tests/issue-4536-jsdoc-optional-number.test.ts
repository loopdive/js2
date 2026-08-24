// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4536 — an optional JSDoc scalar must retain JavaScript's undefined value
 * across a module boundary.
 *
 * This is the small generic shape behind webpack's `formatSize()` residual:
 * `@param {number=} size` is a number to TypeScript, but callers may omit it.
 * A cross-module f64 ABI used to pad that call with 0, making the undefined
 * branch unreachable. The closure ABI must keep the parameter dynamic instead.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";

const OPTIONAL_JS = `
/**
 * @param {number=} value
 */
module.exports = (value) =>
  typeof value !== "number" || Number.isNaN(value) ? "undefined" : String(value);
`;

const ENTRY_TS = `
import describe from "./optional.js";
export function run(): string { return describe(); }
export function runNumber(): string { return describe(7); }
export function runNaN(): string { return describe(Number.NaN); }
`;

async function compileFixture() {
  const root = mkdtempSync(join(tmpdir(), "issue-4536-jsdoc-optional-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "optional.js"), OPTIONAL_JS);
  const entry = join(root, "entry.ts");
  writeFileSync(entry, ENTRY_TS);

  const result = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "web",
    experimentalIR: true,
    emitWat: false,
    deferTopLevelInit: true,
  });
  expect(result.success).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const imports = buildCompiledImports(result as never, {}) as Record<string, unknown> & {
    setInstance?: (instance: WebAssembly.Instance) => void;
    __setInstance?: (instance: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary!, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, () => string>;
}

describe("#4536 optional JSDoc scalar ABI", () => {
  it("preserves omitted and explicit NaN while retaining numeric calls", async () => {
    const exports = await compileFixture();
    expect(exports.run()).toBe("undefined");
    expect(exports.runNumber()).toBe("7");
    expect(exports.runNaN()).toBe("undefined");
  });
});
