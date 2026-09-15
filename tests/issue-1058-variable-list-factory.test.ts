// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1058 variable declaration list factory ABI", () => {
  it.each(["gc", "standalone"] as const)("passes a parsed list and explicit defaulted flags in %s", async (target) => {
    const result = await compile(
      `
      interface Node { kind: number; flags: number; }
      interface VariableDeclaration extends Node { value: number; }
      interface VariableDeclarationList extends Node { declarations: readonly VariableDeclaration[]; }
      interface Factory {
        createVariableDeclarationList(declarations: readonly VariableDeclaration[], flags?: number): VariableDeclarationList;
      }
      function createFactory(): Factory {
        return { createVariableDeclarationList };
        function createVariableDeclarationList(declarations: readonly VariableDeclaration[], flags = 4) {
          return { kind: 262, flags: flags & 7, declarations };
        }
      }
      namespace Parser {
        const factory = createFactory();
        const { createVariableDeclarationList: factoryCreateVariableDeclarationList } = factory;
        function parseDelimitedList<T>(callback: () => T): T[] {
          const list = [];
          list.push(callback());
          return list;
        }
        function parseVariable(): VariableDeclaration { return { kind: 261, flags: 0, value: 17 }; }
        export function parse(): number {
          const declarations: readonly VariableDeclaration[] = parseDelimitedList(parseVariable);
          const node = factoryCreateVariableDeclarationList(declarations, 2);
          const omitted = factoryCreateVariableDeclarationList(declarations);
          const nan = factoryCreateVariableDeclarationList(declarations, NaN);
          const infinity = factoryCreateVariableDeclarationList(declarations, Infinity);
          return node.flags * 100 + node.declarations[0].value + omitted.flags
            + nan.flags * 1000 + infinity.flags * 10000;
        }
      }
      export function probe(): number { return Parser.parse(); }
    `,
      { target, skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
    const imports = result.importObject ?? {};
    const instance = await WebAssembly.instantiate(module, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(221);
  });
});
