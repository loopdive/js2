// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * #1609 — a `new` expression must collect a non-literal spread through the
 * iterator protocol before entering an anonymous constructor. The constructor
 * has no formal parameters in the ES2015 cohort, so its dynamic `arguments`
 * object is the observable call boundary.
 */

import { describe, expect, it } from "vitest";

import { buildImports, compile, instantiateWasm } from "../src/index.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-1609.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

const lanes: Lane[] = ["host", "standalone"];

describe("#1609 — dynamic spread arguments in new expressions", () => {
  for (const lane of lanes) {
    describe(lane, () => {
      it("collects one custom iterable and exposes length, indexes, and constructor this", async () => {
        const source = `
          export function test(): number {
            var iter = {};
            iter[Symbol.iterator] = function() {
              var nextCount = 0;
              return {
                next: function() {
                  nextCount += 1;
                  return { done: nextCount === 3, value: nextCount };
                }
              };
            };
            var seenThis;
            var ok = 0;
            var result = new function() {
              seenThis = this;
              ok = arguments.length === 2 && arguments[0] === 1 && arguments[1] === 2 ? 1 : 0;
            }(...iter);
            return ok + (seenThis === result ? 1 : 0);
          }
        `;
        await expect(run(source, lane)).resolves.toBe(2);
      });

      it("preserves fixed-argument order around multiple spreads", async () => {
        const source = `
          export function test(): number {
            var left = {};
            var leftCount = 0;
            left[Symbol.iterator] = function() {
              return { next: function() {
                leftCount += 1;
                return { done: leftCount === 2, value: leftCount + 1 };
              } };
            };
            var right = {};
            var rightCount = 2;
            right[Symbol.iterator] = function() {
              return { next: function() {
                rightCount += 1;
                return { done: rightCount === 6, value: rightCount };
              } };
            };
            var ok = 0;
            new function() {
              ok = arguments.length === 5 && arguments[0] === 1 && arguments[1] === 2 &&
                arguments[2] === 3 && arguments[3] === 4 && arguments[4] === 5 ? 1 : 0;
            }(1, ...left, ...right);
            return ok;
          }
        `;
        await expect(run(source, lane)).resolves.toBe(1);
      });

      it("propagates an abrupt iterator step", async () => {
        const source = `
          export function test(): number {
            var iter = {};
            iter[Symbol.iterator] = function() {
              return { next: function() { throw new Error("iterator boom"); } };
            };
            try {
              new function() {}(...iter);
            } catch (error) {
              return 1;
            }
            return 0;
          }
        `;
        await expect(run(source, lane)).resolves.toBe(1);
      });

      it("keeps the adjacent literal-spread fast path working", async () => {
        const source = `
          export function test(): number {
            var ok = 0;
            new function() {
              ok = arguments.length === 3 && arguments[0] === 3 && arguments[1] === 4 && arguments[2] === 5 ? 1 : 0;
            }(...[3, 4, 5]);
            return ok;
          }
        `;
        await expect(run(source, lane)).resolves.toBe(1);
      });
    });
  }
});
