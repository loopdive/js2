// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7129 — an unannotated class method whose every value return is the same
// bare number or string literal resolves to that kind (the checker's widened
// `number` / `string`, which legacy's class descriptor registers) on the
// host-free lanes. Methods carry no lattice entry, so before this the selector
// refused every such JS method as `return-type-not-resolvable`. The
// host-assisted lane keeps the refusal so its legacy output stays byte-identical.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { uniformLiteralReturnKind } from "../src/ir/select-expression-structure.js";
import { buildImports } from "../src/runtime.js";

type Lane = { target: "standalone" | "gc"; semanticProviders?: "host-assisted" | "native-first" };

const STANDALONE: Lane = { target: "standalone" };
const GC_HOST_ASSISTED: Lane = { target: "gc", semanticProviders: "host-assisted" };
const GC_NATIVE_FIRST: Lane = { target: "gc", semanticProviders: "native-first" };

function laneName(lane: Lane): string {
  return lane.semanticProviders ? `${lane.target} ${lane.semanticProviders}` : lane.target;
}

async function compileAndRun(
  source: string,
  lane: Lane,
  experimentalIR: boolean,
  fileName = "issue-7129.js",
): Promise<{ value: unknown; irBodies: string[]; legacy: string[]; codes: string[] }> {
  const result = await compile(source, {
    experimentalIR,
    skipSemanticDiagnostics: true,
    allowJs: true,
    ...lane,
    trackIrOutcomes: true,
    fileName,
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = lane.target === "gc" ? buildImports(result.imports, {}, result.stringPool) : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  const value = (instance.exports.run as () => unknown)();
  const outcomes = (result.irOutcomes ?? []).filter((o) => o.kind !== "non-executable");
  return {
    value,
    irBodies: outcomes.filter((o) => o.irBodyEmitted).map((o) => o.displayName),
    legacy: outcomes.filter((o) => !o.irBodyEmitted).map((o) => o.displayName),
    codes: outcomes.map((o) => `${o.displayName}:${(o as { code?: string }).code ?? ""}`),
  };
}

function nodeRun(source: string): unknown {
  const body = source.replace(/export function run/, "function run").replace(/\(x: number\)/g, "(x)");
  return new Function(`${body}\nreturn run();`)();
}

const CASES: { name: string; source: string; method: string; fileName?: string }[] = [
  {
    name: "instance method returning a number literal",
    method: "C_m",
    source: `
      class C { m() { return 42; } }
      export function run() { return new C().m() + 1; }
    `,
  },
  {
    name: "instance method returning a negative literal",
    method: "C_m",
    source: `
      class C { m() { return (-2.5); } }
      export function run() { return new C().m() * 2; }
    `,
  },
  {
    name: "instance method returning a string literal",
    method: "C_s",
    source: `
      class C { s() { return 'abc'; } }
      export function run() { return new C().s().length; }
    `,
  },
  {
    // Not a bare literal tail: the same literal on two paths. Legacy and the IR
    // lower the bodies differently, so this is the shape whose host-assisted
    // bytes would move without the lane gate.
    name: "method returning the same literal on two paths",
    method: "C_m",
    fileName: "issue-7129.ts",
    source: `
      class C { m(x: number) { if (x > 0) { return 1; } return 1; } }
      export function run() { return new C().m(1) * 10 + new C().m(-1); }
    `,
  },
];

describe("#7129 — literal-returning unannotated methods resolve their primitive kind", () => {
  for (const lane of [STANDALONE, GC_NATIVE_FIRST]) {
    for (const testCase of CASES) {
      it(`${testCase.name} (${laneName(lane)}) ships an IR body and matches legacy and node`, async () => {
        const ir = await compileAndRun(testCase.source, lane, true, testCase.fileName);
        const legacy = await compileAndRun(testCase.source, lane, false, testCase.fileName);
        expect(ir.irBodies, JSON.stringify(ir.codes)).toContain(testCase.method);
        expect(ir.value).toBe(legacy.value);
        expect(ir.value).toBe(nodeRun(testCase.source));
      });
    }
  }

  for (const testCase of CASES) {
    it(`${testCase.name} (gc host-assisted) keeps the method legacy and matches node`, async () => {
      const ir = await compileAndRun(testCase.source, GC_HOST_ASSISTED, true, testCase.fileName);
      expect(ir.codes).toContain(`${testCase.method}:return-type-not-resolvable`);
      expect(ir.value).toBe(nodeRun(testCase.source));
    });
  }

  // Shapes that reach `resolveReturnType` and are refused BY the predicate:
  // the specific code proves the class-member body-shape gate did not refuse
  // them first.
  for (const [name, method] of [
    ["a non-literal return", "m() { return this.constructor.name.length; }"],
    ["a boolean literal (legacy slot differs)", "m() { return true; }"],
  ] as const) {
    it(`a method with ${name} is refused as return-type-not-resolvable and runs correctly`, async () => {
      const source = `
        class C { ${method} }
        export function run() { var v = new C().m(); return typeof v === "number" ? 1 : 2; }
      `;
      const ir = await compileAndRun(source, STANDALONE, true);
      expect(ir.codes).toContain("C_m:return-type-not-resolvable");
      expect(ir.value).toBe(nodeRun(source));
    });
  }
});

describe("#7129 — uniformLiteralReturnKind", () => {
  function methodBody(body: string): ts.Block {
    const sf = ts.createSourceFile("u.ts", `class C { m(x: number) ${body} }`, ts.ScriptTarget.Latest, true);
    const cls = sf.statements[0] as ts.ClassDeclaration;
    const method = cls.members[0] as ts.MethodDeclaration;
    return method.body as ts.Block;
  }

  const ROWS: [string, "f64" | "string" | null][] = [
    ["{ return 42; }", "f64"],
    ["{ return (-2.5); }", "f64"],
    ["{ return +7; }", "f64"],
    ["{ return 'abc'; }", "string"],
    ["{ return `abc`; }", "string"],
    // the same literal on several paths — still one widened type
    ["{ if (x > 0) { return 1; } return 1; }", "f64"],
    ["{ if (x > 0) { return 1.0; } return 1; }", "f64"],
    ["{ switch (x) { case 1: return 'a'; default: return 'a'; } }", "string"],
    // returns inside nested functions and classes belong to those
    ["{ const f = () => 'q'; class I { n() { return true; } } return 5; }", "f64"],
    // two distinct literals infer the union `1 | 2`, not `number`
    ["{ if (x > 0) { return 1; } return 2; }", null],
    ["{ if (x > 0) { return 'a'; } return 'b'; }", null],
    ["{ if (x > 0) { return 1; } return -1; }", null],
    // mixed kinds
    ["{ if (x > 0) { return 1; } return 'x'; }", null],
    // booleans, non-literals, bare return, substitution template
    ["{ return true; }", null],
    ["{ return x; }", null],
    ["{ return; }", null],
    ["{ return `a${x}`; }", null],
    // fall-out is the caller's `functionBodyAlwaysTerminates` question, not this one
    ["{ if (x > 0) { return 1; } }", "f64"],
  ];
  for (const [body, expected] of ROWS) {
    it(`${body} → ${String(expected)}`, () => {
      expect(uniformLiteralReturnKind(methodBody(body))).toBe(expected);
    });
  }
});
