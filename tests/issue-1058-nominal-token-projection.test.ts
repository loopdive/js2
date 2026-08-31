// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, wrapExports } from "../src/index.js";

const TYPES = `
export type Mutable<T> = { -readonly [P in keyof T]: T[P] };
export type KeywordSyntaxKind = 125 | 126;
export interface Node {
  readonly kind: number;
  readonly pos: number;
  readonly end: number;
  readonly flags: number;
  modifierFlagsCache: number;
  readonly transformFlags: number;
  readonly nodeBrand: number;
}
export interface Token<TKind extends number = number> extends Node { readonly kind: TKind; }
export interface KeywordToken<TKind extends KeywordSyntaxKind> extends Token<TKind> { readonly keywordBrand: number; }
export interface TypeNode extends Node { readonly _typeNodeBrand: number; readonly typeTag: number; }
export interface KeywordTypeNode<TKind extends KeywordSyntaxKind> extends KeywordToken<TKind>, TypeNode {
  readonly kind: TKind;
}
export interface BaseNodeFactory { createBaseTokenNode(kind: number): Node; }
export interface NodeFactory {
  createToken<TKind extends KeywordSyntaxKind>(kind: TKind): KeywordToken<TKind>;
  createToken<TKind extends number>(kind: TKind): Token<TKind>;
}
export function countNode(node: Node): Node { return node; }
`;

