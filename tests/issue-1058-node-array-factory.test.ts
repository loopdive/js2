// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, compileMulti } from "../src/index.js";

async function instantiate(result: Awaited<ReturnType<typeof compile>>) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return instance.exports as Record<string, Function>;
}

describe("#1058 TypeScript node-array factory", () => {
  it("calls a destructured nested generic array factory without losing its carrier", async () => {
    const result = await compile(
      `
        interface Node { transformFlags: number }
        interface NodeArray<T extends Node> extends ReadonlyArray<T> {
          pos: number;
          end: number;
          hasTrailingComma: boolean;
          transformFlags: number;
        }

        const emptyArray: never[] = [];
        const hasOwnProperty = Object.prototype.hasOwnProperty;
        function hasProperty(map: object, key: string): boolean {
          return hasOwnProperty.call(map, key);
        }
        function isNodeArray<T extends Node>(array: readonly T[]): array is NodeArray<T> {
          return hasProperty(array, "pos") && hasProperty(array, "end");
        }
        function aggregateChildrenFlags(children: NodeArray<Node>): void {
          let flags = 0;
          for (const child of children) flags |= child.transformFlags;
          children.transformFlags = flags;
        }

        function createNodeFactory() {
          const factory = { createNodeArray };
          return factory;

          function createNodeArray<T extends Node>(
            elements?: readonly T[],
            hasTrailingComma?: boolean,
          ): NodeArray<T> {
            if (elements === undefined || elements === emptyArray) elements = [];
            else if (isNodeArray(elements)) {
              if (hasTrailingComma === undefined || elements.hasTrailingComma === hasTrailingComma) return elements;
              const copied = elements.slice() as NodeArray<T>;
              copied.pos = elements.pos;
              copied.end = elements.end;
              copied.hasTrailingComma = hasTrailingComma;
              copied.transformFlags = elements.transformFlags;
              return copied;
            }
            const length = elements.length;
            const array = (length >= 1 && length <= 4 ? elements.slice() : elements) as NodeArray<T>;
            array.pos = -1;
            array.end = -1;
            array.hasTrailingComma = !!hasTrailingComma;
            array.transformFlags = 0;
            aggregateChildrenFlags(array as NodeArray<Node>);
            return array;
          }
        }

        namespace Parser {
          var factory = createNodeFactory();
          var { createNodeArray: factoryCreateNodeArray } = factory;

          export function parseList(): number {
            const list: Node[] = [];
            const array = factoryCreateNodeArray(list, false);
            return array.length * 100 + array.pos * 10 + array.end;
          }

          export function parseNonEmptyList(): number {
            const list: Node[] = [{ transformFlags: 8 }];
            const first = factoryCreateNodeArray(list, false);
            const array = factoryCreateNodeArray(first, true);
            return array.length * 10_000 + array.pos * 1_000 + array.end * 100 + array.transformFlags;
          }
        }

        export function test(): number { return Parser.parseList(); }
        export function testNonEmpty(): number { return Parser.parseNonEmptyList(); }
      `,
      {
        fileName: "issue-1058-node-array-factory.ts",
        skipSemanticDiagnostics: true,
      },
    );

    const exports = await instantiate(result);
    expect(exports.test()).toBe(-11);
    expect(exports.testNonEmpty()).toBe(8_908);
  });

  it("projects an overloaded token implementation's anonymous carrier to its public Token result", async () => {
    const result = await compile(
      `
        type SyntaxKind = number;
        interface Node {
          readonly pos: number;
          readonly end: number;
          readonly kind: SyntaxKind;
          readonly flags: number;
          modifierFlagsCache: number;
          readonly transformFlags: number;
        }
        interface Token<TKind extends SyntaxKind = SyntaxKind> extends Node {
          readonly kind: TKind;
        }
        type Mutable<T> = { -readonly [P in keyof T]: T[P] };
        interface NodeFactory {
          createToken(token: 1): Token<1>;
          createToken<TKind extends SyntaxKind>(token: TKind): Token<TKind>;
        }

        function createNodeFactory(): NodeFactory {
          const factory: NodeFactory = { createToken };
          return factory;

          function createToken(token: 1): Token<1>;
          function createToken<TKind extends SyntaxKind>(token: TKind): Token<TKind>;
          function createToken<TKind extends SyntaxKind>(token: TKind) {
            return {
              kind: token,
              flags: 0,
              modifierFlagsCache: 0,
              transformFlags: 0,
              pos: -1,
              end: -1,
            };
          }
        }

        namespace Parser {
          var factory = createNodeFactory();
          var { createToken: factoryCreateToken } = factory;

          function finishNode<T extends Node>(node: T, pos: number): T {
            (node as Mutable<Node>).pos = pos;
            (node as Mutable<Node>).end = pos + 1;
            return node;
          }

          export function parseToken<T extends Node>(kind: SyntaxKind): T {
            return finishNode(factoryCreateToken(kind), 10) as T;
          }
        }

        export function test(): number {
          const token = Parser.parseToken<Node>(125);
          return token.kind * 100 + token.pos * 10 + token.end;
        }
      `,
      {
        fileName: "issue-1058-overloaded-token-factory.ts",
        skipSemanticDiagnostics: true,
      },
    );

    const exports = await instantiate(result);
    expect(exports.test()).toBe(12611);
  });

  it("keeps an imported factory's nested callable property through namespace destructuring", async () => {
    const result = await compileMulti(
      {
        "./factory.ts": `
          export interface Token<TKind extends number = number> { kind: TKind }
          export interface BaseNodeFactory {
            createBaseTokenNode<TKind extends number>(kind: TKind): Token<TKind>;
          }
          export interface NodeFactory {
            readonly parenthesizer: number;
            createToken(token: 1): Token<1>;
            createToken<TKind extends number>(token: TKind): Token<TKind>;
          }

          export function createNodeFactory(baseFactory: BaseNodeFactory): NodeFactory {
            const factory = {
              get parenthesizer(): number { return 7; },
              createToken,
            };
            return factory;

            function createToken(token: 1): Token<1>;
            function createToken<TKind extends number>(token: TKind): Token<TKind>;
            function createToken<TKind extends number>(token: TKind): Token<TKind> {
              return baseFactory.createBaseTokenNode(token);
            }
          }
        `,
        "./entry.ts": `
          import { createNodeFactory, type BaseNodeFactory } from "./factory.js";

          namespace Parser {
            var baseFactory: BaseNodeFactory = {
              createBaseTokenNode: kind => ({ kind }),
            };
            var factory = createNodeFactory(baseFactory);
            var { createToken: factoryCreateToken } = factory;

            export function parseToken(): number {
              return factoryCreateToken(42).kind;
            }
          }

          export function test(): number { return Parser.parseToken(); }
        `,
      },
      "./entry.ts",
      { skipSemanticDiagnostics: true },
    );

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });

  it("initializes every callable in a wide namespace factory destructure", async () => {
    const methodNames = [
      "createNodeArray",
      "createNumericLiteral",
      "createStringLiteral",
      "createLiteralLikeNode",
      "createIdentifier",
      "createPrivateIdentifier",
      "createToken",
      "createArrayLiteralExpression",
      "createObjectLiteralExpression",
      "createPropertyAccessExpression",
      "createPropertyAccessChain",
      "createElementAccessExpression",
      "createElementAccessChain",
      "createCallExpression",
      "createCallChain",
      "createNewExpression",
      "createParenthesizedExpression",
      "createBlock",
      "createVariableStatement",
      "createExpressionStatement",
      "createIfStatement",
      "createWhileStatement",
      "createForStatement",
      "createForOfStatement",
      "createVariableDeclaration",
      "createVariableDeclarationList",
    ];
    const declarations = methodNames
      .filter((name) => name !== "createToken")
      .map((name, index) => `function ${name}(value: number): number { return value + ${index + 1}; }`)
      .join("\n");
    const bindings = methodNames.map((name) => `${name}: factory${name[0]!.toUpperCase()}${name.slice(1)}`).join(",");
    const result = await compile(
      `
        function createFactory() {
          const factory = {
            get parenthesizer(): number { return 7; },
            ${methodNames.join(",")}
          };
          return factory;

          ${declarations}
          function createToken(value: 1): number;
          function createToken<T extends number>(value: T): number;
          function createToken<T extends number>(value: T): number { return value; }
        }

        namespace Parser {
          var factory = createFactory();
          var { ${bindings} } = factory;
          export function parseToken(): number { return factoryCreateToken(42); }
        }

        export function test(): number { return Parser.parseToken(); }
      `,
      { fileName: "issue-1058-wide-token-factory.ts", skipSemanticDiagnostics: true },
    );

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });
});
