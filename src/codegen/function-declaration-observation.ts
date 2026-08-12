// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { addFunctionOwnLocals } from "./binding-info.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/** Whether a closure observes a binding outside a direct call position. */
export function closureObservesBindingValue(closure: ts.ArrowFunction | ts.FunctionExpression, name: string): boolean {
  let observed = false;
  const visit = (node: ts.Node): void => {
    if (observed) return;
    if (node !== closure && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      if (!(ts.isCallExpression(parent) && parent.expression === node)) observed = true;
    }
    node.forEachChild(visit);
  };
  visit(closure);
  return observed;
}

/** Expand nested-function capture dependencies to their transitive closure. */
export function collectTransitiveCaptureNames(
  nestedCaptures: ReadonlyMap<string, readonly { name: string }[]>,
  referencedNames: Set<string>,
  ownLocals: ReadonlySet<string>,
  isEnclosingParameter: (name: string) => boolean,
): Set<string> {
  const required = new Set<string>();
  const worklist = [...referencedNames];
  const visited = new Set<string>();
  while (worklist.length > 0) {
    const name = worklist.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    if (ownLocals.has(name) || isEnclosingParameter(name)) continue;
    for (const capture of nestedCaptures.get(name) ?? []) {
      if (ownLocals.has(capture.name)) continue;
      required.add(capture.name);
      if (!referencedNames.has(capture.name)) {
        referencedNames.add(capture.name);
        worklist.push(capture.name);
      }
    }
  }
  return required;
}

export function collectNestedCaptureReferences(
  referencedNames: Set<string>,
  ownLocals: ReadonlySet<string>,
  visibleCaptures: Iterable<string>,
  siblingCaptures: Iterable<string>,
): { directlyReferencedNames: Set<string>; transitivelyRequiredNames: Set<string> } {
  const directlyReferencedNames = new Set(referencedNames);
  const transitivelyRequiredNames = new Set<string>();
  for (const name of visibleCaptures) {
    if (ownLocals.has(name)) continue;
    referencedNames.add(name);
    transitivelyRequiredNames.add(name);
  }
  for (const name of siblingCaptures) {
    referencedNames.add(name);
    transitivelyRequiredNames.add(name);
  }
  return { directlyReferencedNames, transitivelyRequiredNames };
}

/** True when a declaration body uses `name` in an identity-observing position. */
export function functionDeclarationObservesBindingValue(stmt: ts.FunctionDeclaration, name: string): boolean {
  let observed = false;
  const visit = (node: ts.Node): void => {
    if (observed) return;
    if (
      node !== stmt &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      const nestedOwnLocals = new Set<string>();
      addFunctionOwnLocals(node, nestedOwnLocals);
      if (nestedOwnLocals.has(name)) return;
    } else if (node !== stmt && ts.isClassLike(node) && node.name?.text === name) {
      return;
    }
    if (ts.isIdentifier(node) && node !== stmt.name && node.text === name) {
      const parent = node.parent;
      if (!(ts.isCallExpression(parent) && parent.expression === node)) {
        observed = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(stmt);
  return observed;
}

/** True when a stable function binding's lifted implementation executes here. */
export function functionDeclarationInvokesBinding(stmt: ts.FunctionDeclaration, name: string): boolean {
  let invoked = false;
  const visit = (node: ts.Node): void => {
    if (invoked) return;
    if (
      node !== stmt &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isClassLike(node))
    ) {
      return;
    }
    if (ts.isIdentifier(node) && node !== stmt.name && node.text === name) {
      const parent = node.parent;
      if (
        (ts.isCallExpression(parent) && parent.expression === node) ||
        (ts.isNewExpression(parent) && parent.expression === node)
      ) {
        invoked = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(stmt);
  return invoked;
}

export function observesHoistedFunctionValueBinding(
  fctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
  name: string,
): boolean {
  return !!fctx.hoistedFunctionValueBindings?.has(name) && functionDeclarationObservesBindingValue(stmt, name);
}

export function hasUnobservedHoistedFunctionValueBinding(
  fctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
  name: string,
): boolean {
  return !!fctx.hoistedFunctionValueBindings?.has(name) && !functionDeclarationObservesBindingValue(stmt, name);
}

export function skipUnobservedHoistedCapture(
  fctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
  name: string,
  directlyReferencedNames: ReadonlySet<string>,
  transitivelyRequiredNames: ReadonlySet<string>,
): boolean {
  return (
    directlyReferencedNames.has(name) &&
    !transitivelyRequiredNames.has(name) &&
    hasUnobservedHoistedFunctionValueBinding(fctx, stmt, name)
  );
}

export function observesOnlyHoistedFunctionValue(
  fctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
  name: string,
): boolean {
  return observesHoistedFunctionValueBinding(fctx, stmt, name) && !functionDeclarationInvokesBinding(stmt, name);
}

/** Allocate stable lexical storage for identity-observed FunctionDeclarations. */
export function prepareHoistedFunctionValueBindings(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
): void {
  for (const stmt of stmts) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !stmt.body || !declarationValueIsObserved(ctx, stmt)) {
      continue;
    }
    if (!fctx.localMap.has(stmt.name.text)) {
      allocLocal(fctx, stmt.name.text, { kind: "externref" });
      (fctx.hoistedFunctionValueBindings ??= new Set()).add(stmt.name.text);
    }
  }
}

function declarationValueIsObserved(ctx: CodegenContext, decl: ts.FunctionDeclaration): boolean {
  let observed = false;
  const visit = (node: ts.Node): void => {
    if (observed) return;
    if (ts.isIdentifier(node) && node !== decl.name && ctx.oracle.valueDeclarationOf(node) === decl) {
      const parent = node.parent;
      if (!(ts.isCallExpression(parent) && parent.expression === node)) observed = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.isBlock(decl.parent) || ts.isSourceFile(decl.parent) ? decl.parent : decl.getSourceFile());
  return observed;
}
