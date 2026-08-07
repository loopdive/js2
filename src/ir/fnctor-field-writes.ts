// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) Edge (a) of the field/param mutual fixpoint: WHICH writes can reach a
// fnctor field slot, and WHEN a `this.<y>` read of one is provably defined.
// See `fnctor-graph-model.ts` for the satellite's module map.

import { forEachChild, ts } from "../ts-api.js";
import type { IrUnitId } from "./identity.js";
import {
  type AnalysisState,
  type FieldAttribution,
  type FieldOwner,
  type FieldWrite,
  NO_FIELDS,
  enclosingThisBinder,
  isClassMemberLike,
  isDirectlyInside,
  isFunctionLikeNode,
  isSymbolKeyed,
  scopeChainOf,
  spaceOfBase,
  unwrap,
} from "./fnctor-graph-model.js";

// ── Phase 4b: field writes (edge (a) of the mutual fixpoint) ──────────────────
//
// Every write-ish operation on a property is collected here, classified by its
// RECEIVER. The unsound direction is a write that can reach a slot but
// contributes nothing — so an unclassifiable receiver becomes the name-based
// `"all"` over-approximation rather than being dropped, and anything that can
// intercept or rename a slot (dynamic keys, `delete`, `defineProperty`,
// destructuring targets, accessors) poisons instead.

/** Compound operators whose result is a NUMBER regardless of the old value. */
const NUMERIC_COMPOUND: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
]);

const LOGICAL_COMPOUND: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

interface ReceiverAttribution {
  readonly owner: FieldOwner;
  readonly attribution: FieldAttribution;
  readonly thisOwner?: IrUnitId;
  /** The receiver is literally `this` (not merely name-attributed). */
  readonly viaThis: boolean;
}

/**
 * Which field space a write-ish operation on `base` addresses.
 * `undefined` = attribute NOWHERE (a static method's `this` is the constructor
 * OBJECT, and a method-space install is already handled by the method scan).
 */
function classifyFieldReceiver(
  state: AnalysisState,
  base: ts.Expression,
  site: ts.Node,
): ReceiverAttribution | undefined {
  const b = unwrap(base);
  if (b.kind !== ts.SyntaxKind.ThisKeyword) {
    // A `F.prototype.x = …` / `F.x = …` install is method-space business; a
    // DATA property there cannot intercept own-field writes and definiteness
    // blocks reads of it. Everything else is a real (untracked-receiver) field
    // write — `node.end = pos` inside `finishNodeAt` is the load-bearing case,
    // and name-based attribution is what keeps its f64 alive instead of
    // poisoning the name.
    return spaceOfBase(state, b) !== undefined ? undefined : { owner: "all", attribution: "all", viaThis: false };
  }
  const binder = enclosingThisBinder(site);
  const untracked: ReceiverAttribution = { owner: "all", attribution: "all", viaThis: true };
  if (binder === undefined || isClassMemberLike(binder)) return untracked;
  const nodeId = state.nodeIdByFn.get(binder);
  const node = nodeId !== undefined ? state.nodes.get(nodeId) : undefined;
  if (node === undefined) return untracked; // demoted method / plain fn
  if (node.kind === "static-method") return undefined; // `this` is the ctor object
  if (node.kind === "callable") {
    return {
      owner: node.id,
      thisOwner: node.id,
      viaThis: true,
      // A write nested in an arrow inside the ctor may run at any time or
      // never, so it is attributed but never definite.
      attribution: isDirectlyInside(site, binder) ? "ctor-direct" : "ctor-nested",
    };
  }
  const ownerId = node.ownerId;
  if (ownerId === undefined) return untracked;
  return { owner: ownerId, thisOwner: ownerId, attribution: "proto-method", viaThis: true };
}

function poisonFieldName(state: AnalysisState, owner: FieldOwner, name: string): void {
  if (owner === "all") {
    state.fieldDynamicNames.add(name);
    return;
  }
  let set = state.fieldDynamicPerOwner.get(owner);
  if (!set) {
    set = new Set();
    state.fieldDynamicPerOwner.set(owner, set);
  }
  set.add(name);
}

/** Every field of `owner` becomes unknowable; an untracked receiver poisons all. */
function poisonAllFieldsOf(state: AnalysisState, owner: FieldOwner): void {
  if (owner === "all") state.poisonAllFields = true;
  else state.fieldPoisonedOwners.add(owner);
}

/** Literal property name of a write target, or `undefined` for a dynamic key. */
function literalFieldName(target: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(target)) {
    return ts.isPrivateIdentifier(target.name) ? undefined : target.name.text;
  }
  const key = unwrap(target.argumentExpression);
  if (ts.isStringLiteral(key) || key.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    return (key as ts.StringLiteral).text;
  }
  return undefined;
}

