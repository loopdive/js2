// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5195 r3-5) ES §15.7.14 ClassDefinitionEvaluation step 5f: when a class has
// a heritage clause, the superclass value is evaluated and
// `IsConstructor(superclass)` is checked BEFORE anything else about the class
// exists — before its computed keys run, before its prototype is built. A
// non-constructor heritage (an arrow, a generator function, `42`, an object
// literal) is a TypeError.
//
// Standalone never performed that check: `collectClassDeclaration` resolves an
// identifier or a class expression statically and the host-lane registration
// `extern.ts::emitRegisterDynamicClassParent` returns immediately under
// `ctx.standalone`, so `class D extends (() => {}) {}` silently compiled as a
// base class.
//
// SCOPE, deliberately narrow. This module answers the IsConstructor half only,
// and only for a heritage the compiler can prove NOT to be a constructor by
// reading the source. The §15.7.14 step 5.g.ii "Get(superclass, 'prototype')
// is neither Object nor Null" half is NOT implemented here — see the residual
// note in `plan/issues/5195-es2015-standalone-class-r2.md`.
//
// COMPILE-TIME PROOF ONLY (r3 review F1, 2026-09-04). The first cut also
// admitted any heritage the compiler could not trace — a parameter, a
// function-scope alias, a conditional, an inline function expression — and
// then treated every non-externref value as a non-constructor, which threw
// unconditionally on WORKING programs: the canonical mixin factory
// `B => class extends B {}`, `function mk(P) { class D extends P {} }`,
// `class D extends (flag ? A : B) {}`. There is no true-positive runtime lane
// for a class VALUE either, because `__reflect_is_constructor` does not
// recognise a compiled class object (a `$C` struct, not one of the nominal
// closure wrappers it tests). So the runtime arm is gone: a heritage the
// compiler cannot prove to be a non-constructor is DECLINED and keeps exactly
// the code the base tree emitted for it.

import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";

/** Unwrap the parenthesis / assertion wrappers a heritage expression may carry. */
function unwrapHeritage(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** A syntactic form whose VALUE can never be a constructor. */
function literalIsProvablyNotConstructor(expr: ts.Expression): boolean {
  switch (expr.kind) {
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
      return true;
    default:
      return false;
  }
}

/**
 * A function-like whose [[Construct]] slot does not exist: an arrow, a
 * generator, an async function, an async generator. A PLAIN function
 * expression / declaration IS a constructor and answers false here.
 */
function functionLikeIsProvablyNotConstructor(node: ts.Node): boolean {
  if (ts.isArrowFunction(node)) return true;
  if (!ts.isFunctionExpression(node) && !ts.isFunctionDeclaration(node)) return false;
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  const isAsync = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  return node.asteriskToken !== undefined || isAsync;
}

/**
 * True when this identifier occurrence is an ASSIGNMENT TARGET in any spelling.
 *
 * (#5195 r3 review round 2, F1) The first cut recognised only
 * `BinaryExpression.left` and a `++`/`--` operand, so every destructuring and
 * loop-head spelling of a write read as "never written":
 * `for (X of [Base]) {}`, `[X] = [Base]`, `({X} = o)`, `({q: X} = o)`,
 * `(X) = Base`, `[a, ...X] = o`, `({...X} = o)`. A heritage bound that way was
 * "proven" a non-constructor and threw on a working program.
 *
 * So the target test walks UP through every wrapper a destructuring pattern can
 * put between the identifier and the assignment — parentheses, array/object
 * literal patterns, spreads, shorthand and keyed property assignments — and
 * then asks whether the thing it arrived at sits in a write position.
 */
function occurrenceIsWriteTarget(id: ts.Node): boolean {
  let current: ts.Node = id;
  let parent: ts.Node | undefined = current.parent;
  while (parent !== undefined) {
    if (ts.isParenthesizedExpression(parent)) {
      current = parent;
      parent = current.parent;
      continue;
    }
    if (ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent)) {
      current = parent;
      parent = current.parent;
      continue;
    }
    if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) {
      current = parent;
      parent = current.parent;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(parent) || ts.isPropertyAssignment(parent)) {
      // `({X} = o)` / `({q: X} = o)` — and, conservatively, the read spellings
      // `({X})` / `({q: X})` too, which only costs a decline.
      current = parent;
      parent = current.parent;
      continue;
    }
    // A binding element (`var {X = d} = o`) is a declaration site, handled by
    // the binding count; treat the whole shape as a write to stay conservative.
    if (ts.isBindingElement(parent)) return true;
    break;
  }
  if (parent === undefined) return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === current &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === current) return true;
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if (ts.isDeleteExpression(parent)) return true;
  return false;
}

