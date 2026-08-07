// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) The satellite's MODULE-CONSTANT rule — lever 2 of the three the
// `Scope.flags` probe measured (issue Results table, 2026-08-07).
//
// The satellite's scope model is PARAMS-ONLY: `buildScope` in
// `fnctor-method-edges.ts` binds the parameters of the enclosing function
// chain and nothing else, so `core.inferExpr`'s identifier arm
// (`scope.get(text) ?? DYNAMIC`) answers DYNAMIC for a module-level binding.
// acorn calls `this.enterScope(SCOPE_SWITCH)` where `SCOPE_SWITCH` is a bare
// module `var` with a numeric initializer, and that single DYNAMIC is enough
// to lose the whole `Scope.flags` chain.
//
// This module resolves such a binding to `f64` when it can PROVE the binding
// only ever holds a Number. Three proof obligations, each with its own guard
// below, and none of them optional:
//
//   1. VALUE — the initializer is a constant numeric expression, evaluated
//      from literals and previously-accepted constants only (`isConstantNumeric`).
//      Deliberately NOT "the checker says `number`": in an untyped `.mjs` the
//      checker's answer is an inference over code it does not type-check, and
//      a later `X = "s"` is a silent TS error rather than a widened type.
//   2. STABILITY — the binding is never written ANYWHERE in the module
//      (`isWriteOccurrence`, applied to every occurrence, plus a whole-module
//      refusal on `with` / direct `eval`, which can write a binding without
//      naming it syntactically). One write anywhere poisons, exactly like the
//      satellite's field-write discipline.
//   3. INITIALISEDNESS — no read can observe the binding's hoisted `undefined`
//      (`buildInitOrder`). This is the obligation that is easy to miss and the
//      one the satellite already refuses to waive elsewhere: `readFieldFact`
//      answers DYNAMIC for a field outside its definiteness snapshot precisely
//      because "an unassigned read yields `undefined`, and an f64 fact would
//      silently turn that into NaN at a coercing store". A `var X = 1` binding
//      holds `undefined` from module instantiation until its own statement
//      runs, so the same hazard applies and gets the same treatment.
//
// Only `var`/`let`/`const` statements whose parent IS the SourceFile are
// candidates (a conditionally-executed declaration may never run at all), and
// only in an ES MODULE — a script's top-level `var` becomes a property of the
// global object, reachable and writable as `globalThis.X` without any
// identifier occurrence for obligation 2 to see. That module-only restriction
// matches `directTopLevelDeclaration` in `src/ir/module-bindings.ts`, which
// already fixes a unique top-level `var` in an ES module to one checker
// identity and one scalar slot for the same reason.
//
// Resolution is by SYMBOL, never by name: a parameter or local that shadows a
// module constant has a different symbol, so it falls through to the shared
// dispatch and the more precise param fact wins. The name set is only a cheap
// pre-filter in front of the checker call.
import { ts } from "../ts-api.js";
import { isFunctionLikeNode, unwrap } from "./fnctor-graph-model.js";
import type { InferExtension, LatticeType } from "./propagate.js";

const F64: LatticeType = { kind: "f64" };

/**
 * "This code cannot run during module initialisation at all."
 *
 * A lower bound of `NEVER` is the honest answer for a function nothing in the
 * module ever references: the only remaining caller is an external one, which
 * by definition runs after the module's top-level statements have completed.
 */
const NEVER = Number.POSITIVE_INFINITY;

/** The init-order equations are monotone-decreasing; this is a safety net, not a budget. */
const MAX_INIT_ORDER_ITERS = 64;

/** Operators whose result is a Number whenever both operands already are. */
const NUMERIC_BINARY_OPS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

const ASSIGNMENT_OPS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
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
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function enclosingFunctionOf(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (isFunctionLikeNode(cur)) return cur;
  }
  return undefined;
}