function recordFieldWrite(
  state: AnalysisState,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  site: ts.Node,
  kind: FieldWrite["kind"],
  carrier?: ts.Expression,
): void {
  if (ts.isElementAccessExpression(target) && isSymbolKeyed(target.argumentExpression)) return;
  const attribution = classifyFieldReceiver(state, target.expression, site);
  if (attribution === undefined) return;
  const name = literalFieldName(target);
  if (name === undefined) {
    // A dynamic-key write through `this` can name ANY field of that owner (or
    // of every owner when the binder is untracked). A dynamic-key write on a
    // NON-`this` base (`newNode[prop] = node[prop]` — acorn's `copyNode`) is the
    // family's DOCUMENTED GAP, shared with #4166's dynamic instance reads and
    // with the legacy #4117 scan, which has no escape analysis at all. Poisoning
    // it instead would be a whole-module kill switch that any `for…in` copy
    // loop trips — measured: it zeroed every acorn field fact.
    if (attribution.viaThis) poisonAllFieldsOf(state, attribution.owner);
    return;
  }
  state.fieldWrites.push({
    owner: attribution.owner,
    name,
    kind,
    ...(carrier !== undefined ? { carrier } : {}),
    site,
    scopeChain: scopeChainOf(site),
    attribution: attribution.attribution,
    ...(attribution.thisOwner !== undefined ? { thisOwner: attribution.thisOwner } : {}),
    readSnapshot: NO_FIELDS,
  });
  if (attribution.owner !== "all") {
    let names = state.fieldNamesByOwner.get(attribution.owner);
    if (!names) {
      names = new Set();
      state.fieldNamesByOwner.set(attribution.owner, names);
    }
    names.add(name);
  }
}

/** Poison every property target reachable in a destructuring / for-in-of target. */
function poisonWriteTarget(state: AnalysisState, target: ts.Node, site: ts.Node): void {
  const t = ts.isExpression(target) ? unwrap(target) : target;
  if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) {
    const attribution = classifyFieldReceiver(state, t.expression, site);
    if (attribution === undefined) return;
    const name = literalFieldName(t);
    // Same documented gap as `recordFieldWrite`: a dynamic key on a non-`this`
    // base names nothing this analysis can localize.
    if (name === undefined) {
      if (attribution.viaThis) poisonAllFieldsOf(state, attribution.owner);
    } else poisonFieldName(state, attribution.owner, name);
    return;
  }
  if (ts.isObjectLiteralExpression(t) || ts.isArrayLiteralExpression(t) || ts.isSpreadElement(t)) {
    forEachChild(t, (child) => {
      poisonWriteTarget(state, child, site);
    });
  }
  if (ts.isPropertyAssignment(t) || ts.isShorthandPropertyAssignment(t)) {
    poisonWriteTarget(state, ts.isPropertyAssignment(t) ? t.initializer : t.name, site);
  }
}

/** `Object.defineProperty(this, …)` / `Object.assign(this, …)` on a tracked `this`. */
function handleThisFieldDefine(state: AnalysisState, call: ts.CallExpression): void {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  const base = unwrap(callee.expression);
  if (!ts.isIdentifier(base) || base.text !== "Object") return;
  const method = callee.name.text;
  if (method !== "defineProperty" && method !== "defineProperties" && method !== "assign") return;
  const first = call.arguments[0];
  if (first === undefined || unwrap(first).kind !== ts.SyntaxKind.ThisKeyword) return;
  const attribution = classifyFieldReceiver(state, first, call);
  if (attribution === undefined) return;
  if (method === "defineProperty") {
    const key = call.arguments[1] !== undefined ? unwrap(call.arguments[1]!) : undefined;
    if (key !== undefined && ts.isStringLiteral(key)) {
      poisonFieldName(state, attribution.owner, key.text);
      return;
    }
  }
  poisonAllFieldsOf(state, attribution.owner);
}

export function scanFieldWrites(state: AnalysisState): void {
  const scan = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      const left = unwrap(n.left);
      const isTarget = ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left);
      if (op === ts.SyntaxKind.EqualsToken) {
        if (isTarget) recordFieldWrite(state, left, n, "assign", n.right);
        else if (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) {
          poisonWriteTarget(state, left, n); // destructuring assignment
        }
      } else if (isTarget && NUMERIC_COMPOUND.has(op)) {
        recordFieldWrite(state, left, n, "numeric-op");
      } else if (isTarget && op === ts.SyntaxKind.PlusEqualsToken) {
        recordFieldWrite(state, left, n, "plus-assign", n.right);
      } else if (isTarget && LOGICAL_COMPOUND.has(op)) {
        recordFieldWrite(state, left, n, "logical-assign", n.right);
      }
    }
    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
      const isIncDec = n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken;
      const operand = unwrap(n.operand);
      if (isIncDec && (ts.isPropertyAccessExpression(operand) || ts.isElementAccessExpression(operand))) {
        recordFieldWrite(state, operand, n, "numeric-op");
      }
    }
    if (ts.isDeleteExpression(n)) {
      const t = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) {
        poisonWriteTarget(state, t, n);
      }
    }
    if (ts.isCallExpression(n)) handleThisFieldDefine(state, n);
    if (ts.isForInStatement(n) || ts.isForOfStatement(n)) {
      if (!ts.isVariableDeclarationList(n.initializer)) poisonWriteTarget(state, n.initializer, n);
    }
    forEachChild(n, scan);
  };
  scan(state.sourceFile);
}

