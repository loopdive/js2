// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * §13.4.4 / §13.4.5: `++x` / `x--` on an UNRESOLVABLE reference is a
 * ReferenceError — the update expressions begin with GetValue, and GetValue on
 * an unresolvable Reference throws (§6.2.5.5 step 3).
 *
 * The update expressions were the ONLY spelling of that read that did not
 * throw. Measured, `target=standalone`, on an undeclared name:
 *
 * | expression        | before   |
 * | ----------------- | -------- |
 * | `var t = x;`      | ReferenceError |
 * | `x();`            | ReferenceError |
 * | `x + 1`           | ReferenceError |
 * | `x += 1;`         | ReferenceError |
 * | `++x;` / `x++;`   | **no throw** |
 *
 * So the compound-assignment path already had it and the four update arms did
 * not — the same "one site of a set was missed" shape as the #4500 realm-global
 * trio right above this in `unary-updates.ts`.
 *
 * A name an enclosing `with` may supply is NOT unresolvable: the object
 * environment record decides at runtime. `resolveWithBinding` is the same
 * predicate the `with` update path (`with-rmw.ts`) gates on, so the two cannot
 * disagree about which names it owns.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitStaticTdzThrow } from "./expressions/identifiers.js";
import { isSloppyImplicitGlobalBinding } from "./expressions/implicit-global-binding.js"; // (#4640 D3)
import { getCapturedBoxGlobal } from "./property-access.js"; // (#4662) boxed captured global
import { resolveWithBinding } from "./with-scope.js";

/**
 * (#4662) Whether CODEGEN already holds a binding for `name` in the scope being
 * compiled — i.e. one of the very arms the caller takes right after this helper
 * declines (`fctx.localMap` → boxed cell → module global → captured global →
 * boxed captured global).
 *
 * `oracle.isUnresolvableIdentifier` asks the TypeScript checker, and the checker
 * can only answer for nodes in ITS program. An eval'd / `Function`-minted body is
 * parsed into a FOREIGN `ts.SourceFile` (`<eval>.ts`) that was never added to the
 * program, so `getSymbolAtLocation` returns `undefined` for EVERY identifier in
 * it — parameters and locals included. That is "the checker has no opinion", not
 * "the reference is unresolvable", and turning the first into the second made
 * `++`/`--` throw `ReferenceError: <name> is not defined` on names that were
 * demonstrably bound: measured on campaign HEAD, every one of the six throwing
 * cells reached this site with `fctx.localMap.has(name) === true`.
 *
 * Absent-not-wrong: where codegen KNOWS the binding, the static diagnostic is
 * provably false, so decline and let the ordinary update arm run. Where codegen
 * does NOT know it, nothing changes — a genuinely undeclared name in an eval body
 * still gets the §13.4.4 throw, which is the whole point of this module.
 *
 * For ordinary (in-program) source this predicate is unreachable in the affirmative:
 * an identifier with a live local/global always HAS a checker symbol, so the
 * conjunction "no symbol AND codegen has a binding" is the foreign-AST case.
 */
function codegenHasBindingFor(ctx: CodegenContext, fctx: FunctionContext, name: string): boolean {
  if (fctx.localMap.has(name)) return true;
  if (fctx.boxedCaptures?.has(name)) return true;
  if (ctx.moduleGlobals.has(name)) return true;
  if (ctx.capturedGlobals.has(name)) return true;
  return getCapturedBoxGlobal(ctx, name) !== undefined;
}

/**
 * Emit the ReferenceError when `operand` is an unresolvable bare identifier,
 * and report whether it did. `operand` must already be paren-unwrapped.
 */
export function tryEmitUnresolvableUpdateThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
): ValType | undefined {
  if (!ts.isIdentifier(operand)) return undefined;
  if (resolveWithBinding(fctx, operand.text) !== null) return undefined;
  // (#4640 D3) A SLOPPY IMPLICIT GLOBAL is unresolvable to the checker and
  // perfectly resolvable at run time: some `<name> = v` in this module creates
  // the property on the realm global object, and every other spelling of the
  // read (`x`, `x + 1`, `x += 1`) resolves it from there. Throwing statically
  // here made `x = 1; x++` a ReferenceError for a name that existed — and since
  // sloppy loop counters are written exactly that way, it took out whole nested
  // loops (`statements/for/S12.6.3_A10_T1`, `A10.1_T1`).
  //
  // Declining is not a loss of the diagnostic: the caller's own implicit-global
  // arm (`tryEmitImplicitGlobalIncDec`, #3966) reads through
  // `emitImplicitGlobalRead`, which throws the SAME ReferenceError at run time
  // when the property genuinely is not there yet — which is the spec answer, and
  // strictly more accurate than a static one. Same shape as the `with` decline
  // directly above: the environment record decides, not the checker.
  if (isSloppyImplicitGlobalBinding(ctx, fctx, operand.text)) return undefined;
  if (!ctx.oracle.isUnresolvableIdentifier(operand)) return undefined;
  // (#4662) LAST, deliberately: the checker has just said "no symbol", and this
  // asks whether that is knowledge or absence of it. See `codegenHasBindingFor`.
  // Ordering it here (rather than earlier, where the map lookups would also be
  // cheaper) keeps the predicate's meaning exact — it fires only on operands the
  // helper was about to throw for — which is what makes its blast radius
  // measurable rather than argued.
  if (codegenHasBindingFor(ctx, fctx, operand.text)) return undefined;
  emitStaticTdzThrow(ctx, fctx, operand.text);
  return { kind: "f64" };
}
