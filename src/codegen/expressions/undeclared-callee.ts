// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * §6.2.5.5 GetValue on an unresolvable Reference, at a CALL site.
 *
 * Calling a truly undeclared identifier — `$DETACHBUFFER(ab)` in a test262 file
 * that declares no `includes:` (harness/detachArrayBuffer.js) — must throw
 * ReferenceError, and the arguments must NOT be evaluated: the callee reference
 * is resolved first (§13.3.6.1 step 1). Without this the call fell to
 * `compileIdentifierCall`'s graceful last-resort arm, which compiles the
 * arguments for side effects and answers `ref.null.extern`, so the call
 * silently evaluated to `undefined` and nothing threw.
 *
 * The identifier READ path has thrown here since #1380; this is the same rule
 * at the call site. Both lanes are handled in one place because they differ
 * only in HOW undeclared-ness is proven:
 *
 * | lane            | predicate                             | why                                                       |
 * | --------------- | ------------------------------------- | --------------------------------------------------------- |
 * | standalone/wasi | no value declaration                  | pre-existing (#4640 D1 lineage); proven by that lane's corpus |
 * | JS host (#4650) | no checker symbol AT ALL (narrower)   | see below                                                  |
 *
 * The host arm is deliberately the narrower of the two. `declaration ===
 * undefined` alone is too weak in this lane: an ambient lib binding has a
 * symbol but no value declaration, and the host lane's late-bound shapes
 * (inline closure-struct candidates, the `__call_dyn_*` reference-preserving
 * bridge, implicit realm globals) legitimately call names that resolve only at
 * runtime. Every one of those has its own arm ABOVE this point in
 * `compileIdentifierCall` and returns there, so reaching here with no symbol at
 * all means the name resolves nowhere in the program.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitAnnexBUnboundReferenceError, emitThrowReferenceError } from "../js-errors.js";
import { noJsHost } from "./helpers.js";

export interface UndeclaredCalleeFacts {
  /** Callee has no value declaration (`ctx.oracle.valueDeclarationOf`). */
  declarationIsUndefined: boolean;
  /** Standalone runtime-eval may define this global later — never throw. */
  isRuntimeEvalGlobal: boolean;
  /** The name is a realm-global property the program itself created (#3966). */
  implicitCallee: boolean;
}

/**
 * Emit the ReferenceError throw for a call on an unresolvable identifier, or
 * return `undefined` to let the caller continue its dispatch chain.
 */
export function tryEmitUndeclaredCalleeReferenceError(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  funcName: string,
  facts: UndeclaredCalleeFacts,
): ValType | undefined {
  if (facts.implicitCallee || !facts.declarationIsUndefined) return undefined;

  if ((ctx.standalone || ctx.wasi) && noJsHost(ctx)) {
    if (facts.isRuntimeEvalGlobal) return undefined;
    emitThrowReferenceError(ctx, fctx, `${funcName} is not defined`);
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  // (#4650) JS-host lane.
  if (ctx.standalone || ctx.wasi || noJsHost(ctx)) return undefined;
  if (!ts.isIdentifier(expr.expression) || !ctx.oracle.isUnresolvableIdentifier(expr.expression)) return undefined;
  return emitAnnexBUnboundReferenceError(ctx, fctx, funcName);
}
