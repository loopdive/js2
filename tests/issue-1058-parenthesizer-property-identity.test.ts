// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, wrapExports } from "../src/index.js";

const SOURCES = {
  "./src/compiler/core.ts": `
export function cast<TOut extends TIn, TIn = unknown>(value: TIn, test: (value: TIn) => value is TOut): TOut {
  return test(value) ? value : undefined!;
}

export function map<T, U>(array: readonly T[] | undefined, callback: (value: T, index: number) => U): U[] | undefined {
  if (array === undefined) return undefined;
  const result: U[] = [];
  for (let i = 0; i < array.length; i++) result.push(callback(array[i]!, i));
  return result;
}

export function memoize<T>(callback: () => T): () => T {
  let value: T;
  return () => {
    if (callback) {
      value = callback();
      callback = undefined!;
    }
    return value;
  };
}
`,
  "./src/compiler/types.ts": `
export interface Node {
  readonly kind: number;
  readonly value: number;
  readonly pos: number;
  readonly end: number;
  readonly parent: Node;
  readonly original?: Node;
}

// Note: 'brands' in our syntax nodes serve to give us a small amount of nominal typing.
// The brands are never actually given values. At runtime they have zero cost.
export interface Expression extends Node {
  _expressionBrand: any;
}

export interface UnaryExpression extends Expression {
  _unaryExpressionBrand: any;
}

export interface UpdateExpression extends UnaryExpression {
  _updateExpressionBrand: any;
}

export interface LeftHandSideExpression extends UpdateExpression {
  _leftHandSideExpressionBrand: any;
}

export interface NodeArray<T extends Node> extends Array<T> {
  pos: number;
  end: number;
}

export interface ParenthesizerRules {
  parenthesizeExpressionOfNew(expression: Expression): LeftHandSideExpression;
  parenthesizeLeftSideOfAccess(expression: Expression, optionalChain?: boolean): LeftHandSideExpression;
  parenthesizeOperandOfPostfixUnary(operand: Expression): LeftHandSideExpression;
  parenthesizeOperandOfPrefixUnary(operand: Expression): UnaryExpression;
  parenthesizeExpressionsOfCommaDelimitedList(nodes: NodeArray<Expression>): NodeArray<Expression>;
  parenthesizeTypeArguments(nodes: readonly Expression[] | undefined): NodeArray<Expression> | undefined;
}
`,
  "./src/compiler/utilitiesPublic.ts": `
import type { Node, NodeArray } from "./types.js";

const hasOwnProperty = Object.prototype.hasOwnProperty;

function hasProperty(map: object, key: string): boolean {
  return hasOwnProperty.call(map, key);
}

export function isNodeArray<T extends Node>(value: readonly T[]): value is NodeArray<T> {
  return hasProperty(value, "pos") && hasProperty(value, "end");
}
`,
  "./src/compiler/_namespaces/ts.ts": `
export * from "../core.js";
export * from "../types.js";
export * from "../utilitiesPublic.js";
`,
  "./src/compiler/allocator.ts": `
import type { Node } from "./types.js";

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

function NodeObject(this: Mutable<Node>, kind: number, value: number): void {
  this.pos = -1;
  this.end = -1;
  this.kind = kind;
  this.value = value;
  this.parent = undefined!;
  this.original = undefined;
}

let NodeConstructor: new (kind: number, value: number) => Node;

export function createBaseNode<T extends Node>(kind: number, value: number): T {
  NodeConstructor ||= NodeObject as any;
  return new NodeConstructor(kind, value) as T;
}
`,
  "./src/compiler/parenthesizerRules.ts": `
import type {
  Expression,
  LeftHandSideExpression,
  Node,
  NodeArray,
  ParenthesizerRules,
  UnaryExpression,
} from "./_namespaces/ts.js";
import { cast, isNodeArray } from "./_namespaces/ts.js";

function isLeftHandSideExpression(value: Node): value is LeftHandSideExpression {
  return value.kind === 1;
}

function isUnaryExpression(value: Node): value is UnaryExpression {
  return value.kind === 1;
}

export const nullParenthesizerRules: ParenthesizerRules = {
  parenthesizeExpressionOfNew: expression => cast(expression, isLeftHandSideExpression),
  parenthesizeLeftSideOfAccess: expression => cast(expression, isLeftHandSideExpression),
  parenthesizeOperandOfPostfixUnary: operand => cast(operand, isLeftHandSideExpression),
  parenthesizeOperandOfPrefixUnary: operand => cast(operand, isUnaryExpression),
  parenthesizeExpressionsOfCommaDelimitedList: nodes => cast(nodes, isNodeArray),
  parenthesizeTypeArguments: nodes => cast(nodes, isNodeArray),
};
`,
  "./src/compiler/nodeFactory.ts": `
import { createBaseNode } from "./allocator.js";
import { memoize } from "./_namespaces/ts.js";
import type { Expression, NodeArray } from "./_namespaces/ts.js";
import { nullParenthesizerRules } from "./parenthesizerRules.js";

const parenthesizerRules = memoize(() => nullParenthesizerRules);

export function probe(): number {
  const expression = createBaseNode<Expression>(1, 42);
  return parenthesizerRules().parenthesizeLeftSideOfAccess(expression, false).value;
}

export function probeNodeArray(): number {
  const typeArguments = makeNodeArray();
  return parenthesizerRules().parenthesizeTypeArguments(typeArguments)![0].value;
}

export function makeNodeArray(): NodeArray<Expression> {
  const expression = createBaseNode<Expression>(1, 42);
  const typeArguments = [expression] as NodeArray<Expression>;
  typeArguments.pos = 10;
  typeArguments.end = 11;
  return typeArguments;
}

export function makeEmptyNodeArray(): NodeArray<Expression> {
  const typeArguments = [] as NodeArray<Expression>;
  typeArguments.pos = 10;
  typeArguments.end = 11;
  return typeArguments;
}

export function makeExpression(): Expression {
  return createBaseNode<Expression>(1, 42);
}

export function createExpressionWithTypeArguments(
  expression: Expression,
  typeArguments: readonly Expression[] | undefined,
): number {
  const left = parenthesizerRules().parenthesizeLeftSideOfAccess(expression, false);
  const argumentsArray = typeArguments && parenthesizerRules().parenthesizeTypeArguments(typeArguments);
  return left.value * 1_000_000 + (argumentsArray ? argumentsArray.length * 10_000 + argumentsArray.pos * 100 + argumentsArray.end : -1);
}

export function createNodeArray<T extends Expression>(
  elements?: readonly T[],
  hasTrailingComma?: boolean,
): NodeArray<T> {
  if (elements === undefined) elements = [];
  const length = elements.length;
  const array = (length >= 1 && length <= 4 ? elements.slice() : elements) as NodeArray<T>;
  array.pos = -1;
  array.end = -1;
  return array;
}

export const factory: any = {
  createNodeArray,
  createExpressionWithTypeArguments,
};

export function getCreateExpressionWithTypeArguments() {
  return createExpressionWithTypeArguments;
}

export function getParenthesizeTypeArguments() {
  return parenthesizerRules().parenthesizeTypeArguments;
}

export function scoreNodeArray(typeArguments: NodeArray<Expression> | undefined): number {
  return typeArguments
    ? typeArguments[0].value * 10000 + typeArguments.pos * 100 + typeArguments.end
    : -1;
}
`,
  "./src/compiler/parser.ts": `
import { factory, makeExpression } from "./nodeFactory.js";
import type { Expression, NodeArray } from "./_namespaces/ts.js";

function tryParseTypeArguments(): NodeArray<Expression> | undefined {
  return undefined;
}

function createNodeArray<T extends Expression>(elements: T[], pos: number, end: number): NodeArray<T> {
  const array = factory.createNodeArray(elements, false) as NodeArray<T>;
  array.pos = pos;
  array.end = end;
  return array;
}

export function parseHeritage(): number {
  const elements: Expression[] = [];
  elements.push(makeExpression());
  const typeArguments = createNodeArray(elements, 711, 712);
  return factory.createExpressionWithTypeArguments(makeExpression(), typeArguments);
}

export function parseHeritageWithoutTypeArguments(): number {
  const typeArguments = tryParseTypeArguments();
  if (typeArguments !== undefined) return -2;
  return factory.createExpressionWithTypeArguments(makeExpression(), typeArguments);
}
`,
} as const;

