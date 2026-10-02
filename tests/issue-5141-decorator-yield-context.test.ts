// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5141 — a direct class decorator expression inherits the enclosing
// [Yield]/strict context. The class body remains strict, but evaluating
//
//     function yield() {}
//     @yield class C {}
//
// in a noStrict Script is not part of that body. Keep these focused on the
// compiler's early-error pass: they do not claim decorator runtime support.

import { describe, expect, it } from "vitest";

import { ts } from "../src/ts-api.js";
import { detectEarlyErrors } from "../src/compiler/early-errors/index.js";
import { isStrictMode } from "../src/compiler/early-errors/predicates.js";

const YIELD_RESERVED = "'yield' is a reserved word and may not be used as an identifier in strict mode";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("issue-5141.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function nonWarningErrors(source: string, moduleGoal = false): string[] {
  return detectEarlyErrors(parse(source), { moduleGoal })
    .filter((error) => error.severity !== "warning")
    .map((error) => error.message);
}

function decoratorAndBodyYields(source: string): { decoratorYield: ts.Identifier; bodyYield: ts.Identifier } {
  const sourceFile = parse(source);
  const classDeclaration = sourceFile.statements.find(ts.isClassDeclaration);
  if (!classDeclaration) throw new Error("expected a class declaration");

  const decorator = ts.getDecorators(classDeclaration)?.[0];
  if (!decorator || !ts.isIdentifier(decorator.expression)) {
    throw new Error("expected a direct identifier class decorator");
  }

  const method = classDeclaration.members.find(ts.isMethodDeclaration);
  const statement = method?.body?.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isIdentifier(statement.expression)) {
    throw new Error("expected an identifier expression in the class body");
  }

  return { decoratorYield: decorator.expression, bodyYield: statement.expression };
}

describe("#5141 — direct class decorators keep the enclosing [Yield] context", () => {
  it("accepts relevant noStrict bodies matching the statement original and expression twin", () => {
    // Relevant body of test/language/statements/class/decorator/syntax/valid/
    // decorator-member-expr-identifier-reference-yield.js. The authoritative
    // original remains a separate maintained-runner control.
    expect(nonWarningErrors("function yield() {}; @yield class C {}")).toEqual([]);

    // Relevant body of test/language/expressions/class/decorator/syntax/valid/
    // decorator-member-expr-identifier-reference-yield.js
    expect(nonWarningErrors("function yield() {}; var C = @yield class {};")).toEqual([]);
  });

  it("retains strict, module, and valid-AST generator [Yield] rejections", () => {
    expect(nonWarningErrors('"use strict"; @yield class C {}')).toContain(YIELD_RESERVED);
    expect(nonWarningErrors("@yield class C {}", true)).toContain(YIELD_RESERVED);
    // TypeScript parses a direct decorator in a generator body as a syntax
    // recovery node, so use a valid Identifier AST that inherits [+Yield].
    expect(nonWarningErrors("function* g() { function yield() {} }")).toContain(YIELD_RESERVED);
  });

  it("records the direct-decorator generator shape as parser recovery, not an early-error AST control", () => {
    // Keep this source visible: TypeScript currently recovers it with TS1109
    // before it creates an Identifier node. The compiler may tolerate that
    // parser diagnostic elsewhere, so this says nothing about full compilation
    // or decorator execution; it only guards the focused test's instrument.
    const sourceFile = parse("function* g() { @yield class C {} }");
    expect(sourceFile.parseDiagnostics.map((diagnostic) => diagnostic.code)).toContain(1109);
  });

  it("keeps class bodies and member decorators strict", () => {
    expect(nonWarningErrors("class C { m() { yield; } }")).toContain(YIELD_RESERVED);
    expect(nonWarningErrors("class C { @yield m() {} }")).toContain(YIELD_RESERVED);
  });

  it("does not let strict-mode cache order change the decorator boundary", () => {
    const source = "function yield() {}; @yield class C { m() { yield; } }";

    const bodyFirst = decoratorAndBodyYields(source);
    expect(isStrictMode(bodyFirst.bodyYield)).toBe(true);
    expect(isStrictMode(bodyFirst.decoratorYield)).toBe(false);

    const decoratorFirst = decoratorAndBodyYields(source);
    expect(isStrictMode(decoratorFirst.decoratorYield)).toBe(false);
    expect(isStrictMode(decoratorFirst.bodyYield)).toBe(true);
  });
});
