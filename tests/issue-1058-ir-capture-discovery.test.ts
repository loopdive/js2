// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { declarationHasNestedCapture, nestedFunctionUsedAsValue } from "../src/ir/closure-captures.js";

it("uses binding identity rather than a shadowed capture name", () => {
  const source = ts.createSourceFile(
    "capture.ts",
    `
    function outer() {
      let shadowed = 1;
      let shared = 2;
      function inner(shadowed: number) { return shadowed + shared; }
      return inner(shadowed);
    }
  `,
    ts.ScriptTarget.Latest,
    true,
  );
  const host = ts.createCompilerHost({ noLib: true });
  host.getSourceFile = (name) => (name === "capture.ts" ? source : undefined);
  const checker = ts.createProgram(["capture.ts"], { noLib: true }, host).getTypeChecker();
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(declarations).toHaveLength(2);
  expect(declarationHasNestedCapture(declarations[0]!, checker)).toBe(false);
  expect(declarationHasNestedCapture(declarations[1]!, checker)).toBe(true);
  expect(declarationHasNestedCapture(declarations[1]!)).toBe(false);
});

it("distinguishes named function values from direct calls and shadowed references", () => {
  const source = ts.createSourceFile(
    "values.ts",
    `
    function outer() {
      function direct(value: number): number { return value; }
      function field(value: number): number { return value; }
      function escaped(value: number): number { return value; }
      function shadow(direct: number) { return direct; }
      direct(1);
      const table = { field };
      return escaped;
    }
  `,
    ts.ScriptTarget.Latest,
    true,
  );
  const host = ts.createCompilerHost({ noLib: true });
  host.getSourceFile = (name) => (name === "values.ts" ? source : undefined);
  const checker = ts.createProgram(["values.ts"], { noLib: true }, host).getTypeChecker();
  const outer = source.statements[0] as ts.FunctionDeclaration;
  const functions = outer.body!.statements.filter(ts.isFunctionDeclaration);
  expect(functions).toHaveLength(4);
  expect(nestedFunctionUsedAsValue(functions[0]!, checker)).toBe(false);
  expect(nestedFunctionUsedAsValue(functions[1]!, checker)).toBe(true);
  expect(nestedFunctionUsedAsValue(functions[2]!, checker)).toBe(true);
  expect(nestedFunctionUsedAsValue(functions[2]!)).toBe(false);
});