/**
 * Obligation 3's machinery: a lower bound, per code position, on the top-level
 * statement index at which that position may FIRST execute.
 *
 * The bound rests on one hard JavaScript guarantee — **a function cannot be
 * invoked before the code that creates its closure has run** — plus one
 * consequence of it: a method installed by `pp.enterScope = function (…) {…}`
 * at statement 610 does not exist at statement 100, so no receiver can dispatch
 * to it there. That is why property dispatch (`this.enterScope(…)`), which this
 * analysis does not model at all, cannot break the bound.
 *
 * HOISTED top-level function declarations are the one shape with no creation
 * bound: they exist from module instantiation. Their bound comes from their
 * REFERENCES instead — a hoisted function can only run if something names it,
 * and every such name sits in a context that has a bound of its own. acorn's
 * `functionFlags` (a hoisted declaration reading `SCOPE_FUNCTION`) is exactly
 * this case: referenced only from parser methods installed far below the
 * `SCOPE_*` declarations, so it is provably not runnable while they are still
 * `undefined`. Costing it at 0 instead — the obvious conservative shortcut —
 * rejects `SCOPE_FUNCTION`/`SCOPE_ASYNC`/`SCOPE_GENERATOR` and takes the whole
 * lever with them.
 *
 * Two escapes are handled bluntly because they are rare and unbounded:
 *  - `with` / direct `eval` (handled by the caller) can name a binding without
 *    an identifier occurrence, defeating obligation 2 as well as this one.
 *  - a CYCLIC import can call back into this module before its top-level has
 *    run, so with any import present every hoisted declaration drops to 0 and
 *    the bound propagates outward from there through the same equations.
 */
function buildInitOrder(sf: ts.SourceFile, checker: ts.TypeChecker): (node: ts.Node) => number {
  const stmtIndex = new Map<ts.Node, number>();
  sf.statements.forEach((stmt, i) => stmtIndex.set(stmt, i));

  const topLevelIndex = (node: ts.Node): number => {
    let cur: ts.Node = node;
    while (cur.parent !== undefined && cur.parent !== sf) cur = cur.parent;
    return stmtIndex.get(cur) ?? NEVER;
  };

  const fns: ts.SignatureDeclaration[] = [];
  const hoistedByName = new Map<string, ts.FunctionDeclaration[]>();
  const collectFns = (node: ts.Node): void => {
    if (isFunctionLikeNode(node)) fns.push(node);
    if (ts.isFunctionDeclaration(node) && node.parent === sf && node.name !== undefined) {
      const list = hoistedByName.get(node.name.text);
      if (list) list.push(node);
      else hoistedByName.set(node.name.text, [node]);
    }
    ts.forEachChild(node, collectFns);
  };
  ts.forEachChild(sf, collectFns);

  const refs = new Map<ts.FunctionDeclaration, ts.Identifier[]>();
  if (hoistedByName.size > 0) {
    const declOf = (id: ts.Identifier): ts.FunctionDeclaration | undefined => {
      const candidates = hoistedByName.get(id.text);
      if (candidates === undefined) return undefined;
      const decl = checker.getSymbolAtLocation(id)?.valueDeclaration;
      return candidates.find((c) => c === decl);
    };
    const collectRefs = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const decl = declOf(node);
        if (decl !== undefined && decl.name !== node) {
          const list = refs.get(decl);
          if (list) list.push(node);
          else refs.set(decl, [node]);
        }
      }
      ts.forEachChild(node, collectRefs);
    };
    ts.forEachChild(sf, collectRefs);
  }

  const cyclicImportRisk = sf.statements.some((s) => ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s));

  const earliest = new Map<ts.SignatureDeclaration, number>(fns.map((f) => [f, NEVER]));
  const contextEarliest = (node: ts.Node): number => {
    const fn = enclosingFunctionOf(node);
    return fn === undefined ? topLevelIndex(node) : (earliest.get(fn) ?? 0);
  };

  for (let iter = 0; iter < MAX_INIT_ORDER_ITERS; iter++) {
    let changed = false;
    for (const fn of fns) {
      const hoisted = ts.isFunctionDeclaration(fn) && fn.parent === sf ? fn : undefined;
      let next: number;
      if (hoisted === undefined) {
        next = contextEarliest(fn);
      } else if (cyclicImportRisk) {
        next = 0;
      } else {
        next = NEVER;
        for (const ref of refs.get(hoisted) ?? []) next = Math.min(next, contextEarliest(ref));
      }
      if (next < (earliest.get(fn) ?? NEVER)) {
        earliest.set(fn, next);
        changed = true;
      }
    }
    if (!changed) return contextEarliest;
  }
  // Non-convergence would mean the equations are not what this module thinks
  // they are; answer "anything may run at any time", which rejects every
  // candidate rather than shipping a bound nothing established.
  for (const fn of fns) earliest.set(fn, 0);
  return contextEarliest;
}