// ── Phase 4c: definiteness and ordering (the undefined-read guard) ────────────
//
// A `this.<y>` read is resolvable ONLY if `y` is provably assigned before the
// read can execute; otherwise the read is `undefined` and an f64 fact would
// turn it into NaN at a coercing store. This mirrors (in simplified form) the
// escape gate's `guaranteedAssignmentsInClosedStatement` /
// `containsConstructorReturn`, which is what decides presence tracking.

interface OrderState {
  /** Names assigned along the straight-line path reaching the current point. */
  snap: Set<string>;
  /** Names assigned on EVERY successful construction path so far. */
  def: Set<string>;
  /** A mid-ctor `return` completes construction without any later write. */
  defFrozen: boolean;
}

function chainAssignedThisNames(expr: ts.Expression, out: Set<string>): void {
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(expr.left) &&
    expr.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
    !ts.isPrivateIdentifier(expr.left.name)
  ) {
    out.add(expr.left.name.text);
    chainAssignedThisNames(expr.right, out);
  }
}

function containsCtorReturn(stmt: ts.Statement): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== stmt && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(stmt);
  return found;
}

/** Give every ctor-direct write inside `root` the snapshot in force there. */
function applySnapshot(writesBySite: Map<ts.Node, FieldWrite[]>, root: ts.Node, snapshot: ReadonlySet<string>): void {
  const visit = (node: ts.Node): void => {
    if (node !== root && isFunctionLikeNode(node)) return; // arrows keep the empty snapshot
    for (const w of writesBySite.get(node) ?? []) w.readSnapshot = snapshot;
    forEachChild(node, visit);
  };
  visit(root);
}

function walkCtorStatement(stmt: ts.Statement, st: OrderState, writesBySite: Map<ts.Node, FieldWrite[]>): void {
  if (ts.isExpressionStatement(stmt)) {
    applySnapshot(writesBySite, stmt, new Set(st.snap));
    const names = new Set<string>();
    chainAssignedThisNames(stmt.expression, names);
    for (const name of names) {
      st.snap.add(name);
      if (!st.defFrozen) st.def.add(name);
    }
    return;
  }
  if (ts.isBlock(stmt)) {
    for (const child of stmt.statements) {
      walkCtorStatement(child, st, writesBySite);
      if (containsCtorReturn(child)) st.defFrozen = true;
    }
    return;
  }
  if (ts.isIfStatement(stmt) && stmt.elseStatement) {
    // Both arms complete → the intersection is definite even though each arm
    // is syntactically conditional. Acorn's `pos`/`lineStart`/`curLine` are
    // initialized exactly this way.
    const thenSt: OrderState = { snap: new Set(st.snap), def: new Set(st.def), defFrozen: st.defFrozen };
    const elseSt: OrderState = { snap: new Set(st.snap), def: new Set(st.def), defFrozen: st.defFrozen };
    walkCtorStatement(stmt.thenStatement, thenSt, writesBySite);
    walkCtorStatement(stmt.elseStatement, elseSt, writesBySite);
    st.snap = new Set([...thenSt.snap].filter((n) => elseSt.snap.has(n)));
    st.def = new Set([...thenSt.def].filter((n) => elseSt.def.has(n)));
    st.defFrozen = thenSt.defFrozen || elseSt.defFrozen;
    return;
  }
  // Loops, if-without-else, try, switch, declarations: writes inside are not
  // definite and see the frozen prefix.
  applySnapshot(writesBySite, stmt, new Set(st.snap));
}

export function computeDefiniteCtorFields(state: AnalysisState): void {
  const writesBySite = new Map<ts.Node, FieldWrite[]>();
  for (const w of state.fieldWrites) {
    if (w.attribution !== "ctor-direct") continue;
    const arr = writesBySite.get(w.site);
    if (arr) arr.push(w);
    else writesBySite.set(w.site, [w]);
  }
  for (const node of state.nodes.values()) {
    if (node.kind !== "callable" || !node.fn.body || !ts.isBlock(node.fn.body)) continue;
    const st: OrderState = { snap: new Set(), def: new Set(), defFrozen: false };
    for (const stmt of node.fn.body.statements) {
      walkCtorStatement(stmt, st, writesBySite);
      if (containsCtorReturn(stmt)) st.defFrozen = true;
    }
    state.definiteCtorFields.set(node.id, st.def);
  }
  // A prototype method runs after construction completed, so the owner's
  // definite set is exactly what it may assume.
  for (const w of state.fieldWrites) {
    if (w.attribution !== "proto-method" || w.thisOwner === undefined) continue;
    w.readSnapshot = state.definiteCtorFields.get(w.thisOwner) ?? NO_FIELDS;
  }
}
