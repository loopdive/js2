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
import { computeFnctorGraphCtorParamFacts, computeFnctorGraphCtorThisReadFacts } from "../ir/fnctor-method-edges.js";
import { fnctorCtorParamTypesFlagEnabled } from "../derivation-flags.js";
import { inferParamTypeFromCallSites } from "./declarations/param-return-inference.js";

/**
 * **ON by default since 2026-08-08** — `JS2WASM_FNCTOR_CTOR_PARAM_TYPES=0`
 * (or `off`, or empty) restores the pre-flip behaviour. Spelling rule and the
 * decision that set it: `src/derivation-flags.ts`.
 *
 * The history below is preserved because it is what the flip overrode, and
 * because it is the reason not to expect this to show up as a win.
 *
 * The mechanism works (a one-field fixture goes `externref` → `f64`, and the
 * #2660/#4155 fnctor suites stay green), but on the corpus it was built for it
 * never paid. Single-hop agreement recovered **2 slots** on acorn (`unknown`
 * 43 → 41) for +90 bytes; the transitive fixpoint that followed added no slots
 * at all; the #4246 pin-retirement slice brought the census to 61 typed / 1
 * discarded / 34 unknown, and the value-level instrument read **zero movement**
 * (`$AnyValue` 22,008 of 233,320 allocations per parse, identical flag-on and
 * flag-off) for +124 B. Three "stays OFF" verdicts on a benefit criterion.
 *
 * The 2026-08-08 stakeholder decision retires that criterion — derivation runs
 * always, consumers arrive later — so the flag ships ON at a measured null,
 * deliberately and on the record. Do not read the default as evidence of a win.
 */
export function fnctorCtorParamTypesEnabled(): boolean {
  return fnctorCtorParamTypesFlagEnabled();
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
  // STANDALONE ONLY. The narrowing's trust boundary is "the module owns every
  // write to this slot" — the same boundary the #3683 S4a numeric promotion
  // draws when it populates `numericPropertyNames` in the standalone lane only,
  // and the same one `fnctor-typed-bindings.ts` draws in its admission rule 1.
  // In the host lane a JS caller can hand the module anything and store it
  // through the generic member path, so a machine slot is not defensible.
  //
  // This gate was missing while the flag was OFF, and the flip surfaced it:
  // `tests/issue-3683-numeric-fields.test.ts` "host mode is untouched by the
  // promotion" compiles `this.pos = startPos` in the HOST lane and pins the
  // slot at `externref` — it went f64. Every measurement this pass has ever
  // been given (the acorn census, the binary sizes, the A/Bs in
  // plan/issues/743-*.md) is standalone, so nothing is lost by saying so.
  if (!ctx.standalone) return null;
  // Only rescue a slot the checker could not type; never perturb a typed one.
  if (rhsWasm.kind !== "externref") return null;

  // (#743) `deriveFnctorFields` hands us the value flowing into THIS slot, which
  // for a chain (`this.start = this.end = this.pos`) is the inner ASSIGNMENT,
  // not the value. Unwrap exactly the way its carrier loop does before deciding
  // what kind of carrier this is.
  let carrier: ts.Expression = valueExpr;
  while (ts.isBinaryExpression(carrier) && carrier.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    carrier = carrier.right;
  }

  // (#743) A `this.<y>` READ (the value is a FIELD of the instance under
  // construction) or a `<param>.<y>` READ (`this.start = p.start` — acorn's
  // Token pattern, where `p` carries the source owner's instance atom): neither
  // is expressible as a parameter fact. The satellite's mutual field↔param
  // fixpoint has already applied definiteness and statement ordering, so a
  // read that could observe `undefined` never carries a numeric fact here.
  // Node-keyed so this cannot drift from what was proven.
  if (
    ts.isPropertyAccessExpression(carrier) &&
    (carrier.expression.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(carrier.expression))
  ) {
    const fact = computeFnctorGraphCtorThisReadFacts(funcDecl.getSourceFile(), ctx).get(carrier);
    if (fact === undefined) return null;
    return fact.kind === "f64" || fact.kind === "i32" || fact.kind === "u32" ? { kind: "f64" } : null;
  }

  if (!ts.isIdentifier(carrier)) return null;
  const name = funcDecl.name?.text;
  if (name === undefined) return null;

  // The identifier must resolve to a PARAMETER OF THIS constructor — not a
  // same-named outer binding, and not a local that shadows one.
  const decl = ctx.oracle.valueDeclarationOf(carrier);
  if (decl === undefined || !ts.isParameter(decl)) return null;
  if (decl.parent !== funcDecl) return null;
  // A defaulted or rest parameter does not have the plain positional
  // argument-to-parameter mapping the call-site scan assumes.
  if (decl.initializer !== undefined || decl.dotDotDotToken !== undefined) return null;

  const paramIndex = funcDecl.parameters.indexOf(decl);
  if (paramIndex < 0) return null;

  const inferred = inferParamTypeFromCallSites(ctx, name, paramIndex, funcDecl.getSourceFile());
  // Legacy single-hop first: a conclusive direct-site agreement keeps exactly
  // its #4117 behaviour (f64 or nothing — a ref/string agreement never touches
  // a field slot here).
  if (inferred.sawCallSite && inferred.type !== null) {
    return inferred.type.kind === "f64" ? { kind: "f64" } : null;
  }
  // (#743) Graph-completeness fallback for the two cases the single-hop scan
  // cannot decide: NO identifier sites at all (acorn's `Parser` is only ever
  // constructed via `new this(…)` in its write-once static methods), or sites
  // whose args are themselves untyped forwards. The satellite fixpoint
  // (src/ir/fnctor-method-edges.ts) carries prototype/static METHOD call edges
  // and `new this(…)` edges to convergence, so a fact here has joined every
  // construction path the module contains — including the transitive
  // entrypoint → static-method → `new this` chain. Consumption stays f64-only,
  // mirroring this function's existing restriction: the numeric unbox at the
  // export boundary is the family's accepted guard for a violating external
  // caller. `i32`/`u32` are numeric subdomains of f64 (propagate.ts lattice)
  // and lower to the same f64 slot.
  const fact = computeFnctorGraphCtorParamFacts(funcDecl.getSourceFile(), ctx).get(name)?.[paramIndex];
  if (fact !== undefined && (fact.kind === "f64" || fact.kind === "i32" || fact.kind === "u32")) {
    return { kind: "f64" };
  }
  return null;
}
