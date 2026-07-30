// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
function helper(): number {
  return 5;
}

const shared = 5;

function consumeDescriptor(value: any): number {
  return value.answer;
}

export function direct(): number {
  return eval(
    "if (true) { function directLocal() { return 1; } } helper();"
  ) as number;
}

export function indirect(): number {
  return (0, eval)(
    "if (true) { function indirectLocal() { return 1; } } helper();"
  ) as number;
}

export function lifecycle(): number {
  return eval(
    "if (true) function lifecycleLocal() { return helper(); } lifecycleLocal();"
  ) as number;
}

export function descriptor(): number {
  return eval(
    "if (true) { function descriptorLocal() {} } consumeDescriptor({ answer: helper() });"
  ) as number;
}

export function directScope(): number {
  const shared = 7;
  return eval("if (true) { function directScopeLocal() {} } shared;") as number;
}

export function indirectScope(): number {
  const shared = 7;
  return (0, eval)("if (true) { function indirectScopeLocal() {} } shared;") as number;
}
`;

async function compileAndRun(options: CompileOptions): Promise<Record<string, () => number>> {
  const result = await compile(SOURCE, options);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports.some((entry) => entry.name === "__extern_eval")).toBe(false);

  const imports = options.target === "standalone" ? {} : buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, () => number>;
}

describe("#3633 — constant eval shares compiled global bindings with Annex B bodies", () => {
  for (const [lane, options] of [
    ["host", {}],
    ["standalone", { target: "standalone" as const }],
  ] as const) {
    it(`${lane}: direct and indirect eval resolve the compiled global helper`, async () => {
      const exports = await compileAndRun(options);
      expect(exports.direct!()).toBe(5);
      expect(exports.indirect!()).toBe(5);
      expect(exports.directScope!()).toBe(7);
      expect(exports.indirectScope!()).toBe(5);
    });

    it(`${lane}: B.3.3 lifecycle and foreign descriptor objects stay in the compiled module`, async () => {
      const exports = await compileAndRun(options);
      expect(exports.lifecycle!()).toBe(5);
      expect(exports.descriptor!()).toBe(5);
    });
  }
});
