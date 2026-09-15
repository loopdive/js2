// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, wrapExports } from "../src/index.js";

const SOURCES = {
  "./src/compiler/types.ts": `
export type Mutable<T> = { -readonly [P in keyof T]: T[P] };

export interface Node {
  readonly kind: number;
  readonly pos: number;
  readonly end: number;
  readonly flags: number;
}

// Note: 'brands' in our syntax nodes serve to give us a small amount of nominal typing.
// The brands are never actually given values. At runtime they have zero cost.
export interface TypeNode extends Node {
  _typeNodeBrand: any;
}

/** @internal */
export interface TypeNode extends Node {
  readonly kind: number;
}

export interface NodeArray<T extends Node> extends Array<T> {
  pos: number;
  end: number;
}

export interface UnionTypeNode extends TypeNode {
  readonly kind: 192;
  readonly types: NodeArray<TypeNode>;
}

export interface IntersectionTypeNode extends TypeNode {
  readonly kind: 193;
  readonly types: NodeArray<TypeNode>;
}

export type UnionOrIntersectionTypeNode = UnionTypeNode | IntersectionTypeNode;

export interface VariableDeclarationList extends Node {
  readonly kind: 262;
  readonly declarations: NodeArray<Node>;
}

export interface BaseNodeFactory {
  createBaseNode(kind: number): Node;
}

export interface NodeFactory {
  createUnionTypeNode(types: readonly TypeNode[]): UnionTypeNode;
  createIntersectionTypeNode(types: readonly TypeNode[]): IntersectionTypeNode;
  createConcreteUnionTypeNode(types: readonly TypeNode[]): UnionTypeNode;
  createConcreteIntersectionTypeNode(types: readonly TypeNode[]): IntersectionTypeNode;
  createVariableDeclarationList(flags: number): VariableDeclarationList;
}
`,
  "./src/compiler/factory.ts": `
import type {
  BaseNodeFactory,
  IntersectionTypeNode,
  Mutable,
  Node,
  NodeArray,
  NodeFactory,
  TypeNode,
  UnionOrIntersectionTypeNode,
  UnionTypeNode,
  VariableDeclarationList,
} from "./types.js";

let lastAllocated: Node | undefined;
export function getLastAllocated(): Node | undefined {
  return lastAllocated;
}

function NodeConstructor(this: Mutable<Node>, kind: number, pos: number, end: number): void {
  this.kind = kind;
  this.pos = pos;
  this.end = end;
  this.flags = 0;
}

function createBaseNodeFactory(): BaseNodeFactory {
  let Ctor: new (kind: number, pos: number, end: number) => Node;
  return { createBaseNode };

  function createBaseNode(kind: number): Node {
    Ctor ||= NodeConstructor as unknown as new (kind: number, pos: number, end: number) => Node;
    const node = new Ctor(kind, -1, -1);
    lastAllocated = node;
    return node;
  }
}

function createNodeArray<T extends Node>(elements: readonly T[]): NodeArray<T> {
  const result = elements.slice() as NodeArray<T>;
  result.pos = 11;
  result.end = 17;
  return result;
}

export function createNodeFactory(): NodeFactory {
  const baseFactory = createBaseNodeFactory();
  return {
    createUnionTypeNode,
    createIntersectionTypeNode,
    createConcreteUnionTypeNode,
    createConcreteIntersectionTypeNode,
    createVariableDeclarationList,
  };

  function createBaseNode<T extends Node>(kind: T["kind"]): Mutable<T> {
    return baseFactory.createBaseNode(kind) as Mutable<T>;
  }

  function createUnionOrIntersectionTypeNode(
    kind: 192 | 193,
    types: readonly TypeNode[],
  ): UnionOrIntersectionTypeNode {
    const node = createBaseNode<UnionTypeNode | IntersectionTypeNode>(kind);
    node.types = createNodeArray(types);
    return node;
  }

  function createUnionTypeNode(types: readonly TypeNode[]): UnionTypeNode {
    return createUnionOrIntersectionTypeNode(192, types) as UnionTypeNode;
  }

  function createIntersectionTypeNode(types: readonly TypeNode[]): IntersectionTypeNode {
    return createUnionOrIntersectionTypeNode(193, types) as IntersectionTypeNode;
  }

  function createConcreteUnionTypeNode(types: readonly TypeNode[]): UnionTypeNode {
    const node = createBaseNode<UnionTypeNode>(192);
    node.types = createNodeArray(types);
    return node;
  }

  function createConcreteIntersectionTypeNode(types: readonly TypeNode[]): IntersectionTypeNode {
    const node = createBaseNode<IntersectionTypeNode>(193);
    node.types = createNodeArray(types);
    return node;
  }

  function createVariableDeclarationList(flags: number): VariableDeclarationList {
    const node = createBaseNode<VariableDeclarationList>(262);
    node.flags |= flags & 3;
    node.declarations = createNodeArray([]);
    return node;
  }
}
`,
  "./src/compiler/parser.ts": `
import type {
  Mutable,
  Node,
  NodeArray,
  NodeFactory,
  TypeNode,
  UnionOrIntersectionTypeNode,
  VariableDeclarationList,
} from "./types.js";

function createNodeArray<T extends Node>(elements: readonly T[]): NodeArray<T> {
  const result = elements.slice() as NodeArray<T>;
  result.pos = 3;
  result.end = 5;
  return result;
}

function finishNode<T extends Node>(node: T, pos: number, contextFlags = 0): T {
  (node as Mutable<Node>).pos = pos;
  (node as Mutable<Node>).end = 99;
  if (contextFlags) (node as Mutable<T>).flags |= contextFlags;
  return node;
}

function parseType(): TypeNode {
  return { kind: 150, pos: 0, end: 1 } as TypeNode;
}

function parseUnionOrIntersectionType(
  createTypeNode: (types: NodeArray<TypeNode>) => UnionOrIntersectionTypeNode,
): TypeNode {
  const first = parseType();
  return finishNode(createTypeNode(createNodeArray([first, parseType()])), 23);
}

export function parseUnion(factory: NodeFactory): TypeNode {
  return parseUnionOrIntersectionType(factory.createUnionTypeNode);
}

export function parseIntersection(factory: NodeFactory): TypeNode {
  return parseUnionOrIntersectionType(factory.createIntersectionTypeNode);
}

export function parseConcreteUnion(factory: NodeFactory): TypeNode {
  return parseUnionOrIntersectionType(factory.createConcreteUnionTypeNode);
}

export function parseConcreteIntersection(factory: NodeFactory): TypeNode {
  return parseUnionOrIntersectionType(factory.createConcreteIntersectionTypeNode);
}

export function parseAmbientConst(factory: NodeFactory): VariableDeclarationList {
  return finishNode(factory.createVariableDeclarationList(2), 23, 1 << 25);
}
`,
  "./src/compiler/entry.ts": `
import { createNodeFactory, getLastAllocated } from "./factory.js";
import { parseAmbientConst, parseIntersection, parseUnion, parseConcreteUnion, parseConcreteIntersection } from "./parser.js";
import type { IntersectionTypeNode, UnionTypeNode } from "./types.js";

const factory = createNodeFactory();

export function unionAliasIdentity(intersection: boolean): number {
  const node = intersection ? factory.createIntersectionTypeNode([]) : factory.createUnionTypeNode([]);
  const base = getLastAllocated();
  if (base !== node) return -1;
  (base as any).types = [{ kind: 150, pos: 0, end: 1 }];
  if (node.types.length !== 1) return -2;
  (node as any).types = [];
  if ((base as any).types.length !== 0) return -3;
  (base as any).pos = 37;
  if (node.pos !== 37) return -4;
  return 1;
}

function fingerprint(node: UnionTypeNode | IntersectionTypeNode): number {
  return node.kind * 100_000 + node.pos * 1_000 + node.end * 10 + node.types.length;
}

export function unionFingerprint(): number {
  return fingerprint(parseUnion(factory) as UnionTypeNode);
}

export function intersectionFingerprint(): number {
  return fingerprint(parseIntersection(factory) as IntersectionTypeNode);
}

export function concreteUnionCallback(): number {
  return fingerprint(parseConcreteUnion(factory) as UnionTypeNode);
}

export function concreteIntersectionCallback(): number {
  return fingerprint(parseConcreteIntersection(factory) as IntersectionTypeNode);
}

export function directUnionFingerprint(): number {
  return fingerprint(factory.createUnionTypeNode([{ kind: 150, pos: 0, end: 1 } as UnionTypeNode]));
}

export function directIntersectionFingerprint(): number {
  return fingerprint(factory.createIntersectionTypeNode([
    { kind: 150, pos: 0, end: 1 } as IntersectionTypeNode,
  ]));
}

export function concreteUnionFingerprint(): number {
  return fingerprint(factory.createConcreteUnionTypeNode([
    { kind: 150, pos: 0, end: 1 } as UnionTypeNode,
  ]));
}

export function concreteIntersectionFingerprint(): number {
  return fingerprint(factory.createConcreteIntersectionTypeNode([
    { kind: 150, pos: 0, end: 1 } as IntersectionTypeNode,
  ]));
}

export function ambientConstFlags(): number {
  return parseAmbientConst(factory).flags;
}
`,
} as const;

