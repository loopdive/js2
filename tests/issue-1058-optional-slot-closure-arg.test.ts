// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1058 — an interface method declaring `x?: T` and an implementation
// declaring `x: T | undefined` lower the slot differently (externref vs a
// nullable ref). A call through the interface-typed closure value must still
// reach the implementation instead of ending in TypeError.
// Witness: the TypeScript parser's `factoryCreateVariableDeclaration(...)`.
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1058 optional interface slot vs `T | undefined` implementation", () => {
  it("dispatches to the implementation with present and omitted slots", async () => {
    const ex = (await compileToWasm(`
      interface Node { kind: number; pos: number }
      interface Ident extends Node { text: string }
      interface Token extends Node { tk: number }
      interface TypeNode extends Node { tn: number }
      interface Expression extends Node { ex: number }
      interface Decl extends Node {
        name: Ident; bang: Token | undefined; type: TypeNode | undefined; init: Expression | undefined;
      }
      interface Factory {
        createDecl(name: Ident, bang?: Token, type?: TypeNode, init?: Expression): Decl;
      }
      function createFactory(): Factory {
        return { createDecl };
        function createDecl(name: Ident, bang: Token | undefined, type: TypeNode | undefined, init: Expression | undefined): Decl {
          return { kind: 260, pos: -1, name, bang, type, init };
        }
      }
      const { createDecl: factoryCreateDecl } = createFactory();
      function parseDecl(withType: boolean): Decl {
        const name: Ident = { kind: 80, pos: 0, text: "x" };
        const type: TypeNode | undefined = withType ? { kind: 1, pos: 2, tn: 3 } : undefined;
        const init: Expression = { kind: 9, pos: 3, ex: 7 };
        return factoryCreateDecl(name, undefined, type, init);
      }
      export function run(): number {
        const a = parseDecl(false);
        const b = parseDecl(true);
        return a.kind + (a.init ? a.init.ex : 0) * 1000 + (b.type ? b.type.tn : 0) * 10000 + (a.type ? 1 : 0) + (b.bang ? 2 : 0);
      }
      export function omitted(): number {
        const d = factoryCreateDecl({ kind: 80, pos: 0, text: "y" });
        // Truthiness, not \`=== undefined\`: a \`T | undefined\` struct field reads
        // an absent value back as null even on a direct call (separate gap).
        return (d.init ? 0 : 1) + (d.type ? 0 : 10) + d.name.text.length * 100;
      }
    `)) as { run(): number; omitted(): number };
    expect(ex.run()).toBe(37260);
    expect(ex.omitted()).toBe(111);
  });

  it("dispatches to an implementation whose omitted number slot has a default", async () => {
    const ex = (await compileToWasm(`
      const enum Flags { None = 0, Let = 1, Const = 2 }
      interface Decl { kind: number }
      interface DeclList { decls: readonly Decl[]; flags: number }
      interface Factory {
        createList(decls: readonly Decl[], flags?: Flags): DeclList;
      }
      function createFactory(): Factory {
        return { createList };
        function createList(decls: readonly Decl[], flags = Flags.None) {
          const list: DeclList = { decls, flags: flags + 10 };
          return list;
        }
      }
      const { createList: factoryCreateList } = createFactory();
      function parseList(flags: Flags): DeclList {
        const decls: Decl[] = [{ kind: 1 }, { kind: 2 }];
        return factoryCreateList(decls, flags);
      }
      export function run(): number {
        const a = parseList(Flags.Const);
        const b = factoryCreateList([{ kind: 3 }]);
        return a.flags * 100 + b.flags + a.decls.length * 10000;
      }
    `)) as { run(): number };
    expect(ex.run()).toBe(21210);
  });
});
