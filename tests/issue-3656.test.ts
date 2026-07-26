// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3656 — JavaScript JSDoc object types must not become dynamic between IR
// selection and overlay type planning.

import { describe, expect, it } from "vitest";

import { compile, compileProject } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { ESLINT_DEV_DEPENDENCY_SKIP, resolveEslintFile } from "./helpers/eslint.js";

const FLAGS_FILE = resolveEslintFile("lib/shared/flags.js");

const SOURCE = `
/**
 * @typedef {Object} InactiveFlagData
 * @property {string} description
 * @property {string | null} [replacedBy]
 */

/**
 * @param {InactiveFlagData} inactiveFlagData
 * @returns {string}
 */
export function reason({ replacedBy }) {
  if (typeof replacedBy === "undefined") {
    return "This feature has been abandoned.";
  }
  if (typeof replacedBy === "string") {
    return "renamed:" + replacedBy;
  }
  return "This feature is now enabled by default.";
}
`;

describe("#3656 — untyped JavaScript destructured parameter", () => {
  it("preserves the JSDoc parameter type through planning and runs all branches", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-3656.js",
      allowJs: true,
      target: "gc",
      platform: "node",
      experimentalIR: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.errors.some((error) => error.message.includes("object destructuring source must"))).toBe(false);
    expect(result.irPostClaimErrors?.some((error) => error.kind === "build")).not.toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const reason = instance.exports.reason as (value: unknown) => string;
    expect(reason({ description: "x" })).toBe("This feature has been abandoned.");
    expect(reason({ description: "x", replacedBy: "stable" })).toBe("renamed:stable");
    expect(reason({ description: "x", replacedBy: null })).toBe("This feature is now enabled by default.");
  });

  it.skipIf(FLAGS_FILE === null)(
    `compiles and validates ESLint's real flags.js ${ESLINT_DEV_DEPENDENCY_SKIP}`,
    async () => {
      const result = await compileProject(FLAGS_FILE!, {
        allowJs: true,
        target: "gc",
        platform: "node",
        experimentalIR: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect(result.errors.some((error) => error.message.includes("object destructuring source must"))).toBe(false);
      expect(result.irPostClaimErrors?.some((error) => error.kind === "build")).not.toBe(true);
    },
  );
});
