// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#1058 self-referential shorthand factory capture", () => {
  it("updates a hoisted factory method's capture after the factory initializer completes", async () => {
    const result = await compile(
      `
        interface Node { kind: number }
        interface NodeArray<T extends Node> extends Array<T> {
          pos: number;
          end: number;
        }

        function createFactory() {
          const factory = { createNodeArray, createUnion };
          return factory;

          function createNodeArray<T extends Node>(elements: readonly T[]): NodeArray<T> {
            const array = elements.slice() as NodeArray<T>;
            array.pos = -1;
            array.end = -1;
            return array;
          }

          function createUnion(
            types: readonly Node[],
            parenthesize: (nodes: readonly Node[]) => readonly Node[],
          ): NodeArray<Node> {
            return factory.createNodeArray(parenthesize(types));
          }
        }

        export function run(): number {
          const factory = createFactory();
          const array = factory.createUnion([{ kind: 7 }], (nodes) => nodes);
          return array[0].kind * 100 + array.pos * 10 + array.end;
        }
      `,
      { fileName: "self-referential-shorthand-factory.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    expect((instance.exports.run as Function)()).toBe(689);
  });
});