const FACTORY = `
import type { BaseNodeFactory, KeywordSyntaxKind, KeywordToken, Mutable, Node, NodeFactory, Token } from "./types.js";

namespace Debug { export function assert(condition: boolean): void { if (!condition) throw 1; } }
function forEach<T>(values: readonly T[], callback: (value: T) => void): void {
  for (let i = 0; i < values.length; i++) callback(values[i]!);
}

const nodeFactoryPatchers: ((factory: NodeFactory) => void)[] = [];
const nodeMutators: (() => void)[] = [];
export function addNodeFactoryPatcher(patcher: (factory: NodeFactory) => void): void {
  nodeFactoryPatchers.push(patcher);
}
export function runNodeMutators(): void {
  forEach(nodeMutators, mutate => mutate());
}

export function createNodeFactory(flags: number, baseFactory: BaseNodeFactory): NodeFactory {
  const factory: NodeFactory = { createToken };
  forEach(nodeFactoryPatchers, fn => fn(factory));
  return factory;

  function createBaseToken<T extends Node>(kind: T["kind"]) {
    return baseFactory.createBaseTokenNode(kind) as Mutable<T>;
  }
  function createToken<TKind extends KeywordSyntaxKind>(kind: TKind): KeywordToken<TKind>;
  function createToken<TKind extends number>(kind: TKind): Token<TKind>;
  function createToken<TKind extends number>(kind: TKind) {
    Debug.assert(kind >= 0);
    Debug.assert(kind !== 99);
    Debug.assert(kind !== 100);
    Debug.assert(kind !== 101);
    const node = createBaseToken<Token<TKind>>(kind);
    let transformFlags = 0;
    switch (kind) {
      case 125: transformFlags = 16; break;
      case 126: transformFlags = 32; break;
    }
    if (transformFlags) node.transformFlags |= transformFlags;
    void flags;
    return node;
  }
}

export function createPrefixNodeFactory(flags: number, baseFactory: BaseNodeFactory): NodeFactory {
  const shared = baseFactory.createBaseTokenNode(125) as Token<125>;
  const factory: NodeFactory = { createToken };
  return factory;

  function createBaseToken<T extends Node>(kind: T["kind"]) {
    return baseFactory.createBaseTokenNode(kind) as Mutable<T>;
  }
  function createToken<TKind extends KeywordSyntaxKind>(kind: TKind): KeywordToken<TKind>;
  function createToken<TKind extends number>(kind: TKind): Token<TKind>;
  function createToken<TKind extends number>(kind: TKind) {
    if (kind === 0) return shared as Token<TKind>;
    const node = createBaseToken<Token<TKind>>(kind);
    void flags;
    return node;
  }
}

export function createEscapedNodeFactory(flags: number, baseFactory: BaseNodeFactory): NodeFactory {
  const factory: NodeFactory = { createToken };
  function observe(value: NodeFactory): void {
    void value;
  }
  observe(factory);
  return factory;

  function createBaseToken<T extends Node>(kind: T["kind"]) {
    return baseFactory.createBaseTokenNode(kind) as Mutable<T>;
  }
  function createToken<TKind extends KeywordSyntaxKind>(kind: TKind): KeywordToken<TKind>;
  function createToken<TKind extends number>(kind: TKind): Token<TKind>;
  function createToken<TKind extends number>(kind: TKind) {
    const node = createBaseToken<Token<TKind>>(kind);
    void flags;
    return node;
  }
}

export function createCapturedFactoryMutator(flags: number, baseFactory: BaseNodeFactory): NodeFactory {
  const factory: NodeFactory = { createToken };
  function invoke(callback: () => void): void {
    callback();
  }
  function mutateCapturedFactory(): void {
    factory.createToken = ((kind: number) => baseFactory.createBaseTokenNode(kind)) as typeof factory.createToken;
  }
  invoke(mutateCapturedFactory);
  return factory;

  function createBaseToken<T extends Node>(kind: T["kind"]) {
    return baseFactory.createBaseTokenNode(kind) as Mutable<T>;
  }
  function createToken<TKind extends KeywordSyntaxKind>(kind: TKind): KeywordToken<TKind>;
  function createToken<TKind extends number>(kind: TKind): Token<TKind>;
  function createToken<TKind extends number>(kind: TKind) {
    const node = createBaseToken<Token<TKind>>(kind);
    void flags;
    return node;
  }
}

export function createCallbackEscapedNodeFactory(flags: number, baseFactory: BaseNodeFactory): NodeFactory {
  const factory: NodeFactory = { createToken };
  return factory;

  function createBaseToken<T extends Node>(kind: T["kind"]) {
    return baseFactory.createBaseTokenNode(kind) as Mutable<T>;
  }
  function createToken<TKind extends KeywordSyntaxKind>(kind: TKind): KeywordToken<TKind>;
  function createToken<TKind extends number>(kind: TKind): Token<TKind>;
  function createToken<TKind extends number>(kind: TKind) {
    const node = createBaseToken<Token<TKind>>(kind);
    nodeMutators.push(() => {
      (node as Mutable<Node>).pos = 900;
    });
    void flags;
    return node;
  }
}

export function createThisMutatingNodeFactory(flags: number, baseFactory: BaseNodeFactory) {
  const shared = baseFactory.createBaseTokenNode(125) as Token<125>;
  const factory = {
    createToken,
    mutate() {
      this.createToken = ((kind: number) => shared) as typeof this.createToken;
    },
  };
  return factory;

  function createBaseToken<T extends Node>(kind: T["kind"]) {
    return baseFactory.createBaseTokenNode(kind) as Mutable<T>;
  }
  function createToken<TKind extends KeywordSyntaxKind>(kind: TKind): KeywordToken<TKind>;
  function createToken<TKind extends number>(kind: TKind): Token<TKind>;
  function createToken<TKind extends number>(kind: TKind) {
    const node = createBaseToken<Token<TKind>>(kind);
    void flags;
    return node;
  }
}

export function createSpreadOverrideNodeFactory(flags: number, baseFactory: BaseNodeFactory): NodeFactory {
  const shared = baseFactory.createBaseTokenNode(125) as Token<125>;
  const replacement = {
    createToken: ((kind: number) => shared) as NodeFactory["createToken"],
  };
  const factory: NodeFactory = { createToken, ...replacement };
  return factory;

  function createBaseToken<T extends Node>(kind: T["kind"]) {
    return baseFactory.createBaseTokenNode(kind) as Mutable<T>;
  }
  function createToken<TKind extends KeywordSyntaxKind>(kind: TKind): KeywordToken<TKind>;
  function createToken<TKind extends number>(kind: TKind): Token<TKind>;
  function createToken<TKind extends number>(kind: TKind) {
    const node = createBaseToken<Token<TKind>>(kind);
    void flags;
    return node;
  }
}

export function createReassignedMethodNodeFactory(flags: number, baseFactory: BaseNodeFactory): NodeFactory {
  const shared = baseFactory.createBaseTokenNode(125) as Token<125>;
  createToken = ((kind: number) => shared) as typeof createToken;
  const factory: NodeFactory = { createToken };
  return factory;

  function createBaseToken<T extends Node>(kind: T["kind"]) {
    return baseFactory.createBaseTokenNode(kind) as Mutable<T>;
  }
  function createToken<TKind extends KeywordSyntaxKind>(kind: TKind): KeywordToken<TKind>;
  function createToken<TKind extends number>(kind: TKind): Token<TKind>;
  function createToken<TKind extends number>(kind: TKind) {
    const node = createBaseToken<Token<TKind>>(kind);
    void flags;
    return node;
  }
}

export function createParameterMutatingNodeFactory(flags: number, baseFactory: BaseNodeFactory): NodeFactory {
  const shared = baseFactory.createBaseTokenNode(125);
  baseFactory.createBaseTokenNode = (_kind: number) => shared;
  const factory: NodeFactory = { createToken };
  return factory;

  function createBaseToken<T extends Node>(kind: T["kind"]) {
    return baseFactory.createBaseTokenNode(kind) as Mutable<T>;
  }
  function createToken<TKind extends KeywordSyntaxKind>(kind: TKind): KeywordToken<TKind>;
  function createToken<TKind extends number>(kind: TKind): Token<TKind>;
  function createToken<TKind extends number>(kind: TKind) {
    const node = createBaseToken<Token<TKind>>(kind);
    void flags;
    return node;
  }
}
`;

