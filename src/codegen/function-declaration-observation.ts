// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { addFunctionOwnLocals } from "../ir/analysis/binding-info.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { annexBDeclaringRange, annexBUpdatesExistingVarBinding } from "./annexb-cancel.js";
import { getOrRegisterRefCellType } from "./registry/types.js";

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

/** Whether a source local shadows a same-named lifted capturing function. */
export function localBindingShadowsCapturingFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callee: ts.Identifier,
): boolean {
  const name = callee.text;
  if (!fctx.localMap.has(name) || !ctx.funcMap.has(name)) return false;
  if (fctx.hoistedFunctionValueBindings?.has(name)) return false;
  // A lifted frame's recorded capture slot is a proven lexical binding in
  // this activation; it must outrank any same-named bare funcMap entry.
  if (fctx.liftedCaptureSlots?.has(name)) return true;
  const declaration = ctx.oracle.valueDeclarationOf(callee);
  // A declaration-backed dynamic local can shadow a same-named lifted body,
  // while a local with closure metadata must retain its wrapper path for
  // recursive/rest calls.
  if (declaration && ts.isVariableDeclaration(declaration)) {
    const initializer = declaration.initializer;
    if (
      initializer &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
      initializer.parameters.some((param) => param.dotDotDotToken !== undefined)
    ) {
      return false;
    }
    if (initializer && ts.isFunctionExpression(initializer) && initializer.name?.text === name) return false;
    return true;
  }
  // Call syntax already proves the local is being invoked. Redirect only when
  // the conflicting direct body would also prepend captures, which is the
  // cross-frame corruption this predicate guards against.
  return ctx.nestedFuncCaptures.has(name) || (declaration !== undefined && ts.isParameter(declaration));
}

/** Allocate stable lexical storage for identity-observed FunctionDeclarations. */
export function prepareHoistedFunctionValueBindings(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
): void {
  for (const stmt of stmts) {
    if (
      !ts.isFunctionDeclaration(stmt) ||
      !stmt.name ||
      !stmt.body ||
      annexBDeclaringRange(stmt) !== null ||
      functionDeclarationHasAnnexBUpdater(stmt) ||
      !functionDeclarationValueIsObserved(ctx, stmt)
    ) {
      continue;
    }
    if (!hasStableFunctionValueCaptureAbi(fctx, stmt)) continue;
    if (!fctx.localMap.has(stmt.name.text)) {
      const cyclic = functionValueDependencyIsCyclic(ctx, stmt, stmts);
      if (cyclic) {
        const valueType = { kind: "externref" } as const;
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, valueType);
        const localIdx = allocLocal(fctx, stmt.name.text, { kind: "ref", typeIdx: refCellTypeIdx });
        // Allocate the live binding before constructing any closure in this
        // reachable cycle. Every edge can carry the cell first; the recursive
        // materializer then fills closure values without recursing forever.
        fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        fctx.body.push({ op: "local.set", index: localIdx });
        (fctx.boxedCaptures ??= new Map()).set(stmt.name.text, { refCellTypeIdx, valType: valueType });
      } else {
        allocLocal(fctx, stmt.name.text, { kind: "externref" });
      }
      (fctx.hoistedFunctionValueBindings ??= new Set()).add(stmt.name.text);
    }
  }
}

/** Keep unsafe declaration-value captures on statement-position lowering. */
export function canHoistFunctionDeclarationInLiftedFrame(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.Statement,
  siblings: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
): boolean {
  return (
    !ts.isFunctionDeclaration(stmt) ||
    !stmt.name ||
    !stmt.body ||
    !functionDeclarationValueIsObserved(ctx, stmt) ||
    !declarationOwnerIsAsync(stmt) ||
    hasStableFunctionValueCaptureAbi(fctx, stmt)
  );
}

