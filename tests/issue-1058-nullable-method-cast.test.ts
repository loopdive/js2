// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

const SOURCE = `
type Mutable<T> = { -readonly [P in keyof T]: T[P] };

interface NodeLike {
  readonly kind: number;
  readonly pos: number;
  readonly end: number;
}

interface TypeNodeLike extends NodeLike {
  _typeNodeBrand: any;
}

interface Token<TKind extends number = number> extends NodeLike {
  readonly kind: TKind;
}

interface NodeFactory {
  createToken(token: 1): Token<1>;
  createToken<TKind extends number>(token: TKind): Token<TKind>;
  createAs(expression: NodeLike, type: TypeNodeLike): NodeLike;
}

function createNodeFactory(): NodeFactory {
  function createToken(token: 1): Token<1>;
  function createToken<TKind extends number>(token: TKind): Token<TKind>;
  function createToken<TKind extends number>(token: TKind) {
    return { kind: token, pos: -1, end: -1 };
  }

  function createAs(expression: NodeLike, type: TypeNodeLike): NodeLike {
    return { kind: expression.kind * 10 + type.kind, pos: 0, end: 0 };
  }

  return { createToken, createAs };
}

const factory = createNodeFactory();
const { createToken: factoryCreateToken } = factory;

function finishNode<T extends NodeLike>(node: T, pos: number): T {
  (node as Mutable<NodeLike>).pos = pos;
  (node as Mutable<NodeLike>).end = pos + 1;
  return node;
}

function replaceNode<T extends NodeLike>(node: T): T {
  (node as Mutable<NodeLike>).pos += 0;
  return { kind: 99, pos: 3, end: 4 } as T;
}

function rebindNode<T extends NodeLike>(node: T): T {
  (node as Mutable<NodeLike>).pos += 0;
  node = { kind: 77, pos: 5, end: 6 } as T;
  return node;
}

function parseTokenNode<T extends NodeLike>(): T {
  return finishNode(factoryCreateToken(2), 10) as T;
}

function parseKeywordAndNoDot(): TypeNodeLike | undefined {
  return parseTokenNode<TypeNodeLike>();
}

export function tokenKind(): number {
  return parseKeywordAndNoDot()!.kind;
}

export function test(): number {
  const expression: NodeLike = { kind: 4, pos: 0, end: 0 };
  return factory.createAs(expression, parseKeywordAndNoDot()!).kind;
}

export function replacementKind(): number {
  return replaceNode(factoryCreateToken(2)).kind;
}

export function reboundKind(): number {
  return rebindNode(factoryCreateToken(2)).kind;
}
`;

describe("#1058 generic identity structural projection", () => {
  it("recovers only a body-proven identity parameter carrier", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-1058-nullable-method-cast.ts",
      target: "gc",
      platform: "node",
      skipSemanticDiagnostics: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as {
      test(): number;
      tokenKind(): number;
      replacementKind(): number;
      reboundKind(): number;
    };
    // Positive: finishNode mutates only properties and returns the exact node
    // binding, so its opaque T result can recover the Token carrier before the
    // sibling TypeNode projection.
    expect(exports.tokenKind()).toBe(2);
    expect(exports.test()).toBe(42);
    // Negative: replaceNode has the same T -> T signature but returns a fresh
    // asserted object. Recovering its argument carrier would null-cast that
    // distinct result; the body-level proof must decline and preserve kind 99.
    expect(exports.replacementKind()).toBe(99);
    // Returning the parameter identifier is insufficient after rebinding it.
    expect(exports.reboundKind()).toBe(77);
  });
});
