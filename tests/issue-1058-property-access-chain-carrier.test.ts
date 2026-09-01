// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { assertedStructFactoryExpression } from "../src/codegen/generic-struct-factory.js";
import { compile, compileMulti } from "../src/index.js";
import { ts } from "../src/ts-api.js";

function typedSource(source: string): { checker: ts.TypeChecker; sourceFile: ts.SourceFile } {
  const fileName = "/asserted-fresh-wrapper.ts";
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.ES2022 };
  const sourceFile = ts.createSourceFile(fileName, source, options.target!, true, ts.ScriptKind.TS);
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? source : undefined);
  host.getSourceFile = (name) => (name === fileName ? sourceFile : undefined);
  host.writeFile = () => {};
  const program = ts.createProgram([fileName], options, host);
  return { checker: program.getTypeChecker(), sourceFile };
}

describe("#1058 property-access-chain factory carrier", () => {
  it("declines a fresh wrapper that exposes its source as a method receiver", () => {
    const { checker, sourceFile } = typedSource(`
      interface Base { value: number; leak(): void }
      interface Derived extends Base { extra: number }
      let escaped: Base;
      function createBase(): Base {
        const node: Base = {
          value: 1,
          leak() { escaped = this; },
        };
        node.leak();
        return node;
      }
      const result = createBase() as Derived;
    `);
    let assertion: ts.AsExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node)) assertion = node;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(assertion).toBeDefined();
    const context = {
      checker,
      callableSourceFiles: [sourceFile],
      oracle: {
        valueDeclarationOf(node: ts.Node) {
          const symbol = checker.getSymbolAtLocation(node);
          return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        },
      },
    } as unknown as Parameters<typeof assertedStructFactoryExpression>[0];
    expect(assertedStructFactoryExpression(context, assertion!)).toBeNull();
  });

  it("extends a fresh base property-access node without null-narrowing it", async () => {
    const result = await compile(
      `
        type Mutable<T> = { -readonly [P in keyof T]: T[P] };

        interface Node {
          readonly kind: number;
          readonly pos: number;
          readonly end: number;
          readonly flags: number;
          readonly transformFlags: number;
          readonly parent: Node;
        }

        interface PropertyAccessExpression extends Node {
          readonly expression: Node;
          readonly name: Node;
        }

        interface PropertyAccessChain extends PropertyAccessExpression {
          readonly questionDotToken: Node | undefined;
        }

        interface BaseNodeFactory {
          createBaseNode(kind: number): Node;
        }

        function RuntimeNode(this: Mutable<Node>, kind: number, pos: number, end: number): void {
          this.kind = kind;
          this.pos = pos;
          this.end = end;
          this.flags = 0;
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
          function createBaseNode<T extends Node>(kind: T["kind"]): Mutable<T> {
            return baseFactory.createBaseNode(kind) as Mutable<T>;
          }

          function createBasePropertyAccessExpression(
            expression: Node,
            questionDotToken: Node | undefined,
            name: Node,
          ): PropertyAccessExpression {
            const node = createBaseNode<PropertyAccessExpression>(211);
            node.expression = expression;
            node.name = name;
            return node;
          }

          function createPropertyAccessChain(
            expression: Node,
            questionDotToken: Node | undefined,
            name: Node,
          ): PropertyAccessChain {
            const node = createBasePropertyAccessExpression(expression, questionDotToken, name) as Mutable<PropertyAccessChain>;
            node.questionDotToken = questionDotToken;
            node.flags |= 64;
            node.transformFlags |= 32;
            return node;
          }

          return { createPropertyAccessChain };
        }

        export function run(): number {
          const factory = createNodeFactory(createBaseNodeFactory());
          const { createPropertyAccessChain: factoryCreatePropertyAccessChain } = factory;
          const expression: Node = { kind: 7, pos: 0, end: 0, flags: 0, transformFlags: 0, parent: undefined! };
          const name: Node = { kind: 8, pos: 0, end: 0, flags: 0, transformFlags: 0, parent: undefined! };
          const node = factoryCreatePropertyAccessChain(expression, undefined, name);
          return node.kind + node.expression.kind * 10 + node.name.kind * 100 + node.flags + node.transformFlags;
        }
      `,
      { fileName: "property-access-chain-carrier.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    expect((instance.exports.run as Function)()).toBe(1177);
  });

  it("preserves the concrete carrier through a generic base-declaration wrapper", async () => {
    const result = await compile(
      `
        type Mutable<T> = { -readonly [P in keyof T]: T[P] };

        interface Node {
          readonly kind: number;
          readonly pos: number;
          readonly end: number;
          readonly flags: number;
          readonly transformFlags: number;
          readonly parent: Node;
        }

        interface Declaration extends Node {
          readonly symbol: object;
          readonly localSymbol: object | undefined;
        }

        interface PropertyAccessExpression extends Declaration {
          readonly expression: Node;
          readonly name: Node;
        }

        interface PropertyAccessChain extends PropertyAccessExpression {
          readonly questionDotToken: Node | undefined;
        }

        interface BaseNodeFactory {
          createBaseNode(kind: number): Node;
        }

        function RuntimeNode(this: Mutable<Node>, kind: number, pos: number, end: number): void {
          this.kind = kind;
          this.pos = pos;
          this.end = end;
          this.flags = 0;
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
          function createBaseNode<T extends Node>(kind: T["kind"]): Mutable<T> {
            return baseFactory.createBaseNode(kind) as Mutable<T>;
          }

          function createBaseDeclaration<T extends Declaration>(kind: T["kind"]) {
            const node = createBaseNode(kind);
            node.symbol = undefined!;
            node.localSymbol = undefined;
            return node;
          }

          function createBasePropertyAccessExpression(
            expression: Node,
            questionDotToken: Node | undefined,
            name: Node,
          ): PropertyAccessExpression {
            const node = createBaseDeclaration<PropertyAccessExpression>(211);
            node.expression = expression;
            node.name = name;
            return node;
          }

          function createPropertyAccessChain(
            expression: Node,
            questionDotToken: Node | undefined,
            name: Node,
          ): PropertyAccessChain {
            const node = createBasePropertyAccessExpression(expression, questionDotToken, name) as Mutable<PropertyAccessChain>;
            node.questionDotToken = questionDotToken;
            node.flags |= 64;
            node.transformFlags |= 32;
            return node;
          }

          return { createPropertyAccessChain };
        }

        export function run(): number {
          const factory = createNodeFactory(createBaseNodeFactory());
          const { createPropertyAccessChain: factoryCreatePropertyAccessChain } = factory;
          const expression: Node = { kind: 7, pos: 0, end: 0, flags: 0, transformFlags: 0, parent: undefined! };
          const name: Node = { kind: 8, pos: 0, end: 0, flags: 0, transformFlags: 0, parent: undefined! };
          const node = factoryCreatePropertyAccessChain(expression, undefined, name);
          return node.kind + node.expression.kind * 10 + node.name.kind * 100 + node.flags + node.transformFlags;
        }
      `,
      { fileName: "property-access-chain-declaration-carrier.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    expect((instance.exports.run as Function)()).toBe(1177);
  });

  it("keeps TypeScript's property-access chain on its shared syntax-node carrier", async () => {
    const result = await compileMulti(
      {
        "./src/compiler/types.ts": `
          // The brands are never actually given values. At runtime they have zero cost.
          export type Mutable<T> = { -readonly [P in keyof T]: T[P] };

          export interface Node {
            readonly pos: number;
            readonly end: number;
            readonly kind: number;
            readonly flags: number;
            modifierFlagsCache: number;
            readonly transformFlags: number;
            readonly parent: Node;
          }

          export interface Declaration extends Node {
            _declarationBrand: any;
          }
          export interface NamedDeclaration extends Declaration {
            readonly name?: Node;
          }
          export interface Expression extends Node { _expressionBrand: any; }
          export interface UnaryExpression extends Expression { _unaryExpressionBrand: any; }
          export interface UpdateExpression extends UnaryExpression { _updateExpressionBrand: any; }
          export interface LeftHandSideExpression extends UpdateExpression { _leftHandSideExpressionBrand: any; }
          export interface MemberExpression extends LeftHandSideExpression { _memberExpressionBrand: any; }
          export interface JSDocContainer extends Node {
            _jsdocContainerBrand: any;
            jsDoc?: readonly Node[];
          }
          export interface FlowContainer extends Node {
            _flowContainerBrand: any;
            flowNode?: Node;
          }
          export interface PropertyAccessExpression extends MemberExpression, NamedDeclaration, JSDocContainer, FlowContainer {
            readonly kind: number;
            readonly expression: LeftHandSideExpression;
            readonly questionDotToken?: Node;
            readonly name: Node;
          }
          export interface PropertyAccessChain extends PropertyAccessExpression {
            _optionalChainBrand: any;
            readonly name: Node;
          }

          export interface BaseNodeFactory { createBaseNode(kind: number): Node; }
          export interface NodeFactory {
            createPropertyAccessChain(
              expression: LeftHandSideExpression,
              questionDotToken: Node | undefined,
              name: Node,
            ): PropertyAccessChain;
          }
        `,
        "./src/compiler/base.ts": `
          import type { BaseNodeFactory, Mutable, Node } from "./types.js";

          function RuntimeNode(this: Mutable<Node>, kind: number, pos: number, end: number): void {
            this.pos = pos;
            this.end = end;
            this.kind = kind;
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
        "./src/compiler/factory.ts": `
          import type {
            BaseNodeFactory,
            LeftHandSideExpression,
            Mutable,
            Node,
            NodeFactory,
            PropertyAccessChain,
            PropertyAccessExpression,
          } from "./types.js";

          export function createNodeFactory(baseFactory: BaseNodeFactory): NodeFactory {
            function createBaseNode<T extends Node>(kind: T["kind"]): Mutable<T> {
              return baseFactory.createBaseNode(kind) as Mutable<T>;
            }

            function createBasePropertyAccessExpression(
              expression: LeftHandSideExpression,
              questionDotToken: Node | undefined,
              name: Node,
            ): PropertyAccessExpression {
              const node = createBaseNode<PropertyAccessExpression>(212);
              node.expression = expression;
              node.questionDotToken = questionDotToken;
              node.name = name;
              node.transformFlags = node.expression.kind | node.name.kind;
              node.jsDoc = undefined;
              node.flowNode = undefined;
              return node;
            }

            function createPropertyAccessChain(
              expression: LeftHandSideExpression,
              questionDotToken: Node | undefined,
              name: Node,
            ): PropertyAccessChain {
              const node = createBasePropertyAccessExpression(expression, questionDotToken, name) as Mutable<PropertyAccessChain>;
              node.flags |= 64;
              node.transformFlags |= 32;
              return node;
            }

            return { createPropertyAccessChain };
          }
        `,
        "./src/compiler/parser.ts": `
          import type { LeftHandSideExpression, Node } from "./types.js";
          import { createBaseNodeFactory } from "./base.js";
          import { createNodeFactory } from "./factory.js";

          const factory = createNodeFactory(createBaseNodeFactory());
          const { createPropertyAccessChain: factoryCreatePropertyAccessChain } = factory;

          export function test(): number {
            const expression = {
              pos: 1, end: 2, kind: 7, flags: 0, modifierFlagsCache: 0, transformFlags: 0, parent: undefined!,
            } as LeftHandSideExpression;
            const name: Node = {
              pos: 3, end: 4, kind: 8, flags: 0, modifierFlagsCache: 0, transformFlags: 0, parent: undefined!,
            };
            const node = factoryCreatePropertyAccessChain(expression, undefined, name);
            return node.kind + node.expression.kind * 10 + node.name.kind * 100 + node.flags + node.transformFlags;
          }
        `,
      },
      "./src/compiler/parser.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    expect((instance.exports.test as Function)()).toBe(1193);
  });
});
