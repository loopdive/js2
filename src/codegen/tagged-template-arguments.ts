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
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
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
 * A zero-parameter tag would need the STRINGS object itself in the extras vec,
 * which this function cannot supply (it sources only AST expressions). That
 * shape is handled by `publishZeroParamTagArguments` below (#6651).
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
 * (#6651) The ZERO-parameter tag, which the header above records as the one
 * shape left behind: `` (function () { … })`x` `` is still a call with ONE
 * argument — the template object — so §13.2.8 demands `arguments.length === 1`.
 *
 * A zero-formal callee receives its whole call-site list through
 * `__extras_argv` (`emitArgumentsVecTail`: `totalLen = argc + extrasLen`, and
 * with no formals `argc` is 0), so the fix is to put the template object into
 * that vector and pin `__argc` to 0 — the latter so the callee's "the caller
 * said nothing, assume my own formal count" default cannot re-enter.
 *
 * Stack-neutral like its sibling, so it is emitted after the arguments and
 * before the call; the caller must still emit `resetTaggedTemplateArguments`.
 *
 * SUBSTITUTIONS ARE REFUSED, not silently dropped. `` (function(){})`a${x}b` ``
 * owes `arguments` the substitutions too, but they arrive as AST expressions
 * that only `emitSetExtrasArgv` knows how to box — and it OWNS the extras
 * global, so the template object cannot be prepended to its vec without a
 * second builder. Refusing keeps that shape exactly as it is today (an empty
 * `arguments`, wrong in the same way it was before) rather than trading it for
 * a list that is wrong in a new way — a one-element list missing the values.
 */
function publishZeroParamTagArguments(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stringsLocal: number,
  substitutions: readonly ts.Expression[],
): boolean {
  if (substitutions.length > 0) return false;
  const { globalIdx, vecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return false;
  // The template object is argument 0; `emitSetExtrasArgv` can only source
  // AST expressions, and this one lives in a local, so build the vec here.
  fctx.body.push({ op: "local.get", index: stringsLocal });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: 1 });
  const dataLocal = allocLocal(fctx, `__tt_argv0_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.get", index: dataLocal });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "global.set", index: globalIdx });
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "global.set", index: argcGlobalIdx });
  return true;
}

/**
 * (#6651) The ONE entry point a tagged-template call arm needs: publish this
 * call's surplus arguments, whichever of the two shapes applies. A zero-formal
 * callee takes its whole list through the extras vec, so its template object
 * is argument 0 there; every other arity keeps the established #5338 split.
 *
 * Returns true when anything was published — the caller must then emit
 * `resetTaggedTemplateArguments` after the call, exactly as before.
 */
export function publishTagCallArguments(
  ctx: CodegenContext,
  fctx: FunctionContext,
  substitutions: readonly ts.Expression[],
  userParamCount: number,
  positionalCount: number,
  stringsLocal: number,
): boolean {
  return userParamCount === 0
    ? publishZeroParamTagArguments(ctx, fctx, stringsLocal, substitutions)
    : publishTaggedTemplateArguments(ctx, fctx, substitutions, userParamCount, positionalCount);
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
