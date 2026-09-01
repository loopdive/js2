// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, wrapExports } from "../src/index.js";

const SOURCES = {
  "./parser.ts": `
export interface Scanner {
  setScriptKind(kind: number): void;
  readObserved(): number;
}

export function parse(scanner: Scanner): number {
  scanner.setScriptKind(42);
  return scanner.readObserved();
}
`,
  "./scanner.ts": `
interface Token { kind: number; }

export function createScanner(offset: number) {
  let observed = 0;

  function setScriptKind(kind: number): Token {
    observed = kind + offset;
    return { kind: observed };
  }

  function readObserved(): number {
    return observed;
  }

  return { setScriptKind, readObserved };
}
`,
  "./main.ts": `
import { parse } from "./parser.js";
import { createScanner } from "./scanner.js";

export function probe(): number {
  return parse(createScanner(7));
}
`,
} as const;

async function compileAndRun(
  target: "gc" | "standalone",
): Promise<{ value: number; imports: WebAssembly.ModuleImportDescriptor[] }> {
  const result = await compileMulti(SOURCES, "./main.ts", {
    target,
    platform: "node",
    skipSemanticDiagnostics: true,
    experimentalIR: false,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const module = new WebAssembly.Module(result.binary);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as { probe(): number };
  return { value: exports.probe(), imports: WebAssembly.Module.imports(module) };
}

describe("#1058 deferred callable-property dispatch", () => {
  it.each(["gc", "standalone"] as const)(
    "uses the complete later-source closure set in the %s lane",
    async (target) => {
      const result = await compileAndRun(target);
      expect(result.value).toBe(49);
      if (target === "standalone") expect(result.imports).toEqual([]);
    },
  );

  it("keeps reference-bearing parameter prefixes off the non-rest deferred ABI", async () => {
    const result = await compileMulti(
      {
        "./parser.ts": `
interface Box { value: number; }
export interface Rules { apply(value: Box, flag: number): number; }
export function invoke(rules: Rules): number {
  return rules.apply({ value: 40 }, 2);
}
`,
        "./factory.ts": `
import { invoke, type Rules } from "./parser.js";
interface Box { value: number; }
export function probe(): number {
  let offset = 0;
  function apply(value: Box, flag: number): number {
    return value.value + flag + offset;
  }
  return invoke({ apply } as Rules);
}
`,
      },
      "./factory.ts",
      {
        target: "gc",
        platform: "node",
        skipSemanticDiagnostics: true,
        experimentalIR: false,
        emitWat: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.wat).not.toContain("__call_cprop_deferred");
  });

  it("projects a NodeArray argument and exports a concrete factory result through a union callback", async () => {
    const result = await compileMulti(
      {
        "./types.ts": `
interface Node { kind: number; pos: number; end: number; }
export interface TypeNode extends Node { _typeNodeBrand: any; }
export interface UnionTypeNode extends TypeNode { types: NodeArray<TypeNode>; }
export interface IntersectionTypeNode extends TypeNode { types: NodeArray<TypeNode>; }
export type UnionOrIntersectionTypeNode = UnionTypeNode | IntersectionTypeNode;
export interface NodeArray<T extends Node> extends Array<T> { pos: number; end: number; }
export interface NodeFactory { createUnionTypeNode(types: readonly TypeNode[]): UnionTypeNode; }
`,
        "./parser.ts": `
import type { Node, NodeArray, NodeFactory, TypeNode, UnionOrIntersectionTypeNode } from "./types.js";

function createNodeArray<T extends Node>(elements: readonly T[], pos: number): NodeArray<T> {
  const values = elements.slice() as NodeArray<T>;
  values.pos = pos;
  values.end = pos + 1;
  return values;
}
function finishNode<T extends Node>(node: T, pos: number): T {
  node.pos = pos;
  node.end = 99;
  return node;
}
function parseType(): TypeNode {
  return { kind: 150, pos: -1, end: -1 } as TypeNode;
}
export function parse(factory: NodeFactory): TypeNode {
  function parseUnionOrIntersectionType(
    parseConstituentType: () => TypeNode,
    createTypeNode: (types: NodeArray<TypeNode>) => UnionOrIntersectionTypeNode,
  ): TypeNode {
    let type = parseConstituentType();
    type = finishNode(createTypeNode(createNodeArray([type], 17)), 23);
    return type;
  }
  return parseUnionOrIntersectionType(parseType, factory.createUnionTypeNode);
}
`,
        "./factory.ts": `
import { parse } from "./parser.js";
import type { NodeArray, NodeFactory, TypeNode, UnionTypeNode } from "./types.js";

function createFactory(offset: number): NodeFactory {
  function createUnionTypeNode(types: readonly TypeNode[]): UnionTypeNode {
    return { kind: 192 + offset, pos: -1, end: -1, types } as UnionTypeNode;
  }
  return { createUnionTypeNode };
}
export function probe(): number {
  const node = parse(createFactory(0)) as UnionTypeNode;
  return node.kind * 100 + node.pos;
}
`,
      },
      "./factory.ts",
      {
        target: "gc",
        platform: "node",
        skipSemanticDiagnostics: true,
        experimentalIR: false,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as { probe(): number };
    expect(exports.probe()).toBe(19_223);
  });
});
