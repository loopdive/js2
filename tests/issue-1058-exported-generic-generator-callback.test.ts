// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

async function compileAndRun(source: string) {
  const result = await compile(source, {
    target: "gc",
    platform: "node",
    nativeStrings: false,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

describe("#1058 exported generic generator callbacks", () => {
  it("maps entries into a host Map during module initialization", async () => {
    const exports = await compileAndRun(`
      export function* mapIterator<T, U>(
        iter: Iterable<T>,
        mapFn: (x: T) => U,
      ): Generator<U, void, unknown> {
        for (const x of iter) {
          yield mapFn(x);
        }
      }

      const options = { preserve: 1, react: 2 };
      const first = new Map(Object.entries(options));
      const second = new Map(
        mapIterator(
          first.entries(),
          ([key, value]: [string, number]) => [String(value), key] as const,
        ),
      );

      export function size(): number { return second.size; }
      export function preserve(): string { return second.get("1") ?? ""; }
      export function react(): string { return second.get("2") ?? ""; }
    `);

    expect(exports.size()).toBe(2);
    expect(exports.preserve()).toBe("preserve");
    expect(exports.react()).toBe("react");
  });
});