function entry(
  baseBody: string,
  factoryName = "createNodeFactory",
  aliasMutation = "",
  aliasKeyword = "var",
  prelude = "",
  factoryMutation = "",
  baseEscape = "",
  tokenSource = "factoryCreateToken(kind)",
): string {
  return `
import { addNodeFactoryPatcher, runNodeMutators, ${factoryName} } from "./barrel.js";
import { countNode } from "./types.js";
import type { BaseNodeFactory, KeywordTypeNode, Mutable, Node, NodeFactory, TypeNode } from "./types.js";

function finishNode<T extends Node>(node: T, pos: number): T {
  (node as Mutable<Node>).pos = pos;
  (node as Mutable<Node>).end = pos + 1;
  return node;
}

namespace Parser {
  var shared: Node = {
    kind: 125, pos: -1, end: -1, flags: 7, modifierFlagsCache: 8, transformFlags: 0, nodeBrand: 10,
  };
  var baseNodeFactory: BaseNodeFactory = { createBaseTokenNode: kind => ${baseBody} };
  ${baseEscape}
  ${prelude}
  var factory = ${factoryName}(2, baseNodeFactory);
  ${factoryMutation}
  ${aliasKeyword} { createToken: factoryCreateToken } = factory;
  ${aliasMutation}
  var currentKind: number = 125;
  function token(): number { return currentKind; }
  function nextToken(): void { currentKind = 125; }
  function parseTokenNode<T extends Node>(): T {
    const pos = 40;
    const kind = token();
    nextToken();
    return finishNode(${tokenSource}, pos) as T;
  }
  export function keywordKind(): number {
    const node = parseTokenNode<KeywordTypeNode<125>>();
    runNodeMutators();
    return node.kind * 1000 + node.pos * 10 + node.end;
  }
  export function typeKind(): number {
    const node = parseTokenNode<TypeNode>();
    runNodeMutators();
    return node.kind * 1000 + node.pos * 10 + node.end;
  }
}
export function keywordKind(): number { return Parser.keywordKind(); }
export function typeKind(): number { return Parser.typeKind(); }
`;
}

