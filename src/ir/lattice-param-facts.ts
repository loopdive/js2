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
import { identifierWritesOf, skipOuterExpressions } from "../shared/binding-writes.js";

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

interface IdentifierWriteSite {
  readonly target: ts.Identifier;
  /** The node performing the write (`identifierWritesOf`'s argument). */
  readonly node: ts.Node;
}

interface WriteIndex {
  /** A `with` statement or a direct `eval` may write any name under the root. */
  readonly dynamicScope: boolean;
  readonly byName: ReadonlyMap<string, readonly IdentifierWriteSite[]>;
}

const writeIndexes = new WeakMap<ts.Node, WriteIndex>();

/**
 * Every identifier write ANYWHERE inside `root`, nested function bodies
 * included, as `identifierWritesOf` defines a write: assignments (plain,
 * compound, logical, destructuring), `++`/`--`, for-in/of heads and `var`
 * initializers. Member writes are not variable writes. Built once per root:
 * the parameter facts and every `localIsRewritten` query read the same index.
 *
 * Nested bodies are deliberately included (unlike from-ast's
 * `collectMutatedLetNamesFromBlock`): a binding written by a nested closure is
 * still written for reads that follow the closure's invocation.
 */
function writeIndexOf(root: ts.Node): WriteIndex {
  const cached = writeIndexes.get(root);
  if (cached) return cached;
  let dynamicScope = false;
  const byName = new Map<string, IdentifierWriteSite[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isWithStatement(node)) dynamicScope = true;
    if (ts.isCallExpression(node)) {
      const callee = skipOuterExpressions(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "eval") dynamicScope = true;
    }
    for (const { target } of identifierWritesOf(node)) {
      const sites = byName.get(target.text);
      if (sites) sites.push({ target, node });
      else byName.set(target.text, [{ target, node }]);
    }
    forEachChild(node, visit);
  };
  visit(root);
  const index = { dynamicScope, byName };
  writeIndexes.set(root, index);
  return index;
}

/**
 * (#7106) Is the local `declaration` written after it is declared, anywhere in
 * its function (nested functions included)? A destructured declaration counts
 * as written. (#7283) A function declaration's binding is checked the same way.
 *
 * (#7306) The writes are `identifierWritesOf`'s: assignments, updates,
 * for-in/of heads and repeated `var` initializers; `with` and direct `eval`
 * fail closed. With `resolve`, a same-name write counts only when it resolves
 * to this binding (or to nothing); without it, every same-name write counts.
 */
export function localIsRewritten(
  declaration: ts.VariableDeclaration | ts.FunctionDeclaration,
  resolve?: (identifier: ts.Identifier) => ts.Declaration | undefined,
): boolean {
  if (declaration.name === undefined || !ts.isIdentifier(declaration.name)) return true;
  const name = declaration.name;
  const identity = resolve?.(name);
  if (resolve && !identity) return true;
  const writesBinding = (target: ts.Identifier): boolean => {
    if (!resolve) return true;
    const written = resolve(target);
    return !written || written === identity || sameVarScopedBinding(written, identity!);
  };
  const index = writeIndexOf(varScopeOf(declaration));
  if (index.dynamicScope) return true;
  return (index.byName.get(name.text) ?? []).some(({ target, node }) => node !== declaration && writesBinding(target));
}

function varScopeOf(node: ts.Node): ts.Node {
  return ts.findAncestor(node.parent, (parent) => ts.isFunctionLike(parent) || ts.isSourceFile(parent))!;
}

function isVarScoped(node: ts.Declaration): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    (ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.BlockScoped) === 0)
  );
}

/** `var` and function declarations of one name in one function scope are one binding. */
function sameVarScopedBinding(a: ts.Declaration, b: ts.Declaration): boolean {
  return isVarScoped(a) && isVarScoped(b) && varScopeOf(a) === varScopeOf(b);
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
  const writes = writeIndexOf(fn.body);
  if (writes.dynamicScope) return undefined; // `with` / direct `eval` may write any parameter
  const facts = new Map<ts.ParameterDeclaration, "number" | "string">();
  for (let i = 0; i < fn.parameters.length; i++) {
    const astParam = fn.parameters[i]!;
    if (!ts.isIdentifier(astParam.name)) continue; // pattern params bind leaves, not the param itself
    if (writes.byName.has(astParam.name.text)) continue;
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
