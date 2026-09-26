// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { runtimeEvalStateMayShadowBinding } from "./direct-eval-environment.js";
import { emitThrowReferenceError } from "./js-errors.js";

/**
 * Timer globals on a host-free (`--target standalone`) module.
 *
 * `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` are host
 * (HTML / Node) APIs, not ECMAScript globals. They need an event loop that
 * runs callbacks after the current job and a clock to order them; a pure
 * standalone module has neither — nothing re-enters it once an export returns,
 * and it may not import a host timer (the no-host contract, #2961). WASI is
 * different: it lowers these calls onto its poll_oneoff reactor (#2632).
 *
 * So the standalone environment models an engine without the globals, the way
 * #6659 treats `crypto` and #6664 the DOM-only globals: `typeof setTimeout` is
 * "undefined" and a reference throws `ReferenceError: setTimeout is not
 * defined`. Previously the lib.dom declaration materialized an `env.setTimeout`
 * import, so a module that merely CONTAINED a timer call (lodash's
 * `debounce` / `throttle` / `delay`) could not be instantiated host-free.
 */
const STANDALONE_UNAVAILABLE_TIMER_GLOBALS = new Set(["setTimeout", "setInterval", "clearTimeout", "clearInterval"]);

export function isStandaloneUnavailableTimerGlobal(ctx: CodegenContext, name: string): boolean {
  return ctx.targetProfile.environment === "none" && STANDALONE_UNAVAILABLE_TIMER_GLOBALS.has(name);
}

/**
 * Is `ident` the AMBIENT timer global (declared only by lib .d.ts files) on a
 * standalone module? A user binding of the same name — a function, a `var`,
 * an import — has a declaration in a real source file and keeps its normal
 * lowering; a sloppy implicit global or a runtime-eval binding may create it.
 */
function isStandaloneUnavailableTimerReference(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ident: ts.Identifier,
): boolean {
  if (!isStandaloneUnavailableTimerGlobal(ctx, ident.text)) return false;
  if (runtimeEvalStateMayShadowBinding(ctx, fctx, ident.text)) return false;
  // `setTimeout = shim` in sloppy code creates the global the program then calls.
  if (ctx.sloppyImplicitGlobals?.has(ident.text) === true) return false;
  const decls = ctx.oracle.declarationsOf(ident);
  return decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * `setTimeout(cb, ms)` on a standalone module: the callee reference is
 * unresolvable, so §13.3.6.1 step 1 throws ReferenceError before any argument
 * is evaluated. Returns `undefined` for every other call.
 */
export function tryStandaloneUnavailableTimerCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  if (!ts.isIdentifier(expr.expression)) return undefined;
  if (!isStandaloneUnavailableTimerReference(ctx, fctx, expr.expression)) return undefined;
  emitThrowReferenceError(ctx, fctx, `${expr.expression.text} is not defined`);
  fctx.body.push({ op: "unreachable" });
  return { kind: "externref" };
}