interface CarrierExports {
  unionAliasIdentity(intersection: number): number;
  concreteUnionCallback(): number;
  concreteIntersectionCallback(): number;
  ambientConstFlags(): number;
  concreteIntersectionFingerprint(): number;
  concreteUnionFingerprint(): number;
  directIntersectionFingerprint(): number;
  directUnionFingerprint(): number;
  unionFingerprint(): number;
  intersectionFingerprint(): number;
}

async function compileCarrier(target: "gc" | "standalone"): Promise<CarrierExports> {
  const result = await compileMulti(SOURCES, "./src/compiler/entry.ts", {
    target,
    ...(target === "gc" ? { platform: "node" as const } : {}),
    skipSemanticDiagnostics: true,
    experimentalIR: false,
  });

  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  if (target === "standalone") {
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    return instance.exports as unknown as CarrierExports;
  }
  return wrapExports(instance, { signatures: result.exportSignatures }) as unknown as CarrierExports;
}

describe("#1058 TypeScript union result carrier", () => {
  it.each(["gc", "standalone"] as const)("preserves union allocation identity and writes in %s", async (target) => {
    const exports = await compileCarrier(target);
    expect(exports.unionAliasIdentity(0)).toBe(1);
    expect(exports.unionAliasIdentity(1)).toBe(1);
  });
  it.each(["gc", "standalone"] as const)(
    "exports concrete callback results through the erased union ABI in %s",
    async (target) => {
      const exports = await compileCarrier(target);
      expect(exports.concreteUnionCallback()).toBe(19_223_992);
      expect(exports.concreteIntersectionCallback()).toBe(19_323_992);
    },
  );
  it("keeps production-shaped union and intersection results on the host TypeNode carrier", async () => {
    const exports = await compileCarrier("gc");

    expect(exports.directUnionFingerprint()).toBe(19_198_991);
    expect(exports.directIntersectionFingerprint()).toBe(19_298_991);
    expect(exports.unionFingerprint()).toBe(19_223_992);
    expect(exports.intersectionFingerprint()).toBe(19_323_992);
    expect(exports.ambientConstFlags()).toBe(33_554_434);
  });

  it("retains physical union and intersection fields in standalone mode", async () => {
    const exports = await compileCarrier("standalone");

    expect(exports.concreteUnionFingerprint()).toBe(19_198_991);
    expect(exports.concreteIntersectionFingerprint()).toBe(19_298_991);
    expect(exports.unionFingerprint()).toBe(19_223_992);
    expect(exports.intersectionFingerprint()).toBe(19_323_992);
  });
});
