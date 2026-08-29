// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1058 — scope-wide hoist analyses are indexed once per CodegenContext.
 *
 * TypeScript's bundled compiler puts hundreds of `var` declarations in one
 * factory IIFE. The carrier and bare-for-in predicates used to walk that whole
 * scope once per declaration. These focused tests exercise the identity and
 * boundary rules directly while counting oracle queries: N bindings plus N
 * writes must stay O(N), not become N × N.
 */
import { describe, expect, it } from "vitest";

import type { JsTag } from "../src/checker/oracle.js";
import {
  bindingHasAnnexBExistingVarUpdate,
  bindingHasMixedAssignmentCarrier,
} from "../src/codegen/analysis/mixed-assignment-carrier.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { varBindingIsForInIdentifierTarget } from "../src/codegen/index.js";
import { ts } from "../src/ts-api.js";

function parse(source: string, scriptKind: ts.ScriptKind = ts.ScriptKind.TS): ts.SourceFile {
  return ts.createSourceFile("scope-cache.ts", source, ts.ScriptTarget.Latest, true, scriptKind);
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

function declarations(root: ts.Node): ts.VariableDeclaration[] {
  return collect(root, ts.isVariableDeclaration).filter((decl) => ts.isIdentifier(decl.name));
}

function equalsAssignments(root: ts.Node): ts.BinaryExpression[] {
  return collect(root, ts.isBinaryExpression).filter((expr) => expr.operatorToken.kind === ts.SyntaxKind.EqualsToken);
}

function stripParens(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

function staticTag(expression: ts.Expression): JsTag | "mixed" {
  if (ts.isNumericLiteral(expression)) return "number";
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return "string";
  if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) return "object";
  if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) return "function";
  if (ts.isIdentifier(expression) && expression.text === "replacement") return "function";
  return "mixed";
}

function fakeContext(
  resolved: WeakMap<ts.Identifier, ts.VariableDeclaration>,
  numericVerdict: () => boolean = () => false,
): {
  ctx: CodegenContext;
  counts: { declaration: number; staticType: number };
} {
  const counts = { declaration: 0, staticType: 0 };
  const ctx = {
    declaredGlobals: new Map(),
    oracle: {
      variableDeclarationOf(identifier: ts.Identifier): ts.VariableDeclaration | undefined {
        counts.declaration++;
        return resolved.get(identifier);
      },
      staticJsTypeOf(expression: ts.Expression): JsTag | "mixed" {
        counts.staticType++;
        return staticTag(expression);
      },
    },
    numericLocalVerdict: numericVerdict,
  } as unknown as CodegenContext;
  return { ctx, counts };
}

function identifierName(decl: ts.VariableDeclaration): string {
  return (decl.name as ts.Identifier).text;
}

