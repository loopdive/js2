// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7126 — an unannotated class method whose body never returns a value is
// VOID, exactly like the unannotated function declaration (#7106). Methods
// carry no lattice entry, so before this the selector refused every such JS
// method as `return-type-not-resolvable` and the method stayed legacy.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "standalone" | "gc";

async function compileAndRun(
  source: string,
  target: Target,
  experimentalIR: boolean,
): Promise<{ value: unknown; irBodies: string[]; legacy: string[] }> {
  const result = await compile(source, {
    experimentalIR,
    skipSemanticDiagnostics: true,
    allowJs: true,
    target,
    trackIrOutcomes: true,
    fileName: "issue-7126.js",
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
  };
}

function nodeRun(source: string): unknown {
  const body = source.replace(/export function run/, "function run");
  return new Function(`${body}\nreturn run();`)();
}

const CASES: { name: string; source: string; method: string }[] = [
  {
    name: "empty instance method",
    method: "C_m",
    source: `
      class C { m() { } }
      export function run() { new C().m(); return 7; }
    `,
  },
  {
    name: "instance method calling a local function",
    method: "C_m",
    source: `
      function tick() { }
      class C { m() { tick(); } }
      export function run() { var c = new C(); c.m(); c.m(); return 3; }
    `,
  },
  {
    name: "static method with a bare return",
    method: "C_s",
    source: `
      class C { static s() { return; } }
      export function run() { C.s(); return 5; }
    `,
  },
];

describe("#7126 — value-less unannotated methods resolve void", () => {
  for (const target of ["standalone", "gc"] as const) {
    for (const testCase of CASES) {
      it(`${testCase.name} (${target}) ships an IR body and matches legacy and node`, async () => {
        const ir = await compileAndRun(testCase.source, target, true);
        const legacy = await compileAndRun(testCase.source, target, false);
        expect(ir.irBodies, JSON.stringify(ir)).toContain(testCase.method);
        expect(ir.value).toBe(legacy.value);
        expect(ir.value).toBe(nodeRun(testCase.source));
      });
    }
  }

  it("a value-returning unannotated method is still refused (no lattice fact)", async () => {
    const source = `
      class C { m() { return 1; } }
      export function run() { return new C().m(); }
    `;
    const ir = await compileAndRun(source, "standalone", true);
    expect(ir.legacy).toContain("C_m");
    expect(ir.value).toBe(nodeRun(source));
  });
});