function declarationOwnerIsAsync(stmt: ts.FunctionDeclaration): boolean {
  let owner: ts.Node | undefined = stmt.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  return (
    !!owner &&
    !!ts.getModifiers(owner as ts.HasModifiers)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

export function liftedFrameHoistableStatements(
  ctx: CodegenContext,
  fctx: FunctionContext,
  statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
): ts.Statement[] {
  const unsafe = new Set<ts.FunctionDeclaration>();
  const unsafeNames = new Set<string>();
  for (const statement of statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      !canHoistFunctionDeclarationInLiftedFrame(ctx, fctx, statement, statements)
    ) {
      unsafe.add(statement);
      if (statement.name) unsafeNames.add(statement.name.text);
    }
  }

  for (let changed = true; changed; ) {
    changed = false;
    for (const statement of statements) {
      if (!ts.isFunctionDeclaration(statement) || unsafe.has(statement)) continue;
      let reachesUnsafeSibling = false;
      const visit = (node: ts.Node): void => {
        if (reachesUnsafeSibling) return;
        if (node !== statement && ts.isFunctionLike(node)) return;
        if (ts.isIdentifier(node) && unsafeNames.has(node.text) && isRuntimeIdentifierReference(node)) {
          reachesUnsafeSibling = true;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(statement);
      if (reachesUnsafeSibling) {
        unsafe.add(statement);
        if (statement.name) unsafeNames.add(statement.name.text);
        changed = true;
      }
    }
  }

  return statements.filter((statement) => !ts.isFunctionDeclaration(statement) || !unsafe.has(statement));
}

/**
 * The stable declaration-value carrier snapshots capture fields using the
 * declaring frame's current Wasm representation. GC references may be rebuilt
 * with a different concrete type in a lifted/async frame. Keep those on the
 * established direct declaration route until the carriers have a compatible
 * ABI. Cyclic function values are safe because their live cells are allocated
 * before closure construction begins.
 */
function hasStableFunctionValueCaptureAbi(fctx: FunctionContext, decl: ts.FunctionDeclaration): boolean {
  const ownLocals = new Set<string>();
  addFunctionOwnLocals(decl, ownLocals);
  let stable = true;
  const visit = (node: ts.Node): void => {
    if (!stable) return;
    if (node !== decl && ts.isFunctionLike(node)) return;
    if (ts.isIdentifier(node) && isRuntimeIdentifierReference(node) && !ownLocals.has(node.text)) {
      const localIdx = fctx.localMap.get(node.text);
      if (localIdx !== undefined) {
        const type = getLocalType(fctx, localIdx);
        if (!type || (type.kind !== "i32" && type.kind !== "i64" && type.kind !== "f32" && type.kind !== "f64")) {
          stable = false;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(decl);
  return stable;
}

/** Whether materializing target can reach any recursive value dependency. */
function functionValueDependencyIsCyclic(
  ctx: CodegenContext,
  target: ts.FunctionDeclaration,
  siblings: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
): boolean {
  const namedDeclarations = new Map<ts.Declaration, string>();
  const dependencyRoots = new Map<string, ts.Node>();
  for (const stmt of siblings) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      namedDeclarations.set(stmt, stmt.name.text);
      dependencyRoots.set(stmt.name.text, stmt);
      continue;
    }
    if (!ts.isVariableStatement(stmt)) continue;
    for (const variable of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(variable.name) || !variable.initializer) continue;
      namedDeclarations.set(variable, variable.name.text);
      dependencyRoots.set(variable.name.text, variable.initializer);
    }
  }

  const targetName = target.name?.text;
  if (!targetName || !dependencyRoots.has(targetName)) return false;
  const edges = new Map<string, Set<string>>();
  for (const [name, root] of dependencyRoots) {
    const dependencies = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (node !== root && ts.isFunctionLike(node)) return;
      if (ts.isIdentifier(node) && isRuntimeIdentifierReference(node)) {
        const declaration = ctx.oracle.valueDeclarationOf(node);
        const resolved = declaration ? namedDeclarations.get(declaration) : undefined;
        // Large diagnostic-free CJS programs occasionally leave an otherwise
        // unique sibling reference unresolved. The lexical-name fallback is
        // conservative within this one declaration set.
        const dependency = resolved ?? (dependencyRoots.has(node.text) ? node.text : undefined);
        if (dependency) dependencies.add(dependency);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    edges.set(name, dependencies);
  }

  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): boolean => {
    const current = state.get(name);
    if (current === "visiting") return true;
    if (current === "done") return false;
    state.set(name, "visiting");
    for (const dependency of edges.get(name) ?? []) {
      if (visit(dependency)) return true;
    }
    state.set(name, "done");
    return false;
  };
  return visit(targetName);
}

/** Prepare stable values and return the shared Annex B name accumulator. */
export function prepareHoistedFunctionBindings(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
  existingDirectFuncNames?: Set<string>,
): Set<string> {
  prepareHoistedFunctionValueBindings(ctx, fctx, stmts);
  return existingDirectFuncNames ?? new Set<string>();
}

/**
 * True when a direct declaration's binding is replaced by a statement-position
 * Annex B declaration in the same var scope. That binding has its own eager
 * initialization/update lifecycle; the generic lazy declaration-value path
 * must not reserve the local first or the initial outer value is never stored.
 */
function functionDeclarationHasAnnexBUpdater(decl: ts.FunctionDeclaration): boolean {
  const name = decl.name?.text;
  const scope = decl.parent;
  if (!name || !scope) return false;

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== scope && ts.isFunctionDeclaration(node)) {
      if (
        node !== decl &&
        node.name?.text === name &&
        annexBDeclaringRange(node) !== null &&
        annexBUpdatesExistingVarBinding(node)
      ) {
        found = true;
      }
      return;
    }
    if (node !== scope && (ts.isFunctionLike(node) || ts.isSourceFile(node) || ts.isModuleBlock(node))) return;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

export function functionDeclarationValueIsObserved(ctx: CodegenContext, decl: ts.FunctionDeclaration): boolean {
  let observed = false;
  const visit = (node: ts.Node): void => {
    if (observed) return;
    if (
      ts.isIdentifier(node) &&
      node !== decl.name &&
      isRuntimeIdentifierReference(node) &&
      ctx.oracle.valueDeclarationOf(node) === decl
    ) {
      const parent = node.parent;
      if (!(ts.isCallExpression(parent) && parent.expression === node)) observed = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.isBlock(decl.parent) || ts.isSourceFile(decl.parent) ? decl.parent : decl.getSourceFile());
  return observed;
}

/** Exclude binding/member-name syntax that does not read the function value. */
function isRuntimeIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
      parent.name === node) ||
    ((ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isQualifiedName(parent) && parent.right === node) ||
    ((ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
      parent.label === node)
  ) {
    return false;
  }
  return true;
}
