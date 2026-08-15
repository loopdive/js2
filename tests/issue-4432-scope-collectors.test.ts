// #4432 — pins the scope-boundary behaviour of the per-var-scope-root var
// declaration index that replaced `checkVarLexicalConflicts`' per-block subtree
// re-walk, and the emission order of the single-traversal TDZ collector that
// replaced its per-pending-name re-walk.
//
// Both rewrites answer a block's query from data indexed at an ancestor, so the
// two things that could silently break are (a) leaking a `var` from a nested
// function into an enclosing block's conflict set and (b) reordering
// diagnostics when one statement references two pending TDZ names. Neither
// shows up in a pass/fail count — only in which node is flagged and in what
// order — so they are asserted directly here.
import { describe, it, expect } from "vitest";
import { ts } from "../src/ts-api.js";
import { createEarlyErrorContext } from "../src/compiler/early-errors/context.js";
import { checkVarLexicalConflicts } from "../src/compiler/early-errors/duplicates.js";
import { checkTDZInStatements } from "../src/compiler/early-errors/tdz.js";

function parse(src: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
}

/** Run checkVarLexicalConflicts over every Block/SourceFile in `src`, in document order. */
function varLexicalMessages(src: string): string[] {
  const sf = parse(src);
  const ctx = createEarlyErrorContext(sf);
  const walk = (node: ts.Node): void => {
    if (ts.isBlock(node) || ts.isSourceFile(node)) checkVarLexicalConflicts(ctx, node);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return ctx.errors.map((e) => e.message);
}

function tdzMessages(src: string): string[] {
  const sf = parse(src);
  const ctx = createEarlyErrorContext(sf);
  checkTDZInStatements(ctx, sf.statements);
  return ctx.errors.map((e) => `${e.message}@${e.column}`);
}

describe("#4432 var/lexical conflict index — scope boundaries", () => {
  it("a nested block's var conflicts with an enclosing block's lexical name", () => {
    expect(varLexicalMessages("{ let x; { var x; } }")).toEqual(["Cannot redeclare block-scoped variable 'x'"]);
  });

  it("a var inside a nested function does NOT leak into the enclosing block", () => {
    expect(varLexicalMessages("{ let x; function f() { var x; } }")).toEqual([]);
  });

  it("sibling blocks under one var-scope root do not see each other's vars", () => {
    expect(varLexicalMessages("function g() { { let x; } { var x; } }")).toEqual([]);
  });

  it("a var inside a class static block does not leak out of the class", () => {
    expect(varLexicalMessages("{ let x; class C { static { var x; } } }")).toEqual([]);
  });

  it("one shared index answers several blocks without cross-contamination", () => {
    expect(varLexicalMessages("function g() { { let a; { var a; } } { let b; { var b; } } }")).toEqual([
      "Cannot redeclare block-scoped variable 'a'",
      "Cannot redeclare block-scoped variable 'b'",
    ]);
  });
});

describe("#4432 TDZ single-traversal collector — emission order", () => {
  it("groups by declaration order, then by node encounter order", () => {
    // One statement referencing both pending names twice each. The original
    // per-name re-traversal emitted both `a` rows before both `b` rows; a naive
    // single-pass rewrite would interleave them in node order (a, b, a, b).
    expect(tdzMessages("f(a, b, a, b); let a; let b;")).toEqual([
      "Cannot access 'a' before initialization@3",
      "Cannot access 'a' before initialization@9",
      "Cannot access 'b' before initialization@6",
      "Cannot access 'b' before initialization@12",
    ]);
  });

  it("stops at nested function scopes and skips property names", () => {
    expect(tdzMessages("obj.a; ({ a: 1 }); function f() { a; } let a;")).toEqual([]);
  });

  it("still flags a self-reference in the declaration's own initializer", () => {
    expect(tdzMessages("let a = a + 1;")).toEqual(["Cannot access 'a' before initialization@9"]);
  });
});
