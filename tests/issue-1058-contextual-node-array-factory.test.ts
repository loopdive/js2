// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function instantiate(result: Awaited<ReturnType<typeof compile>>) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return instance.exports as Record<string, Function>;
}

describe("#1058 contextual node-array factory", () => {
  it("keeps a nested generic callable compatible with its contextual NodeFactory field", async () => {
    const result = await compile(
      `
        interface Node { kind: number }
        interface NodeArray<T extends Node> extends ReadonlyArray<T> {
          hasTrailingComma: boolean;
        }
        interface NodeFactory {
          createNodeArray<T extends Node>(
            elements: readonly T[],
            hasTrailingComma?: boolean,
          ): NodeArray<T>;
        }

        function createNodeFactory(): NodeFactory {
          const factory: NodeFactory = { createNodeArray };
          return factory;

          function createNodeArray<T extends Node>(
            elements: readonly T[],
            hasTrailingComma?: boolean,
          ): NodeArray<T> {
            const array = elements.slice() as NodeArray<T>;
            array.hasTrailingComma = hasTrailingComma === undefined ? true : hasTrailingComma;
            return array;
          }
        }

        namespace Parser {
          var factory = createNodeFactory();
          var { createNodeArray: factoryCreateNodeArray } = factory;

          export function parseLists(): number {
            const omitted = factoryCreateNodeArray([{ kind: 7 }]);
            const explicitFalse = factoryCreateNodeArray([{ kind: 3 }], false);
            return omitted[0].kind * 100
              + (omitted.hasTrailingComma ? 10 : 0)
              + explicitFalse[0].kind
              + (explicitFalse.hasTrailingComma ? 1 : 0);
          }
        }

        export function test(): number { return Parser.parseLists(); }
      `,
      {
        fileName: "issue-1058-contextual-node-array-factory.ts",
        skipSemanticDiagnostics: true,
      },
    );

    const exports = await instantiate(result);
    expect(exports.test()).toBe(713);
  });
});