/**
 * True when `name` has EXACTLY ONE binding site in this file — `declaration` —
 * and is never assigned to. Only then does the declaration's initializer prove
 * anything about the value the heritage clause reads.
 *
 * Deliberately whole-file and name-based rather than scope-aware: a same-named
 * binding or write anywhere in the module makes this answer false, which
 * DECLINES the check. Over-declining costs a row; under-declining throws on a
 * working program (`let X = () => {}; X = A; class D extends X {}`).
 *
 * A file containing `eval` or a `with` statement declines outright: either can
 * rebind the name in a way no source scan can see.
 */
export function bindingIsUniqueAndNeverWritten(id: ts.Identifier, declaration: ts.Declaration): boolean {
  const name = id.text;
  let bindings = 0;
  let ownBinding = false;
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    if (ts.isWithStatement(node)) {
      written = true;
      return;
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "eval") {
        written = true;
        return;
      }
      if (node.text === name) {
        const parent: ts.Node | undefined = node.parent;
        if (parent !== undefined) {
          const isBindingSite =
            (ts.isVariableDeclaration(parent) ||
              ts.isParameter(parent) ||
              ts.isBindingElement(parent) ||
              ts.isFunctionDeclaration(parent) ||
              ts.isFunctionExpression(parent) ||
              ts.isClassDeclaration(parent) ||
              ts.isClassExpression(parent) ||
              ts.isImportSpecifier(parent) ||
              ts.isNamespaceImport(parent) ||
              ts.isImportClause(parent)) &&
            (parent as { name?: ts.Node }).name === node;
          const isPropertyName =
            (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node) ||
            (ts.isQualifiedName(parent) && parent.right === node);
          if (isBindingSite) {
            bindings += 1;
            if (parent === declaration) ownBinding = true;
          } else if (!isPropertyName && occurrenceIsWriteTarget(node)) {
            written = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(id.getSourceFile());
  return !written && bindings === 1 && ownBinding;
}

/**
 * True when this identifier names an AMBIENT GLOBAL — no declaration at all, or
 * one that lives in a `.d.ts` lib file. A module-local binding of the same name
 * answers false, so a shadowed `Proxy` is never treated as the intrinsic.
 */
function identifierIsAmbientGlobal(ctx: CodegenContext, id: ts.Identifier): boolean {
  const declaration = ctx.oracle.valueDeclarationOf(id);
  return declaration === undefined || declaration.getSourceFile().isDeclarationFile;
}

/**
 * Can the compiler PROVE, by reading the source, that this heritage value is
 * not a constructor? Everything it cannot prove is declined — see the
 * COMPILE-TIME PROOF ONLY note at the top of this file.
 */
function heritageIsProvablyNotConstructor(ctx: CodegenContext, expr: ts.Expression, depth = 0): boolean {
  if (literalIsProvablyNotConstructor(expr)) return true;
  if (functionLikeIsProvablyNotConstructor(expr)) return true;
  // `(<non-constructor function literal>).bind(…)`: BoundFunctionCreate copies
  // the target's [[Construct]], so binding a non-constructor yields a
  // non-constructor. Binding a plain function yields a CONSTRUCTOR, which is
  // why the receiver has to be a literal arrow / generator / async function
  // right here — nothing indirect is admitted.
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "bind" &&
    functionLikeIsProvablyNotConstructor(unwrapHeritage(expr.expression.expression))
  ) {
    return true;
  }
  // `new Proxy(<non-constructor>, …)`: a proxy exposes [[Construct]] only when
  // its TARGET has one (§10.5.14).
  if (
    ts.isNewExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Proxy" &&
    identifierIsAmbientGlobal(ctx, expr.expression) &&
    expr.arguments !== undefined &&
    expr.arguments.length > 0 &&
    functionLikeIsProvablyNotConstructor(unwrapHeritage(expr.arguments[0]!))
  ) {
    return true;
  }
  if (!ts.isIdentifier(expr)) return false;
  const declaration = ctx.oracle.valueDeclarationOf(expr);
  // A bare `undefined` that resolves to no declaration is the global
  // `undefined` — `class D extends undefined {}` is a TypeError.
  if (declaration === undefined || declaration.getSourceFile().isDeclarationFile) {
    return expr.text === "undefined";
  }
  if (!bindingIsUniqueAndNeverWritten(expr, declaration)) return false;
  if (ts.isFunctionDeclaration(declaration)) return functionLikeIsProvablyNotConstructor(declaration);
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    const initializer = unwrapHeritage(declaration.initializer);
    // An alias chain (`var a = () => {}; var b = a;`) is followed while every
    // link is itself a unique, never-written binding. Bounded so a cycle the
    // binder allows cannot spin.
    if (depth >= 4) return false;
    return heritageIsProvablyNotConstructor(ctx, initializer, depth + 1);
  }
  return false;
}

/**
 * The heritage expression of `decl` that is PROVABLY not a constructor and so
 * must throw at class-definition time, or `undefined` when the compiler cannot
 * prove it — in which case the class keeps exactly the code the base tree
 * emitted for it.
 *
 * Declines, among everything else it cannot prove: a bare `extends null`
 * (legal, §15.7.14 step 5e); a class, builtin or plain-function parent; an
 * inline class expression; a PROPERTY-ACCESS heritage (`class Foo extends
 * React.Component`, the #4618 host-framework shape); a CALL / `new` /
 * tagged-template heritage whose value the compiler cannot see; and every
 * parameter, alias, conditional or reassigned binding.
 */
export function heritageExpressionNeedingRuntimeCheck(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
): ts.Expression | undefined {
  if (!ctx.standalone) return undefined;
  if (decl.heritageClauses === undefined) return undefined;
  for (const clause of decl.heritageClauses) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword || clause.types.length === 0) continue;
    const expr = unwrapHeritage(clause.types[0]!.expression);
    if (expr.kind === ts.SyntaxKind.NullKeyword) return undefined;
    return heritageIsProvablyNotConstructor(ctx, expr) ? expr : undefined;
  }
  return undefined;
}