describe("#1058 parenthesizer callable-property identity", () => {
  it("keeps the parser's generic Node allocation on its zero-cost Expression view", async () => {
    const result = await compileMulti(SOURCES, "./src/compiler/nodeFactory.ts", {
      target: "gc",
      platform: "node",
      skipSemanticDiagnostics: true,
      experimentalIR: false,
      resolve: { consumerDrivenBarrels: true },
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { marshal: "live", signatures: result.exportSignatures }) as unknown as {
      probe(): number;
      probeNodeArray(): number;
      makeNodeArray(): Array<{ value: number }> & { pos: number; end: number };
      makeEmptyNodeArray(): Array<{ value: number }> & { pos: number; end: number };
      makeExpression(): { value: number };
      getParenthesizeTypeArguments(): (
        nodes: Array<{ value: number }> & { pos: number; end: number },
      ) => Array<{ value: number }> & { pos: number; end: number };
    };
    expect(exports.probe()).toBe(42);
    expect(exports.probeNodeArray()).toBe(42);
    const hostNodes = exports.makeNodeArray();
    expect(Object.prototype.hasOwnProperty.call(hostNodes, "pos")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(hostNodes, "end")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(hostNodes, "data")).toBe(false);
    expect(Reflect.ownKeys(hostNodes)).toEqual(["0", "length", "pos", "end"]);
    const rawExports = instance.exports as unknown as {
      getParenthesizeTypeArguments(): unknown;
      getCreateExpressionWithTypeArguments(): unknown;
      __call_fn_method_1(receiver: unknown, closure: unknown, value: unknown): unknown;
      __call_fn_method_2(receiver: unknown, closure: unknown, first: unknown, second: unknown): unknown;
      scoreNodeArray(value: unknown): number;
    };
    const hostResult = rawExports.__call_fn_method_1(undefined, rawExports.getParenthesizeTypeArguments(), hostNodes);
    expect(rawExports.scoreNodeArray(hostResult)).toBe(421011);
    expect(
      rawExports.__call_fn_method_2(
        undefined,
        rawExports.getCreateExpressionWithTypeArguments(),
        exports.makeExpression(),
        exports.makeEmptyNodeArray(),
      ),
    ).toBe(42_001_011);
  });
});

describe("#1058 parser to NodeFactory callable seam", () => {
  it("preserves a non-empty NodeArray through both dynamic factory calls", async () => {
    const result = await compileMulti(SOURCES, "./src/compiler/parser.ts", {
      target: "gc",
      platform: "node",
      skipSemanticDiagnostics: true,
      experimentalIR: false,
      resolve: { consumerDrivenBarrels: true },
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { marshal: "live", signatures: result.exportSignatures }) as unknown as {
      parseHeritage(): number;
      parseHeritageWithoutTypeArguments(): number;
    };
    expect(exports.parseHeritage()).toBe(42_081_812);
    expect(exports.parseHeritageWithoutTypeArguments()).toBe(41_999_999);
  });
});
