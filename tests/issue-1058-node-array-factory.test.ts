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
  it.each(["gc", "standalone"] as const)("preserves omitted generic vectors in %s", async (target) => {
    const result = await compile(
      `
      interface Node { kind: number }
      interface NodeArray<T extends Node> extends ReadonlyArray<T> { pos: number }
      interface Factory { make<T extends Node>(xs?: readonly T[], flag?: boolean): NodeArray<T> }
      function factory(): Factory {
        return { make };
        function make<T extends Node>(xs?: readonly T[], flag?: boolean): NodeArray<T> {
          if (xs === undefined) xs = [];
          const result = xs as NodeArray<T>;
          result.pos = flag ? 7 : 3;
          return result;
        }
      }
      const { make } = factory();
      export function omitted(): number { const a = make(); return a.length * 10 + a.pos; }
      export function explicit(): number { const a = make(undefined); return a.length * 10 + a.pos; }
      export function populated(): number {
        const xs: Node[] = [{ kind: 8 }];
        const a = make(xs, true); return a.length * 100 + a[0].kind * 10 + a.pos;
      }
    `,
      { target, skipSemanticDiagnostics: true },
    );
    const exports = await instantiate(result);
    if (target === "standalone") expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    expect(exports.omitted()).toBe(3);
    expect(exports.explicit()).toBe(3);
    expect(exports.populated()).toBe(187);
  });

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

  it.each(["gc", "standalone"] as const)(
    "forwards a generic node array and optional flag through the parser wrapper in %s",
    async (target) => {
      const result = await compile(
        `
        interface Node { transformFlags: number }
        interface NodeArray<T extends Node> extends ReadonlyArray<T> {
          pos: number;
          end: number;
          hasTrailingComma: boolean;
          transformFlags: number;
        }
        interface NodeFactory {
          createNodeArray<T extends Node>(elements?: readonly T[], hasTrailingComma?: boolean): NodeArray<T>;
        }

        function createNodeFactory(): NodeFactory {
          const factory: NodeFactory = { createNodeArray };
          return factory;

          function createNodeArray<T extends Node>(
            elements?: readonly T[],
            hasTrailingComma?: boolean,
          ): NodeArray<T> {
            if (elements === undefined) elements = [];
            const array = elements as NodeArray<T>;
            array.pos = -1;
            array.end = -1;
            array.hasTrailingComma = !!hasTrailingComma;
            array.transformFlags = elements.length === 0 ? 0 : elements[0]!.transformFlags;
            return array;
          }
        }

        namespace Parser {
          var factory = createNodeFactory();
          var { createNodeArray: factoryCreateNodeArray } = factory;

          function createNodeArray<T extends Node>(
            elements: T[],
            pos: number,
            end?: number,
            hasTrailingComma?: boolean,
          ): NodeArray<T> {
            const array = factoryCreateNodeArray(elements, hasTrailingComma);
            array.pos = pos;
            array.end = end ?? 99;
            return array;
          }

          export function parseList(mode: number): number {
            const list: Node[] = [{ transformFlags: 8 }];
            const array = mode === 0 ? createNodeArray(list, 2) : createNodeArray(list, 2, 7, false);
            return array.length * 10_000 + array.pos * 1_000 + array.end * 10 + array.transformFlags;
          }
        }

        export function test(mode: number): number { return Parser.parseList(mode); }
      `,
        {
          fileName: "issue-1058-parser-node-array-wrapper.ts",
          target,
          skipSemanticDiagnostics: true,
        },
      );

      const exports = await instantiate(result);
      expect(exports.test(0)).toBe(12_998);
      expect(exports.test(1)).toBe(12_078);
    },
  );

  it("calls a destructured factory whose optional numeric flag has a scalar implementation ABI", async () => {
    const result = await compile(
      `
        const enum TokenFlags {
          None = 0,
          BinaryOrOctalSpecifier = 1,
        }

        interface NumericLiteral {
          text: string;
          numericLiteralFlags: TokenFlags;
          transformFlags: number;
        }

        interface NodeFactory {
          createNumericLiteral(value: string | number, numericLiteralFlags?: TokenFlags): NumericLiteral;
        }

        function createNodeFactory(): NodeFactory {
          return { createNumericLiteral };

          function createNumericLiteral(
            value: string | number,
            numericLiteralFlags: TokenFlags = TokenFlags.None,
          ): NumericLiteral {
            const text = typeof value === "number" ? value + "" : value;
            const node = { text, numericLiteralFlags, transformFlags: 0 };
            if (numericLiteralFlags & TokenFlags.BinaryOrOctalSpecifier) node.transformFlags |= 8;
            return node;
          }
        }

        function getNumericLiteralFlags(): TokenFlags {
          return TokenFlags.BinaryOrOctalSpecifier;
        }

        namespace Parser {
          var factory = createNodeFactory();
          var { createNumericLiteral: factoryCreateNumericLiteral } = factory;

          export function parseNumericLiteral(): number {
            const node = factoryCreateNumericLiteral("101", getNumericLiteralFlags());
            return node.text.length * 100 + node.numericLiteralFlags * 10 + node.transformFlags;
          }

          export function parseDefaultNumericLiteral(): number {
            const node = factoryCreateNumericLiteral("101");
            return node.text.length * 100 + node.numericLiteralFlags * 10 + node.transformFlags;
          }
        }

        export function test(): number { return Parser.parseNumericLiteral(); }
        export function testDefault(): number { return Parser.parseDefaultNumericLiteral(); }
      `,
      {
        fileName: "issue-1058-numeric-literal-factory.ts",
        skipSemanticDiagnostics: true,
      },
    );

    const exports = await instantiate(result);
    expect(exports.test()).toBe(318);
    expect(exports.testDefault()).toBe(300);
  });

  it.each(["host", "standalone"] as const)(
    "calls a destructured factory with explicitly forwarded optional node references in %s mode",
    async (target) => {
      const result = await compile(
        `
        interface Node { kind: number }
        interface BindingName extends Node { text: string }
        interface ExclamationToken extends Node { bang: number }
        interface TypeNode extends Node { typeCode: number }
        interface Expression extends Node { value: number }
        interface VariableDeclaration extends Node {
          name: BindingName;
          exclamationToken: ExclamationToken | undefined;
          type: TypeNode | undefined;
          initializer: Expression | undefined;
        }

        interface NodeFactory {
          createVariableDeclaration(
            name: string | BindingName,
            exclamationToken?: ExclamationToken,
            type?: TypeNode,
            initializer?: Expression,
          ): VariableDeclaration;
        }

        function createNodeFactory(): NodeFactory {
          return { createVariableDeclaration };

          function createVariableDeclaration(
            name: string | BindingName,
            exclamationToken: ExclamationToken | undefined,
            type: TypeNode | undefined,
            initializer: Expression | undefined,
          ): VariableDeclaration {
            const resolvedName = typeof name === "string" ? { kind: 80, text: name } : name;
            return { kind: 260, name: resolvedName, exclamationToken, type, initializer };
          }
        }

        namespace Parser {
          var factory = createNodeFactory();
          var { createVariableDeclaration: factoryCreateVariableDeclaration } = factory;

          export function parseVariableDeclaration(): number {
            const name: BindingName = { kind: 80, text: "value" };
            const exclamationToken: ExclamationToken | undefined = undefined;
            const type: TypeNode | undefined = undefined;
            const initializer: Expression | undefined = undefined;
            const node = factoryCreateVariableDeclaration(name, exclamationToken, type, initializer);
            return node.kind + node.name.kind + node.name.text.length;
          }

          export function parsePopulatedVariableDeclaration(): number {
            const name: BindingName = { kind: 80, text: "value" };
            const exclamationToken: ExclamationToken | undefined = { kind: 54, bang: 1 };
            const type: TypeNode | undefined = { kind: 183, typeCode: 2 };
            const initializer: Expression | undefined = { kind: 9, value: 3 };
            const node = factoryCreateVariableDeclaration(name, exclamationToken, type, initializer);
            return node.exclamationToken!.bang * 100 + node.type!.typeCode * 10 + node.initializer!.value;
          }
        }

        export function test(): number { return Parser.parseVariableDeclaration(); }
        export function testPopulated(): number { return Parser.parsePopulatedVariableDeclaration(); }
      `,
        {
          fileName: "issue-1058-variable-declaration-factory.ts",
          skipSemanticDiagnostics: true,
          ...(target === "standalone" ? { target: "standalone" as const } : {}),
        },
      );

      if (target === "standalone") {
        expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      }
      const exports = await instantiate(result);
      expect(exports.test()).toBe(345);
      expect(exports.testPopulated()).toBe(123);
    },
  );

  it("snapshots a materializing optional reference before later arguments reassign its source", async () => {
    const result = await compile(
      `
        interface RichNode {
          kind: number;
          valueOf(): number;
        }

        interface NodeConsumer {
          consume(value?: RichNode, marker?: any): number;
        }

        function createConsumer(): NodeConsumer {
          return { consume };

          function consume(value: RichNode | undefined, marker: any): number {
            marker;
            return value ? value.kind : -1;
          }
        }

        var consumer = createConsumer();
        var { consume: consumeNode } = consumer;

        export function testOmitted(): number {
          return consumeNode();
        }

        export function testUndefined(): number {
          return consumeNode(undefined);
        }

        export function testPopulated(): number {
          const current: RichNode = { kind: 7, valueOf() { return 1; } };
          return consumeNode(current);
        }

        export function testOrder(): number {
          let current: RichNode = { kind: 7, valueOf() { return 1; } };
          const replacement: RichNode = { kind: 9, valueOf() { return 2; } };
          const observed = consumeNode(current, current = replacement);
          return observed * 10 + current.kind;
        }
      `,
      {
        fileName: "issue-1058-standalone-optional-reference-snapshot.ts",
        skipSemanticDiagnostics: true,
        target: "standalone",
      },
    );

    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    const exports = await instantiate(result);
    expect(exports.testOmitted()).toBe(-1);
    expect(exports.testUndefined()).toBe(-1);
    expect(exports.testPopulated()).toBe(7);
    expect(exports.testOrder()).toBe(79);
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
