// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4177 — fixpoint-fact consumption for from-ast's `+` operand proof.
//
// Selection admits a function off the interprocedural fixpoint's lattice
// facts (src/ir/propagate.ts, #1131): an unannotated `n` proved f64 from its
// call sites claims `function addOne(n) { return n + 1; }` for the IR path.
// The #2781 Row-7 `+` proof, however, re-derived operand types from the TS
// checker ALONE — which says `any` for that param — and hard-failed AFTER the
// legacy body had been skipped (IR-first #2138: no fallback). One stage
// claimed the function *because of* a fact the next stage refused to look at.
//
// This module translates exactly the facts the claim was already made with
// into the proof's vocabulary — no new inference:
//   - a parameter's resolved IR type (annotation forced by `resolveIrType` to
//     agree with any `paramTypeOverrides` entry — the fixpoint's atom via
//     `latticeToIr`): val f64 → "number", `IrType.string` → "string". The
//     lattice's bool atom is i32-branded and deliberately unmapped (the Row-7
//     trap: a boolean must never enter the number fast path).
//   - a certified direct-call plan's return type (`cx.directCalls` — the same
//     signatures the call lowering itself trusts, present only for claimed
//     callees whose overrides resolved).
//
// Soundness boundaries:
//   - Facts are keyed by the parameter DECLARATION node, never by name, and
//     consumption resolves the identifier through the checker's symbol first —
//     so a shadowing local can never satisfy a lookup.
//   - Only parameters never written ANYWHERE in the function (including
//     nested function bodies) get a fact: the fixpoint atom describes the
//     parameter's INCOMING call-site values, so a reassigned parameter's
//     later reads are outside the proven fact.

import { ts, forEachChild } from "../ts-api.js";

import type { IrDirectCallLoweringPlan } from "./ast-lowering-plans.js";
import { asVal, type IrType } from "./nodes.js";

export type LatticeParamFacts = ReadonlyMap<ts.ParameterDeclaration, "number" | "string">;

/** The slice of `LowerCtx` that {@link latticeAdditiveFact} consumes. */
export interface LatticeFactContext {
  readonly checker?: ts.TypeChecker;
  readonly latticeParamFacts?: LatticeParamFacts;
  readonly directCalls?: ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan>;
}

function peelParens(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/**
 * Every name written ANYWHERE inside `root`, including nested function bodies
 * (deliberately unlike from-ast's `collectMutatedLetNamesFromBlock`, which
 * stops at nested-function boundaries because it governs outer-scope slot
 * allocation). Used only to EXCLUDE parameters from
 * {@link collectLatticeParamFacts}: a parameter reassigned by a nested closure
 * still invalidates the fixpoint's incoming-value fact for outer reads that
 * follow the closure's invocation, so the exclusion must see through function
 * boundaries. Over-approximation (a nested function's own shadowing local
 * write drops an unrelated outer fact) is conservative and therefore safe.
 *
 * Write forms collected: plain/compound assignment to an identifier,
 * destructuring-assignment targets (`[n] = …`, `({ x: n } = …)`, shorthand
 * `({ n } = …)`), pre/postfix `++`/`--`, and a `for (n of/in …)` head that
 * rebinds an existing identifier. Member writes (`obj.n = …`) are NOT
 * variable writes and are deliberately not collected.
 */
function collectWrittenNamesIncludingNested(root: ts.Node): Set<string> {
  const written = new Set<string>();
  const addTargets = (target: ts.Expression): void => {
    const t = peelParens(target);
    if (ts.isIdentifier(t)) {
      written.add(t.text);
      return;
    }
    if (ts.isArrayLiteralExpression(t)) {
      for (const el of t.elements) {
        if (ts.isOmittedExpression(el)) continue;
        if (ts.isSpreadElement(el)) addTargets(el.expression);
        else if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          addTargets(el.left); // defaulted destructuring target `[n = 1] = …`
        } else addTargets(el);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(t)) {
      for (const prop of t.properties) {
        if (ts.isPropertyAssignment(prop)) addTargets(prop.initializer);
        else if (ts.isShorthandPropertyAssignment(prop)) written.add(prop.name.text);
        else if (ts.isSpreadAssignment(prop)) addTargets(prop.expression);
      }
    }
    // PropertyAccess / ElementAccess targets write a property, not a variable.
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        addTargets(node.left);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        addTargets(node.operand);
      }
    }
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      addTargets(node.initializer as ts.Expression);
    }
    forEachChild(node, visit);
  };
  visit(root);
  return written;
}

/**
 * Build the per-parameter primitive facts map consumed via
 * `LowerCtx.latticeParamFacts`. `resolvedParams` is the same
 * positionally-indexed array `lowerFunctionAstToIr` computed through
 * `resolveIrType`, so an `f64` val here is exactly the "number-typed" claim
 * selection admitted the function on. Only identifier-named parameters that
 * are never written anywhere in the function get an entry.
 */
export function collectLatticeParamFacts(
  fn:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
  resolvedParams: readonly { name: string; type: IrType }[],
): LatticeParamFacts | undefined {
  if (!fn.body || fn.parameters.length === 0) return undefined;
  const written = collectWrittenNamesIncludingNested(fn.body);
  const facts = new Map<ts.ParameterDeclaration, "number" | "string">();
  for (let i = 0; i < fn.parameters.length; i++) {
    const astParam = fn.parameters[i]!;
    if (!ts.isIdentifier(astParam.name)) continue; // pattern params bind leaves, not the param itself
    if (written.has(astParam.name.text)) continue;
    const resolved = resolvedParams[i]?.type;
    if (!resolved) continue;
    if (asVal(resolved)?.kind === "f64") facts.set(astParam, "number");
    else if (resolved.kind === "string") facts.set(astParam, "string");
  }
  return facts.size > 0 ? facts : undefined;
}

/**
 * The fixpoint-backed arm of from-ast's `proveAdditiveOperand`. Returns a
 * provable primitive class for exactly two shapes, both keyed on facts the
 * enclosing claim was ALREADY made with:
 *   - an identifier resolving (checker symbol, so shadowing locals can never
 *     match) to one of the enclosing function's own never-written parameters
 *     with a {@link LatticeParamFacts} entry;
 *   - a direct call with a certified AST-site plan whose return type is the
 *     number (val f64) or string atom.
 * Anything else → `undefined` (caller stays "unprovable", behavior unchanged).
 */
export function latticeAdditiveFact(node: ts.Expression, cx: LatticeFactContext): "number" | "string" | undefined {
  const expr = peelParens(node);
  if (ts.isIdentifier(expr)) {
    const facts = cx.latticeParamFacts;
    if (!facts) return undefined;
    const decl = cx.checker?.getSymbolAtLocation(expr)?.valueDeclaration;
    if (!decl || !ts.isParameter(decl)) return undefined;
    return facts.get(decl);
  }
  if (ts.isCallExpression(expr)) {
    const plan = cx.directCalls?.get(expr);
    const ret = plan?.signature.returnType;
    if (ret == null) return undefined;
    if (asVal(ret)?.kind === "f64") return "number";
    if (ret.kind === "string") return "string";
  }
  return undefined;
}
