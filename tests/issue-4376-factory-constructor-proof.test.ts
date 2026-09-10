import { expect, it } from "vitest";
import { ts, forEachChild } from "../src/ts-api.js";
import { isConstFactoryConstructor } from "../src/codegen/factory-constructor-value.js";
import type { CodegenContext } from "../src/codegen/context/types.js";

it.each([
  ["ordinary", "function() {}", "", false, true],
  ["arrow", "() => {}", "", false, false],
  ["generator", "function*() {}", "", false, false],
  ["async", "async function() {}", "", false, false],
  ["assignment", "function() {}", "factory = replacement;", false, false],
  ["destructuring", "function() {}", "[factory] = replacements;", false, false],
  ["loop assignment", "function() {}", "for (factory of replacements) {}", false, false],
  ["redeclaration", "function() {}", "var factory = replacement;", false, false],
  ["dynamic code", "function() {}", "", true, false],
] as const)("factory constructor proof: %s", (_name, returned, tail, dynamic, expected) => {
  const file = ts.createSourceFile(
    "probe.ts",
    `function factory(): any { return ${returned}; } const C: any = factory(); ${tail}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const factory = file.statements[0] as ts.FunctionDeclaration;
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "C") declaration = node;
    forEachChild(node, visit);
  };
  visit(file);
  expect(declaration).toBeDefined();
  const context = {
    dynamicCodeDirty: dynamic,
    oracle: {
      constInitializerOf: () => declaration!.initializer,
      valueDeclarationOf: () => factory,
    },
  } as unknown as CodegenContext;
  expect(isConstFactoryConstructor(context, declaration!.name as ts.Identifier)).toBe(expected);
});
