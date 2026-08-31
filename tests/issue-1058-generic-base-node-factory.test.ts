// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, compileMulti, wrapExports } from "../src/index.js";

async function instantiate(result: Awaited<ReturnType<typeof compile>>) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  let validationError: unknown;
  try {
    new WebAssembly.Module(result.binary);
  } catch (error) {
    validationError = error;
  }
  expect(validationError).toBeUndefined();
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

describe("#1058 generic base-node factories", () => {
  it("keeps a memoized callback's later factory capture live", async () => {
    const result = await compileMulti(
      {
        "./core.ts": `
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
        "./factory.ts": `
          import { memoize } from "./core.js";

          interface Rules { value: number; }

          export function createFactory() {
            const rules = memoize((): Rules => ({ value: factory.seed }));
            const factory = {
              seed: 41,
              create(): number { return rules().value + 1; },
            };
            return factory;
          }
        `,
        "./entry.ts": `
          import { createFactory } from "./factory.js";
          const factory = createFactory();
          export function test(): number { return factory.create(); }
        `,
      },
      "./entry.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect((await instantiate(result)).test()).toBe(42);
  });

  it("dispatches a captured callable returned by a cross-module generic memoizer", async () => {
    const result = await compileMulti(
      {
        "./core.ts": `
          export function memoize<T>(callback: () => T): () => T {
            let value: T | undefined;
            return () => value || (value = callback());
          }
        `,
        "./factory.ts": `
          import { memoize } from "./core.js";

          interface Rules { value: number; }

          export function createFactory() {
            const rules = memoize((): Rules => ({ value: 41 }));
            function create(): number {
              return rules().value + 1;
            }
            return { create };
          }
        `,
        "./entry.ts": `
          import { createFactory } from "./factory.js";
          const factory = createFactory();
          export function test(): number { return factory.create(); }
        `,
      },
      "./entry.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect((await instantiate(result)).test()).toBe(42);
  });

  it("does not materialize an arbitrary cached getter as a fresh generic factory", async () => {
    const result = await compile(
      `
        interface Node { kind: number; }
        interface DerivedNode extends Node { extra: number; }

        const cached: DerivedNode = { kind: 7, extra: 9 };

        function getCachedNode(): Node {
          return cached;
        }

        function getAs<T extends Node>(): T {
          return getCachedNode() as T;
        }

        export function test(): number {
          const first = getAs<DerivedNode>();
          const second = getAs<DerivedNode>();
          return first === second ? 1 : 0;
        }
      `,
      { fileName: "issue-1058-cached-generic-getter.ts", skipSemanticDiagnostics: true },
    );

    expect((await instantiate(result)).test()).toBe(1);
  });

  it("keeps prepared multi-module generic node factories on the materializing frontend", async () => {
    const result = await compileMulti(
      {
        "./entry.ts": `
        type Mutable<T> = { -readonly [P in keyof T]: T[P] };

        interface Node {
          readonly kind: number;
          readonly pos: number;
          readonly end: number;
          readonly flags: number;
          modifierFlagsCache: number;
          readonly transformFlags: number;
          readonly parent: Node;
        }

        interface JSDocContainer extends Node {
          _jsdocContainerBrand: any;
          jsDoc?: Node[];
        }

        interface FlowContainer extends Node {
          _flowContainerBrand: any;
          flowNode?: unknown;
        }

        interface Expression extends Node {
          _expressionBrand: any;
        }

        interface SymbolInfo {
          id: number;
        }

        interface Declaration extends Node {
          _declarationBrand: any;
          symbol: SymbolInfo;
          localSymbol?: SymbolInfo;
        }

        interface Statement extends Node, JSDocContainer {
          _statementBrand: any;
        }

        interface ExpressionStatement extends Statement, FlowContainer {
          readonly expression: Expression;
        }

        interface IterationStatement extends Statement {
          readonly statement: Statement;
        }

        interface DoStatement extends IterationStatement, FlowContainer {
          readonly expression: Expression;
        }

        interface WhileStatement extends IterationStatement, FlowContainer {
          readonly expression: Expression;
        }

        interface BinaryExpression extends Expression, Declaration, JSDocContainer {
          readonly left: Expression;
          readonly operatorToken: Node;
          readonly right: Expression;
        }

        interface BaseNodeFactory {
          createBaseNode(kind: number): Node;
        }

        function RuntimeNode(this: Mutable<Node>, kind: number, pos: number, end: number): void {
          this.kind = kind;
          this.pos = pos;
          this.end = end;
          this.flags = 0;
          this.modifierFlagsCache = 0;
          this.transformFlags = 0;
          this.parent = undefined!;
        }

        const objectAllocator = {
          getNodeConstructor: () => RuntimeNode as any,
        };

        function createBaseNodeFactory(): BaseNodeFactory {
          let NodeConstructor: new (kind: number, pos: number, end: number) => Node;
          return { createBaseNode };

          function createBaseNode(kind: number): Node {
            return new (NodeConstructor || (NodeConstructor = objectAllocator.getNodeConstructor()))(kind, -1, -1);
          }
        }

        function createNodeFactory(baseFactory: BaseNodeFactory) {
          function createBaseNode<T extends Node>(kind: T["kind"]) {
            return baseFactory.createBaseNode(kind) as Mutable<T>;
          }

          function createBaseDeclaration<T extends Declaration>(kind: T["kind"]) {
            const node = createBaseNode(kind);
            node.symbol = undefined!;
            node.localSymbol = undefined;
            return node;
          }

          function createExpressionStatement(expression: Expression): ExpressionStatement {
            const node = createBaseNode<ExpressionStatement>(244);
            node.expression = expression;
            node.transformFlags |= expression.transformFlags;
            node.jsDoc = undefined;
            node.flowNode = undefined;
            return node;
          }

          function createBinaryExpression(
            left: Expression,
            operatorToken: Node,
            right: Expression,
          ): BinaryExpression {
            const node = createBaseDeclaration<BinaryExpression>(226);
            node.left = left;
            node.operatorToken = operatorToken;
            node.right = right;
            node.transformFlags |= left.transformFlags | operatorToken.transformFlags | right.transformFlags;
            node.jsDoc = undefined;
            return node;
          }

          function createDoStatement(statement: Statement, expression: Expression): DoStatement {
            const node = createBaseNode<DoStatement>(229);
            node.statement = statement;
            node.expression = expression;
            node.jsDoc = undefined;
            node.flowNode = undefined;
            return node;
          }

          function createWhileStatement(expression: Expression, statement: Statement): WhileStatement {
            const node = createBaseNode<WhileStatement>(230);
            node.expression = expression;
            node.statement = statement;
            node.jsDoc = undefined;
            node.flowNode = undefined;
            return node;
          }

          return { createExpressionStatement, createBinaryExpression, createDoStatement, createWhileStatement };
        }

        const factory = createNodeFactory(createBaseNodeFactory());

        export function test(): number {
          const expression: Expression = {
            kind: 80,
            pos: 1,
            end: 2,
            flags: 0,
            modifierFlagsCache: 0,
            transformFlags: 8,
            parent: undefined!,
            _expressionBrand: undefined,
          };
          const operatorToken: Node = {
            kind: 40,
            pos: 3,
            end: 4,
            flags: 0,
            modifierFlagsCache: 0,
            transformFlags: 4,
            parent: undefined!,
          };
          const statement = factory.createExpressionStatement(expression);
          const binary = factory.createBinaryExpression(expression, operatorToken, expression);
          const doStatement = factory.createDoStatement(statement, expression);
          const whileStatement = factory.createWhileStatement(expression, statement);
          return statement.kind
            + statement.expression.kind
            + statement.transformFlags
            + binary.kind
            + binary.left.kind
            + binary.operatorToken.kind
            + binary.right.kind
            + binary.transformFlags
            + doStatement.kind
            + doStatement.statement.kind
            + doStatement.expression.kind
            + whileStatement.kind
            + whileStatement.statement.kind
            + whileStatement.expression.kind;
        }
        `,
      },
      "./entry.ts",
      { fileName: "issue-1058-expression-statement-base-node.ts", skipSemanticDiagnostics: true },
    );

    expect((await instantiate(result)).test()).toBe(1877);
  });

  it("materializes TypeScript's Node-constrained generic token factory as Token<TKind>", async () => {
    const result = await compile(
      `
        type Mutable<T> = { -readonly [P in keyof T]: T[P] };

        interface Node {
          kind: number;
          pos: number;
          end: number;
          flags: number;
          transformFlags: number;
          parent: Node;
        }

        interface Token<TKind extends number> extends Node {
          kind: TKind;
        }

        interface BaseNodeFactory {
          createBaseTokenNode(kind: number): Node;
        }

        interface ObjectAllocator {
          getTokenConstructor(): new (kind: number, pos: number, end: number) => Node;
        }

        function RuntimeToken(this: Mutable<Node>, kind: number, pos: number, end: number): void {
          this.kind = kind;
          this.pos = pos;
          this.end = end;
          this.flags = 0;
          this.transformFlags = 0;
          this.parent = undefined!;
        }

        const objectAllocator: ObjectAllocator = {
          getTokenConstructor: () => RuntimeToken as any,
        };

        function createBaseNodeFactory(): BaseNodeFactory {
          let TokenConstructor: new (kind: number, pos: number, end: number) => Node;
          return { createBaseTokenNode };

          function createBaseTokenNode(kind: number): Node {
            return new (TokenConstructor || (TokenConstructor = objectAllocator.getTokenConstructor()))(kind, -1, -1);
          }
        }

        function createNodeFactory(baseFactory: BaseNodeFactory) {
          function createBaseToken<T extends Node>(kind: T["kind"]) {
            return baseFactory.createBaseTokenNode(kind) as Mutable<T>;
          }

          function createToken<TKind extends number>(kind: TKind): Token<TKind> {
            const node = createBaseToken<Token<TKind>>(kind);
            node.transformFlags = 4;
            return node;
          }

          return { createToken };
        }

        const factory = createNodeFactory(createBaseNodeFactory());

        export function test(): number {
          const token = factory.createToken(2);
          return token.kind + token.pos + token.end + token.transformFlags;
        }
      `,
      { fileName: "issue-1058-node-constrained-token-factory.ts", skipSemanticDiagnostics: true },
    );

    expect((await instantiate(result)).test()).toBe(4);
  });

  it("keeps a cross-module base allocator on Node before generic sibling refinements", async () => {
    const result = await compileMulti(
      {
        "./types.ts": `
          export type Mutable<T> = { -readonly [P in keyof T]: T[P] };
          export interface Node { kind: number; pos: number; end: number; parent: Node; }
          export interface Declaration extends Node { symbol: unknown; localSymbol?: unknown; }
          export interface Expression extends Node { value: number; }
          export interface ExpressionStatement extends Node { expression: Expression; }

          function RuntimeNode(this: Mutable<Node>, kind: number, pos: number, end: number): void {
            this.kind = kind;
            this.pos = pos;
            this.end = end;
            this.parent = undefined!;
          }
          export const objectAllocator = { getNodeConstructor: () => RuntimeNode as any };
        `,
        "./base.ts": `
          import { type Node, objectAllocator } from "./types.js";
          export interface BaseNodeFactory {
            createBaseTokenNode(kind: number): Node;
            createBaseNode(kind: number): Node;
          }

          export function createBaseNodeFactory(): BaseNodeFactory {
            let NodeConstructor: new (kind: number, pos: number, end: number) => Node;
            let TokenConstructor: new (kind: number, pos: number, end: number) => Node;
            return { createBaseTokenNode, createBaseNode };
            function createBaseTokenNode(kind: number): Node {
              return new (TokenConstructor || (TokenConstructor = objectAllocator.getNodeConstructor()))(kind, -1, -1);
            }
            function createBaseNode(kind: number): Node {
              return new (NodeConstructor || (NodeConstructor = objectAllocator.getNodeConstructor()))(kind, -1, -1);
            }
          }
        `,
        "./factory.ts": `
          import { type BaseNodeFactory } from "./base.js";
          import { type Declaration, type Expression, type ExpressionStatement, type Mutable, type Node } from "./types.js";

          export function createNodeFactory(baseFactory: BaseNodeFactory) {
            function createBaseNode<T extends Node>(kind: T["kind"]) {
              return baseFactory.createBaseNode(kind) as Mutable<T>;
            }
            function createBaseDeclaration<T extends Declaration>(kind: T["kind"]) {
              const node = createBaseNode(kind);
              node.symbol = undefined!;
              node.localSymbol = undefined;
              return node;
            }
            function createDeclaration(): Declaration {
              return createBaseDeclaration<Declaration>(1);
            }
            function createExpressionStatement(expression: Expression): ExpressionStatement {
              const node = createBaseNode<ExpressionStatement>(2);
              node.expression = expression;
              return node;
            }
            return { createDeclaration, createExpressionStatement };
          }
        `,
        "./entry.ts": `
          import { createBaseNodeFactory } from "./base.js";
          import { createNodeFactory } from "./factory.js";
          import { type Expression } from "./types.js";

          const factory = createNodeFactory(createBaseNodeFactory());
          export function test(): number {
            const declaration = factory.createDeclaration();
            const expression: Expression = { kind: 3, pos: 4, end: 5, parent: undefined!, value: 6 };
            const statement = factory.createExpressionStatement(expression);
            return declaration.kind + statement.kind + statement.expression.value;
          }
        `,
      },
      "./entry.ts",
      { experimentalIR: true, trackIrOutcomes: true, resolve: { consumerDrivenBarrels: true } },
    );

    expect((await instantiate(result)).test()).toBe(9);
  });

  it("does not freeze createBaseNode<T> to the first sibling node layout", async () => {
    const result = await compile(
      `
        type Mutable<T> = { -readonly [P in keyof T]: T[P] };

        interface Node {
          kind: number;
          pos: number;
          end: number;
          flags: number;
          parent: Node;
        }

        interface Identifier extends PrimaryExpression, Declaration {
          escapedText: string;
          jsDoc?: Node[];
          flowNode?: unknown;
          symbol: unknown;
        }

        type TokenSyntaxKind = 1 | 2;

        interface Token<TKind extends TokenSyntaxKind> extends Node {
          kind: TKind;
        }

        interface Declaration extends Node {
          symbol: unknown;
          localSymbol?: unknown;
        }

        // Match TypeScript's real declaration order: Identifier appears before
        // the expression hierarchy it extends. The backend must precollect the
        // stable base chain so Identifier can retain nominal runtime identity.
        interface Expression extends Node {
          _expressionBrand: any;
          value: number;
        }

        interface PrimaryExpression extends Expression {
          _primaryExpressionBrand: any;
        }

        interface NumericLiteral extends Declaration {
          text: string;
          numericLiteralFlags: number;
        }

        interface ExpressionStatement extends Node {
          expression: Expression;
          jsDoc?: Node[];
          flowNode?: unknown;
        }

        // The parent factory materialization widens expression to its
        // initially-missing nullable carrier. Its nominal descendants must
        // retain the exact mutable prefix required by WasmGC subtyping.
        interface SpecializedExpressionStatement extends ExpressionStatement {
          specializationFlags: number;
        }

        interface BaseNodeFactory {
          createBaseIdentifierNode(kind: number): Node;
          createBaseTokenNode(kind: number): Node;
          createBaseNode(kind: number): Node;
        }

        function RuntimeNode(this: Mutable<Node>, kind: number, pos: number, end: number): void {
          this.kind = kind;
          this.pos = pos;
          this.end = end;
          this.flags = 0;
          this.parent = undefined!;
        }

        interface ObjectAllocator {
          getNodeConstructor(): new (kind: number, pos: number, end: number) => Node;
        }

        const objectAllocator: ObjectAllocator = {
          getNodeConstructor: () => RuntimeNode as any,
        };

        function createBaseNodeFactory(): BaseNodeFactory {
          let NodeConstructor: new (kind: number, pos: number, end: number) => Node;
          return { createBaseIdentifierNode, createBaseTokenNode, createBaseNode };

          function createBaseIdentifierNode(kind: number): Node {
            return new (NodeConstructor || (NodeConstructor = objectAllocator.getNodeConstructor()))(kind, -1, -1);
          }

          function createBaseTokenNode(kind: number): Node {
            return new (NodeConstructor || (NodeConstructor = objectAllocator.getNodeConstructor()))(kind, -1, -1);
          }

          function createBaseNode(kind: number): Node {
            return new (NodeConstructor || (NodeConstructor = objectAllocator.getNodeConstructor()))(kind, -1, -1);
          }
        }

        function createNodeFactory(baseFactory: BaseNodeFactory) {
          function createBaseNode<T extends Node>(kind: T["kind"]) {
            return baseFactory.createBaseNode(kind) as Mutable<T>;
          }

          function createBaseToken<TKind extends TokenSyntaxKind>(kind: TKind) {
            return baseFactory.createBaseTokenNode(kind) as Mutable<Token<TKind>>;
          }

          function createBaseDeclaration<T extends Declaration>(kind: T["kind"]) {
            const node = createBaseNode(kind);
            node.symbol = undefined!;
            node.localSymbol = undefined;
            return node;
          }

          function createBaseIdentifier(escapedText: string): Identifier {
            const node = baseFactory.createBaseIdentifierNode(81) as Mutable<Identifier>;
            node.escapedText = escapedText;
            node.jsDoc = undefined;
            node.flowNode = undefined;
            node.symbol = undefined!;
            return node;
          }

          function createIdentifier(text: string): Identifier {
            const node = createBaseNode<Identifier>(80);
            node.escapedText = text;
            node.jsDoc = undefined;
            node.flowNode = undefined;
            node.symbol = undefined!;
            return node;
          }

          function createDirectIdentifier(text: string): Identifier {
            return createBaseIdentifier(text);
          }

          function createToken<TKind extends TokenSyntaxKind>(kind: TKind): Token<TKind> {
            return createBaseToken(kind);
          }

          function createExpressionStatement(expression: Expression): ExpressionStatement {
            const node = createBaseNode<ExpressionStatement>(244);
            node.expression = expression;
            node.jsDoc = undefined;
            node.flowNode = undefined;
            return node;
          }

          function createNumericLiteral(text: string): NumericLiteral {
            const node = createBaseDeclaration<NumericLiteral>(9);
            node.text = text;
            node.numericLiteralFlags = 3;
            return node;
          }

          return { createIdentifier, createDirectIdentifier, createToken, createExpressionStatement, createNumericLiteral };
        }

        const baseFactory = createBaseNodeFactory();
        const factory = createNodeFactory(baseFactory);

        export function test(): number {
          const identifier = factory.createIdentifier("id");
          const directIdentifier = factory.createDirectIdentifier("direct");
          const token = factory.createToken(2);
          const expression: Expression = {
            kind: 9,
            pos: 1,
            end: 2,
            flags: 3,
            parent: undefined!,
            value: 7,
          };
          const statement = factory.createExpressionStatement(expression);
          const identifierStatement = factory.createExpressionStatement(identifier);
          const literal = factory.createNumericLiteral("42");
          return identifier.kind
            + identifier.escapedText.length
            + directIdentifier.kind
            + directIdentifier.escapedText.length
            + token.kind
            + statement.kind
            + statement.expression.value
            + identifierStatement.expression.kind
            + (identifierStatement.expression === identifier ? 1 : 0)
            + literal.kind
            + literal.text.length
            + literal.numericLiteralFlags;
        }
      `,
      { fileName: "issue-1058-generic-base-node-factory.ts", skipSemanticDiagnostics: true },
    );

    expect((await instantiate(result)).test()).toBe(517);
  });

  it("preserves a literal's nominal identity across a diamond interface return", async () => {
    const result = await compileMulti(
      {
        "./types.ts": `
          export type Mutable<T> = { -readonly [P in keyof T]: T[P] };
          export interface Node {
            kind: number;
            pos: number;
            end: number;
            flags: number;
            modifierFlagsCache: number;
            transformFlags: number;
            parent: Node;
          }
          export interface SymbolInfo { id: number; }
          export interface Declaration extends Node { symbol: SymbolInfo; localSymbol?: SymbolInfo; }
          export interface MemberExpression extends Node { _memberBrand: any; }
          export interface PrimaryExpression extends MemberExpression { _primaryBrand: any; }
          export interface LiteralLikeNode extends Node {
            text: string;
            isUnterminated?: boolean;
            hasExtendedUnicodeEscape?: boolean;
          }
          export interface LiteralExpression extends LiteralLikeNode, PrimaryExpression { _literalBrand: any; }
          export interface StringLiteral extends LiteralExpression, Declaration { singleQuote?: boolean; }
          export interface BaseNodeFactory { createBaseNode(kind: number): Node; }
        `,
        "./base.ts": `
          import type { BaseNodeFactory, Mutable, Node } from "./types.js";

          function RuntimeNode(this: Mutable<Node>, kind: number, pos: number, end: number): void {
            this.kind = kind;
            this.pos = pos;
            this.end = end;
            this.flags = 0;
            this.modifierFlagsCache = 0;
            this.transformFlags = 0;
            this.parent = undefined!;
          }

          const objectAllocator = { getNodeConstructor: () => RuntimeNode as any };

          export function createBaseNodeFactory(): BaseNodeFactory {
            let NodeConstructor: new (kind: number, pos: number, end: number) => Node;
            return { createBaseNode };

            function createBaseNode(kind: number): Node {
              return new (NodeConstructor || (NodeConstructor = objectAllocator.getNodeConstructor()))(kind, -1, -1);
            }
          }
        `,
        "./factory.ts": `
          import type { BaseNodeFactory, Declaration, Mutable, Node, StringLiteral } from "./types.js";

          export function createNodeFactory(baseFactory: BaseNodeFactory) {
            function createBaseNode<T extends Node>(kind: T["kind"]) {
              return baseFactory.createBaseNode(kind) as Mutable<T>;
            }
            function createBaseDeclaration<T extends Declaration>(kind: T["kind"]) {
              const node = createBaseNode(kind);
              node.symbol = undefined!;
              node.localSymbol = undefined;
              return node;
            }
            function createBaseStringLiteral(text: string, isSingleQuote?: boolean) {
              const node = createBaseDeclaration<StringLiteral>(11);
              node.text = text;
              node.singleQuote = isSingleQuote;
              return node;
            }
            function createStringLiteral(
              text: string,
              isSingleQuote?: boolean,
              hasExtendedUnicodeEscape?: boolean,
            ): StringLiteral {
              const node = createBaseStringLiteral(text, isSingleQuote);
              node.hasExtendedUnicodeEscape = hasExtendedUnicodeEscape;
              if (hasExtendedUnicodeEscape) node.transformFlags |= 4;
              return node;
            }
            return { createStringLiteral };
          }
        `,
        "./parser.ts": `
          import type { LiteralExpression, LiteralLikeNode } from "./types.js";
          import { createBaseNodeFactory } from "./base.js";
          import { createNodeFactory } from "./factory.js";

          const factory = createNodeFactory(createBaseNodeFactory());
          function parseLiteralLikeNode(): LiteralLikeNode {
            const node = factory.createStringLiteral("5.9", undefined, false);
            if (false) node.isUnterminated = true;
            return node;
          }
          function parseLiteralNode(): LiteralExpression {
            return parseLiteralLikeNode() as LiteralExpression;
          }
          export function test(): number {
            const node = parseLiteralNode();
            return node.text.length * 100 + node.kind;
          }
        `,
      },
      "./parser.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect((await instantiate(result)).test()).toBe(311);
  });
});
