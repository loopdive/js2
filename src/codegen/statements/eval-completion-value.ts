// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * §13/§14 **completion value** (the spec's `V` register) for a direct `eval`
 * whose body the inline path splices in.
 *
 * ## What was wrong
 *
 * `eval` returns the Script's completion value, and §13 propagates that value
 * out of nested statements. The inline path took a much cruder rule — "if the
 * LAST top-level statement is an ExpressionStatement, its value; otherwise
 * `undefined`" — which is right only when nothing nests. Measured, one module:
 *
 * ```js
 * eval("1+1")                     // 2         ✓
 * eval("var w; w = 7")            // 7         ✓
 * eval("if (true) 3;")            // undefined ✗ spec 3
 * eval("{ 4; }")                  // undefined ✗ spec 4
 * eval("do 9; while(false)")      // undefined ✗ spec 9
 * eval("while(false) 1;")         // undefined ✓ (body never runs)
 * ```
 *
 * ## The mechanism
 *
 * `V` is a real runtime register, not a syntactic "find the last expression":
 * §13's rule is that EVERY ExpressionStatement that *executes* updates it, and
 * `break` / `continue` / a loop's own scaffolding do not. So the ES5 sputnik
 * rows turn on execution order across iterations —
 * `eval("do { c++; if (…) continue; odds++; } while (c < 10)")` is `4`, the last
 * `odds++` to run, reached through a `continue` on every other iteration.
 *
 * A local threaded on the FunctionContext gives exactly that for free: it
 * persists across iterations, survives `continue`, and needs no rewrite of any
 * loop, block or `if` lowering — each of those keeps compiling its children
 * through the ordinary path, and the children happen to store instead of drop.
 *
 * Scope: set only while the inline-eval path compiles the last statement. A
 * nested FUNCTION body must not update `V`, and cannot here — the inline path
 * refuses any body containing a function declaration or expression
 * (`allNodesInlineSupported`), so it falls to dynamic eval before reaching this.
 */
import type { CodegenContext, FunctionContext } from "../context/types.js";
import type { ValType } from "../../ir/types.js";
import { coerceType } from "../shared.js";
import { allocLocal } from "../context/locals.js";
import { emitUndefined } from "../expressions/late-imports.js";

/**
 * Sink an ExpressionStatement's already-compiled value: into the eval
 * completion register when one is active, otherwise the ordinary `drop`.
 *
 * `resultType === null` means the expression compiled to an abrupt completion
 * (a throw) and left nothing on the stack — no sink either way.
 */
export function sinkExpressionStatementValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  resultType: ValType | null,
): void {
  if (resultType === null) return;
  const target = fctx.evalCompletionLocal;
  if (target === undefined) {
    fctx.body.push({ op: "drop" });
    return;
  }
  if (resultType.kind !== "externref") coerceType(ctx, fctx, resultType, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: target });
}

/**
 * Run `compileTail` with a fresh completion register installed, then leave that
 * register's value on the stack as the eval result.
 *
 * The register is seeded with `undefined` so a body that executes no
 * ExpressionStatement answers `undefined` — which is the right result for
 * `while (false) 1;` and for a declaration-only tail. Restoring the previous
 * register in a `finally` keeps a nested inline eval from stealing the outer
 * one's slot.
 */
export function emitEvalCompletionTail(ctx: CodegenContext, fctx: FunctionContext, compileTail: () => void): ValType {
  const completionLocal = allocLocal(fctx, `__eval_v_${fctx.locals.length}`, { kind: "externref" });
  emitUndefined(ctx, fctx);
  fctx.body.push({ op: "local.set", index: completionLocal });
  const saved = fctx.evalCompletionLocal;
  fctx.evalCompletionLocal = completionLocal;
  try {
    compileTail();
  } finally {
    fctx.evalCompletionLocal = saved;
  }
  fctx.body.push({ op: "local.get", index: completionLocal });
  return { kind: "externref" };
}
