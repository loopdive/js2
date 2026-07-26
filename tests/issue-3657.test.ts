// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3657 — class-member IR calls to same-file ambient host functions.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
declare function predicate(value: string): boolean;

class Gate {
  check(value: string): number {
    if (predicate(value)) return 17;
    return -4;
  }
}

export function check(value: string): number {
  return new Gate().check(value);
}
`;

async function compileGate() {
  const result = await compile(SOURCE, {
    fileName: "ambient-class-call.ts",
    target: "gc",
    platform: "node",
    experimentalIR: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  expect(result.irCompiledFuncs ?? []).toContain("Gate_check");
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect(result.imports.some((entry) => entry.module === "env" && entry.name === "predicate")).toBe(true);
  return result;
}

async function instantiateGate(deps: Record<string, unknown>) {
  const result = await compileGate();
  const imports = buildImports(result.imports, deps, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports.check as (value: string) => number;
}

describe("#3657 — ambient primitive host calls from IR class members", () => {
  it("branches on both true and false host predicate results", async () => {
    const check = await instantiateGate({
      predicate: (value: unknown) => value === "yes",
    });
    expect(check("yes")).toBe(17);
    expect(check("no")).toBe(-4);
  });

  it("retains #3325's missing-dependency no-op behavior", async () => {
    const check = await instantiateGate({});
    expect(check("anything")).toBe(-4);
  });
});
