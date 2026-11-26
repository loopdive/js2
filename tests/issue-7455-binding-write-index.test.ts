// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7455/#7457 PR 1 — `bindingWrites` files every identifier write of a source file under the de-aliased symbol its
// target resolves to, from one walk per file. The script-var queries (`scriptVarWrites`,
// `preparedBindingRewritten`) now read it; their answers are unchanged.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { bindingWrites, deAliasedSymbol } from "../src/shared/binding-write-index.js";
import { preparedBindingRewritten, scriptVarWrites } from "../src/ir/module-binding-script-var.js";
import { ts } from "../src/ts-api.js";

function analyze(source: string) {
  const { sourceFile, checker } = analyzeSource(source, "input.js");
  const declared = (name: string): ts.Identifier => {
    let found: ts.Identifier | undefined;
    const visit = (node: ts.Node): void => {
      if (
        !found &&
        (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        ts.isSourceFile(ts.findAncestor(node.parent, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n))!)
      )
        found = node.name;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found!;
  };
  const writesOf = (name: string) =>
    bindingWrites(checker, [sourceFile], checker.getSymbolAtLocation(declared(name))!).map((w) => w.target.getText());
  return { sourceFile, checker, declared, writesOf };
}

describe("#7455 one binding-write index per source file", () => {
  it("files every write form under its binding: plain, compound, update, destructuring, shorthand, loop head", () => {
    const { writesOf } = analyze("var o = 1; o = 2; o += 3; o++; [o] = [4]; ({ o } = { o: 5 }); for (o in {}) {}");
    expect(writesOf("o")).toEqual(["o", "o", "o", "o", "o", "o", "o"]);
  });

  it("does not file a same-named local's writes under the script binding", () => {
    const { writesOf } = analyze("var o = 1; function g() { var o; o = 2; } g();");
    expect(writesOf("o")).toEqual(["o"]);
  });

  it("answers the script-var queries as before", () => {
    const { checker, declared } = analyze("var o = 1; function h() {} h = 3; o = 2;");
    const o = declared("o").parent as ts.VariableDeclaration;
    expect(scriptVarWrites(checker, o)?.map((w) => w.target.pos)).toHaveLength(2);
    expect(preparedBindingRewritten(checker, declared("h"))).toBe(true);
    expect(preparedBindingRewritten(checker, declared("o"))).toBe(true);
    const { checker: c2, declared: d2 } = analyze("function k() {} k();");
    expect(preparedBindingRewritten(c2, d2("k"))).toBe(false);
  });

  it("returns a var's symbol unchanged from de-aliasing", () => {
    const { checker, declared } = analyze("var o = 1;");
    const symbol = checker.getSymbolAtLocation(declared("o"))!;
    expect(deAliasedSymbol(checker, symbol)).toBe(symbol);
  });

  it("answers from one walk per file: a repeated query returns the same write records", () => {
    const { checker, sourceFile, declared } = analyze("var o = 1; o = 2;");
    const symbol = checker.getSymbolAtLocation(declared("o"))!;
    const first = bindingWrites(checker, [sourceFile], symbol);
    const second = bindingWrites(checker, [sourceFile], symbol);
    expect(second[1]).toBe(first[1]);
  });
});
