// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7129 — an unannotated class method whose every value return is a bare
// literal of one primitive kind resolves to that kind (the checker's widened
// `number` / `string`, which legacy's class descriptor registers).
// Methods carry no lattice entry, so before this the selector refused every
// such JS method as `return-type-not-resolvable`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "standalone" | "gc";

async function compileAndRun(
  source: string,
  target: Target,
  experimentalIR: boolean,
): Promise<{ value: unknown; irBodies: string[]; legacy: string[]; codes: string[] }> {
  const result = await compile(source, {
    experimentalIR,
    skipSemanticDiagnostics: true,
    allowJs: true,
    target,
    trackIrOutcomes: true,
    fileName: "issue-7129.js",
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = target === "gc" ? buildImports(result.imports, {}, result.stringPool) : {};
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
  const body = source.replace(/export function run/, "function run");
  return new Function(`${body}\nreturn run();`)();
}

const CASES: { name: string; source: string; method: string }[] = [
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
];

describe("#7129 — literal-returning unannotated methods resolve their primitive kind", () => {
  for (const target of ["standalone", "gc"] as const) {
    for (const testCase of CASES) {
      it(`${testCase.name} (${target}) ships an IR body and matches legacy and node`, async () => {
        const ir = await compileAndRun(testCase.source, target, true);
        const legacy = await compileAndRun(testCase.source, target, false);
        expect(ir.irBodies, JSON.stringify(ir.codes)).toContain(testCase.method);
        expect(ir.value).toBe(legacy.value);
        expect(ir.value).toBe(nodeRun(testCase.source));
      });
    }
  }

  for (const [name, method] of [
    ["mixed literal kinds", "m() { if (this) { return 1; } return 'x'; }"],
    ["a non-literal return", "m() { return this.constructor.name.length; }"],
    ["a fall-out path", "m() { if (this) { return 1; } }"],
    ["a boolean literal (legacy slot differs)", "m() { return true; }"],
  ] as const) {
    it(`a method with ${name} is still refused and runs correctly`, async () => {
      const source = `
        class C { ${method} }
        export function run() { var v = new C().m(); return typeof v === "number" ? 1 : 2; }
      `;
      const ir = await compileAndRun(source, "standalone", true);
      expect(ir.legacy).toContain("C_m");
      expect(ir.value).toBe(nodeRun(source));
    });
  }
});
