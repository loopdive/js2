// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { addFunctionOwnLocals } from "../ir/analysis/binding-info.js";
import { condenseDirectedGraph } from "./analysis/strongly-connected-components.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { annexBDeclaringRange, annexBUpdatesExistingVarBinding } from "./annexb-cancel.js";
import { getOrRegisterRefCellType } from "./registry/types.js";

interface FunctionObservationContextFacts {
  /** Function declarations whose value is observed, grouped by the exact scan root. */
  observedDeclarationsByScope: WeakMap<ts.Node, ReadonlySet<ts.FunctionDeclaration>>;
  /** Static sibling dependency graphs, grouped by the exact statement-list identity. */
  dependencyGraphsByStatements: WeakMap<readonly ts.Statement[], FunctionValueDependencyGraph>;
}

interface FunctionValueDependencyGraph {
  /** Names whose dependency path reaches a strongly-connected component. */
  reachesCycle: ReadonlySet<string>;
}

/**
 * These facts depend on the selected oracle as well as the immutable AST. Keep
 * them scoped to the CodegenContext: module-init recompilation may reuse the
 * same nodes with a different context/backend, and a bare node-keyed cache
 * would leak declaration answers between those runs.
 */
const observationFactsByContext = new WeakMap<CodegenContext, FunctionObservationContextFacts>();

interface FunctionBindingUseFacts {
  /** Names read outside a direct call position, with nested lexical shadows applied. */
  observedNames: ReadonlySet<string>;
  /** Names called/constructed directly by this declaration, excluding nested scopes. */
  invokedNames: ReadonlySet<string>;
}

/** Pure syntax facts: safe to share for the lifetime of an immutable AST node. */
const functionBindingUseFactsCache = new WeakMap<ts.FunctionDeclaration, FunctionBindingUseFacts>();

/** Pure structural inverse of `functionDeclarationHasAnnexBUpdater`. */
const annexBUpdaterNamesByDirectScope = new WeakMap<ts.Node, ReadonlySet<string>>();

function observationFactsFor(ctx: CodegenContext): FunctionObservationContextFacts {
  let facts = observationFactsByContext.get(ctx);
  if (!facts) {
    facts = {
      observedDeclarationsByScope: new WeakMap(),
      dependencyGraphsByStatements: new WeakMap(),
    };
    observationFactsByContext.set(ctx, facts);
  }
  return facts;
}

function functionBindingUseFacts(stmt: ts.FunctionDeclaration): FunctionBindingUseFacts {
  const cached = functionBindingUseFactsCache.get(stmt);
  if (cached) return cached;

  const observedNames = new Set<string>();
  const collectObserved = (node: ts.Node, shadowed: ReadonlySet<string>): void => {
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
      const nestedShadowed = new Set(shadowed);
      addFunctionOwnLocals(node, nestedShadowed);
      ts.forEachChild(node, (child) => collectObserved(child, nestedShadowed));
      return;
    }
    if (node !== stmt && ts.isClassLike(node) && node.name) {
      const nestedShadowed = new Set(shadowed);
      nestedShadowed.add(node.name.text);
      ts.forEachChild(node, (child) => collectObserved(child, nestedShadowed));
      return;
    }
    if (ts.isIdentifier(node) && node !== stmt.name && !shadowed.has(node.text)) {
      const parent = node.parent;
      if (!(ts.isCallExpression(parent) && parent.expression === node)) observedNames.add(node.text);
    }
    ts.forEachChild(node, (child) => collectObserved(child, shadowed));
  };
  collectObserved(stmt, new Set());

  const invokedNames = new Set<string>();
  const collectInvoked = (node: ts.Node): void => {
    if (node !== stmt && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isIdentifier(node) && node !== stmt.name) {
      const parent = node.parent;
      if (
        (ts.isCallExpression(parent) && parent.expression === node) ||
        (ts.isNewExpression(parent) && parent.expression === node)
      ) {
        invokedNames.add(node.text);
      }
    }
    ts.forEachChild(node, collectInvoked);
  };
  collectInvoked(stmt);

  const facts = { observedNames, invokedNames } satisfies FunctionBindingUseFacts;
  functionBindingUseFactsCache.set(stmt, facts);
  return facts;
}

/**
 * A nested function can return the pre-initialization value of a `var` owned
 * by an enclosing activation. TypeScript's signature still reports the
 * declaration's eventual type, but the closure may run before that initializer
 * executes (`function g(){ return x; } return g(); var x = 1`). Keep the
 * return ABI dynamic for that source-proven shape, and propagate it through a
 * direct nested-function call (`return g()`) in the owner.
 */
