// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1058 — a generic callable whose array parameter is erased to externref must
// convert a caller's array of another element representation into the
// selected closure's vec formal instead of trapping with `illegal cast`.
// Witness: the TypeScript parser's `factoryCreateNodeArray(elements)`.
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1058 erased vec argument through a destructured closure", () => {
  it("passes arrays of different element types to the same closure", async () => {
    const ex = (await compileToWasm(`
      interface Node { kind: number; pos: number }
      interface Ident extends Node { text: string }
      interface Factory {
        createNodeArray<T extends Node>(elements?: readonly T[], hasTrailingComma?: boolean): T[];
      }
      function createFactory(): Factory {
        function createNodeArray<T extends Node>(elements?: readonly T[], hasTrailingComma?: boolean): T[] {
          if (elements === undefined) return [];
          const out: T[] = [];
          for (let i = 0; i < elements.length; i++) out.push(elements[i]!);
          return out;
        }
        return { createNodeArray };
      }
      const factory = createFactory();
      const { createNodeArray: factoryCreateNodeArray } = factory;
      function createList<T extends Node>(elements: T[], hasTrailingComma?: boolean): T[] {
        return factoryCreateNodeArray(elements, hasTrailingComma);
      }
      export function run(): number {
        const ids: Ident[] = [{ kind: 1, pos: 2, text: "a" }, { kind: 3, pos: 4, text: "b" }];
        const nodes: Node[] = [{ kind: 5, pos: 6 }];
        return createList(ids, false).length * 10 + createList(nodes).length;
      }
      export function kindOf(): number {
        const ids: Ident[] = [{ kind: 1, pos: 2, text: "a" }, { kind: 3, pos: 4, text: "b" }];
        return createList(ids, false)[1]!.kind;
      }
    `)) as { run(): number; kindOf(): number };
    expect(ex.run()).toBe(21);
    expect(ex.kindOf()).toBe(3);
  });
});