/** Obligation 1: a Number provable from literals and already-accepted constants. */
function isConstantNumeric(expr: ts.Expression, accepted: ReadonlySet<ts.Symbol>, checker: ts.TypeChecker): boolean {
  const e = unwrap(expr);
  if (ts.isNumericLiteral(e)) return true;
  if (ts.isPrefixUnaryExpression(e)) {
    const unary =
      e.operator === ts.SyntaxKind.MinusToken ||
      e.operator === ts.SyntaxKind.PlusToken ||
      e.operator === ts.SyntaxKind.TildeToken;
    return unary && isConstantNumeric(e.operand, accepted, checker);
  }
  if (ts.isBinaryExpression(e)) {
    if (!NUMERIC_BINARY_OPS.has(e.operatorToken.kind)) return false;
    return isConstantNumeric(e.left, accepted, checker) && isConstantNumeric(e.right, accepted, checker);
  }
  if (ts.isIdentifier(e)) {
    const sym = checker.getSymbolAtLocation(e);
    return sym !== undefined && accepted.has(sym);
  }
  // `BigIntLiteral` deliberately falls through here: `1n | 2n` is a BigInt, and
  // a BigInt reaching an f64 slot is the miscompile these guards exist for.
  return false;
}

/** Obligation 2: every occurrence that is not a plain read poisons the binding. */
function isWriteOccurrence(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (parent === undefined) return true;
  // Any OTHER declaration of the same name (a second `var`, a parameter, a
  // destructuring binding, an import) — rejected here as well as by the
  // one-declaration check, because it also means the name is rebound.
  if (ts.isVariableDeclaration(parent) && parent.name === id) return true;
  if (ts.isBindingElement(parent) || ts.isParameter(parent)) return true;
  if (ts.isPostfixUnaryExpression(parent)) return true;
  if (
    ts.isPrefixUnaryExpression(parent) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if (ts.isDeleteExpression(parent)) return true;
  // Assignment targets, including destructuring ones. The walk climbs only the
  // literal "pattern spine" (`[X] = …`, `({p: X} = …)`, `({X} = …)`) so a read
  // that merely sits inside an assignment's LHS expression — `obj[X] = 1` — is
  // not mistaken for a write to X.
  let cur: ts.Node = id;
  for (let up: ts.Node | undefined = cur.parent; up !== undefined; up = cur.parent) {
    if (ts.isBinaryExpression(up) && up.left === cur && ASSIGNMENT_OPS.has(up.operatorToken.kind)) return true;
    if ((ts.isForInStatement(up) || ts.isForOfStatement(up)) && up.initializer === cur) return true;
    const spine =
      ts.isArrayLiteralExpression(up) ||
      ts.isObjectLiteralExpression(up) ||
      ts.isSpreadElement(up) ||
      ts.isShorthandPropertyAssignment(up) ||
      (ts.isPropertyAssignment(up) && up.initializer === cur);
    if (!spine) return false;
    cur = up;
  }
  return false;
}

interface ModuleConsts {
  readonly symbols: ReadonlySet<ts.Symbol>;
  readonly names: ReadonlySet<string>;
}

const EMPTY_CONSTS: ModuleConsts = { symbols: new Set(), names: new Set() };

function collectModuleNumericConsts(sf: ts.SourceFile, checker: ts.TypeChecker): ModuleConsts {
  if (!ts.isExternalModule(sf)) return EMPTY_CONSTS;

  const candidates: { decl: ts.VariableDeclaration; name: ts.Identifier; index: number }[] = [];
  const candidateNames = new Set<string>();
  sf.statements.forEach((stmt, index) => {
    if (!ts.isVariableStatement(stmt)) return;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
      candidates.push({ decl, name: decl.name, index });
      candidateNames.add(decl.name.text);
    }
  });
  if (candidates.length === 0) return EMPTY_CONSTS;

  // One walk for every occurrence of a candidate NAME, plus the two dynamic-scope
  // constructs that can reach a binding without naming it.
  const occurrences = new Map<ts.Symbol, ts.Identifier[]>();
  let dynamicScope = false;
  const walk = (node: ts.Node): void => {
    if (ts.isWithStatement(node)) dynamicScope = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      dynamicScope = true;
    }
    if (ts.isIdentifier(node) && candidateNames.has(node.text)) {
      // A shorthand property resolves to the PROPERTY symbol through the normal
      // API; `({X} = o)` is a write to X and would otherwise be invisible.
      const sym = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (sym !== undefined) {
        const list = occurrences.get(sym);
        if (list) list.push(node);
        else occurrences.set(sym, [node]);
      }
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sf, walk);
  if (dynamicScope) return EMPTY_CONSTS;

  const contextEarliest = buildInitOrder(sf, checker);
  const symbols = new Set<ts.Symbol>();
  const names = new Set<string>();

  // Source order is load-bearing twice over: `isConstantNumeric` only accepts
  // constants already proven (so `SCOPE_VAR = SCOPE_TOP | …` works and a
  // forward reference does not), and that same ordering is what licenses the
  // `>= index` (rather than `> index`) read bound for a same-statement read —
  // declarators in one `var` statement evaluate left to right.
  for (const candidate of candidates) {
    const sym = checker.getSymbolAtLocation(candidate.name);
    if (sym === undefined) continue;
    const declsHere = (sym.declarations ?? []).filter((d) => d.getSourceFile() === sf);
    if (declsHere.length !== 1 || declsHere[0] !== candidate.decl) continue;
    if (candidate.decl.initializer === undefined) continue;
    if (!isConstantNumeric(candidate.decl.initializer, symbols, checker)) continue;
    let safe = true;
    for (const occurrence of occurrences.get(sym) ?? []) {
      if (occurrence === candidate.name) continue;
      if (isWriteOccurrence(occurrence)) {
        safe = false;
        break;
      }
      const bound = contextEarliest(occurrence);
      const insideFunction = enclosingFunctionOf(occurrence) !== undefined;
      if (insideFunction ? !(bound > candidate.index) : !(bound >= candidate.index)) {
        safe = false;
        break;
      }
    }
    if (!safe) continue;
    symbols.add(sym);
    names.add(candidate.name.text);
  }
  return { symbols, names };
}

/**
 * Build the satellite's module-constant `InferExtension`.
 *
 * The fact is always `f64`, never a narrower integer domain: the satellite's
 * only consumer collapses `f64`/`i32`/`u32` into one f64 field slot, so a
 * value-range classification here would buy nothing and would perturb every
 * joined fact in the corpus for it.
 */
export function createModuleConstExtension(sf: ts.SourceFile, checker: ts.TypeChecker): InferExtension {
  const { symbols, names } = collectModuleNumericConsts(sf, checker);
  if (symbols.size === 0) return { tryInfer: () => undefined };
  return {
    tryInfer(expr) {
      if (!ts.isIdentifier(expr) || !names.has(expr.text)) return undefined;
      const sym = checker.getSymbolAtLocation(expr);
      return sym !== undefined && symbols.has(sym) ? F64 : undefined;
    },
  };
}