export function functionReturnsPreInitVarValue(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
  seen = new Set<ts.FunctionLikeDeclaration>(),
): boolean {
  if (seen.has(fn) || !fn.body || !ts.isBlock(fn.body)) return false;
  seen.add(fn);
  const isPreInitVar = (id: ts.Identifier): boolean => {
    const decl = ctx.oracle.variableDeclarationOf(id);
    return (
      decl !== undefined &&
      decl.initializer !== undefined &&
      ts.isIdentifier(decl.name) &&
      (decl.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) ===
        0 &&
      id.getStart() < decl.name.getStart()
    );
  };
  const visit = (node: ts.Node): boolean => {
    if (ts.isReturnStatement(node) && node.expression) {
      let expression = node.expression;
      while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
      if (ts.isIdentifier(expression) && isPreInitVar(expression)) {
        return true;
      }
      if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
        const target = ctx.oracle.valueDeclarationOf(expression.expression);
        if (
          target &&
          (ts.isFunctionDeclaration(target) || ts.isFunctionExpression(target)) &&
          functionReturnsPreInitVarValue(ctx, target, new Set(seen))
        ) {
          return true;
        }
      }
      return false;
    }
    if (node !== fn && ts.isFunctionLike(node)) return false;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && visit(child)) found = true;
    });
    return found;
  };
  return visit(fn.body);
}

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
  return functionBindingUseFacts(stmt).observedNames.has(name);
}

