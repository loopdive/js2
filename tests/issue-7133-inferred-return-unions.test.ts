// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { _propagationCore } from "../src/ir/propagate.js";
import { buildImports } from "../src/runtime.js";

function returnSeed(body: string, signature = "(n: number)"): string {
  const source = `function f${signature} { ${body} }`;
  const options = { strictNullChecks: true, noLib: true };
  const host = ts.createCompilerHost(options);
  const sf = ts.createSourceFile("return.ts", source, ts.ScriptTarget.Latest, true);
  const program = ts.createProgram(["return.ts"], options, {
    ...host,
    getSourceFile: (name) => (name === "return.ts" ? sf : undefined),
    fileExists: (name) => name === "return.ts",
    readFile: (name) => (name === "return.ts" ? source : undefined),
  });
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  return _propagationCore.seedReturnType(fn, program.getTypeChecker()).kind;
}

describe("inferred literal unions at function returns", () => {
  it.each([
    ["if (n > 2) return 1; return 0;", "f64"],
    ["if (n > 0) return -1.25; return 2.5;", "f64"],
    ["if (n > 0) return 'abc'; return 'z';", "string"],
    ["if (n > 0) return true; return false;", "bool"],
    ["if (n > 0) return 1; return 'z';", "dynamic"],
    ["if (n > 0) return 1; return undefined;", "dynamic"],
    ["if (n > 0) return 'abc'; return null;", "dynamic"],
    ["if (n > 0) return 1;", "dynamic"],
    ["if (n > 0) return { a: 1 }; return { b: 2 };", "dynamic"],
    ["enum E { A = 1, B = 2 }; if (n > 0) return E.A; return E.B;", "dynamic"],
    ["enum E { A = 'a', B = 'b' }; if (n > 0) return E.A; return E.B;", "dynamic"],
  ])("seeds %s as %s", (body, kind) => {
    expect(returnSeed(body)).toBe(kind);
  });

  it("keeps explicitly annotated return unions on their existing path", () => {
    expect(returnSeed("if (n > 0) return 1; return 0;", "(n: number): 1 | 0")).toBe("dynamic");
  });

  const cases = [
    {
      name: "four-argument early-return numeric literals",
      source: `function g(a,b,c,d) { if (a > 2) return 1; return 0; }
        export function run() { return g(3,0,0,0) * 10 + g(0,0,0,0); }`,
      expected: 10,
    },
    {
      name: "signed fractional literals",
      source: `function g(n) { if (n > 0) return -1.25; return 2.5; }
        export function run() { return g(1) * 10 + g(0); }`,
      expected: -10,
    },
    {
      name: "string literals",
      source: `function g(n) { if (n > 0) return 'abc'; return 'z'; }
        export function run() { return g(1).length * 10 + g(0).length; }`,
      expected: 31,
    },
  ];

  for (const target of ["standalone", "gc"] as const) {
    for (const testCase of cases) {
      it(`${testCase.name} emits an IR body and preserves both branches (${target})`, async () => {
        for (const experimentalIR of [false, true]) {
          const result = await compile(testCase.source, {
            allowJs: true,
            fileName: "return-unions.js",
            skipSemanticDiagnostics: true,
            experimentalIR,
            trackIrOutcomes: true,
            target,
          });
          expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
          const imports = target === "gc" ? buildImports(result.imports, {}, result.stringPool) : {};
          const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
          (imports as { setExports?: (exports: object) => void }).setExports?.(instance.exports);
          (instance.exports.__module_init as (() => void) | undefined)?.();
          expect((instance.exports.run as () => number)()).toBe(testCase.expected);
          if (experimentalIR) {
            for (const name of ["g", "run"]) {
              const outcome = result.irOutcomes?.find((entry) => entry.displayName === name);
              expect(outcome, JSON.stringify(result.irOutcomes)).toMatchObject({ irBodyEmitted: true });
            }
            expect(result.irPostClaimErrors ?? []).toEqual([]);
          }
        }
      });
    }
  }
});
