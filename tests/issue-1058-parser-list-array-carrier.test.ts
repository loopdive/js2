// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1058 parser list array carrier", () => {
  it.each(["gc", "standalone"] as const)(
    "retains sibling node lists through the generic factory in %s",
    async (target) => {
      const result = await compile(
        `
      interface Node { kind: number; }
      interface Statement extends Node { statement: number; }
      interface Parameter extends Node { parameter: number; }
      interface NodeArray<T extends Node> extends ReadonlyArray<T> { pos: number; end: number; }
      interface ReadonlyTextRange { readonly pos: number; readonly end: number; }
      interface TextRange { pos: number; end: number; }
      function setTextRangePos<T extends ReadonlyTextRange>(range: T, pos: number): T {
        (range as TextRange).pos = pos;
        return range;
      }
      function setTextRangeEnd<T extends ReadonlyTextRange>(range: T, end: number): T {
        (range as TextRange).end = end;
        return range;
      }
      function setTextRangePosEnd<T extends ReadonlyTextRange>(range: T, pos: number, end: number): T {
        return setTextRangeEnd(setTextRangePos(range, pos), end);
      }
      interface Factory { createNodeArray<T extends Node>(elements?: readonly T[], trailing?: boolean): NodeArray<T>; }
      function hasProperty(object: object, key: string): boolean {
        return Object.prototype.hasOwnProperty.call(object, key);
      }
      function isNodeArray<T extends Node>(array: readonly T[]): array is NodeArray<T> {
        return hasProperty(array, "pos") && hasProperty(array, "end");
      }
      function makeFactory(): Factory {
        return { createNodeArray };
        function createNodeArray<T extends Node>(elements?: readonly T[], trailing?: boolean): NodeArray<T> {
          if (elements === undefined) elements = [];
          else if (isNodeArray(elements)) return elements;
          const length = elements.length;
          const array = (length >= 1 && length <= 4 ? elements.slice() : elements) as NodeArray<T>;
          array.pos = -1;
          array.end = -1;
          return array;
        }
      }
      const { createNodeArray: factoryCreateNodeArray } = makeFactory();
      function createNodeArray<T extends Node>(elements: T[], pos: number, end?: number, trailing?: boolean): NodeArray<T> {
        const array = factoryCreateNodeArray(elements, trailing);
        setTextRangePosEnd(array, pos, end ?? 99);
        return array;
      }
      function parseList<T extends Node>(parseElement: () => T): NodeArray<T> {
        const list = [];
        for (let i = 0; i < 2; i++) list.push(parseElement());
        return createNodeArray(list, 7);
      }
      function parseParameter(): Parameter { return { kind: 1, parameter: 3 }; }
      function parseStatement(): Statement { return { kind: 2, statement: 5 }; }
      export function probe(): number {
        const parameters = parseList(parseParameter);
        const statements = parseList(parseStatement);
        return parameters[0].parameter + statements[1].statement + parameters.pos + statements.end;
      }
      export function probeOrder(): number {
        let list = [];
        list.push(parseStatement());
        const array = factoryCreateNodeArray(list, (list = [], false));
        return array[0].kind * 100 + array.length * 10 + list.length;
      }
    `,
        { target, skipSemanticDiagnostics: true, experimentalIR: false },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
      const imports = result.importObject ?? {};
      const instance = await WebAssembly.instantiate(module, imports);
      (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
      expect((instance.exports.probe as () => number)()).toBe(114);
      expect((instance.exports.probeOrder as () => number)()).toBe(210);
    },
  );
});
