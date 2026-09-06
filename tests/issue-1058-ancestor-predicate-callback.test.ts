// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(["match", "missing", "quit"])("adapts ancestor callbacks: %s", async (name) => {
  const result = await compile(
    `interface Node { kind: number; parent?: Node; }
    interface Doc extends Node { kind: 309; }
    function isDoc(node: Node): node is Doc { return node.kind === 309; }
    function findAncestor<T extends Node>(node: Node | undefined, callback: (node: Node) => node is T): T | undefined;
    function findAncestor(node: Node | undefined, callback: (node: Node) => boolean | "quit"): Node | undefined;
    function findAncestor(node: Node | undefined, callback: (node: Node) => boolean | "quit"): Node | undefined {
      while (node) {
        const result = callback(node);
        if (result === "quit") return undefined;
        else if (result) return node;
        node = node.parent;
      }
      return undefined;
    }
    export function match(): number {
      const root: Node = { kind: 309 };
      const child: Node = { kind: 80, parent: root };
      if (findAncestor(child, isDoc) !== root) return -1;
      return 1;
    }
    export function missing(): number { return findAncestor({ kind: 80 }, isDoc) === undefined ? 1 : -2; }
    export function quit(): number { return findAncestor({ kind: 80 }, () => "quit") === undefined ? 1 : -3; }`,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports[name] as () => number)()).toBe(1);
});
