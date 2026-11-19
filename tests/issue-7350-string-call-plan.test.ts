// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7350 — the Prepared program's `String(v)` call plan (`prepareConversionResolvers`) holds while the realm's
// `String` is pristine (G1's `isPristineIntrinsic`), whatever value reads of `String` the program makes: the
// harness prelude reads it as a value (`Array.prototype.map.call(arrayLike, String)`, assert.js) beside its
// `String(value)` calls. A declaration, write, delete or define of `String` withdraws the plan.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareConversionResolvers } from "../src/frontend/builtins/prepare-number-conversion.js";
import { ts } from "../src/frontend/typescript.js";

/** Whether the plan admits the `String(…)` call inside the source's function `run`. */
function admitsCall(source: string): boolean {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const run = ast.entryFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "run",
  )!;
  let callee: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "String")
      callee ??= node.expression;
    ts.forEachChild(node, visit);
  };
  visit(run);
  return prepareConversionResolvers(ast.checker, ast.sourceFiles, run).isAmbientStringBinding(callee!);
}

const CALL = "export function run(v: any) { return String(v); }";

describe("#7350 — the String(v) call plan asks the pristine realm binding", () => {
  it.each([
    ["the call alone", CALL],
    ["a value read beside it (assert.js's map.call)", `${CALL}\nvar mapped = [1].map.call([1], String);`],
    ["String stored as a value", `${CALL}\nvar S: any = String;`],
    ["String read off globalThis", `${CALL}\nvar G: any = globalThis.String;`],
  ])("keeps the plan: %s", (_, source) => {
    expect(admitsCall(source)).toBe(true);
  });

  it.each([
    ["String assigned", `${CALL}\n(String as any) = 1;`],
    ["String written through globalThis", `${CALL}\n(globalThis as any).String = 1;`],
    ["String deleted", `${CALL}\ndelete (globalThis as any).String;`],
    ["String declared", `${CALL}\nvar String: any = 1;`],
    ["the call inside a with body", `export function run(v: any, o: any) { with (o) { return String(v); } }`],
  ])("withdraws the plan: %s", (_, source) => {
    expect(admitsCall(source)).toBe(false);
  });
});
