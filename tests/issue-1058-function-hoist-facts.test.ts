// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1058 — the TypeScript 5 bundle has 4,289 direct function declarations in
 * one IIFE. Observation and dependency questions must index that scope/graph
 * once, while keeping declaration and CodegenContext identity exact.
 */
import { describe, expect, it } from "vitest";

import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";
import {
  functionDeclarationInvokesBinding,
  functionDeclarationObservesBindingValue,
  functionDeclarationValueIsObserved,
  functionValueDependencyIsCyclic,
} from "../src/codegen/function-declaration-observation.js";
import { transitiveSiblingCaptures } from "../src/codegen/statements/nested-declarations.js";
import { ts } from "../src/ts-api.js";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("function-hoist-facts.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function collect<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

function functions(root: ts.Node): ts.FunctionDeclaration[] {
  return collect(root, ts.isFunctionDeclaration).filter(
    (declaration): declaration is ts.FunctionDeclaration & { name: ts.Identifier; body: ts.Block } =>
      declaration.name !== undefined && declaration.body !== undefined,
  );
}

function contextWithResolver(resolve: (identifier: ts.Identifier) => ts.Declaration | undefined): {
  ctx: CodegenContext;
  count: () => number;
} {
  let queries = 0;
  const ctx = {
    oracle: {
      valueDeclarationOf(node: ts.Node): ts.Declaration | undefined {
        queries++;
        return ts.isIdentifier(node) ? resolve(node) : undefined;
      },
    },
  } as unknown as CodegenContext;
  return { ctx, count: () => queries };
}

describe("#1058 function-declaration observation facts", () => {
  it("walks one large scope once for every declaration query", () => {
    const count = 96;
    const source = parse(`
      function factory() {
        ${Array.from({ length: count }, (_, index) => `function f${index}() { return ${index}; }`).join("\n")}
        ${Array.from({ length: count }, (_, index) =>
          index % 2 === 0 ? `const value${index} = f${index};` : `f${index}();`,
        ).join("\n")}
      }
    `);
    const declarations = functions(source).filter((declaration) => /^f\d+$/.test(declaration.name!.text));
    const byName = new Map(declarations.map((declaration) => [declaration.name!.text, declaration]));
    const { ctx, count: oracleQueries } = contextWithResolver((identifier) => byName.get(identifier.text));

    expect(declarations).toHaveLength(count);
    expect(functionDeclarationValueIsObserved(ctx, declarations[0]!)).toBe(true);
    const queriesAfterFirstScopeIndex = oracleQueries();
    for (let index = 1; index < declarations.length; index++) {
      expect(functionDeclarationValueIsObserved(ctx, declarations[index]!)).toBe(index % 2 === 0);
    }
    expect(oracleQueries()).toBe(queriesAfterFirstScopeIndex);
    expect(queriesAfterFirstScopeIndex).toBe(count);
  });

  it("keeps same-named declarations and CodegenContexts identity-exact", () => {
    const source = parse(`
      function factory() {
        { function same() { return 1; } const observed = same; }
        { function same() { return 2; } same(); }
      }
    `);
    const sameDeclarations = functions(source).filter((declaration) => declaration.name!.text === "same");
    const [observedDeclaration, calledDeclaration] = sameDeclarations;
    const [observedBlock, calledBlock] = sameDeclarations.map((declaration) => declaration.parent);
    const resolvedDeclaration = (identifier: ts.Identifier): ts.FunctionDeclaration | undefined => {
      for (let node: ts.Node | undefined = identifier; node; node = node.parent) {
        if (node === observedBlock) return observedDeclaration;
        if (node === calledBlock) return calledDeclaration;
      }
      return undefined;
    };
    const first = contextWithResolver(resolvedDeclaration);
    const second = contextWithResolver(() => undefined);

    expect(functionDeclarationValueIsObserved(first.ctx, observedDeclaration!)).toBe(true);
    expect(functionDeclarationValueIsObserved(first.ctx, calledDeclaration!)).toBe(false);
    // The same AST nodes queried through another oracle must not reuse the first
    // context's positive declaration set.
    expect(functionDeclarationValueIsObserved(second.ctx, observedDeclaration!)).toBe(false);
  });

  it("indexes observed and invoked binding-name syntax without crossing shadows", () => {
    const source = parse(`
      function owner() {
        observed;
        calledOnly();
        function nested(observed: unknown) {
          observed;
          inherited;
          nestedCall();
        }
        function shadowOwner(shadowOnly: unknown) { shadowOnly; }
        class inherited { method() { inherited; } }
        class classOnly { method() { classOnly; } }
      }
    `);
    const owner = functions(source).find((declaration) => declaration.name!.text === "owner")!;

    expect(functionDeclarationObservesBindingValue(owner, "observed")).toBe(true);
    expect(functionDeclarationObservesBindingValue(owner, "calledOnly")).toBe(false);
    expect(functionDeclarationObservesBindingValue(owner, "inherited")).toBe(true);
    expect(functionDeclarationObservesBindingValue(owner, "shadowOnly")).toBe(false);
    expect(functionDeclarationObservesBindingValue(owner, "classOnly")).toBe(false);
    expect(functionDeclarationObservesBindingValue(owner, "nestedCall")).toBe(false);
    expect(functionDeclarationInvokesBinding(owner, "calledOnly")).toBe(true);
    expect(functionDeclarationInvokesBinding(owner, "nestedCall")).toBe(false);
  });
});

describe("#1058 function-value dependency graph", () => {
  it("builds one graph and preserves reachable-cycle semantics for every target", () => {
    const source = parse(`
      function a() { return b(); }
      function b() { return c(); }
      function c() { return b(); }
      function d() { return e(); }
      function e() { return 1; }
      function self() { return self(); }
    `);
    const declarations = functions(source);
    const byName = new Map(declarations.map((declaration) => [declaration.name!.text, declaration]));
    const { ctx, count: oracleQueries } = contextWithResolver((identifier) => byName.get(identifier.text));

    expect(functionValueDependencyIsCyclic(ctx, byName.get("a")!, source.statements)).toBe(true);
    const queriesAfterFirstGraph = oracleQueries();
    expect(functionValueDependencyIsCyclic(ctx, byName.get("b")!, source.statements)).toBe(true);
    expect(functionValueDependencyIsCyclic(ctx, byName.get("c")!, source.statements)).toBe(true);
    expect(functionValueDependencyIsCyclic(ctx, byName.get("d")!, source.statements)).toBe(false);
    expect(functionValueDependencyIsCyclic(ctx, byName.get("e")!, source.statements)).toBe(false);
    expect(functionValueDependencyIsCyclic(ctx, byName.get("self")!, source.statements)).toBe(true);
    expect(oracleQueries()).toBe(queriesAfterFirstGraph);
    expect(queriesAfterFirstGraph).toBeGreaterThan(0);
  });

  it("does not leak an oracle-resolved edge between CodegenContexts", () => {
    const source = parse(`
      function left() { return alias(); }
      function right() { return left(); }
    `);
    const declarations = functions(source);
    const byName = new Map(declarations.map((declaration) => [declaration.name!.text, declaration]));
    const withAlias = contextWithResolver((identifier) =>
      identifier.text === "alias" ? byName.get("right") : byName.get(identifier.text),
    );
    const withoutAlias = contextWithResolver((identifier) => byName.get(identifier.text));

    expect(functionValueDependencyIsCyclic(withAlias.ctx, byName.get("left")!, source.statements)).toBe(true);
    expect(functionValueDependencyIsCyclic(withoutAlias.ctx, byName.get("left")!, source.statements)).toBe(false);
  });
});

describe("#1058 sibling capture SCC plan", () => {
  it("preserves direct, transitive, cyclic, shadowed, and repeated-call answers per frame", () => {
    const source = parse(`
      let outer = 1;
      function direct() { return outer; }
      function transitive() { return direct(); }
      function valueOnly() { return direct; }
      function cycleA() { return cycleB(); }
      function cycleB() { outer; return cycleA(); }
      function shadowed() { var outer = 2; return outer; }
    `);
    const byName = new Map(functions(source).map((declaration) => [declaration.name!.text, declaration]));
    const ctx = {
      funcMap: new Map<string, number>(),
      jsStringImports: new Map<string, number>(),
    } as unknown as CodegenContext;
    const frameWithOuter = {
      localMap: new Map([["outer", 0]]),
      hoistedFunctionValueBindings: new Set(["direct"]),
    } as unknown as FunctionContext;

    const direct = transitiveSiblingCaptures(ctx, frameWithOuter, byName.get("direct")!);
    expect([...direct]).toEqual(["outer"]);
    expect([...transitiveSiblingCaptures(ctx, frameWithOuter, byName.get("transitive")!)]).toEqual(["outer"]);
    expect([...transitiveSiblingCaptures(ctx, frameWithOuter, byName.get("valueOnly")!)]).toEqual(["direct"]);
    expect([...transitiveSiblingCaptures(ctx, frameWithOuter, byName.get("cycleA")!)]).toEqual(["outer"]);
    expect([...transitiveSiblingCaptures(ctx, frameWithOuter, byName.get("cycleB")!)]).toEqual(["outer"]);
    expect([...transitiveSiblingCaptures(ctx, frameWithOuter, byName.get("shadowed")!)]).toEqual([]);
    expect(transitiveSiblingCaptures(ctx, frameWithOuter, byName.get("direct")!)).toBe(direct);

    // The syntax nodes are identical, but this frame has no outer binding to
    // capture. A node-only cache would leak the first frame's answer here.
    const frameWithoutOuter = {
      localMap: new Map<string, number>(),
      hoistedFunctionValueBindings: new Set<string>(),
    } as unknown as FunctionContext;
    expect([...transitiveSiblingCaptures(ctx, frameWithoutOuter, byName.get("direct")!)]).toEqual([]);
    expect([...transitiveSiblingCaptures(ctx, frameWithoutOuter, byName.get("transitive")!)]).toEqual([]);
  });
});

describe("#1058 TypeScript-scale iterative SCC planning", () => {
  it("handles a 4,289-declaration chain in both dependency analyses", { timeout: 30_000 }, () => {
    const declarationCount = 4_289;
    const source = parse(`
      let outer = 1;
      ${Array.from({ length: declarationCount }, (_, index) =>
        index + 1 < declarationCount
          ? `function f${index}() { return f${index + 1}(); }`
          : `function f${index}() { return outer; }`,
      ).join("\n")}
    `);
    const declarations = functions(source).filter((declaration) => /^f\d+$/.test(declaration.name!.text));
    const byName = new Map(declarations.map((declaration) => [declaration.name!.text, declaration]));
    const ctx = {
      oracle: {
        valueDeclarationOf(node: ts.Node): ts.Declaration | undefined {
          return ts.isIdentifier(node) ? byName.get(node.text) : undefined;
        },
      },
      funcMap: new Map<string, number>(),
      jsStringImports: new Map<string, number>(),
    } as unknown as CodegenContext;
    const fctx = {
      localMap: new Map([["outer", 0]]),
      hoistedFunctionValueBindings: new Set<string>(),
    } as unknown as FunctionContext;

    expect(declarations).toHaveLength(declarationCount);
    expect(functionValueDependencyIsCyclic(ctx, byName.get("f0")!, source.statements)).toBe(false);
    expect(functionValueDependencyIsCyclic(ctx, byName.get(`f${declarationCount - 1}`)!, source.statements)).toBe(
      false,
    );
    expect([...transitiveSiblingCaptures(ctx, fctx, byName.get("f0")!)]).toEqual(["outer"]);
  });
});
