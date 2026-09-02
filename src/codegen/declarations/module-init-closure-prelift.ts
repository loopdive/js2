// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3523 R4 gap-6a) Can the module-init population's closure DISCOVERY be
 * produced without compiling the initializer first?
 *
 * ## The question pass 1 exists to answer
 *
 * `module-init-pass1` compiles the whole initializer before any top-level
 * function body, purely so those bodies can see what pass 1 discovers. Measured
 * (gap-6 design record, 2026-09-02) pass 1 mutates 45+ `ctx` collections on a
 * test262 harness population, but only ONE of them is decision-changing for the
 * bodies compiled between the passes: the closure binding family
 * (`closureMap` / `closureInfoByTypeIdx` / `closureStructByNode`). Remove pass 1
 * with nothing in its place and `doneprintHandle.js`'s
 * `var __consolePrintHandle__ = function (msg) { print(msg); }` compiles from a
 * `call_ref` on the closure struct to a bare call through the dynamic
 * `__call_function_*` boundary; `$DONE` inlines it and the runner never observes
 * completion — six async regressions on an 89-file runner-faithful sample.
 *
 * This module produces that one family AHEAD of the bodies, so the initializer
 * can compile exactly ONCE, after them.
 *
 * ## Why registering the shared WRAPPER is sufficient — the measured mechanism
 *
 * A call site does not consume the closure's own struct type. `compileClosureCall`
 * (`expressions/calls-closures.ts`) derives its `ref.cast` target from
 * `getClosureFuncSelfTypeIdx(ctx, info.funcTypeIdx)` — the SELF parameter of the
 * lifted function type — and only falls back to `info.structTypeIdx` when that
 * func type is private. Both the lifted func type and the wrapper root are
 * keyed by the closure's SIGNATURE, not by its captures:
 *
 * ```
 *   (type $__fn_wrap_1_struct         (sub (struct funcref i32 externref)))          <- root, cast target
 *   (type $__fn_wrap_1_type           (func (param (ref null $root) externref)))     <- call_ref type
 *   (type $__closure_3_struct         (sub final $__fn_wrap_1_struct  … $print …))   <- pass 1's mint
 *   (type $__closure_5_struct         (sub final $__fn_wrap_1_struct  … $print …))   <- pass 2's mint
 * ```
 *
 * `mintClosureStructTypes` gives a capture-CARRYING closure the wrapper's own
 * `liftedFuncTypeIdx` and makes its struct a subtype of the wrapper root
 * (`closures/arrow-phases.ts`, the `else if (wrapperTypes)` arm). So a body
 * compiled against the wrapper facts casts and dispatches correctly on whatever
 * per-closure struct the single real compile mints afterwards — measured on
 * `h1` above, where pass 1 minted struct 16 and pass 2 mints struct 24 while the
 * body's cast names the root either way.
 *
 * That is what lets the pre-lift run the DECLARE half only, with an empty
 * capture list, and never compile a body or mint a lifted function: no dead
 * `$__closure_N` twin, and no dependency on a module-init frame that does not
 * exist yet.
 *
 * ## The refusals, and what each one protects
 *
 * | refusal | what would otherwise break |
 * | --- | --- |
 * | named function expression | takes the private-`liftedFuncTypeIdx` arm — the body's `call_ref` type would not match the funcref it dispatches |
 * | generator / async | own lowering machinery; the async activation REWRITES `closureReturnType` to `externref` after the sig is computed |
 * | concise body with a boxed (`externref`) declared return | the #concise-body return repair can re-mint `liftedFuncTypeIdx` while compiling the body — a type the pre-lift cannot know |
 * | no shared wrapper for the signature | defensive: the real mint would produce an unrelated private struct |
 * | population carries an integrity call | `Object.freeze`/`defineProperty`/`Reflect.*` — the bodies deliberately consume pass 1's END integrity state (#2965 snapshot), which only a first compile produces |
 * | population carries a decorator / await / class expression / class static block | gap-1b's refusals, unchanged: their lowerings are order- and pass-sensitive |
 * | population reaches beyond this source | `"discover"` mode exists to run pass 1 for the whole graph; a multi-source population is out of scope |
 * | population has no pre-liftable closure | there is no discovery to replace, so skipping pass 1 would be a bet on the OTHER families rather than a substitution |
 *
 * Fail-closed throughout: anything not provably reproducible keeps pass 1.
 */

