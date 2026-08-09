// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4262) Which global holds "the function value named `X`"?
 *
 * A user-declared function that is read as a VALUE lives in one of two module
 * globals, and `src/codegen/expressions/identifiers.ts` picks between them with
 * a fixed precedence:
 *
 *   1. `ctx.moduleGlobals.get(name)` — `$__mod_<name>`, taken whenever the
 *      declaration is a reassigned live binding (`ctx.liveFuncBindingGlobals`,
 *      #2931) or is closure-backed (`ctx.closureMap`);
 *   2. `ctx.funcClosureGlobals.get(name)` — `$__fn_closure_<name>`, the cached
 *      captureless singleton (#1340).
 *
 * Any OTHER site that has to answer "what is the function value named `X`?" —
 * today `fillExternGetErrorProps`' `.constructor` arm (#3614) — must use the
 * same precedence, or it hands back a *different* object than the name reads.
 *
 * That is not a cosmetic divergence: two live carriers means two distinct
 * closure identities, and the closure PROPERTY BAG (#3468) is keyed by
 * identity. So the wrong carrier is both `!==` the name and missing every
 * static the source assigned to it. Measured on the assembled literal test262
 * harness (`runTest262File(…, "standalone")`, upstream/main @803a68c13):
 *
 * ```
 * Test262Error === Test262Error       true      both read $__mod_Test262Error
 * e.constructor === e.constructor     true      both read $__fn_closure_Test262Error
 * e.constructor === Test262Error      FALSE     the carriers disagree
 * Test262Error.name                   "Test262Error"
 * e.constructor.name                  undefined the fn-closure carrier has no bag
 * typeof e.constructor                "function"
 * ```
 *
 * `assert.js` closes over `Test262Error`, so the harness is ALWAYS in case 1
 * while `fillExternGetErrorProps` was always reading case 2. The harness's own
 * negative-helper self-tests report this as
 * `Expected a Test262Error, but a "undefined" was thrown.` and `assert.throws`
 * reports it as `Expected a undefined but got a different error constructor
 * with the same name`.
 *
 * This module is deliberately dependency-light (context types only) so the
 * registry layer can import it without a cycle.
 */
import type { CodegenContext } from "./context/types.js";

/**
 * The global index of the canonical carrier for the function value named
 * `name`, or `undefined` when the name is never materialized as a value in this
 * module (in which case nothing can hold the other side of an identity
 * comparison either, so a caller should fall through to its existing miss).
 */
export function userErrorCtorCarrierGlobal(ctx: CodegenContext, name: string): number | undefined {
  // `ctx.classSet` membership means the name is a CLASS, and the identifier
  // read takes an entirely different path for those (the `funcRefIdx` branch in
  // `compileIdentifierValueRead` is gated on `!ctx.classSet.has(name)`). The
  // test262 `wrapTest` preamble declares `class Test262Error`, i.e. the whole
  // main conformance lane — so preferring `moduleGlobals` there would change
  // behaviour on ~30k tests for a case whose precedence this function does not
  // model. Fall straight through to today's answer instead.
  if (ctx.classSet.has(name)) return ctx.funcClosureGlobals.get(name);
  const moduleGlobalIdx = ctx.moduleGlobals.get(name);
  if (moduleGlobalIdx !== undefined && (ctx.liveFuncBindingGlobals?.has(name) === true || ctx.closureMap.has(name))) {
    return moduleGlobalIdx;
  }
  return ctx.funcClosureGlobals.get(name);
}
