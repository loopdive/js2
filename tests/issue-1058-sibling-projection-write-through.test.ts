// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, compileMulti } from "../src/index.js";

describe("#1058 sibling interface projection write-through", () => {
  it("keeps a mutable sibling-interface write on the concrete source object", async () => {
    const result = await compile(
      `
        interface ReadonlyPragmaContext {
          languageVersion: number;
          pragmas?: ReadonlyPragmaMap;
          referencedFiles: readonly number[];
          typeReferenceDirectives: readonly number[];
          libReferenceDirectives: readonly number[];
          amdDependencies: readonly number[];
          hasNoDefaultLib?: boolean;
          moduleName?: string;
        }

        interface PragmaContext extends ReadonlyPragmaContext {
          pragmas?: PragmaMap;
          referencedFiles: number[];
          typeReferenceDirectives: number[];
          libReferenceDirectives: number[];
          amdDependencies: number[];
        }

        interface ReadonlyPragmaMap extends ReadonlyMap<string, number> {}
        interface PragmaMap extends Map<string, number>, ReadonlyPragmaMap {}

        interface NodeDeclaration {
          kind: number;
          pos: number;
          end: number;
        }

        interface LocalsContainer {
          locals?: Map<string, number>;
        }

        interface SourceFile extends NodeDeclaration, LocalsContainer {
          text: string;
          fileName: string;
          nodeCount: number;
          identifierCount: number;
          pragmas: ReadonlyPragmaMap;
        }

        interface SourceFile extends ReadonlyPragmaContext {}

        function createSourceFile(): SourceFile {
          return {
            text: "source",
            fileName: "input.ts",
            kind: 1,
            pos: 0,
            end: 6,
            nodeCount: 3,
            identifierCount: 4,
            languageVersion: 99,
            pragmas: undefined as any,
            referencedFiles: undefined as any,
            typeReferenceDirectives: undefined as any,
            libReferenceDirectives: undefined as any,
            amdDependencies: undefined as any,
            hasNoDefaultLib: false,
          };
        }

        function processCommentPragmas(context: PragmaContext): void {
          context.pragmas = new Map<string, number>() as PragmaMap;
          context.pragmas.set("sentinel", 17);
        }

        function processEmptyCommentPragmas(context: PragmaContext): void {
          context.pragmas = new Map<string, number>() as PragmaMap;
        }

        function processPragmasIntoFields(context: PragmaContext): number {
          context.referencedFiles = [];
          context.typeReferenceDirectives = [];
          context.libReferenceDirectives = [];
          context.amdDependencies = [];
          context.hasNoDefaultLib = false;
          let seen = 0;
          context.pragmas!.forEach((value, key) => {
            if (key === "sentinel") seen = value;
          });
          return seen * 100 + context.pragmas!.size;
        }

        export function repeatedProjection(): number {
          const sourceFile = createSourceFile();
          processCommentPragmas(sourceFile as {} as PragmaContext);
          return processPragmasIntoFields(sourceFile as {} as PragmaContext);
        }

        export function emptyRepeatedProjection(): number {
          const sourceFile = createSourceFile();
          processEmptyCommentPragmas(sourceFile as {} as PragmaContext);
          return processPragmasIntoFields(sourceFile as {} as PragmaContext);
        }

        export function concreteReadAfterProjectionWrite(): number {
          const sourceFile = createSourceFile();
          processCommentPragmas(sourceFile as {} as PragmaContext);
          return sourceFile.pragmas.size;
        }

      `,
      {
        fileName: "issue-1058-sibling-projection-write-through.ts",
        target: "gc",
        platform: "node",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const importNames = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map(
      ({ module, name }) => `${module}.${name}`,
    );
    expect(importNames).toEqual(
      expect.arrayContaining(["env.Map_new", "env.Map_set", "env.Map_forEach", "env.Map_get_size"]),
    );

    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = instance.exports as unknown as {
      repeatedProjection(): number;
      emptyRepeatedProjection(): number;
      concreteReadAfterProjectionWrite(): number;
    };

    // This is the TypeScript parser shape: separate sibling casts must still
    // alias the same merged SourceFile storage rather than independent structs.
    expect(exports.repeatedProjection()).toBe(1701);
    expect(exports.emptyRepeatedProjection()).toBe(0);
    expect(exports.concreteReadAfterProjectionWrite()).toBe(1);
  });

  it("keeps an open identity-preserving ABI when another module has an ordinary caller", async () => {
    const result = await compileMulti(
      {
        "./mutate.ts": `
          export interface Destination { value: number }
          export function mutate(context: Destination): number {
            context.value += 1;
            return context.value;
          }
        `,
        "./asserted.ts": `
          import { mutate, type Destination } from "./mutate.js";
          interface Source { value: number; extra: number }
          export function asserted(): number {
            const source: Source = { value: 3, extra: 7 };
            mutate(source as {} as Destination);
            return source.value * 10 + source.extra;
          }
        `,
        "./ordinary.ts": `
          import { mutate, type Destination } from "./mutate.js";
          export function ordinary(): number {
            const destination: Destination = { value: 40 };
            return mutate(destination);
          }
        `,
        "./entry.ts": `
          import { asserted } from "./asserted.js";
          import { ordinary } from "./ordinary.js";
          export function test(): number {
            return asserted() * 100 + ordinary();
          }
        `,
      },
      "./entry.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    // Both carriers keep identity: the asserted Source observes its write and
    // the ordinary Destination remains valid through the same open ABI.
    expect((instance.exports.test as () => number)()).toBe(4741);
  });

  it("keeps own expando writes on a Map-refining host interface", async () => {
    const result = await compile(
      `
        interface RefinedMap extends Map<number, number> { stamp: number }

        export function test(): number {
          const map = new Map<number, number>() as RefinedMap;
          map.set(1, 4);
          map.stamp = 7;
          map.stamp += 2;
          map.stamp ||= 20;
          return map.stamp * 100 + map.size;
        }
      `,
      {
        fileName: "issue-1058-refined-map-expando.ts",
        target: "gc",
        platform: "node",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.test as () => number)()).toBe(901);
  });

  it("does not classify a user class named Map as the ambient host Map", async () => {
    const result = await compile(
      `
        class Map<K, V> {
          value = 7;
          bump(): number {
            this.value += 1;
            return this.value;
          }
        }

        export function test(): number {
          const map = new Map<number, number>();
          return map.bump() * 10 + map.value;
        }
      `,
      {
        fileName: "issue-1058-user-map-shadow.ts",
        target: "gc",
        platform: "node",
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).some(
        ({ name }) => name.startsWith("Map_"),
      ),
    ).toBe(false);
  });

  it("does not classify a user interface named Map as the ambient host Map", async () => {
    const result = await compile(
      `
        interface Map {
          set(value: number): number;
        }

        const map: Map = {
          set(value: number): number {
            return value + 1;
          },
        };

        export function test(): number {
          return map.set(4);
        }
      `,
      {
        fileName: "issue-1058-user-map-interface-shadow.ts",
        target: "gc",
        platform: "node",
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    expect((instance.exports.test as () => number)()).toBe(5);
  });

});
