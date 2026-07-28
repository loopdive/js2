// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3673 — whole-program set of property names the SOURCE itself defines as a
 * function-valued member (a "user method").
 *
 * ## Why this exists
 *
 * `compileGuardedNativeStringMethodCall` (string-ops.ts) lowers a string method
 * called on an `any`/unknown receiver as a runtime `ref.test $AnyString`:
 * hit → the native `__str_*` helper, miss → "the method's spec default for its
 * result type". That miss default was written for receivers that are arrays,
 * numbers or null, where a benign sentinel is the honest answer.
 *
 * It is NOT honest when the receiver is an OBJECT that defines a method of the
 * same name. Compiled acorn is exactly that case: `RegExpValidationState`
 * defines its own `at(i, forceU)`, and `at` is also `String.prototype.at`, so
 * every `state.at(...)` / `state.current()` took the string arm, missed the
 * `ref.test`, and produced `ref.null $AnyString` — read back as `0` instead of
 * the `-1` end-of-input sentinel. `regexp_eatPatternCharacters`'s
 * `while ((ch = state.current()) !== -1 && …)` therefore never terminated, so
 * EVERY `u`-flag regex literal hung the standalone parser.
 *
 * Knowing which names the program actually defines lets the guarded lowering
 * keep its fast, unboxed native path for the overwhelming majority of names
 * (`charCodeAt`, `slice`, `substr`, … — the acorn tokenizer hot set, which no
 * user code redefines) and pay for a real dynamic fallback only on the names
 * where a collision is genuinely possible.
 *
 * ## What counts as a definition
 *
 * Deliberately over-approximate — a false positive only costs the guarded
 * lowering its unboxed result type on that one name, while a false negative is
 * a silent wrong answer:
 *
 *   - `X.prototype.NAME = <fn>` / `X.NAME = <fn>` (prototype-style JS, acorn)
 *   - a class `NAME() {}` method / get/set accessor
 *   - an object-literal `NAME() {}` shorthand method
 *   - an object-literal / class-property `NAME: <fn>` whose initializer is a
 *     function or arrow
 *
 * A non-function-valued property (`this.pos = 0`, `{ at: 3 }`) is NOT a method
 * definition and must not demote the name — that would pessimize `at`/`slice`
 * for any program with a numeric field of that name.
 */
import ts from "typescript";

/** Is `expr` a function-valued initializer (the RHS of a method definition)? */
function isFunctionValued(expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  return ts.isFunctionExpression(expr) || ts.isArrowFunction(expr) || ts.isClassExpression(expr);
}

/** The member name of a class/object-literal element, when it is a plain identifier or string key. */
function memberName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/**
 * Collect every property name the module defines as a function-valued member.
 * Cheap single walk; safe to run unconditionally (an empty result restores the
 * pre-#3673 lowering exactly).
 */
export function collectUserMethodNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  const visit = (node: ts.Node): void => {
    // `X.prototype.NAME = function …` / `X.NAME = function …`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      isFunctionValued(node.right)
    ) {
      names.add(node.left.name.text);
    }

    // class members: methods, accessors, and function-valued property decls
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
          const n = memberName(member.name);
          if (n !== undefined) names.add(n);
        } else if (ts.isPropertyDeclaration(member) && isFunctionValued(member.initializer)) {
          const n = memberName(member.name);
          if (n !== undefined) names.add(n);
        }
      }
    }

    // object literals: `{ NAME() {} }`, `{ get NAME() {} }`, `{ NAME: fn }`
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
          const n = memberName(prop.name);
          if (n !== undefined) names.add(n);
        } else if (ts.isPropertyAssignment(prop) && isFunctionValued(prop.initializer)) {
          const n = memberName(prop.name);
          if (n !== undefined) names.add(n);
        }
      }
    }

    // TS interface / type-literal method signatures — a declared shape the
    // program may dispatch on dynamically.
    if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
      for (const member of node.members) {
        if (ts.isMethodSignature(member)) {
          const n = memberName(member.name);
          if (n !== undefined) names.add(n);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return names;
}