import ts from "typescript";

import type { CodegenContext, FunctionContext } from "../context/types.js";
import { callableHasConstructBehavior } from "../callback-ctor-bridge.js";
import { computeClosureWrapperSig } from "../closures.js";
import { mintClosureStructTypes, registerClosureBindingInfo } from "../closures/arrow-phases.js";

/**
 * Test-only anti-vacuity seam. With
 * `JS2WASM_TEST_DISABLE_MODULE_INIT_PRELIFT=1` the gate still says yes and pass
 * 1 is still skipped, but NOTHING is registered — which turns "the inventory is
 * what keeps the dispatch typed" from an argument into a measurement: the
 * harness shape's body loses its `call_ref` and falls back to the dynamic
 * `__call_function_*` boundary, exactly the gap-1b `p2only` signature. The seam
 * only ever REMOVES registrations, and nothing outside the mutation test reads
 * it.
 */
export const PRELIFT_DISABLE_SEAM = "JS2WASM_TEST_DISABLE_MODULE_INIT_PRELIFT";

/** A module-scope closure whose declare half can be reproduced ahead of the bodies. */
export interface ModuleClosurePreLiftSite {
  readonly node: ts.ArrowFunction | ts.FunctionExpression;
  /** The binding `registerClosureBindingInfo` will key, when it keys one. */
  readonly binding: string | undefined;
}

/** Why a candidate — or the population as a whole — is not pre-liftable. */
export type ModuleClosurePreLiftRefusalReason =
  | "named-function-expression"
  | "generator"
  | "async"
  | "concise-body-boxed-return"
  | "nested-function-like-in-body"
  | "no-shared-wrapper"
  | "population-not-full-mode"
  | "population-multi-source"
  | "population-async-graph-init"
  | "population-static-init-expressions"
  | "population-integrity-call"
  | "population-decorator"
  | "population-await"
  | "population-class-expression"
  | "population-class-static-block"
  | "population-has-no-pre-liftable-closure";

export interface ModuleClosurePreLiftRefusal {
  readonly reason: ModuleClosurePreLiftRefusalReason;
  readonly binding?: string;
}

/** The pure plan: what the pre-lift WOULD register, and everything it refuses. */
export interface ModuleClosurePreLift {
  readonly sites: readonly ModuleClosurePreLiftSite[];
  readonly refusals: readonly ModuleClosurePreLiftRefusal[];
}

/** Inputs the population scan cannot read off `ctx`. */
export interface ModuleClosurePreLiftInputs {
  /** `"full"` is the only mode with a single emitting pass to move work into. */
  readonly moduleInitMode: string;
  /** The source whose declarations are being compiled. */
  readonly sourceFile: ts.SourceFile;
  /** Top-level await lowers through the async graph, which owns its own passes. */
  readonly hasAsyncGraphInit: boolean;
}

/**
 * §7.3 integrity operations plus the `Object.defineProperty` family. Matched by
 * SPELLING, deliberately: over-refusing `myTable.freeze()` costs one population
 * its pass-1 skip, while under-refusing turns a `TypeError` into a silent write.
 */
const INTEGRITY_METHOD_NAMES = new Set([
  "freeze",
  "seal",
  "preventExtensions",
  "isFrozen",
  "isSealed",
  "isExtensible",
  "defineProperty",
  "defineProperties",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
]);

/** Every `Reflect.*` call is an integrity/MOP operation for this purpose. */
function isIntegrityCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (ts.isIdentifier(callee.expression) && callee.expression.text === "Reflect") return true;
  return INTEGRITY_METHOD_NAMES.has(callee.name.text);
}

