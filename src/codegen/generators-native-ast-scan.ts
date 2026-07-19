// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native-generator AST-scan predicate primitives (#3271 — extracted from
 * generators-native.ts).
 *
 * Pure `ts.Node` / `ValType` → boolean / list predicates used by the generator
 * planner + candidacy gates: does a statement/subtree contain a `yield` / a
 * `return`, does a body reference `this` / `super` / its own name / a colliding
 * binding, does a try-region cross a yield, is a spilled local's ValType
 * struct-safe, etc. None of these take a `CodegenContext`, call the planner /
 * register / emit core, or touch any private state-machine type — they only
 * call each other and the TypeScript API. The core imports them back
 * one-directionally (no runtime import cycle; only a type-only `GeneratorDecl`
 * reference points back to `generators-native.ts`).
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { GeneratorDecl } from "./generators-native.js";

/**
 * (#3271) A function-like SCOPE the AST scans must not descend into (a nested
 * `yield` / `return` / `this` there belongs to an inner function, not the
 * generator being scanned). This is the exact 4-way disjunction the scan
 * visitors repeated inline. NOTE: it INCLUDES arrow functions on purpose — the
 * `this`/`super`-scope scans (`methodBodyUsesSuper` / `fnExprBodyReferencesThis`)
 * deliberately use a DIFFERENT set that OMITS arrows (arrows inherit the
 * enclosing `this`/`super`), so those keep their own inline disjunction and must
 * not be folded into this helper.
 */
export function isFunctionLikeScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

export function statementContainsYield(stmt: ts.Statement): boolean {
  return nodeContainsYield(stmt);
}

/**
 * A `return` anywhere in this statement (not descending into nested functions).
 * Used to route `if`/loops that contain a `return` through the structural
 * lowering even when they have no yield — a `return` inside a generator must
 * produce `{value, done:true}`, NOT a raw wasm `return` (which `compileStatement`
 * would emit, mis-coercing the value to the resume function's result-ref type).
 */
function statementContainsReturn(stmt: ts.Statement): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    if (isFunctionLikeScope(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(stmt, visit);
  return found;
}

/** Statement needs structural state-graph lowering (vs straight-line prelude). */
export function statementNeedsStructuralLowering(stmt: ts.Statement): boolean {
  if (statementContainsYield(stmt)) return true;
  // A bare/top-level `return` is handled by the caller's `return` terminator;
  // but a `return` nested inside control flow needs structural lowering so it
  // still maps to a generator-completion terminator.
  if (!ts.isReturnStatement(stmt) && statementContainsReturn(stmt)) return true;
  return false;
}

export function nodeContainsYield(root: ts.Node): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isYieldExpression(node)) {
      found = true;
      return;
    }
    // Do not descend into nested function bodies — a `yield` there belongs to
    // a different (inner) generator and must not split this one.
    if (isFunctionLikeScope(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(root, visit);
  return found;
}

/**
 * (#2920) A spilled destructured-param local must round-trip through a state
 * struct field, so its ValType needs a struct-construction default. Scalars and
 * nullable refs qualify; a non-null `ref` is widened to `ref_null` (matching the
 * F1b reconcile). Any other kind → null (bail the whole generator to host).
 */
export function spillSafeValType(t: ValType): ValType | null {
  switch (t.kind) {
    case "f64":
    case "i32":
    case "i64":
    case "externref":
    case "ref_null":
      return t;
    case "ref":
      return { kind: "ref_null", typeIdx: t.typeIdx };
    default:
      return null;
  }
}

/**
 * (#3050) True when `body` (a generator body) declares a binding named `name`
 * anywhere reachable in this function's scope model (var/let/const declaration,
 * or a nested non-function block). Used to bail a catch-param spill whose name
 * would collide with a body local in the resume function's flat local map.
 * Does not descend into nested function-likes (their locals are theirs).
 */
export function bodyDeclaresBinding(body: ts.Node, name: string): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      // A catch clause's binding IS a ts.VariableDeclaration — catch params are
      // exactly what this check protects, so they don't collide with themselves
      // (same-named sibling catch params share the externref slot safely).
      !ts.isCatchClause(node.parent)
    ) {
      found = true;
      return;
    }
    if (isFunctionLikeScope(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return found;
}

/** A `break`/`continue` inside a yield-loop body is not modeled in this slice. */
export function loopBodyHasUnsupportedJump(body: ts.Statement): boolean {
  let bad = false;
  function visit(node: ts.Node): void {
    if (bad) return;
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      bad = true;
      return;
    }
    // Don't descend into nested loops/switches — their break/continue bind
    // there, not to the loop we're checking. (A break in a nested yield-free
    // loop is fine; a break in THIS loop that crosses a yield is the problem.
    // Conservatively reject any break/continue at this level when the body
    // yields — caller only invokes this for yielding bodies.)
    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node) ||
      isFunctionLikeScope(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return bad;
}

export function thenBody(stmt: ts.Statement): readonly ts.Statement[] {
  if (ts.isBlock(stmt)) return stmt.statements;
  return [stmt];
}

/**
 * (#2571) True when a method body references `super.*` (a `SuperKeyword` that is
 * not just a nested function's own `super`). The native generator resume
 * function has no `super`-binding setup, so a `super`-using method generator
 * bails to the eager-buffer host path. Stops at nested non-arrow functions
 * (their `super` is their own concern); arrow functions inherit the method's
 * `super`, so it does NOT stop at them.
 */
export function methodBodyUsesSuper(body: ts.Node): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (node.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    // Nested non-arrow function-likes rebind `super` — their `super` is their
    // own; do not descend (arrow functions keep the enclosing `super`).
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return found;
}

/**
 * (#3164) `this` (or `super`) anywhere in the fn-expr body, EXCLUDING nested
 * non-arrow function scopes (their `this` is their own). An arrow's `this` IS
 * the generator's, so arrows are descended into.
 */
export function fnExprBodyReferencesThis(body: ts.Node): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    // Nested non-arrow function-likes rebind `this` — do not descend.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return found;
}

/**
 * (#3164) Conservative: any identifier in the body textually equal to the named
 * fn-expr's own name counts as a self-reference (shadowing not modeled — an
 * over-bail keeps the host path, never a wrong compile).
 */
export function bodyReferencesOwnName(body: ts.Node, name: string): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return found;
}
