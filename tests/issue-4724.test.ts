// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4724 — Reflect.set validates its target before the standalone native write.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4724.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), `${lane} module failed validation`).toBe(true);

  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const imports = result.importObject!;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

const SYMBOL_TARGET = `
  export function test(): number {
    try {
      Reflect.set(Symbol(1), "p", 42);
      return 0;
    } catch (error) {
      return 1;
    }
  }
`;

const PRIMITIVE_TARGETS = `
  export function test(): number {
    try {
      Reflect.set(1, "p", 42);
      return 0;
    } catch (error) {
      return 1;
    }
  }
`;

const PRIMITIVE_KEY_AND_VALUE = `
  export function test(): number {
    const target: any = {};
    const key = "p";
    const value = 42;
    const ok = Reflect.set(target, key, value);
    return ok && target.p === value ? 1 : 0;
  }
`;

describe("#4724 — Reflect.set target validation", () => {
  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: Symbol target throws a catchable TypeError`, async () => {
      await expect(run(SYMBOL_TARGET, lane)).resolves.toBe(1);
    });

    it(`${lane}: ordinary primitive targets throw`, async () => {
      await expect(run(PRIMITIVE_TARGETS, lane)).resolves.toBe(1);
    });

    it(`${lane}: primitive key and value remain valid on an object target`, async () => {
      await expect(run(PRIMITIVE_KEY_AND_VALUE, lane)).resolves.toBe(1);
    });
  }
});
