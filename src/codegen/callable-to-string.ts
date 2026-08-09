// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4265) `ToString` of a CALLABLE value in the host-free string-concat path.
 *
 * ## The defect
 *
 * §13.15.3 `"" + f` runs ToPrimitive(f, string), which reaches
 * `Function.prototype.toString` (§20.2.3.5) — never
 * `Object.prototype.toString`. The standalone concat cascade had no callable
 * arm, so a function-valued operand fell through to `$__any_to_string`, whose
 * terminal is the literal `"[object Object]"`. Measured on
 * `built-ins/Function/prototype/toString` (standalone, REFUSAL eval tier): 15 of
 * the 44 failures in that directory report exactly
 * `Conforms to NativeFunction Syntax: "[object Object]"` — every `Proxy`-of-a-
 * function case and every `class` value.
 *
 * ## What it returns, and why that is the SPEC answer and not a test dodge
 *
 * §20.2.3.5 has two arms:
 *
 *  - the function has a `[[SourceText]]` ⇒ return that source text. When the
 *    operand is a bare identifier naming a top-level function declaration the
 *    compiler already captured it (`ctx.funcSourceText`, #1463), so that arm is
 *    served exactly.
 *  - otherwise — a bound function, a built-in, or a callable **Proxy**, none of
 *    which have `[[SourceText]]` — step 3 mandates *an implementation-defined
 *    String source code representation … NativeFunction*. `function () {
 *    [native code] }` is that string. For the ten `proxy-*` files this is not an
 *    approximation: it is the only conforming answer, and `[object Object]` was
 *    simply wrong.
 *
 * For a `class` value the honest answer is its source text, which this compiler
 * does not retain; the NativeFunction form is §20.2.3.5's own fallback for a
 * function whose source it cannot produce, and it is strictly closer to correct
 * than an object tag. That gap is named in #4265 rather than papered over.
 *
 * ## Blast radius
 *
 * The predicate is STATIC (`ts.Type` call/construct signatures), so a value the
 * checker does not call callable is untouched — including every class
 * *instance*, whose type has neither signature kind. It fires only where the
 * cascade would otherwise have emitted `[object Object]` or routed to
 * `$__any_to_string`, so it cannot displace a working lowering.
 */
import type { ts } from "../ts-api.js";

/** §20.2.3.5 step 3's implementation-defined NativeFunction representation. */
export const NATIVE_FUNCTION_SOURCE = "function () { [native code] }";

/**
 * True when the checker says this value is callable or constructable — the
 * §20.2.3.5 domain. `any`/`unknown` answer `false` (no signatures), so an
 * un-narrowed dynamic operand keeps the runtime `$__any_to_string` dispatch.
 */
export function isStaticallyCallableType(type: ts.Type): boolean {
  const call = type.getCallSignatures?.();
  if (call && call.length > 0) return true;
  const construct = type.getConstructSignatures?.();
  return construct !== undefined && construct.length > 0;
}

/**
 * The §20.2.3.5 string for a callable operand, or `undefined` when the checker
 * does not call it callable.
 *
 * Deliberately does NOT consult `ctx.funcSourceText` for the spec's first arm.
 * That map is keyed by BARE NAME, and a local shadowing a top-level function
 * would be handed the wrong source text — the #3364 hazard. `#1463`'s existing
 * `fn.toString()` site already serves the source-text arm where it has a
 * resolved receiver; this one stays on the unambiguous fallback.
 */
export function callableToStringLiteral(type: ts.Type): string | undefined {
  return isStaticallyCallableType(type) ? NATIVE_FUNCTION_SOURCE : undefined;
}