describe("#1058 mixed-carrier scope index", () => {
  it("resolves N assignment targets once for N declarations", () => {
    const count = 72;
    const source = parse(`
      function factory() {
        ${Array.from({ length: count }, (_, i) => `var v${i} = ${i};`).join("\n")}
        ${Array.from({ length: count }, (_, i) => `v${i} = "s${i}";`).join("\n")}
      }
    `);
    const decls = declarations(source);
    const byName = new Map(decls.map((decl) => [identifierName(decl), decl]));
    const resolved = new WeakMap<ts.Identifier, ts.VariableDeclaration>();
    for (const assignment of equalsAssignments(source)) {
      const target = stripParens(assignment.left);
      if (ts.isIdentifier(target)) resolved.set(target, byName.get(target.text)!);
    }
    const { ctx, counts } = fakeContext(resolved);

    expect(decls).toHaveLength(count);
    for (const decl of decls) expect(bindingHasMixedAssignmentCarrier(ctx, decl)).toBe(true);
    expect(counts.declaration).toBe(count);
    expect(counts.staticType).toBe(count * 2);
  });

  it("indexes out-of-shape property writes once for all object bindings", () => {
    const count = 48;
    const source = parse(`
      function factory() {
        ${Array.from({ length: count }, (_, i) => `var o${i} = { base: ${i} };`).join("\n")}
        ${Array.from({ length: count }, (_, i) => `o${i}.extra = ${i};`).join("\n")}
      }
    `);
    const decls = declarations(source);
    const byName = new Map(decls.map((decl) => [identifierName(decl), decl]));
    const resolved = new WeakMap<ts.Identifier, ts.VariableDeclaration>();
    for (const assignment of equalsAssignments(source)) {
      if (!ts.isPropertyAccessExpression(assignment.left)) continue;
      const receiver = stripParens(assignment.left.expression);
      if (ts.isIdentifier(receiver)) resolved.set(receiver, byName.get(receiver.text)!);
    }
    const { ctx, counts } = fakeContext(resolved);

    for (const decl of decls) expect(bindingHasMixedAssignmentCarrier(ctx, decl)).toBe(true);
    expect(counts.declaration).toBe(count);
    // The out-of-shape proof returns before asking for representation tags.
    expect(counts.staticType).toBe(0);
  });

  it("keeps nested captures, shadows, and duplicate declarations identity-exact", () => {
    const source = parse(`
      function outer() {
        var captured = { a: 1 };
        function grow() { captured.b = 2; }
        var stable = { a: 1 };
        function shadow() { var stable = { a: 1 }; stable.b = 2; }
        var duplicate = 0;
        var duplicate = 1;
        duplicate = "string";
      }
    `);
    const decls = declarations(source);
    const named = (name: string): ts.VariableDeclaration[] => decls.filter((decl) => identifierName(decl) === name);
    const [captured] = named("captured");
    const [outerStable, innerStable] = named("stable");
    const [firstDuplicate, secondDuplicate] = named("duplicate");
    const [capturedWrite, stableWrite, duplicateWrite] = equalsAssignments(source);
    const resolved = new WeakMap<ts.Identifier, ts.VariableDeclaration>();
    resolved.set((capturedWrite!.left as ts.PropertyAccessExpression).expression as ts.Identifier, captured!);
    resolved.set((stableWrite!.left as ts.PropertyAccessExpression).expression as ts.Identifier, innerStable!);
    resolved.set(duplicateWrite!.left as ts.Identifier, secondDuplicate!);
    const { ctx } = fakeContext(resolved);

    expect(bindingHasMixedAssignmentCarrier(ctx, captured!)).toBe(true);
    expect(bindingHasMixedAssignmentCarrier(ctx, outerStable!)).toBe(false);
    expect(bindingHasMixedAssignmentCarrier(ctx, innerStable!)).toBe(true);
    expect(bindingHasMixedAssignmentCarrier(ctx, firstDuplicate!)).toBe(false);
    expect(bindingHasMixedAssignmentCarrier(ctx, secondDuplicate!)).toBe(true);
  });

  it("uses the unresolved-name fallback only in the immediate with body", () => {
    const source = parse(
      `
        function f(obj) {
          var widened = "a";
          with (obj) { widened = replacement; }
          var shadowed = "a";
          with (obj) { let shadowed = "b"; shadowed = replacement; }
          var nested = "a";
          with (obj) { function g() { nested = replacement; } }
        }
      `,
      ts.ScriptKind.JS,
    );
    const decls = declarations(source);
    const byName = new Map<string, ts.VariableDeclaration[]>();
    for (const decl of decls) {
      const list = byName.get(identifierName(decl)) ?? [];
      list.push(decl);
      byName.set(identifierName(decl), list);
    }
    const shadowAssignment = equalsAssignments(source).find(
      (assignment) => ts.isIdentifier(assignment.left) && assignment.left.text === "shadowed",
    )!;
    const innerShadow = byName.get("shadowed")![1]!;
    const resolved = new WeakMap<ts.Identifier, ts.VariableDeclaration>();
    resolved.set(shadowAssignment.left as ts.Identifier, innerShadow);
    const { ctx } = fakeContext(resolved);

    expect(bindingHasMixedAssignmentCarrier(ctx, byName.get("widened")![0]!)).toBe(true);
    expect(bindingHasMixedAssignmentCarrier(ctx, byName.get("shadowed")![0]!)).toBe(false);
    expect(bindingHasMixedAssignmentCarrier(ctx, innerShadow)).toBe(true);
    expect(bindingHasMixedAssignmentCarrier(ctx, byName.get("nested")![0]!)).toBe(false);
  });

  it("re-evaluates the phase-sensitive numeric verdict against cached syntax", () => {
    const source = parse(`function f() { var n = 0; n = dynamic(); }`);
    const [decl] = declarations(source);
    const [assignment] = equalsAssignments(source);
    const resolved = new WeakMap<ts.Identifier, ts.VariableDeclaration>();
    resolved.set(assignment!.left as ts.Identifier, decl!);
    let provenNumeric = false;
    const { ctx } = fakeContext(resolved, () => provenNumeric);

    expect(bindingHasMixedAssignmentCarrier(ctx, decl!)).toBe(true);
    provenNumeric = true;
    expect(bindingHasMixedAssignmentCarrier(ctx, decl!)).toBe(false);
  });

  it("preserves the implicit Annex B cross-domain write", () => {
    const source = parse(`function f() { var value = 0; { function value() {} } }`, ts.ScriptKind.JS);
    const [decl] = declarations(source);
    const { ctx } = fakeContext(new WeakMap());

    expect(bindingHasAnnexBExistingVarUpdate(decl!)).toBe(true);
    expect(bindingHasMixedAssignmentCarrier(ctx, decl!)).toBe(true);
  });
});