async function compileEntry(
  baseBody: string,
  factoryName = "createNodeFactory",
  aliasMutation = "",
  aliasKeyword = "var",
  prelude = "",
  factoryMutation = "",
  baseEscape = "",
  tokenSource = "factoryCreateToken(kind)",
) {
  const source = entry(
    baseBody,
    factoryName,
    aliasMutation,
    aliasKeyword,
    prelude,
    factoryMutation,
    baseEscape,
    tokenSource,
  );
  const result = await compileMulti(
    {
      "./types.ts": TYPES,
      "./factory.ts": FACTORY,
      "./barrel.ts": `export * from "./factory.js";`,
      "./entry.ts": source,
    },
    "./entry.ts",
    {
      target: "gc",
      platform: "node",
      skipSemanticDiagnostics: true,
      resolve: { consumerDrivenBarrels: true },
    },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as {
    keywordKind(): number;
    typeKind(): number;
  };
  expect(typeof exports.keywordKind).toBe("function");
  expect(typeof exports.typeKind).toBe("function");
  return exports;
}

function atLeastOneTraps(exports: { keywordKind(): number; typeKind(): number }): boolean {
  const traps = (invoke: () => number): boolean => {
    try {
      invoke();
      return false;
    } catch {
      return true;
    }
  };
  return traps(exports.keywordKind) || traps(exports.typeKind);
}

const FRESH_BASE = `countNode({
  kind, pos: -1, end: -1, flags: 7, modifierFlagsCache: 8, transformFlags: 0, nodeBrand: 10,
})`;

describe("#1058 nominal token projection", () => {
  it("follows an imported NodeFactory method to its concrete fresh base allocator", async () => {
    const exports = await compileEntry(FRESH_BASE);
    expect(exports.keywordKind()).toBe(125441);
    expect(exports.typeKind()).toBe(125441);
  });

  it("declines exact factory names and signatures backed by a shared singleton", async () => {
    const exports = await compileEntry("countNode(shared)", "createNodeFactory");
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a factory method with an alternative outer return", async () => {
    const exports = await compileEntry(FRESH_BASE, "createPrefixNodeFactory");
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a returned factory local passed to an unrecognized mutator", async () => {
    const exports = await compileEntry(FRESH_BASE, "createEscapedNodeFactory");
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a returned factory local captured by a nested mutator callback", async () => {
    const exports = await compileEntry(FRESH_BASE, "createCapturedFactoryMutator");
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a fresh node captured by a callback that mutates it after return", async () => {
    const exports = await compileEntry(FRESH_BASE, "createCallbackEscapedNodeFactory");
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("scans illegal writes to const destructured aliases under skipped diagnostics", async () => {
    const exports = await compileEntry(
      FRESH_BASE,
      "createNodeFactory",
      "function replaceAlias(): void { factoryCreateToken = factory.createToken; } void replaceAlias;",
      "const",
    );
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a factory after an active NodeFactory patcher", async () => {
    const exports = await compileEntry(
      FRESH_BASE,
      "createNodeFactory",
      "",
      "var",
      `addNodeFactoryPatcher(value => {
        value.createToken = ((kind: number) => shared) as typeof value.createToken;
      });`,
    );
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a patcher registration function passed through another callable", async () => {
    const exports = await compileEntry(
      FRESH_BASE,
      "createNodeFactory",
      "",
      "var",
      `function invoke<T, U>(callback: (value: T) => void, value: U): void {
        (callback as (value: U) => void)(value);
      }
      invoke(addNodeFactoryPatcher, (value: NodeFactory) => {
        value.createToken = ((kind: number) => shared) as typeof value.createToken;
      });`,
    );
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a direct replacement of the returned factory method", async () => {
    const exports = await compileEntry(
      FRESH_BASE,
      "createNodeFactory",
      "",
      "var",
      "",
      `factory.createToken = ((kind: number) => shared) as typeof factory.createToken;`,
    );
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a sibling method that replaces the selected method through this", async () => {
    const exports = await compileEntry(FRESH_BASE, "createThisMutatingNodeFactory", "", "var", "", "factory.mutate();");
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a spread that overwrites the selected fresh method", async () => {
    const exports = await compileEntry(FRESH_BASE, "createSpreadOverrideNodeFactory");
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a selected nested method binding that is reassigned", async () => {
    const exports = await compileEntry(FRESH_BASE, "createReassignedMethodNodeFactory");
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a factory that replaces the selected base-factory parameter property", async () => {
    const exports = await compileEntry(FRESH_BASE, "createParameterMutatingNodeFactory");
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a later var redeclaration of the destructured factory method", async () => {
    const exports = await compileEntry(
      FRESH_BASE,
      "createNodeFactory",
      `var factoryCreateToken = ((kind: number) => shared) as typeof factoryCreateToken;`,
    );
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines an identity-wrapped constructor whose constructor can return a shared node", async () => {
    const exports = await compileEntry(
      FRESH_BASE,
      "createNodeFactory",
      "",
      "var",
      `class ReusingNode implements Node {
        readonly kind = 125;
        readonly pos = -1;
        readonly end = -1;
        readonly flags = 7;
        modifierFlagsCache = 8;
        readonly transformFlags = 0;
        readonly nodeBrand = 10;
        constructor(kind: number) {
          void kind;
          return shared as unknown as ReusingNode;
        }
      }`,
      "",
      "",
      "new ReusingNode(kind)",
    );
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines a computed replacement of the parser factory method", async () => {
    const exports = await compileEntry(
      FRESH_BASE,
      "createNodeFactory",
      "",
      "var",
      "",
      `const key = "createToken";
      factory[key] = ((kind: number) => shared) as typeof factory.createToken;`,
    );
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines the parser factory source passed to an indirect mutator", async () => {
    const exports = await compileEntry(
      FRESH_BASE,
      "createNodeFactory",
      "",
      "var",
      "",
      `function mutate(value: NodeFactory): void {
        value.createToken = ((kind: number) => shared) as typeof value.createToken;
      }
      mutate(factory);`,
    );
    expect(atLeastOneTraps(exports)).toBe(true);
  });

  it("declines an indirectly escaped concrete base factory", async () => {
    const exports = await compileEntry(
      FRESH_BASE,
      "createNodeFactory",
      "",
      "var",
      "",
      "",
      `function mutate(value: BaseNodeFactory): void {
        value.createBaseTokenNode = (kind: number) => shared;
      }
      function dormantMutation(): void { mutate(baseNodeFactory); }
      void dormantMutation;`,
    );
    expect(atLeastOneTraps(exports)).toBe(true);
  });
});
