// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, compileMulti, wrapExports } from "../src/index.js";

async function instantiate(result: Awaited<ReturnType<typeof compile>>) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

describe("#1058 late-assigned Identifier constructor", () => {
  it("constructs a local Node function that shares its imported interface name", async () => {
    const result = await compileMulti(
      {
        "./types.ts": `
          export type Mutable<T> = { -readonly [P in keyof T]: T[P] };
          export interface Node {
            kind: number;
            pos: number;
            end: number;
            id: number;
            flags: number;
            modifierFlagsCache: number;
            transformFlags: number;
            parent: Node;
            original?: Node;
            emitNode?: unknown;
          }
        `,
        "./utilities.ts": `
          import { type Mutable, type Node } from "./types.js";

          function Node(this: Mutable<Node>, kind: number, pos: number, end: number): void {
            this.pos = pos;
            this.end = end;
            this.kind = kind;
            this.id = 0;
            this.flags = 0;
            this.modifierFlagsCache = 0;
            this.transformFlags = 0;
            this.parent = undefined!;
            this.original = undefined;
            this.emitNode = undefined;
          }

          export const objectAllocator = { getNodeConstructor: () => Node as any };
        `,
        "./base.ts": `
          import { type Node } from "./types.js";
          import { objectAllocator } from "./utilities.js";

          export function createBaseNodeFactory() {
            let NodeConstructor: new (kind: number, pos: number, end: number) => Node;
            return { createBaseNode };
            function createBaseNode(kind: number): Node {
              return new (NodeConstructor || (NodeConstructor = objectAllocator.getNodeConstructor()))(kind, -1, -1);
            }
          }
        `,
        "./entry.ts": `
          import { createBaseNodeFactory } from "./base.js";
          const factory = createBaseNodeFactory();
          export function test(): number {
            const node = factory.createBaseNode(245);
            return node.kind + node.pos + node.end;
          }
        `,
      },
      "./entry.ts",
      { resolve: { consumerDrivenBarrels: true } },
    );

    expect((await instantiate(result)).test()).toBe(243);
  });

  it("constructs through a callable returned by an imported object allocator", async () => {
    const result = await compileMulti(
      {
        "./utilities.ts": `
          import { NodeFlags } from "./namespace.js";

          export type Mutable<T> = { -readonly [P in keyof T]: T[P] };

          export interface Node {
            kind: number;
            pos: number;
            end: number;
            flags: number;
            parent: Node;
          }

          function RuntimeNode(this: Mutable<Node>, kind: number, pos: number, end: number): void {
            this.kind = kind;
            this.pos = pos;
            this.end = end;
            this.flags = NodeFlags.None;
            this.parent = undefined!;
          }

          export const objectAllocator = {
            getNodeConstructor: () => RuntimeNode as any,
          };
        `,
        "./base.ts": `
          import { type Node, objectAllocator } from "./namespace.js";

          const dynamicAllocator: any = objectAllocator;

          export function createBaseNodeFactory() {
            let NodeConstructor: new (kind: number, pos: number, end: number) => Node;
            return { createBaseNode };

            function createBaseNode(kind: number): Node {
              return new (NodeConstructor || (NodeConstructor = dynamicAllocator.getNodeConstructor()))(
                kind,
                -1,
                -1,
              );
            }
          }
        `,
        "./syntax.ts": `export enum NodeFlags { None = 0 }`,
        "./namespace.ts": `
          export * from "./syntax.js";
          export * from "./utilities.js";
        `,
        "./entry.ts": `
          import { createBaseNodeFactory } from "./base.js";

          const factory = createBaseNodeFactory();
          export function test(): number {
            const node = factory.createBaseNode(42);
            return node.kind + node.pos + node.end + node.flags;
          }
        `,
      },
      "./entry.ts",
      { resolve: { consumerDrivenBarrels: true } },
    );

    const exports = await instantiate(result);
    expect(exports.test()).toBe(40);
  });

  it("passes the allocated Identifier as `this` without shifting source arguments", async () => {
    const result = await compile(
      `
        type Mutable<T> = { -readonly [P in keyof T]: T[P] };

        interface Node {
          kind: number;
          pos: number;
          end: number;
          id: number;
          flags: number;
          transformFlags: number;
          parent: Node;
          original?: Node;
          emitNode?: unknown;
        }

        interface Identifier extends Node {
          escapedText: string;
          jsDoc?: Node[];
          flowNode?: unknown;
          symbol: unknown;
        }

        interface BaseNodeFactory {
          createBaseIdentifierNode(kind: number): Node;
        }

        function createNodeFactory(baseFactory: BaseNodeFactory) {
          function createBaseIdentifier(escapedText: string): Identifier {
            const node = baseFactory.createBaseIdentifierNode(80) as Mutable<Identifier>;
            node.escapedText = escapedText;
            node.jsDoc = undefined;
            node.flowNode = undefined;
            node.symbol = undefined!;
            return node;
          }

          function createIdentifier(text: string): Identifier {
            return createBaseIdentifier(text);
          }

          return { createIdentifier };
        }

        function RuntimeIdentifier(this: Mutable<Node>, kind: number, pos: number, end: number): void {
          this.kind = kind;
          this.pos = pos;
          this.end = end;
          this.id = 0;
          this.flags = 0;
          this.transformFlags = 0;
          this.parent = undefined!;
          this.original = undefined;
          this.emitNode = undefined;
        }

        interface ObjectAllocator {
          getIdentifierConstructor(): new (kind: number, pos: number, end: number) => Identifier;
        }

        const objectAllocator: ObjectAllocator = {
          getIdentifierConstructor: () => RuntimeIdentifier as any,
        };

        namespace Parser {
          var IdentifierConstructor: new (kind: number, pos: number, end: number) => Identifier;

          function countNode(node: Node): Node {
            return node;
          }

          var baseNodeFactory: BaseNodeFactory = {
            createBaseIdentifierNode: (kind: number): Node =>
              countNode(new IdentifierConstructor(kind, 0, 0)),
          };
          var factory = createNodeFactory(baseNodeFactory);
          var { createIdentifier: factoryCreateIdentifier } = factory;

          function finishNode<T extends Node>(node: T, pos: number): T {
            (node as Mutable<Node>).pos = pos;
            (node as Mutable<Node>).end = pos + 1;
            return node;
          }

          function primeFinishNodeSpecialization(): number {
            const node: Node = {
              kind: 1,
              pos: 0,
              end: 0,
              id: 0,
              flags: 0,
              transformFlags: 0,
              parent: undefined!,
              original: undefined,
              emitNode: undefined,
            };
            return finishNode(node, 1).kind;
          }

          function initializeState(): void {
            IdentifierConstructor = objectAllocator.getIdentifierConstructor();
          }

          export function createIdentifier(): Identifier {
            primeFinishNodeSpecialization();
            initializeState();
            return finishNode(factoryCreateIdentifier("hello"), 10);
          }
        }

        export function test(): number {
          const identifier = Parser.createIdentifier();
          return identifier.kind + identifier.pos + identifier.end + identifier.escapedText.length;
        }
      `,
      { fileName: "issue-1058-identifier-constructor-factory.ts", skipSemanticDiagnostics: true },
    );
    const exports = await instantiate(result);
    expect(exports.test()).toBe(106);
  });
});