describe("#1058 bare-for-in scope index", () => {
  it("resolves N for-in targets once and skips nested function scopes", () => {
    const count = 64;
    const source = parse(`
      function factory(obj) {
        ${Array.from({ length: count }, (_, i) => `var v${i} = ${i};`).join("\n")}
        var nestedOnly = 0;
        ${Array.from({ length: count }, (_, i) => `for (${i === 0 ? "(v0)" : `v${i}`} in obj) {}`).join("\n")}
        function nested() { for (nestedOnly in obj) {} }
      }
    `);
    const decls = declarations(source);
    const byName = new Map(decls.map((decl) => [identifierName(decl), decl]));
    const resolved = new WeakMap<ts.Identifier, ts.VariableDeclaration>();
    for (const decl of decls) resolved.set(decl.name as ts.Identifier, decl);
    for (const statement of collect(source, ts.isForInStatement)) {
      const target = stripParens(statement.initializer as ts.Expression);
      if (ts.isIdentifier(target)) resolved.set(target, byName.get(target.text)!);
    }
    const { ctx, counts } = fakeContext(resolved);

    for (let i = 0; i < count; i++) {
      expect(varBindingIsForInIdentifierTarget(ctx, byName.get(`v${i}`)!)).toBe(true);
    }
    expect(varBindingIsForInIdentifierTarget(ctx, byName.get("nestedOnly")!)).toBe(false);
    // One declaration lookup per query plus one lookup per target in this
    // function. The nested function's target is never visited by this index.
    expect(counts.declaration).toBe(count * 2 + 1);
  });

  it("queries duplicate vars by canonical declaration and gives nested shadows their own index", () => {
    const source = parse(`
      function outer(obj) {
        var duplicate = 0;
        var duplicate = 1;
        for (duplicate in obj) {}
        var shadowed = 0;
        function inner() {
          var shadowed = 1;
          for (shadowed in obj) {}
        }
      }
    `);
    const decls = declarations(source);
    const duplicateDecls = decls.filter((decl) => identifierName(decl) === "duplicate");
    const shadowDecls = decls.filter((decl) => identifierName(decl) === "shadowed");
    const [outerForIn, innerForIn] = collect(source, ts.isForInStatement);
    const resolved = new WeakMap<ts.Identifier, ts.VariableDeclaration>();
    for (const decl of duplicateDecls) resolved.set(decl.name as ts.Identifier, duplicateDecls[0]!);
    resolved.set(outerForIn!.initializer as ts.Identifier, duplicateDecls[0]!);
    resolved.set(shadowDecls[0]!.name as ts.Identifier, shadowDecls[0]!);
    resolved.set(shadowDecls[1]!.name as ts.Identifier, shadowDecls[1]!);
    resolved.set(innerForIn!.initializer as ts.Identifier, shadowDecls[1]!);
    const { ctx } = fakeContext(resolved);

    expect(varBindingIsForInIdentifierTarget(ctx, duplicateDecls[0]!)).toBe(true);
    expect(varBindingIsForInIdentifierTarget(ctx, duplicateDecls[1]!)).toBe(true);
    expect(varBindingIsForInIdentifierTarget(ctx, shadowDecls[0]!)).toBe(false);
    expect(varBindingIsForInIdentifierTarget(ctx, shadowDecls[1]!)).toBe(true);
  });
});
