// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4224 — the §22.1.3.19 / §22.2.6.11 REPLACEMENT-VALUE subsystem (standalone).
 *
 * `String.prototype.replace` / `replaceAll` and `RegExp.prototype[@@replace]`
 * all branch on ONE question about their second argument
 * (§22.2.6.11 step 2 / §22.1.3.19 step 5):
 *
 *   > *If `IsCallable(replaceValue)` is `false`, set `replaceValue` to
 *   > `ToString(replaceValue)`.*
 *
 * The standalone lane conflated **"not statically a string"** with **"needs a
 * JS host"** and refused both arms (`#1913 follow-up`). They are different
 * questions, and the non-callable one needs no new machinery at all — the
 * `$`-substitution engine (`__regex_get_substitution`, #1913) already consumes
 * an arbitrary `$AnyString`, so `"…".replace(/e/g, void 0)` only ever needed
 * its argument routed through the same `ToString` the `+`-concat engine uses.
 *
 * This module owns that DECISION. It deliberately answers `false` for anything
 * it cannot PROVE is non-callable (`any`/`unknown`/`object`), because admitting
 * a callable here would silently stringify the function source instead of
 * calling it — a wrong answer rather than a missing feature. Callable
 * replacers keep the narrowed refusal in `regexp-standalone.ts`.
 */
import { ts } from "../ts-api.js";
import type { TypeFact } from "../checker/oracle.js";
import type { CodegenContext } from "./context/types.js";
import { stripStaticWrapper } from "./regexp-standalone.js";

/**
 * The primitive facts whose `ToString` is total, side-effect-free and already
 * implemented by `emitArgAsNativeString`'s native-concat engine.
 *
 * `symbol` is absent on purpose: §7.1.17 `ToString(symbol)` THROWS, and
 * admitting it here would stringify where the spec raises (same carve-out as
 * `isPlainToStringSearchValue`'s, #3724/#4016).
 */
const TO_STRING_TOTAL_FACTS: ReadonlySet<TypeFact["kind"]> = new Set([
  "number",
  "string",
  "boolean",
  "bigint",
  "undefined",
  "null",
  "void",
]);

/**
 * Is `replExpr` provably a NON-CALLABLE replacement value — i.e. does
 * §22.2.6.11 step 2's `ToString(replaceValue)` describe the whole of its
 * semantics?
 *
 * A syntactic `null` literal answers `true` even though its checker type is
 * `any` under `strictNullChecks: false`: it is unambiguously the null value and
 * is non-callable by inspection (the same escape hatch
 * `isPlainToStringSearchValue` grants).
 */
export function isPlainToStringReplacement(ctx: CodegenContext, replExpr: ts.Expression): boolean {
  if (isPrimitiveToStringOperand(ctx, replExpr)) return true;
  // An ORDINARY OBJECT is admissible here even though it is not for a SEARCH
  // value. The two gates are asymmetric on purpose: a search value's `@@replace`
  // can be installed after its type is fixed, but callability cannot be — a
  // type carrying a call signature already classifies as `function`
  // (`oracle.factOfType`), so a fact of `object`/`array`/`tuple` is a PROOF that
  // `IsCallable` is false, which is all §22.2.6.11 step 2 asks. This is what
  // lets `"".replace("a", { toString() {…} })` run its `toString` instead of
  // reaching a refusal.
  const fact = ctx.oracle.typeFactOf(stripStaticWrapper(replExpr));
  const parts = fact.kind === "union" ? fact.parts : [fact];
  return parts.length > 0 && parts.every((part) => NON_CALLABLE_OBJECT_FACTS.has(part.kind));
}

/** Object-ish facts that are PROVABLY not callable (see above). */
const NON_CALLABLE_OBJECT_FACTS: ReadonlySet<TypeFact["kind"]> = new Set(["object", "array", "tuple"]);

/**
 * Is `expr` a PRIMITIVE whose `ToString` is total and side-effect-free?
 *
 * Deliberately narrower than `isPlainToStringSearchValue` (#4016), which admits
 * any type the checker can prove does not declare the well-known symbol. That
 * proof is sound about the DECLARED type and blind to a member installed later:
 *
 *     var searchValue = {};
 *     searchValue[Symbol.replace] = function () { … };
 *     "".replace(searchValue, "x");   // must dispatch @@replace
 *
 * The checker's type for `searchValue` is `{}`, so the symbol lookup answers a
 * confident `false`. On the `replace` lane that would turn a clean #1474
 * refusal into a silently wrong answer, so this predicate refuses every object
 * — a primitive cannot acquire `@@replace` after the fact.
 */
export function isPrimitiveToStringOperand(ctx: CodegenContext, expr: ts.Expression): boolean {
  const value = stripStaticWrapper(expr);
  // `null` is unambiguously the null value even though its checker type is
  // `any` under `strictNullChecks: false`.
  if (value.kind === ts.SyntaxKind.NullKeyword) return true;
  const fact = ctx.oracle.typeFactOf(value);
  const parts = fact.kind === "union" ? fact.parts : [fact];
  return parts.length > 0 && parts.every((part) => TO_STRING_TOTAL_FACTS.has(part.kind));
}

/**
 * Is `replExpr` a CALLABLE replacement — the `IsCallable(replaceValue)` arm of
 * §22.2.6.11 step 2, which invokes the replacer per match rather than
 * stringifying it?
 *
 * Answers `true` only on a proven function fact. `any`/`unknown` answer
 * `false` here AND `false` from {@link isPlainToStringReplacement}, so an
 * un-provable replacement lands in neither arm and keeps the existing refusal —
 * which is the correct conservative outcome for a value that could be either.
 */
export function isCallableReplacement(ctx: CodegenContext, replExpr: ts.Expression): boolean {
  const fact = ctx.oracle.typeFactOf(stripStaticWrapper(replExpr));
  return fact.kind === "function";
}
