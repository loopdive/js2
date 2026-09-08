// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5338) Call-site arity for TAGGED TEMPLATE calls.
 *
 * `tag\`a${x}b${y}c\`` is a call — `tag(strings, x, y)` — so a tag whose body
 * reads `arguments` must see the substitutions there, exactly as an ordinary
 * over-application does. Every arm of `compileTaggedTemplateExpression`
 * instead marshalled at most `declaredParams - 1` substitutions into positional
 * slots and DROPPED the rest without even evaluating them, so
 *
 *     function tag(strings) { return Array.prototype.slice.call(arguments, 1) }
 *     tag\`a${1}b\`   // → [] instead of [1]
 *
 * answered an empty list. That is the exact shape of the vitest/jest
 * `test.each\`table\`` helper the dogfood suites use
 * (`__upstreamEach(cases) { const values = […].slice.call(arguments, 1) }`),
 * which then fell back to "treat the template STRINGS array as the case list"
 * and registered one bogus test per template chunk with a string where the row
 * object belonged — hono's `src/utils/ipaddr.test.ts` `Cannot read properties
 * of null (reading 'split')` cluster.
 *
 * The mechanism is the established `__argc` / `__extras_argv` protocol
 * (#1053/#2202) that `call-identifier.ts` already uses for a direct
 * over-application: the caller stores the surplus arguments in a module global
 * and publishes how many landed in the FORMAL region; the callee prologue
 * concatenates the two and clears both. The only tagged-template-specific part
 * is the argument numbering — the strings object is user argument 0, so
 * substitution `i` is user argument `i + 1`.
 *
 * Both globals are reset after the call (the #2704 sentinel discipline). A
 * tagged template's callee is frequently DYNAMIC (`` obj.tag`…` `` resolves the
 * callee at runtime), so we cannot always prove the callee reads `arguments`
 * and must publish conservatively; resetting afterwards keeps a callee that
 * ignored the extras from leaking them into an unrelated later call.
 */
import type { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureArgcGlobal, ensureExtrasArgvGlobal, emitSetExtrasArgv } from "./statements/nested-declarations.js";

/**
 * Publish `substitutions[positionalCount..]` as the call's surplus arguments.
 *
 * `userParamCount` is the callee's user-visible parameter count (the strings
 * object occupies slot 0); `positionalCount` is how many substitutions the
 * caller already pushed into declared slots. Returns true when anything was
 * published — the caller must then emit `resetTaggedTemplateArguments` after
 * the call.
 *
 * A zero-parameter tag would need the STRINGS object itself in the extras vec;
 * that shape keeps its previous behaviour (`arguments` stays empty) rather than
 * growing a second extras builder here.
 */
export function publishTaggedTemplateArguments(
  ctx: CodegenContext,
  fctx: FunctionContext,
  substitutions: readonly ts.Expression[],
  userParamCount: number,
  positionalCount: number,
): boolean {
  if (userParamCount < 1) return false;
  if (positionalCount >= substitutions.length) return false;

  // Stack-neutral: every operand already pushed for this call stays put.
  emitSetExtrasArgv(ctx, fctx, substitutions as ts.Expression[], positionalCount);
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  fctx.body.push({ op: "i32.const", value: 1 + positionalCount });
  fctx.body.push({ op: "global.set", index: argcGlobalIdx });
  return true;
}

/**
 * Restore the arity globals to their sentinels after a tagged-template call.
 * Stack-neutral, so it is safe to emit with the call's result on the stack.
 */
export function resetTaggedTemplateArguments(ctx: CodegenContext, fctx: FunctionContext): void {
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  fctx.body.push({ op: "i32.const", value: -1 });
  fctx.body.push({ op: "global.set", index: argcGlobalIdx });
  const { globalIdx, vecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  fctx.body.push({ op: "ref.null", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "global.set", index: globalIdx });
}
