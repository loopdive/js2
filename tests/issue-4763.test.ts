// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4763 — Set constructor adder lookup and invocation must preserve abrupt
// completion and the observable lookup/call order on both compiler lanes.

import { afterEach, describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

type Lane = "host" | "standalone";

const originalSetAdd = Object.getOwnPropertyDescriptor(Set.prototype, "add");

afterEach(() => {
  if (originalSetAdd !== undefined) Object.defineProperty(Set.prototype, "add", originalSetAdd);
});

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4763.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  if (!result.success) throw new Error(result.errors?.[0]?.message ?? "compile failed");

  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

function lanes(): Lane[] {
  return ["host", "standalone"];
}

describe("#4763 Set constructor abrupt completion", () => {
  for (const lane of lanes()) {
    describe(lane, () => {
      it("looks up add once and catches the getter's original error", async () => {
        await expect(
          run(
            `class MyError {}
            export function test(): number {
              const descriptor = Object.getOwnPropertyDescriptor(Set.prototype, "add")!;
              let reads = 0;
              let caught = 0;
              let original = 0;
              Object.defineProperty(Set.prototype, "add", {
                configurable: true,
                get() { reads++; throw new MyError(); },
              });
              try {
                new Set([1]);
              } catch (error) {
                caught = 1;
                original = error instanceof MyError ? 1 : 0;
              } finally {
                Object.defineProperty(Set.prototype, "add", descriptor);
              }
              return reads * 100 + caught * 10 + original;
            }`,
            lane,
          ),
        ).resolves.toBe(111);
      });

      it("calls a custom adder once and catches its original error", async () => {
        await expect(
          run(
            `class MyError {}
            export function test(): number {
              const descriptor = Object.getOwnPropertyDescriptor(Set.prototype, "add")!;
              let calls = 0;
              let caught = 0;
              let original = 0;
              Object.defineProperty(Set.prototype, "add", {
                configurable: true,
                get() {
                  return function(_value: number) { calls++; throw new MyError(); };
                },
              });
              try {
                new Set([1]);
              } catch (error) {
                caught = 1;
                original = error instanceof MyError ? 1 : 0;
              } finally {
                Object.defineProperty(Set.prototype, "add", descriptor);
              }
              return calls * 100 + caught * 10 + original;
            }`,
            lane,
          ),
        ).resolves.toBe(111);
      });

      it("uses a custom adder for every iterable element", async () => {
        await expect(
          run(
            `export function test(): number {
              const descriptor = Object.getOwnPropertyDescriptor(Set.prototype, "add")!;
              const originalAdd: any = Set.prototype.add;
              let calls = 0;
              let reads = 0;
              let receiverChecks = 0;
              let sum = 0;
              Object.defineProperty(Set.prototype, "add", {
                configurable: true,
                get() {
                  reads++;
                  return function(this: any, value: number) {
                    calls++;
                    receiverChecks += this instanceof Set ? 1 : 0;
                    sum += value;
                    return originalAdd.call(this, value);
                  };
                },
              });
              let size = 0;
              try {
                size = new Set([2, 3]).size;
              } finally {
                Object.defineProperty(Set.prototype, "add", descriptor);
              }
              return reads * 10000 + calls * 1000 + receiverChecks * 100 + sum * 10 + size;
            }`,
            lane,
          ),
        ).resolves.toBe(12252);
      });

      it("retains ordinary native Set construction", async () => {
        await expect(
          run(
            `export function test(): number {
              const set = new Set([1, 2, 2]);
              return set.size === 2 && set.has(1) && set.has(2) ? 1 : 0;
            }`,
            lane,
          ),
        ).resolves.toBe(1);
      });
    });
  }
});
