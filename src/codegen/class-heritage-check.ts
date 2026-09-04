// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5195 r3-5) ES §15.7.14 ClassDefinitionEvaluation step 5f: when a class has
// a heritage clause, the superclass value is evaluated and
// `IsConstructor(superclass)` is checked BEFORE anything else about the class
// exists — before its computed keys run, before its prototype is built. A
// non-constructor heritage (an arrow, a generator function, `42`, a call
// result) is a TypeError.
//
// Standalone never performed that check: `collectClassDeclaration` resolves an
// identifier or a class expression statically and the host-lane registration
// `extern.ts::emitRegisterDynamicClassParent` returns immediately under
// `ctx.standalone`, so `class D extends (() => {}) {}` silently compiled as a
// base class.
//
// SCOPE, deliberately narrow. This module answers the IsConstructor half only.
// The §15.7.14 step 5.g.ii "Get(superclass, 'prototype') is neither Object nor
// Null" half is NOT implemented here — see the residual note in
// `plan/issues/5195-es2015-standalone-class-r2.md`. Every row that needs only
// IsConstructor throws correctly; the two rows that need the prototype lookup
// (`constructable-but-no-prototype.js`, `Proxy/no-prototype-throws.js`) still
// fail exactly as they do on the base tree.
//
// The PREDICATE is the safety property of this step, not the emitter. A new
// throw at class-definition time can only ever make things worse if it fires
// on a heritage the compiler already handles, so `heritageExpressionNeedingRuntimeCheck`
// declines every shape with a working static lane and checks only what is left.

import { ts } from "../ts-api.js";
import { isHostConstructibleBuiltin } from "./builtin-tags.js";
import { BUILTIN_CONSTRUCTOR_IDENTITY_NAMES } from "./builtin-static-globals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocTempLocal } from "./context/locals.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureReflectIsConstructor } from "./reflect-construct-native.js";

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

/**
 * Does this identifier resolve to a value the compiler ALREADY lowers as a
 * constructible parent? Those chains are served by a static lane
 * (`classParentMap`, the fnctor-ancestor lane, the builtin-subclass carriers)
 * and must keep their exact current code — checking them at runtime would add
 * a throw where a working program stands.
 */
function identifierHasStaticParentLane(ctx: CodegenContext, id: ts.Identifier): boolean {
  const name = id.text;
  if (ctx.classSet.has(name) || ctx.classExprNameMap.has(name)) return true;
  if (isHostConstructibleBuiltin(name) || BUILTIN_CONSTRUCTOR_IDENTITY_NAMES.has(name)) return true;
  // The fnctor-parent lane: `function F(){} class G extends F {}`. A plain
  // (non-generator, non-async) function declaration or function expression IS
  // a constructor, so the check would pass anyway — declining keeps those
  // modules byte-identical instead of paying for a runtime answer we know.
  const decl = ctx.oracle.valueDeclarationOf(id);
  if (decl === undefined) return false;
  let fn: ts.SignatureDeclarationBase | undefined;
  if (ts.isFunctionDeclaration(decl)) {
    fn = decl;
  } else if (ts.isVariableDeclaration(decl) && decl.initializer !== undefined) {
    const init = unwrapHeritage(decl.initializer);
    if (ts.isFunctionExpression(init)) fn = init;
    if (ts.isClassExpression(init)) return true;
  }
  if (fn === undefined) return false;
  const asFn = fn as ts.FunctionLikeDeclaration;
  const isAsync = (asFn.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  return asFn.asteriskToken === undefined && !isAsync;
}

/**
 * The heritage expression of `decl` that must be evaluated and IsConstructor-
 * checked at runtime, or `undefined` when the compiler's static lane already
 * covers it.
 *
 * Declines: a bare `extends null` (legal, §15.7.14 step 5e); an identifier with
 * a static parent lane (see above); an inline class expression; a
 * PROPERTY-ACCESS heritage (`class Foo extends React.Component`) — the #4618
 * host-framework shape whose silent lane is deliberate; and a CALL / `new` /
 * tagged-template heritage, whose value the compiler cannot see (see the
 * comment on that branch — it is a correctness decline, not a cosmetic one).
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
    if (ts.isClassExpression(expr)) return undefined;
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) return undefined;
    // A CALL heritage is declined, and this is the one decline that is a
    // measured correctness requirement rather than a byte-identity one.
    // `__reflect_is_constructor` does NOT recognise a compiled class OBJECT
    // (the singleton is a `$C` struct, not one of the nominal closure wrappers
    // it tests), so `class D extends (pick()) {}` with `pick()` returning a
    // class answered "not a constructor" and THREW where the base tree quietly
    // compiled — a stable value turned into an exception, exactly what the
    // never-worse-than-base rule forbids (probe `.tmp/p/h4.js`). A call is the
    // only admitted shape whose value the compiler cannot see, so declining it
    // closes the hole; a `new` expression is declined for the same reason.
    if (ts.isCallExpression(expr) || ts.isNewExpression(expr) || ts.isTaggedTemplateExpression(expr)) {
      return undefined;
    }
    if (ts.isIdentifier(expr) && identifierHasStaticParentLane(ctx, expr)) return undefined;
    return expr;
  }
  return undefined;
}

/**
 * Emit the §15.7.14 step 5f check for `decl`, inline in `fctx`.
 *
 * Emitted INLINE rather than through a minted native on purpose: the heritage
 * expression itself has to be compiled in the enclosing scope (its bindings are
 * only live here), so a native would have to take the already-evaluated value
 * anyway — and the check is three instructions plus a throw. It fires only for
 * the shapes `heritageExpressionNeedingRuntimeCheck` admits, so a module
 * without one is byte-identical.
 *
 * The heritage expression is evaluated EXACTLY ONCE, which the
 * `prototype-getter.js` row asserts. In standalone nothing else evaluates it:
 * the static resolution in `collectClassDeclaration` is syntactic and
 * `emitRegisterDynamicClassParent` returns early under `ctx.standalone`.
 */
export function emitStandaloneHeritageCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  compileExpression: (ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression) => unknown,
): void {
  const expr = heritageExpressionNeedingRuntimeCheck(ctx, decl);
  if (expr === undefined) return;
  const isCtorIdx = ensureReflectIsConstructor(ctx);
  const before = fctx.body.length;
  const produced = compileExpression(ctx, fctx, expr);
  if (produced === null || produced === undefined) {
    // The heritage expression did not compile to a value; leave the module
    // exactly as it was rather than emitting a half-built check.
    fctx.body.length = before;
    return;
  }
  const value = produced as { kind: string };
  // Anything that is not already an externref cannot be a constructor
  // (`class C extends 42 {}` compiles its heritage to an f64). Drop the value
  // and throw unconditionally — the spec answer for every non-object.
  if (value.kind !== "externref") {
    fctx.body.push({ op: "drop" });
    fctx.body.push(
      ...buildThrowJsErrorInstrs(ctx, "TypeError", "Class extends value is not a constructor or null", {
        forceInModuleCtor: true,
      }),
    );
    return;
  }
  const tmp = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [],
    else: [
      { op: "local.get", index: tmp },
      { op: "call", funcIdx: isCtorIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...buildThrowJsErrorInstrs(ctx, "TypeError", "Class extends value is not a constructor or null", {
            forceInModuleCtor: true,
          }),
        ],
        else: [],
      },
    ],
  });
}
