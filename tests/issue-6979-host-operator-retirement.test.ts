// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";

describe("#6979 retired host operators", () => {
  it("removes unused host instanceof and deep-array-copy state while retaining boundary adapters", () => {
    const source = ts.createSourceFile(
      "runtime.ts",
      readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const declarations = new Set<string>();
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) declarations.add(statement.name.text);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) declarations.add(declaration.name.text);
        }
      }
    }
    for (const retained of ["_wrapForHost", "_unwrapForHost", "_nativeDynamicFromHost", "buildCompiledImports"]) {
      expect(declarations.has(retained), `required boundary adapter ${retained}`).toBe(true);
    }
    for (const retired of [
      "_instanceofResult",
      "_compiledFnPrototypeSlot",
      "_fnctorInstanceofResult",
      "_toJsArrayDeep",
      "_INSTANCEOF_THROW",
      "_SLOT_ABSENT",
      "VEC_UNWRAP_MAX_DEPTH",
      "_boundFunctionTargets",
      "_fnctorInstanceofHooks",
    ]) {
      expect(declarations.has(retired), `retired host operator ${retired}`).toBe(false);
    }
  });

  for (const target of ["standalone", "wasi"] as const) {
    it(`flattens native arrays without a host deep-copy implementation — ${target}`, async () => {
      const result = await compile(
        "export function run(n: number): number { var nested = [[n], [n + 1]]; return nested.flat()[1]; }",
        { target, skipSemanticDiagnostics: true, inferModuleStrictArguments: false },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      const run = instance.exports.run as (n: number) => number;
      expect(run(41)).toBe(42);
      expect(run(6)).toBe(7);
    });
  }
});
