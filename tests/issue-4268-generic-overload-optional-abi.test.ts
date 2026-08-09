// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4268 — a resolved short overload may specialize ABI types, but it cannot
// erase the body-bearing implementation's optional runtime parameter slots.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports;
}

describe("#4268 generic overload implementation ABI arity", () => {
  it("runs short and full-arity calls when the short overload appears first", async () => {
    const result = await compile(
      `
export function choose<T>(value: T): T;
export function choose<T>(value: T, enabled: boolean): T;
export function choose<T>(value: T, enabled?: boolean): T {
  if (enabled === true) return value;
  return value;
}

export function runCase(): number {
  const short = choose(20);
  const full = choose(22, true);
  return short + full;
}
`,
      { fileName: "generic-overload-arity.ts", trackIrOutcomes: true },
    );
    const exports = await instantiate(result);

    expect((exports.runCase as () => number)()).toBe(42);
    expect(result.irOutcomes?.map((outcome) => outcome.displayName)).toEqual(["choose", "runCase"]);
  });

  it("keeps an unused optional implementation slot instead of crashing", async () => {
    const result = await compile(
      `
function choose<T>(value: T): T;
function choose<T>(value: T, fallback?: T): T {
  return value;
}

export function runCase(): number { return choose(42); }
`,
      { fileName: "generic-overload-unused-optional.ts" },
    );
    const exports = await instantiate(result);

    expect((exports.runCase as () => number)()).toBe(42);
  });
});