/** The gap-1b population refusals, plus this slice's integrity and static-init ones. */
function populationRefusal(node: ts.Node): ModuleClosurePreLiftRefusalReason | undefined {
  switch (node.kind) {
    case ts.SyntaxKind.Decorator:
      return "population-decorator";
    case ts.SyntaxKind.AwaitExpression:
      return "population-await";
    case ts.SyntaxKind.ClassExpression:
      return "population-class-expression";
    case ts.SyntaxKind.ClassStaticBlockDeclaration:
      return "population-class-static-block";
    default:
      return isIntegrityCall(node) ? "population-integrity-call" : undefined;
  }
}

/** The two binding shapes `registerClosureBindingInfo` can key, at TOP LEVEL only. */
function topLevelClosureCandidates(
  statements: readonly ts.Statement[],
): Array<{ node: ts.ArrowFunction | ts.FunctionExpression; binding: string | undefined }> {
  const found: Array<{ node: ts.ArrowFunction | ts.FunctionExpression; binding: string | undefined }> = [];
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declarator of statement.declarationList.declarations) {
        const initializer = declarator.initializer;
        if (!initializer) continue;
        if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) continue;
        found.push({
          node: initializer,
          binding: ts.isIdentifier(declarator.name) ? declarator.name.text : undefined,
        });
      }
      continue;
    }
    if (!ts.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const right = expression.right;
    if (!ts.isArrowFunction(right) && !ts.isFunctionExpression(right)) continue;
    found.push({ node: right, binding: ts.isIdentifier(expression.left) ? expression.left.text : undefined });
  }
  return found;
}