/**
 * Emit the §15.7.14 step 5f throw for `decl`, inline in `fctx`.
 *
 * Emitted INLINE rather than through a minted native on purpose: the heritage
 * expression itself has to be compiled in the enclosing scope (its bindings are
 * only live here). It fires only for the shapes
 * `heritageExpressionNeedingRuntimeCheck` proves are not constructors, so a
 * module without one is byte-identical to the base tree.
 *
 * The heritage expression is evaluated EXACTLY ONCE and then dropped — its own
 * side effects are observable, its value is not a constructor by construction.
 * In standalone nothing else evaluates it: the static resolution in
 * `collectClassDeclaration` is syntactic and `emitRegisterDynamicClassParent`
 * returns early under `ctx.standalone`.
 */
export function emitStandaloneHeritageCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  compileExpression: (ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression) => unknown,
): void {
  const expr = heritageExpressionNeedingRuntimeCheck(ctx, decl);
  if (expr === undefined) return;
  const before = fctx.body.length;
  const produced = compileExpression(ctx, fctx, expr);
  if (typeof (produced as { kind?: unknown } | null)?.kind !== "string") {
    // The heritage expression did not compile to a droppable value; leave the
    // module exactly as it was rather than emitting a half-built check.
    fctx.body.length = before;
    return;
  }
  fctx.body.push({ op: "drop" });
  fctx.body.push(
    ...buildThrowJsErrorInstrs(ctx, "TypeError", "Class extends value is not a constructor or null", {
      forceInModuleCtor: true,
    }),
  );
}
