// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2949 — dynamic member equality is safe when a function is called only
// through its declared ABI. Named HOF callbacks remain on the direct path
// because legacy array methods can pass their receiver argument in a direct
// carrier instead of the boxed-any carrier consumed by dyn.member_get.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

function selectionFor(source: string): ReturnType<typeof planIrCompilation> {
  const sourceFile = ts.createSourceFile("member-equality.ts", source, ts.ScriptTarget.Latest, true);
  return planIrCompilation(sourceFile, { experimentalIR: true, trackFallbacks: true });
}

describe("#2949 — direct-only dynamic member equality", () => {
  it("claims the full Acorn checkKeyName helper", () => {
    const selection = selectionFor(`
      export function checkKeyName(node: any, name: any): boolean {
        var computed = node.computed;
        var key = node.key;
        return !computed && (
          key.type === "Identifier" && key.name === name ||
          key.type === "Literal" && key.value === name
        );
      }
    `);

    expect(selection.funcs.has("checkKeyName"), JSON.stringify(selection.fallbacks)).toBe(true);
  });

  it("keeps a value-used array callback on the direct path", () => {
    const selection = selectionFor(`
      function callbackfn(value: any, index: any, obj: any): boolean {
        return obj.length === 2;
      }
      export function run(values: any[]): number {
        return values.filter(callbackfn).length;
      }
    `);

    expect(selection.funcs.has("callbackfn")).toBe(false);
    expect(selection.fallbacks?.find((fallback) => fallback.name === "callbackfn")?.reason).toBe(
      "param-type-not-resolvable",
    );
  });

  it("executes the claimed helper through the boxed-any host ABI", async () => {
    const result = await compile(
      `
        export function checkKeyName(node: any, name: any): boolean {
          var computed = node.computed;
          var key = node.key;
          return !computed && (
            key.type === "Identifier" && key.name === name ||
            key.type === "Literal" && key.value === name
          );
        }
      `,
      {
        experimentalIR: true,
        fileName: "member-equality.ts",
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("checkKeyName");

    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: imports.env,
      string_constants: imports.string_constants,
    });
    imports.setExports?.(instance.exports);
    const checkKeyName = instance.exports.checkKeyName as (node: unknown, name: unknown) => number;

    expect(checkKeyName({ computed: false, key: { type: "Identifier", name: "value" } }, "value")).toBe(1);
    expect(checkKeyName({ computed: true, key: { type: "Identifier", name: "value" } }, "value")).toBe(0);
    expect(checkKeyName({ computed: false, key: { type: "Literal", value: "value" } }, "value")).toBe(1);
    expect(checkKeyName({ computed: false, key: { type: "Identifier", name: "other" } }, "value")).toBe(0);
  });

  it("matches the direct implicit-string ABI in standalone", async () => {
    const result = await compile(
      `
        function checkKeyName(node, name) {
          var computed = node.computed;
          var key = node.key;
          return !computed && (
            key.type === "Identifier" && key.name === name ||
            key.type === "Literal" && key.value === name
          );
        }
        var identifier = { computed: false, key: { type: "Identifier", name: "value" } };
        var literal = { computed: false, key: { type: "Literal", value: "value" } };
        var result = checkKeyName(identifier, "value") && checkKeyName(literal, "value") ? 1 : 0;
        export function run(): number { return result; }
      `,
      {
        allowJs: true,
        experimentalIR: true,
        fileName: "member-equality.ts",
        skipSemanticDiagnostics: true,
        target: "standalone",
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("checkKeyName");

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });
});