/** Any function-like or class-like node strictly inside this closure. */
function containsNestedFunctionLike(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(child) || ts.isClassLike(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/**
 * Whether the declare half of this closure reproduces what the real compile
 * will mint. Pure: reads the AST and `ctx`'s signature caches, writes nothing.
 */
function siteRefusal(
  ctx: CodegenContext,
  node: ts.ArrowFunction | ts.FunctionExpression,
): ModuleClosurePreLiftRefusalReason | undefined {
  if (ts.isFunctionExpression(node)) {
    if (node.name !== undefined) return "named-function-expression";
    if (node.asteriskToken !== undefined) return "generator";
  }
  if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return "async";
  // (measured 2026-09-02, `.tmp/g6a-variants`) The ONE family where the
  // declare-half inventory is not enough. `const mk = () => { const inner = ()
  // => 5; return inner; }` compiles `inner` while pass 1 compiles `mk`'s LIFTED
  // BODY — a fact no AST-level pre-lift can publish — and a between-pass body
  // that calls `mk()()` loses the second-level dispatch and answers `0` instead
  // of `5` on both lanes. Only escaping nested closures actually break (`v4`,
  // `v11`, `v12`, `v19` in that probe are all fine), but escape analysis is not
  // this slice's job: refuse every nested function-like, fail-closed. This is
  // the "next inventory family" the gap-6 plan says to record and stop at.
  if (containsNestedFunctionLike(node)) return "nested-function-like-in-body";
  // The concise-body return repair (`closures.ts`, the `else if` inside the
  // non-block arm) re-mints `liftedFuncTypeIdx` when the expression lowers to
  // `f64` under a declared `externref` return and no `__box_number` is
  // reachable. Only a body compile can know, so refuse the whole shape.
  const { returnType } = computeClosureWrapperSig(ctx, node);
  if (!ts.isBlock(node.body) && returnType?.kind === "externref") return "concise-body-boxed-return";
  return undefined;
}

/**
 * Plan the pre-lift. **Pure** — this deliberately mutates nothing, because the
 * gate consults the plan and a REFUSED population must reach pass 1 with `ctx`
 * exactly as it is today. Minting happens in {@link applyModuleClosurePreLift},
 * which the caller runs only after the gate says yes. (The plan asked for one
 * `preLiftModuleClosures`; splitting it is what makes "refused ⇒ byte-identical
 * to main" true by construction rather than by review.)
 */
export function planModuleClosurePreLift(
  ctx: CodegenContext,
  inputs: ModuleClosurePreLiftInputs,
): ModuleClosurePreLift {
  const refusals: ModuleClosurePreLiftRefusal[] = [];
  const sites: ModuleClosurePreLiftSite[] = [];

  if (inputs.moduleInitMode !== "full") refusals.push({ reason: "population-not-full-mode" });
  if (inputs.hasAsyncGraphInit) refusals.push({ reason: "population-async-graph-init" });
  if (ctx.staticInitExprs.length > 0) refusals.push({ reason: "population-static-init-expressions" });
  for (const statement of ctx.moduleInitStatements) {
    if (statement.getSourceFile() !== inputs.sourceFile) {
      refusals.push({ reason: "population-multi-source" });
      break;
    }
  }

  // Full-subtree population scan over exactly the nodes the initializer
  // compiles — the same input set `moduleInitPopulationIsPass2Stable` reads.
  const seenPopulationRefusals = new Set<ModuleClosurePreLiftRefusalReason>();
  const stack: ts.Node[] = [...ctx.moduleInitStatements];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const reason = populationRefusal(node);
    if (reason !== undefined && !seenPopulationRefusals.has(reason)) {
      seenPopulationRefusals.add(reason);
      refusals.push({ reason });
    }
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }

  for (const candidate of topLevelClosureCandidates(ctx.moduleInitStatements)) {
    const reason = siteRefusal(ctx, candidate.node);
    if (reason !== undefined) {
      refusals.push(candidate.binding === undefined ? { reason } : { reason, binding: candidate.binding });
      continue;
    }
    sites.push(candidate);
  }

  if (sites.length === 0) refusals.push({ reason: "population-has-no-pre-liftable-closure" });
  return { sites, refusals };
}

/**
 * True when the initializer's closure discovery is fully reproducible ahead of
 * the bodies, so pass 1 can be skipped and the single compile can run in the
 * pass-2 slot. Fail-closed: one refusal is enough.
 */
export function moduleInitDiscoveryIsStatic(preLift: ModuleClosurePreLift): boolean {
  return preLift.refusals.length === 0 && preLift.sites.length > 0;
}

/**
 * Register the closure-binding facts for every planned site.
 *
 * Runs the DECLARE half of `compileArrowAsClosure` and nothing else: the
 * signature, the shared wrapper mint (with an EMPTY capture list — see the
 * module header for why that is the right registration rather than an
 * approximation of one), the `closureStructByNode` record and
 * `registerClosureBindingInfo` with no `inlineBody`. No body is compiled, no
 * lifted function is minted, no construction is emitted.
 *
 * `frame` is the synthetic module-init `FunctionContext`
 * `registerClosureBindingInfo` reads through `ctx.currentFunc` when deciding
 * whether an assignment target is a local or a module global. It is empty, so
 * every target resolves the module-global way — which is the answer for a
 * top-level assignment.
 *
 * Returns the number of registered sites.
 */
export function applyModuleClosurePreLift(
  ctx: CodegenContext,
  preLift: ModuleClosurePreLift,
  frame: FunctionContext,
): number {
  const previousFunc = ctx.currentFunc;
  ctx.currentFunc = frame;
  try {
    for (const site of preLift.sites) {
      const { params, returnType } = computeClosureWrapperSig(ctx, site.node);
      const closureResults = returnType ? [returnType] : [];
      const minted = mintClosureStructTypes(ctx, {
        captures: [],
        arrowParams: params,
        closureResults,
        closureName: `__prelift_${ctx.closureCounter}`,
        isNamedFuncExpr: false,
        decl: site.node,
        constructible: callableHasConstructBehavior(site.node),
      });
      (ctx.closureStructByNode ??= new WeakMap()).set(site.node, { structTypeIdx: minted.structTypeIdx });
      registerClosureBindingInfo(
        ctx,
        site.node,
        minted.structTypeIdx,
        minted.liftedFuncTypeIdx,
        returnType,
        params,
        undefined,
      );
    }
  } finally {
    ctx.currentFunc = previousFunc;
  }
  return preLift.sites.length;
}
