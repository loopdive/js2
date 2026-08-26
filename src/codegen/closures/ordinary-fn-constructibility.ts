// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-6 T12) One answer to "is the closure artifact for this compiled
 * function CONSTRUCTIBLE?", keyed on the FUNCTION, never on the call site.
 *
 * ## Why a site-keyed answer is not merely imprecise — it is unsound
 *
 * `getOrCreateConstructibleFuncRefWrapperTypes` mints a NOMINALLY DISTINCT
 * struct subtype (`__constructible_fn_wrap_N_struct`, one extra
 * `$__constructible i32` field) so IsConstructor can discriminate at runtime.
 * The lazy closure singleton (`ensureFuncClosureSingleton`) is cached by
 * FUNCTION NAME, but until this module existed it chose between that subtype
 * and the plain wrapper from a boolean the CALLER passed. Two sites that
 * disagree therefore share one `__fn_closure_<name>` global while allocating
 * and casting to *unrelated* struct types — and the reader traps:
 *
 * ```wat
 * global.get $__fn_closure_f   ;; allocated as __fn_wrap_10_struct__fnmeta
 * any.convert_extern
 * ref.cast (ref $__constructible_fn_wrap_11_struct)  ;; illegal cast
 * ```
 *
 * `emitFuncRefAsClosure` already normalizes exactly this (#4437's note:
 * "constructibility belongs to the source function, not to whichever value read
 * happened to materialize its cached capture struct first"). The CACHED
 * singleton path did not, so the identical disagreement survived on the path
 * that ordinary identifier reads actually take.
 *
 * ## The site that disagrees, concretely
 *
 * A §B.3.3 block-scoped function declaration:
 *
 * ```js
 * (function () {
 *   { function f() { f = 123; return 'decl'; } }
 *   varBinding = f;   // <- TypeScript cannot resolve this `f`
 *   f();
 * }());
 * ```
 *
 * Inside `f`'s own body the name resolves to the `FunctionDeclaration`, so
 * `identifiers.ts` passes `constructible = true`. At `varBinding = f` the name
 * is the Annex-B web-compat VAR binding, which TypeScript does not model at
 * all — `identifierValueSymbol` answers `undefined`, the site passes `false`,
 * and whichever site compiles first decides the allocation while the other
 * decides the cast. Measured on `annexB/language/function-code/
 * {block-decl,switch-case,switch-dflt}-func-block-scoping`: all three trapped
 * with `illegal cast in f()`.
 *
 * Resolving from `funcMapOwnerDecl` / `topLevelFunctionDeclarations` instead
 * makes the answer a property of the compiled function, so every site agrees
 * however the name resolved there.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/**
 * The declaration that OWNS the compiled function registered under `funcName`,
 * independent of how any particular reference site resolved the name.
 */
export function compiledFunctionOwnerDeclaration(ctx: CodegenContext, funcName: string): ts.Declaration | undefined {
  return ctx.funcMapOwnerDecl.get(funcName) ?? ctx.topLevelFunctionDeclarations.get(funcName);
}

/**
 * `constructible`, widened to the answer the OWNING declaration gives.
 *
 * Never narrows: a caller that already knows the artifact is constructible
 * keeps that verdict even when the owner lookup comes up empty (a synthesized
 * or member-owned function), so this can only make disagreeing sites agree.
 */
export function normalizeOrdinaryFunctionConstructibility(
  ctx: CodegenContext,
  funcName: string,
  constructible: boolean,
): boolean {
  // The synthetic indirect-eval adapter is callable but deliberately has no
  // [[Construct]]. It is FunctionDeclaration-shaped only so the existing
  // closure hoister can compile its body; do not expose that implementation
  // detail through Reflect.construct(eval) in standalone output.
  if (funcName === "__js2wasm_intrinsic_indirect_eval") return false;
  if (constructible) return true;
  // (#4661) Lane-INDEPENDENT (was gated to `noJsHost || native-first`). The
  // js-host lane needs the same nominal constructible subtype so
  // `__is_ctor_closure` can answer §26.1.2's IsConstructor(newTarget).
  const owner = compiledFunctionOwnerDeclaration(ctx, funcName);
  return (
    owner !== undefined &&
    ts.isFunctionDeclaration(owner) &&
    owner.asteriskToken === undefined &&
    !(owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false)
  );
}