/** True when a stable function binding's lifted implementation executes here. */
export function functionDeclarationInvokesBinding(stmt: ts.FunctionDeclaration, name: string): boolean {
  return functionBindingUseFacts(stmt).invokedNames.has(name);
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
  // A same-named `var` initializer affects the declaration-value carrier, but
  // the answer is a property of this statement list, not of each function.
  // Collect it once instead of re-running `stmts.some(...)` for every direct
  // FunctionDeclaration (4,289 of them in the TypeScript 5 bundle IIFE).
  const initializedVariableNames = new Set<string>();
  for (const statement of stmts) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
        initializedVariableNames.add(declaration.name.text);
      }
    }
  }

  for (const stmt of stmts) {
    const hasExistingBinding = ts.isFunctionDeclaration(stmt) && !!stmt.name && fctx.localMap.has(stmt.name.text);
    const existingBindingHasInitializer =
      hasExistingBinding && stmt.name !== undefined && initializedVariableNames.has(stmt.name.text);
    if (
      !ts.isFunctionDeclaration(stmt) ||
      !stmt.name ||
      !stmt.body ||
      annexBDeclaringRange(stmt) !== null ||
      functionDeclarationHasAnnexBUpdater(stmt) ||
      (!functionDeclarationValueIsObserved(ctx, stmt) && !hasExistingBinding)
    ) {
      continue;
    }
    // (#4618) An observed declaration with an UNSTABLE capture ABI (a
    // captured local whose value is not final at function entry — the jest
    // `__jestFn` shape: `function mock()` capturing `var impl` assigned just
    // above it, with `mock.mock = {…}` written after) used to be SKIPPED
    // here, leaving every read — including SELF-reads inside the body — to
    // re-materialize a fresh closure struct, so `mock.mock.calls` answered
    // null inside the invoked mock. Route it through the same ref-cell
    // strategy as cyclic values: the CELL's identity is fixed at entry, and
    // the closure is materialized into it at the declaration statement,
    // where every captured value is live.
    const stableAbi = hasStableFunctionValueCaptureAbi(fctx, stmt);
    if (!hasExistingBinding) {
      const cyclic = !stableAbi || functionValueDependencyIsCyclic(ctx, stmt, stmts);
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
    } else if (!existingBindingHasInitializer) {
      // FunctionDeclarationInstantiation installs a same-named function value
      // into the existing var/parameter binding (ES5 §10.2.1, steps 5/8).
      // Keep that original carrier for initialized vars: allocating a second
      // slot makes later var writes target the old slot while reads target a
      // stale function-valued slot (S13_A19_T2 observes NaN instead of 1).
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
        // (#4616) Entry-hoisted materialization is safe whenever the captured
        // slot's VALUE is already final at function entry:
        //   - numeric scalars (the historical rule),
        //   - the enclosing function's own PARAMS (bound before any statement
        //     runs — jest's vi.fn `spy` captures the `implementation` param;
        //     without a stable binding every self-read inside spy's body
        //     re-materialized a fresh struct, so `spy.mock` written on the
        //     invoked instance answered undefined in every spy body),
        //   - boxed capture CELLS (`__ref_cell_*` refs — a mutated capture
        //     shares the cell, whose identity is fixed at entry even though
        //     its contents change).
        const isParamSlot = localIdx < fctx.params.length;
        const type = getLocalType(fctx, localIdx);
        const isRefCellSlot =
          type !== undefined &&
          type !== null &&
          (type.kind === "ref" || type.kind === "ref_null") &&
          fctx.boxedCaptures?.has(node.text) === true;
        if (
          !isParamSlot &&
          !isRefCellSlot &&
          (!type || (type.kind !== "i32" && type.kind !== "i64" && type.kind !== "f32" && type.kind !== "f64"))
        ) {
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

/** Build the immutable dependency graph for one exact sibling statement list. */
function functionValueDependencyGraph(
  ctx: CodegenContext,
  siblings: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
): FunctionValueDependencyGraph {
  const cache = observationFactsFor(ctx).dependencyGraphsByStatements;
  const cached = cache.get(siblings);
  if (cached) return cached;

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

  // SCCs identify the actual cycles once. The previous per-target DFS
  // rebuilt this whole graph and then repeated a reachability walk for every
  // observed declaration. Preserve its exact predicate: a target is cyclic
  // when it can reach *any* cycle, not only when the target belongs to one.
  const {
    components,
    componentByNode: componentByName,
    successorsByComponent: componentEdges,
    predecessorsByComponent: reverseComponentEdges,
  } = condenseDirectedGraph(dependencyRoots.keys(), (name) => edges.get(name) ?? []);
  const componentReachesCycle = components.map(() => false);
  for (let componentIdx = 0; componentIdx < components.length; componentIdx++) {
    const component = components[componentIdx]!;
    componentReachesCycle[componentIdx] =
      component.length > 1 || (component.length === 1 && edges.get(component[0]!)?.has(component[0]!) === true);
  }

  // Collapse the SCCs into a DAG, then propagate the cycle bit backwards from
  // sinks. This computes every target answer in one graph pass without the
  // recursion depth or repeated edge scans of one DFS per declaration.
  const remainingSuccessors = componentEdges.map((successors) => successors.size);
  const worklist: number[] = [];
  for (let componentIdx = 0; componentIdx < components.length; componentIdx++) {
    if (remainingSuccessors[componentIdx] === 0) worklist.push(componentIdx);
  }
  while (worklist.length > 0) {
    const componentIdx = worklist.pop()!;
    for (const predecessor of reverseComponentEdges[componentIdx]!) {
      if (componentReachesCycle[componentIdx]) componentReachesCycle[predecessor] = true;
      remainingSuccessors[predecessor] = remainingSuccessors[predecessor]! - 1;
      if (remainingSuccessors[predecessor] === 0) worklist.push(predecessor);
    }
  }

  const reachesCycle = new Set<string>();
  for (const [name, componentIdx] of componentByName) {
    if (componentReachesCycle[componentIdx]) reachesCycle.add(name);
  }
  const graph = { reachesCycle } satisfies FunctionValueDependencyGraph;
  cache.set(siblings, graph);
  return graph;
}

/** Whether materializing target can reach any recursive value dependency. */
export function functionValueDependencyIsCyclic(
  ctx: CodegenContext,
  target: ts.FunctionDeclaration,
  siblings: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
): boolean {
  const targetName = target.name?.text;
  return targetName !== undefined && functionValueDependencyGraph(ctx, siblings).reachesCycle.has(targetName);
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
  let updaterNames = annexBUpdaterNamesByDirectScope.get(scope);
  if (!updaterNames) {
    const collected = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (node !== scope && ts.isFunctionDeclaration(node)) {
        if (node.name && annexBDeclaringRange(node) !== null && annexBUpdatesExistingVarBinding(node)) {
          collected.add(node.name.text);
        }
        return;
      }
      if (node !== scope && (ts.isFunctionLike(node) || ts.isSourceFile(node) || ts.isModuleBlock(node))) return;
      ts.forEachChild(node, visit);
    };
    visit(scope);
    updaterNames = collected;
    annexBUpdaterNamesByDirectScope.set(scope, updaterNames);
  }
  return updaterNames.has(name);
}

function observedFunctionDeclarationsInScope(ctx: CodegenContext, scope: ts.Node): ReadonlySet<ts.FunctionDeclaration> {
  const cache = observationFactsFor(ctx).observedDeclarationsByScope;
  const cached = cache.get(scope);
  if (cached) return cached;

  const observed = new Set<ts.FunctionDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isRuntimeIdentifierReference(node)) {
      const declaration = ctx.oracle.valueDeclarationOf(node);
      if (declaration && ts.isFunctionDeclaration(declaration) && node !== declaration.name) {
        const parent = node.parent;
        if (!(ts.isCallExpression(parent) && parent.expression === node)) observed.add(declaration);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  cache.set(scope, observed);
  return observed;
}

export function functionDeclarationValueIsObserved(ctx: CodegenContext, decl: ts.FunctionDeclaration): boolean {
  const scope = ts.isBlock(decl.parent) || ts.isSourceFile(decl.parent) ? decl.parent : decl.getSourceFile();
  return observedFunctionDeclarationsInScope(ctx, scope).has(decl);
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
