// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7372 slice 2a-1 — the Annex B analysis lifted to `src/ir/analysis/annexb-block-functions.ts`, and its one
 * behaviour change: a `switch`'s CaseBlock is ONE lexical scope across all its clauses (its LexicallyDeclaredNames
 * span every clause). A `let f` in one clause therefore makes `var f` an early error for a block function nested in
 * ANOTHER clause, so Annex B creates no var binding (§B.3.2.1/§B.3.2.2) and a read of `f` outside the switch is
 * unbound. The legacy rule looked at the declaring clause's own statements only.
 *
 * Each program is also run in node (sloppy script), so the expected answer is the engine's, not ours.
 */
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  collectAnnexBCancelSites,
  enclosingVarScope,
  hasInterveningLexicalBinder,
} from "../src/ir/analysis/annexb-block-functions.js";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("t.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
}

function blockFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && !ts.isSourceFile(node.parent)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found!;
}

/** node's answer: does the program leave `f` unbound after the switch ran? */
function nodeLeavesUnbound(source: string): boolean {
  return runInNewContext(
    `${source}\ntypeof f === "undefined" && (function () { try { f; return false; } catch (e) { return e instanceof ReferenceError; } })()`,
  );
}

const SIBLING_CLAUSE_LET = [
  ["let", "switch (1) { case 0: let f = 1; break; case 1: { function f() {} } }"],
  ["const", "switch (1) { case 0: const f = 1; break; default: { function f() {} } }"],
  ["class", "switch (1) { case 0: class f {} break; case 1: if (true) function f() {} }"],
] as const;

describe("#7372 2a-1 — a CaseBlock is one lexical scope for Annex B", () => {
  for (const [kind, source] of SIBLING_CLAUSE_LET) {
    it(`a ${kind} in a sibling clause cancels the var binding (node agrees)`, () => {
      expect(nodeLeavesUnbound(source)).toBe(true);
      const sf = parse(source);
      const fn = blockFunction(sf, "f");
      expect(hasInterveningLexicalBinder(fn.parent, "f", enclosingVarScope(fn)!)).toBe(true);
      expect(collectAnnexBCancelSites(sf).map((site) => site.name)).toEqual(["f"]);
    });
  }

  it("no lexical `f` anywhere in the CaseBlock keeps the var binding (node agrees)", () => {
    const source = "switch (1) { case 0: let g = 1; break; case 1: { function f() {} } }";
    expect(nodeLeavesUnbound(source)).toBe(false);
    const sf = parse(source);
    const fn = blockFunction(sf, "f");
    expect(hasInterveningLexicalBinder(fn.parent, "f", enclosingVarScope(fn)!)).toBe(false);
    expect(collectAnnexBCancelSites(sf)).toEqual([]);
  });
});
