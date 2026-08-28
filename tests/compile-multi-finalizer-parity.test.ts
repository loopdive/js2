// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compileMulti, type CompileOptions, type CompileResult } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function compileGraph(
  files: Record<string, string>,
  entryFile = "./entry.ts",
  options: CompileOptions = { target: "standalone", skipSemanticDiagnostics: true },
): Promise<{ result: CompileResult; module: WebAssembly.Module }> {
  const result = await compileMulti(files, entryFile, options);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  return { result, module };
}

async function runHostFreeGraph(
  files: Record<string, string>,
  options: CompileOptions = { target: "standalone", skipSemanticDiagnostics: true },
): Promise<number> {
  const { result, module } = await compileGraph(files, "./entry.ts", options);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports.test as () => number)();
}

describe("compileMulti deferred-finalizer parity", () => {
  it("fills dynamic bind after the graph-wide closure table and apply bridge", async () => {
    expect(
      await runHostFreeGraph({
        "./target.ts": `
          export function digits(a: number, b: number, c: number): number {
            return a * 100 + b * 10 + c;
          }
        `,
        "./entry.ts": `
          import { digits } from "./target.ts";

          export function test(): number {
            const target: any = digits;
            const bound: any = target.bind(undefined, 1, 2);
            return bound(3);
          }
        `,
      }),
    ).toBe(123);
  });

  it("fills thenable classifiers after every source has registered its shapes", async () => {
    expect(
      await runHostFreeGraph(
        {
          "./thenable.ts": `
            export function makeThenable(): any {
              return { then: function (resolve: any): void { resolve(42); } };
            }
          `,
          "./entry.ts": `
            import { makeThenable } from "./thenable.ts";
            declare function __drain_microtasks(): void;

            export function test(): number {
              let value = 0;
              Promise.resolve(makeThenable()).then(
                function (result: any): void { value = result === 42 ? 1 : 2; },
                function (): void { value = 3; },
              );
              __drain_microtasks();
              return value;
            }
          `,
        },
        { target: "wasi", skipSemanticDiagnostics: true },
      ),
    ).toBe(1);
  });

  it("fills GetSetRecord readers over a closed set-like shape from another source", async () => {
    expect(
      await runHostFreeGraph({
        "./set-like.ts": `
          export function makeSetLike(): any {
            return {
              size: 2,
              has: function (_value: any): boolean { return false; },
              keys: function (): any { return [2, 3].values(); },
            };
          }
        `,
        "./entry.ts": `
          import { makeSetLike } from "./set-like.ts";

          export function test(): number {
            const combined = new Set([1, 2]).union(makeSetLike());
            return combined.size + (combined.has(3) ? 10 : 0);
          }
        `,
      }),
    ).toBe(13);
  });

  it("fills the Array prototype iterator driver after receiver-aware closure exports", async () => {
    const { result, module } = await compileGraph(
      {
        "./override.js": `
          Array.prototype[Symbol.iterator] = function* () {
            yield this[0];
            yield 42;
          };
          export const installed = 1;
        `,
        "./entry.js": `
          import { installed } from "./override.js";
          export function test() {
            const values = [5, 6];
            const [first, second] = values;
            return installed * 100 + first * 10 + second;
          }
        `,
      },
      "./entry.js",
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    const imports = buildRuntimeImports(result.imports, undefined, result.stringPool);
    const instance = await WebAssembly.instantiate(module, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports.test as () => number)()).toBe(192);
  });

  it("fills the DisposableStack LIFO driver after public and receiver-aware calls", async () => {
    expect(
      await runHostFreeGraph({
        "./marker.ts": `export const marker = 1;`,
        "./entry.ts": `
          import { marker } from "./marker.ts";

          export function test(): number {
            let order = 0;
            const stack = new DisposableStack();
            stack.defer(function (): void { order = order * 10 + 1; });
            stack.defer(function (): void { order = order * 10 + 2; });
            stack.dispose();
            return marker * 100 + order;
          }
        `,
      }),
    ).toBe(121);
  });

  it("fills function metadata, TypedArray constructor metadata, dynamic class protos, and Error bridges", async () => {
    const { module } = await compileGraph(
      {
        "./reflect.ts": `
          export function read(target: any, key: any): any { return target[key]; }
        `,
        "./entry.ts": `
          import { read } from "./reflect.ts";

          class Box { value: number = 1; }
          function pair(left: any, right: any): void {}

          export function test(): number {
            const box = new Box();
            Object.setPrototypeOf(box, { inherited: 7 });
            if (read(box, "inherited") !== 7) return -1;
            if (read(pair, "length") !== 2) return -2;
            if (read(Array.isArray, "name") !== "isArray") return -3;
            if (read(Uint8Array, "name") !== "Uint8Array") return -4;
            const error = new TypeError("boom");
            return read(error, "message") === "boom" ? 1 : -5;
          }
        `,
      },
      "./entry.ts",
      {
        target: "standalone",
        hostBridge: "always",
        skipSemanticDiagnostics: true,
      },
    );
    const exportNames = WebAssembly.Module.exports(module).map((item) => item.name);
    expect(exportNames).toEqual(
      expect.arrayContaining(["__error_boundary_is_native", "__error_boundary_message", "__error_boundary_name"]),
    );
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });
});
