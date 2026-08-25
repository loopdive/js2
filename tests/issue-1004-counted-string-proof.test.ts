// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#3518 Transaction A / #1004) Non-vacuous tests for the shared counted
// string-append proof. Runtime semantics remain covered by issue-1004.test.ts.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import {
  containsCountedStringAppendCandidate,
  countedStringAppendPlanIsCurrent,
  planCountedStringAppend,
} from "../src/ir/analysis/counted-string-append.js";
import { ts } from "../src/ts-api.js";

function firstFor(sourceFile: ts.SourceFile): ts.ForStatement {
  let result: ts.ForStatement | undefined;
  const visit = (node: ts.Node): void => {
    if (result) return;
    if (ts.isForStatement(node)) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!result) throw new Error("fixture has no for statement");
  return result;
}

function proofFor(source: string) {
  const { sourceFile, checker } = analyzeSource(source, "issue-1004-proof.ts");
  const context = { checker, oracle: new TsCheckerOracle(checker) };
  const plan = planCountedStringAppend(context, firstFor(sourceFile));
  return { context, plan, sourceFile };
}

describe("#3518 Transaction A shared counted string proof", () => {
  it("records exact symbols, declarations, constants, and checked trip count", () => {
    const { context, plan } = proofFor(`
      export function test(): string {
        const START = 1;
        const END = 4;
        const PIECE0 = "xy";
        const PIECE = PIECE0;
        let value = "seed";
        for (let index = START; index <= END; ++index) value += PIECE;
        return value;
      }
    `);
    expect(plan).not.toBeNull();
    expect(plan?.start).toBe(1);
    expect(plan?.bound).toBe(4);
    expect(plan?.tripCount).toBe(4);
    expect(plan?.comparison).toBe("lte");
    expect(plan?.increment).toBe("prefix");
    expect(plan?.startConstDeclarations).toHaveLength(1);
    expect(plan?.boundConstDeclarations).toHaveLength(1);
    expect(plan?.fragmentConstDeclarations).toHaveLength(2);
    expect(plan && countedStringAppendPlanIsCurrent(context, plan)).toBe(true);
  });

  it.each([
    ["const counter", 'const frag = "x"; let s = ""; for (const i = 0; i < 3; i++) s += frag;'],
    ["const accumulator", 'const frag = "x"; const s = ""; for (let i = 0; i < 3; i++) s += frag;'],
    ["mutable fragment", 'let frag = "x"; let s = ""; for (let i = 0; i < 3; i++) s += frag;'],
    ["second accumulator write", 'const frag = "x"; let s = ""; s += "seed"; for (let i = 0; i < 3; i++) s += frag;'],
    [
      "captured accumulator",
      'const frag = "x"; let s = ""; const read = () => s; for (let i = 0; i < 3; i++) s += frag;',
    ],
  ])("rejects %s", (_label, body) => {
    const { plan } = proofFor(`
      export function test(): string {
        ${body}
        return s;
      }
    `);
    expect(plan).toBeNull();
  });

  it.each([
    ["forward/TDZ bound", 'let s = ""; for (let i = 0; i < END; i++) s += "x"; const END = 3;'],
    ["forward/TDZ fragment", 'const FRAG = NEXT; const NEXT = "x"; let s = ""; for (let i = 0; i < 3; i++) s += FRAG;'],
    ["written checker constant", 'const END = 3; END = 4; let s = ""; for (let i = 0; i < END; i++) s += "x";'],
    ["const cycle", 'const A = B; const B = A; let s = ""; for (let i = A; i < 3; i++) s += "x";'],
    ["unsafe trip count", 'let s = ""; for (let i = -9007199254740991; i <= 9007199254740991; i++) s += "x";'],
  ])("rejects %s", (_label, body) => {
    expect(
      proofFor(`
        // @ts-nocheck
        export function test(): string {
          ${body}
          return s;
        }
      `).plan,
    ).toBeNull();
  });

  it("rejects a captured cross-owner bound", () => {
    expect(
      proofFor(`
        const END = 3;
        export function test(): string {
          let s = "";
          for (let i = 0; i < END; i++) s += "x";
          return s;
        }
      `).plan,
    ).toBeNull();
  });

  it("keeps the existing checker-free unconditional selector candidate", () => {
    const { sourceFile } = proofFor(`
      export function test(): string {
        const s = "";
        for (const i = 0; i < 3; i++) s += "x";
        return s;
      }
    `);
    const declaration = sourceFile.statements.find(ts.isFunctionDeclaration);
    expect(declaration?.body && containsCountedStringAppendCandidate(declaration.body)).toBe(true);
  });
});
