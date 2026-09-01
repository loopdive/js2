// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, wrapExports } from "../src/index.js";

const SOURCES = {
  "./src/compiler/types.ts": `
    // The brands are never actually given values. At runtime they have zero cost.
    export interface Node {
      readonly kind: number;
      readonly pos: number;
      readonly end: number;
      readonly flags: number;
      modifierFlagsCache: number;
      readonly transformFlags: number;
      readonly parent: Node;
    }

    export interface NodeArray<T extends Node> extends Array<T> {
      pos: number;
      end: number;
      hasTrailingComma: boolean;
    }

    export interface Declaration extends Node {
      symbol: SymbolInfo;
      localSymbol?: SymbolInfo;
    }

    export interface NamedDeclaration extends Declaration {
      readonly name?: Node;
    }

    export interface SymbolInfo {
      id: number;
    }

    export interface VariableDeclaration extends NamedDeclaration {
      readonly kind: 260;
      readonly parent: VariableDeclarationList | CatchClause;
      readonly initializer?: Node;
    }

    export interface VariableDeclarationList extends Node {
      readonly kind: 261;
      readonly parent: VariableStatement | ForStatement | ForOfStatement | ForInStatement;
      readonly declarations: NodeArray<VariableDeclaration>;
    }

    export interface VariableStatement extends Node {
      readonly kind: 243;
      readonly declarationList: VariableDeclarationList;
    }

    export interface ForStatement extends Node {
      readonly kind: 248;
      readonly initializer?: VariableDeclarationList;
    }

    export interface ForOfStatement extends Node {
      readonly kind: 250;
      readonly initializer: VariableDeclarationList;
    }

    export interface ForInStatement extends Node {
      readonly kind: 249;
      readonly initializer: VariableDeclarationList;
    }

    export interface CatchClause extends Node {
      readonly kind: 300;
      readonly variableDeclaration?: VariableDeclaration;
    }
  `,
  "./src/compiler/_namespaces/ts.ts": `
    import type { Node } from "../types.js";

    export interface BaseNodeFactory {
      createBaseNode(kind: number): Node;
    }

    export type Mutable<T extends object> = { -readonly [K in keyof T]: T[K] };
    export type OpenMutable<T extends Node> = Mutable<T> & { [key: string]: unknown };
  `,
  "./src/compiler/entry.ts": `
    import type { Node, NodeArray, VariableDeclarationList } from "./types.js";
    import type { BaseNodeFactory, Mutable, OpenMutable } from "./_namespaces/ts.js";

    function RuntimeNode(this: Mutable<Node>, kind: number, pos: number, end: number): void {
      this.kind = kind;
      this.pos = pos;
      this.end = end;
      this.flags = 0;
      this.modifierFlagsCache = 0;
      this.transformFlags = 0;
      this.parent = undefined!;
    }

    class PhysicalNode implements Node {
      readonly kind = 261;
      readonly pos = -1;
      readonly end = -1;
      readonly flags = 2;
      modifierFlagsCache = 0;
      readonly transformFlags = 0;
      readonly parent = undefined!;
    }

    function createBaseNodeFactory(): BaseNodeFactory {
      let Ctor: new (kind: number, pos: number, end: number) => Node;
      return { createBaseNode };

      function createBaseNode(kind: number): Node {
        return new (Ctor || (Ctor = RuntimeNode as any))(kind, -1, -1);
      }
    }

    function array<T extends Node>(values: readonly T[]): NodeArray<T> {
      const result = values.slice() as NodeArray<T>;
      result.pos = -1;
      result.end = -1;
      result.hasTrailingComma = false;
      return result;
    }

    const baseFactory = createBaseNodeFactory();

    function createBaseNode<T extends Node>(kind: T["kind"]): Mutable<T> {
      return baseFactory.createBaseNode(kind) as Mutable<T>;
    }

    function createVariableDeclarationList(flags: number): VariableDeclarationList {
      const node = createBaseNode<VariableDeclarationList>(261);
      node.flags |= flags & 3;
      node.declarations = array([]);
      return node;
    }

    function finishNode<T extends Node>(node: T): T {
      (node as Mutable<T> as OpenMutable<T>).flags |= 1 << 25;
      return node;
    }

    export function structFlags(): number {
      const node = new PhysicalNode();
      return finishNode(node).flags;
    }

    export function wrappedFlags(): number {
      return finishNode(createVariableDeclarationList(2)).flags;
    }

    export function hostFlags(): number {
      const map = new Map<number, number>() as Map<number, number> & Mutable<Node>;
      map.kind = 261;
      map.pos = -1;
      map.end = -1;
      map.flags = 2;
      map.modifierFlagsCache = 0;
      map.transformFlags = 0;
      map.parent = undefined!;
      return finishNode(map).flags;
    }

    function bump<T extends object>(value: T): number {
      (value as T & { count: number }).count += 1;
      return (value as any).count;
    }

    export function deletedAnonymous(): number {
      const value: any = { count: 4, marker: 7 };
      delete value.count;
      return bump(value);
    }

    export function mutableReplacement(): number {
      let value: any = createBaseNode<any>(261);
      const map = new Map<number, number>() as any;
      map.flags = 7;
      value = map;
      return value.flags;
    }
  `,
} as const;

describe("#1058 generic factory and finishNode flag carrier", () => {
  it("preserves physical flags through an open generic identity boundary", async () => {
    const result = await compileMulti(SOURCES, "./src/compiler/entry.ts", {
      target: "gc",
      platform: "node",
      skipSemanticDiagnostics: true,
      experimentalIR: false,
      emitWat: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const finishNodeWat = result.wat.match(/\(func \$finishNode\b[\s\S]*?(?=\n {2}\(func |\n {2}\(export |\n\))/)?.[0];
    expect(finishNodeWat).toContain("ref.test (ref");
    expect(finishNodeWat).toContain("struct.set");
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as {
      hostFlags(): number;
      structFlags(): number;
      wrappedFlags(): number;
      deletedAnonymous(): number;
      mutableReplacement(): number;
    };

    expect(exports.structFlags()).toBe(33_554_434);
    expect(exports.wrappedFlags()).toBe(33_554_434);
    expect(exports.hostFlags()).toBe(33_554_434);
    expect(exports.deletedAnonymous()).toBeNaN();
    expect(exports.mutableReplacement()).toBe(7);
  });
});
