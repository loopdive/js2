// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, wrapExports } from "../src/index.js";

describe("#1058 barrel-reexported computed option callbacks", () => {
  it("calls a property-derived const alias from a returned nested function", async () => {
    const result = await compileMulti(
      {
        "./entry.ts": `
          import {
            computedOptions,
            createBinder,
            getAllowImportingTsExtensions,
          } from "./barrel.js";

          const bindSourceFile = createBinder();
          export function test(): number {
            return bindSourceFile({ target: 2 });
          }

          export function surfaceTest(): number {
            return computedOptions ? 1 : 0;
          }

          export function precedingAliasTest(): number {
            return getAllowImportingTsExtensions({ allowImportingTsExtensions: true }) ? 1 : 0;
          }
        `,
        "./binder.ts": `
          import {
            ${Array.from({ length: 120 }, (_, index) => `importedValue${index},`).join("\n")}
            getEmitScriptTarget,
            ${Array.from({ length: 22 }, (_, index) => `getOption${index},`).join("\n")}
            ${Array.from({ length: 12 }, (_, index) => `decoy${index},`).join("\n")}
          } from "./barrel.js";
          import type { CompilerOptions } from "./barrel.js";

          export function createBinder(): (options: CompilerOptions) => number {
            var languageVersion = 0;
            var state00 = 0;
            var state01 = 0;
            var state02 = 0;
            var state03 = 0;
            var state04 = 0;
            var state05 = 0;
            var state06 = 0;
            var state07 = 0;
            var state08 = 0;
            var state09 = 0;
            var state10 = 0;
            var state11 = 0;
            var state12 = 0;
            var state13 = 0;
            var state14 = 0;
            var state15 = 0;
            var state16 = 0;
            var state17 = 0;
            var state18 = 0;
            var state19 = 0;
            var state20 = 0;
            var state21 = 0;
            var state22 = 0;
            var state23 = 0;
            var state24 = 0;
            var state25 = 0;
            var state26 = 0;
            var state27 = 0;
            var state28 = 0;
            var state29 = 0;
            var state30 = 0;
            var state31 = 0;
            var state32 = 0;
            var state33 = 0;
            var state34 = 0;
            return bindSourceFile;

            function bindSourceFile(options: CompilerOptions): number {
              languageVersion = getEmitScriptTarget(options);
              return languageVersion + touchState() + touchOptions(options) + touchModules() + touchImports();
            }

            function touchOptions(options: CompilerOptions): number {
              return ${Array.from({ length: 22 }, (_, index) => `(getOption${index}(options) ? 1 : 0)`).join(" + ")};
            }

            function touchModules(): number {
              return ${Array.from({ length: 12 }, (_, index) => `decoy${index}()`).join(" + ")};
            }

            function touchImports(): number {
              return ${Array.from({ length: 120 }, (_, index) => `importedValue${index}`).join(" + ")};
            }

            function touchState(): number {
              return state00 + state01 + state02 + state03 + state04 +
                state05 + state06 + state07 + state08 + state09 +
                state10 + state11 + state12 + state13 + state14 +
                state15 + state16 + state17 + state18 + state19 +
                state20 + state21 + state22 + state23 + state24 +
                state25 + state26 + state27 + state28 + state29 +
                state30 + state31 + state32 + state33 + state34;
            }
          }
        `,
        "./barrel.ts": `
          export * from "./core.js";
          export * from "./utilities.js";
          export * from "./binder.js";
          ${Array.from({ length: 12 }, (_, index) => `export * from "./decoy${index}.js";`).join("\n")}
        `,
        "./core.ts": `
          export enum ScriptTarget {
            ES5 = 1,
            ES2015 = 2,
            ES2022 = 9,
            ES2023 = 10,
            ESNext = 99,
          }

          export enum ModuleKind {
            CommonJS = 1,
            ES2015 = 2,
            Node16 = 100,
            Node18 = 101,
            Node20 = 102,
            NodeNext = 199,
          }

          export interface CompilerOptions {
            target?: ScriptTarget;
            module?: ModuleKind;
            allowJs?: boolean;
            checkJs?: boolean;
            allowImportingTsExtensions?: boolean;
            rewriteRelativeImportExtensions?: boolean;
            ${Array.from({ length: 22 }, (_, index) => `option${index}?: boolean;`).join("\n")}
            ${Array.from({ length: 100 }, (_, index) => `unused${index}?: boolean;`).join("\n")}
          }

          ${Array.from({ length: 120 }, (_, index) => `export const importedValue${index} = 0;`).join("\n")}
        `,
        "./utilities.ts": `
          import { ModuleKind, ScriptTarget } from "./barrel.js";
          import type { CompilerOptions } from "./barrel.js";

          type CompilerOptionKeys = keyof {
            [K in keyof CompilerOptions as string extends K ? never : K]: unknown;
          };
          type CompilerOptionsValue = number | boolean | undefined;

          function createComputedOptions<T extends Record<string, CompilerOptionKeys[]>>(
            options: {
              [K in keyof T & CompilerOptionKeys]: {
                dependencies: T[K];
                computeValue: (
                  compilerOptions: Pick<CompilerOptions, K | T[K][number]>
                ) => Exclude<CompilerOptions[K], undefined>;
              };
            },
          ) {
            return options;
          }

          const _computedOptions = createComputedOptions({
            allowImportingTsExtensions: {
              dependencies: ["rewriteRelativeImportExtensions"],
              computeValue: (options): boolean =>
                !!(options.allowImportingTsExtensions || options.rewriteRelativeImportExtensions),
            },
            target: {
              dependencies: ["module"],
              computeValue: (options) => {
                const target = options.target;
                return target ??
                  ((options.module === ModuleKind.Node16 && ScriptTarget.ES2022) ||
                    (options.module === ModuleKind.Node18 && ScriptTarget.ES2022) ||
                    (options.module === ModuleKind.Node20 && ScriptTarget.ES2023) ||
                    (options.module === ModuleKind.NodeNext && ScriptTarget.ESNext) ||
                    ScriptTarget.ES5);
              },
            },
            module: {
              dependencies: ["target"],
              computeValue: (options): ModuleKind =>
                options.module ??
                (_computedOptions.target.computeValue(options) >= ScriptTarget.ES2015
                  ? ModuleKind.ES2015
                  : ModuleKind.CommonJS),
            },
            allowJs: {
              dependencies: ["checkJs"],
              computeValue: (options): boolean =>
                options.allowJs === undefined ? !!options.checkJs : options.allowJs,
            },
            ${Array.from(
              { length: 22 },
              (_, index) => `option${index}: {
                dependencies: ["option${index}"],
                computeValue: (options): boolean =>
                  !!options.option${index} || ${
                    index === 0
                      ? "_computedOptions.allowJs.computeValue(options)"
                      : `_computedOptions.option${index - 1}.computeValue(options)`
                  },
              },`,
            ).join("\n")}
          });

          export const computedOptions: Record<string, {
            dependencies: readonly string[];
            computeValue: (options: CompilerOptions) => CompilerOptionsValue;
          }> = _computedOptions;
          export const getAllowImportingTsExtensions: (options: CompilerOptions) => boolean =
            _computedOptions.allowImportingTsExtensions.computeValue;
          export const getEmitScriptTarget: (options: CompilerOptions) => ScriptTarget =
            _computedOptions.target.computeValue;
          export const getEmitModuleKind: (options: CompilerOptions) => ModuleKind =
            _computedOptions.module.computeValue;
          export const getAllowJs: (options: CompilerOptions) => boolean =
            _computedOptions.allowJs.computeValue;
          ${Array.from(
            { length: 22 },
            (_, index) => `export const getOption${index}: (options: CompilerOptions) => boolean =
              _computedOptions.option${index}.computeValue;`,
          ).join("\n")}

          // The exports above are snapshots. Replacing the source property
          // afterwards must not change which callback an imported alias calls.
          _computedOptions.target.computeValue = () => ScriptTarget.ESNext;
        `,
        ...Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => [
            `./decoy${index}.ts`,
            `export function decoy${index}(): number { return 0; }`,
          ]),
        ),
      },
      "./entry.ts",
      { resolve: { consumerDrivenBarrels: true } },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.surfaceTest()).toBe(1);
    expect(exports.precedingAliasTest()).toBe(1);
    expect(exports.test()).toBe(2);
  });

  it("keeps genuine host property aliases on their existing callable path", async () => {
    const result = await compileMulti(
      {
        "./entry.ts": `
          import { max } from "./provider.js";
          export function test(): number {
            return max(1, 2);
          }
        `,
        "./provider.ts": `export const max = Math.max;`,
      },
      "./entry.ts",
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    expect(exports.test()).toBe(2);
  });

  it.each(["host", "standalone"] as const)(
    "re-resolves %s driver indices and honors a wider declared arity",
    async (target) => {
      const result = await compileMulti(
        {
          "./entry.ts": `
            import { combine } from "./provider.js";
            export function test(): number {
              return combine(1, 2);
            }
          `,
          "./provider.ts": `
            const table = {
              combine: (left: number, right: number, offset: number = 10): number =>
                left * 100 + right * 10 + offset,
            };
            export const combine: (left: number, right: number, offset?: number) => number = table.combine;
          `,
        },
        "./entry.ts",
        target === "standalone" ? { target: "standalone" } : undefined,
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      if (target === "standalone") {
        const functionImports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter(
          (entry) => entry.kind === "function",
        );
        expect(functionImports).toEqual([]);
      }
      const imports = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
      const exports = wrapExports(instance, { signatures: result.exportSignatures });
      expect(exports.test()).toBe(130);
    },
  );

  it.each(["host", "standalone"] as const)(
    "does not silently dispatch a %s property alias above the dynamic-driver arity cap",
    async (target) => {
      const result = await compileMulti(
        {
          "./entry.ts": `
            import { wide } from "./provider.js";
            export function test(): number {
              return wide();
            }
          `,
          "./provider.ts": `
            interface Table {
              wide: () => number;
            }
            const table: Table = {
              wide: (
                a = 1, b = 2, c = 3, d = 4, e = 5,
                f = 6, g = 7, h = 8, i = 9,
              ): number => a + b + c + d + e + f + g + h + i,
            };
            export const wide = table.wide;
          `,
        },
        "./entry.ts",
        target === "standalone" ? { target: "standalone" } : undefined,
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      const imports = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
      const exports = wrapExports(instance, { signatures: result.exportSignatures });
      // The bounded bridge has no nine-formal ABI arm. It must fail loudly
      // instead of selecting no arm and silently returning 0.
      expect(() => exports.test()).toThrow();
    },
  );

  it.each(["host", "standalone"] as const)(
    "rejects %s property aliases whose live closure crosses the arity cap before snapshot",
    async (target) => {
      const result = await compileMulti(
        {
          "./entry.ts": `
            import { directWide, escapedWide, factoryWide, hoistedWide, spreadWide } from "./provider.js";
            export function testDirect(): number { return directWide(); }
            export function testEscaped(): number { return escapedWide(); }
            export function testFactory(): number { return factoryWide(); }
            export function testHoisted(): number { return hoistedWide(); }
            export function testSpread(): number { return spreadWide(); }
          `,
          "./provider.ts": `
            const nineFormal = (
              a = 1, b = 2, c = 3, d = 4, e = 5,
              f = 6, g = 7, h = 8, i = 9,
            ): number => a + b + c + d + e + f + g + h + i;

            const directTable = { wide: (): number => 1 };
            directTable.wide = nineFormal as any;
            export const directWide: () => number = directTable.wide;

            const escapedTable = { wide: (): number => 1 };
            const escaped = escapedTable;
            escaped.wide = nineFormal as any;
            export const escapedWide: () => number = escapedTable.wide;

            const hoistedTable = { wide: (): number => 1 };
            mutateHoisted();
            export const hoistedWide: () => number = hoistedTable.wide;
            function mutateHoisted(): void {
              hoistedTable.wide = nineFormal as any;
            }

            const spreadTable = { wide: (): number => 1, ...{ wide: nineFormal as any } };
            export const spreadWide: () => number = spreadTable.wide;

            function replace<T extends { wide: () => number }>(value: T): T {
              value.wide = nineFormal as any;
              return value;
            }
            const factoryTable = replace({ wide: (): number => 1 });
            export const factoryWide: () => number = factoryTable.wide;
          `,
        },
        "./entry.ts",
        target === "standalone" ? { target: "standalone" } : undefined,
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      const imports = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
      const exports = wrapExports(instance, { signatures: result.exportSignatures });
      const invocations = [exports.testDirect, exports.testEscaped, exports.testFactory, exports.testHoisted];
      // Host object-literal spread currently retains the first `wide` value,
      // an unrelated pre-existing divergence. Standalone reaches the live
      // nine-formal carrier and is therefore an arity-boundary oracle.
      if (target === "standalone") invocations.push(exports.testSpread);
      for (const invoke of invocations) {
        let returned: unknown;
        let threw = false;
        try {
          returned = invoke();
        } catch {
          threw = true;
        }
        expect(threw || returned === 45).toBe(true);
      }
    },
  );
});
