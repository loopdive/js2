// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";

describe("#6979 retired host JSON implementation", () => {
  it("removes the private serializer island without removing boundary conversion or public adapter roots", () => {
    const source = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8");
    const file = ts.createSourceFile("runtime.ts", source, ts.ScriptTarget.Latest, true);
    const declarations = new Set(
      file.statements.flatMap((statement) =>
        (ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name
          ? [statement.name.text]
          : [],
      ),
    );
    for (const retained of [
      "buildCompiledImports",
      "buildCompiledAdapterImports",
      "wrapCompiledExports",
      "_wasmToPlain",
      "_wrapForHost",
    ]) {
      expect(declarations.has(retained), `required adapter ${retained}`).toBe(true);
    }
    for (const retired of [
      "_JsonRep",
      "_liveIsArray",
      "_liveGet",
      "_hasReachableToJSON",
      "_isJsonCallable",
      "_invokeJsonCallable",
      "_internalizeJSONProperty",
      "_liveGetEnumerableKeys",
      "_quoteJSON",
      "_serializeJSONProperty",
      "_serializeJSONObject",
      "_serializeJSONArray",
    ]) {
      expect(declarations.has(retired), `retired host JSON declaration ${retired}`).toBe(false);
    }
  });

  for (const target of ["standalone", "wasi"] as const) {
    it(`executes dynamic JSON parsing and serialization without a host implementation — ${target}`, async () => {
      const result = await compile(
        `export function readResult(n: number): number {
          var text = JSON.stringify({ value: n });
          var parsed: any = JSON.parse(text);
          return parsed.value + 1;
        }`,
        { target, skipSemanticDiagnostics: true, inferModuleStrictArguments: false },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      const exports = instance.exports as { readResult: (n: number) => number };
      expect(exports.readResult(41)).toBe(42);
      expect(exports.readResult(6)).toBe(7);
    });
  }
});
