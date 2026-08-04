// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#743) Give a fnctor field the type its constructor PARAMETER was narrowed to.
 *
 * `deriveFnctorFields` picks a slot from the CHECKER's view of the assigned
 * value. For `function P(start) { this.pos = start }` the checker says `any`, so
 * the slot boxes — even when every `new P(…)` site in the module passes a
 * number. On acorn that single pattern is most of the 43-of-96 `unknown` slots
 * the #4155 census reports, because its constructors take untyped parameters and
 * seed nearly every field straight from one.
 *
 * `inferParamTypeFromCallSites` already computes the answer, with the soundness
 * rules that matter: every call site must AGREE, a conflict bails, an
 * under-applied site widens (#3548), and a value forwarded recursively is
 * treated as dynamic (#3961). Until this slice it could not see `new F(…)` at
 * all — it matched only `isCallExpression` — so constructors contributed
 * nothing. Widening that test is the companion half of this change.
 *
 * **Both halves are required, and neither is useful alone.** Narrowing the
 * parameter without the slot makes the ctor store an f64 into an `externref`
 * field, which re-boxes on every construction: measured +27 bytes on a
 * one-field fixture, i.e. strictly worse than doing nothing. Narrowing the slot
 * without the parameter is the mirror image — an `externref` local unboxed at
 * every store, with a new failure mode when the value is not numeric. They move
 * together or not at all.
 *
 * Deliberately NARROW:
 *  - only a bare parameter reference (`this.x = start`), never an expression
 *    over one — anything else is the existing carrier logic's job;
 *  - only when the checker itself gave up (`rhsWasm` is `externref`), so a slot
 *    that already has a machine type is never perturbed;
 *  - only f64. The other narrowings `inferParamTypeFromCallSites` can return
 *    (refs, native strings, bool-branded i32) each carry their own null and
 *    identity questions at a struct field, and none of them is the acorn case;
 *  - a named function declaration only, since the inference is keyed by name.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import type { ValType } from "../ir/types.js";
import { inferParamTypeFromCallSites } from "./declarations/param-return-inference.js";

/**
 * OFF by default — opt in with `JS2WASM_FNCTOR_CTOR_PARAM_TYPES=1`.
 *
 * The mechanism works (a one-field fixture goes `externref` → `f64`, and the
 * #2660/#4155 fnctor suites stay green), but on the corpus it was built for it
 * does not yet pay: **acorn recovers 2 slots** (`unknown` 43 → 41) **for +90
 * bytes** (943,140 → 943,230). Direct call-site agreement is not enough there,
 * because acorn's constructor arguments are themselves untyped values forwarded
 * from other untyped parameters — `new Parser(options, input, startPos)` inside
 * a function whose own params are `any` teaches this pass nothing.
 *
 * Resolving the other 41 needs #743's actual Phase 2: an iterative fixpoint that
 * propagates types transitively through the call graph until convergence, rather
 * than a single-hop agreement check. This slice is the prerequisite for that —
 * it establishes that `new F(…)` participates at all — not a substitute.
 *
 * Kept and shipped rather than deleted because the negative result is the
 * useful part: the next attempt should start from the fixpoint, and should not
 * re-derive that single-hop agreement is worth 2 slots.
 */
export function fnctorCtorParamTypesEnabled(): boolean {
  return process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES === "1";
}

/**
 * The narrowed slot type for `this.<field> = <param>`, or null to leave the
 * existing checker-derived choice alone.
 */
export function inferFnctorFieldTypeFromCtorParam(
  ctx: CodegenContext,
  funcDecl: ts.FunctionDeclaration | ts.FunctionExpression,
  valueExpr: ts.Expression,
  rhsWasm: ValType,
): ValType | null {
  if (!fnctorCtorParamTypesEnabled()) return null;
  // Only rescue a slot the checker could not type; never perturb a typed one.
  if (rhsWasm.kind !== "externref") return null;
  if (!ts.isIdentifier(valueExpr)) return null;
  const name = funcDecl.name?.text;
  if (name === undefined) return null;

  // The identifier must resolve to a PARAMETER OF THIS constructor — not a
  // same-named outer binding, and not a local that shadows one.
  const decl = ctx.oracle.valueDeclarationOf(valueExpr);
  if (decl === undefined || !ts.isParameter(decl)) return null;
  if (decl.parent !== funcDecl) return null;
  // A defaulted or rest parameter does not have the plain positional
  // argument-to-parameter mapping the call-site scan assumes.
  if (decl.initializer !== undefined || decl.dotDotDotToken !== undefined) return null;

  const paramIndex = funcDecl.parameters.indexOf(decl);
  if (paramIndex < 0) return null;

  const inferred = inferParamTypeFromCallSites(ctx, name, paramIndex, funcDecl.getSourceFile());
  // `sawCallSite && type === null` is the polymorphic/conflicting case — the
  // scan's own signal that narrowing would be unsound. No call sites at all is
  // equally inconclusive here (an exported ctor invoked from outside).
  if (!inferred.sawCallSite || inferred.type === null) return null;
  return inferred.type.kind === "f64" ? { kind: "f64" } : null;
}
