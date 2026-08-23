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
 * Scope: the inline-eval path's whole StatementList. A nested FUNCTION body
 * must not update `V`, and cannot here — the inline path refuses any body
 * containing a function declaration or expression (`allNodesInlineSupported`),
 * so it falls to dynamic eval before reaching this.
 *
 * ## (#4515 wave-5) The register spans the LIST, not just the tail
 *
 * §16.1.7 threads `V` across the StatementList with `UpdateEmpty(s, sl)`, so a
 * tail that produces NOTHING answers with the last statement that DID:
 *
 * ```js
 * eval("2;;")                  // 2 — tail is an EmptyStatement
 * eval("4; const test = 5;")   // 4 — tail is a LexicalDeclaration
 * ```
 *
 * Both answered `undefined` while the register covered only the tail
 * (`language/statements/{empty,const,let}/cptn-value.js`). The
 * ExpressionStatement-tail fast path in `eval-inline.ts` is unchanged and does
 * not need the register: such a tail always overwrites `V` last, and keeping it
 * preserves the abrupt `eval("throw 1")` result (`null` — nothing on the stack).
 */
import { ts } from "../../ts-api.js";
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
 * (#4515 wave-5) §13's OTHER half: the statement forms that RESET `V`.
 *
 * The register alone models "an ExpressionStatement that runs updates `V`".
 * That is only half the rule — five statement forms discard the inherited `V`
 * and answer `undefined` when their own body produced nothing:
 *
 * | form                              | spec text                              |
 * | --------------------------------- | -------------------------------------- |
 * | `if`                              | `Return ? UpdateEmpty(stmtCompletion, undefined)` (§14.6.2), and the else-less false branch returns `undefined` outright |
 * | `try`                             | `Return ? UpdateEmpty(result, undefined)` (§14.15.3) |
 * | `switch`                          | `Return ? UpdateEmpty(R, undefined)` (§14.12.4) |
 * | `with`                            | `Return ? UpdateEmpty(C, undefined)` (§14.11.2) |
 * | `while`/`do`/`for`/`for-in`/`for-of` | `Let V be undefined` at loop entry (§14.7.x) |
 *
 * A `Block` and a `LabelledStatement` do NOT reset — they thread the inherited
 * value (`UpdateEmpty(s, sl)`), which is why they are absent from the list.
 * Verified against the reference engine rather than read off the grammar:
 * `eval("1; lbl: {}")` is **1** while `eval("1; if(false);")` is `undefined`.
 *
 * The row this closes is the one that made the omission visible:
 *
 * ```js
 * eval("for(count=0;;) {if (count===supreme)break;else count++; }")
 * // spec undefined — the `break` arm is inside an `if`, so the iteration's
 * // completion is (break, undefined), not (break, empty), and the loop's
 * // UpdateEmpty has nothing to fill.  We answered 4, the last `count++`.
 * ```
 *
 * Emitting the reset at STATEMENT ENTRY is exactly `UpdateEmpty(…, undefined)`:
 * a branch that produces a value overwrites it, and a branch that produces
 * nothing (`break`, `continue`, an empty block, a declaration) leaves the
 * `undefined`. For a loop, entry is evaluated once, which is where `Let V be
 * undefined` sits.
 *
 * A `continue` INSIDE an `if` therefore carries `undefined` out of that
 * iteration — spec-correct, and it does not disturb the rows the register was
 * built for: `do { c++; if (c % 2) continue; o++; } while (c < 10)` still ends
 * on `o++`, so the answer stays `4` (reference-checked, both arms).
 *
 * No-op unless a register is live, so this costs nothing outside inline eval.
 */
export function resetCompletionValueForStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  const target = fctx.evalCompletionLocal;
  if (target === undefined) return;
  if (!statementResetsCompletionValue(stmt)) return;
  emitUndefined(ctx, fctx);
  fctx.body.push({ op: "local.set", index: target });
}

/** The §13 forms whose completion value starts life as `undefined`. */
function statementResetsCompletionValue(stmt: ts.Statement): boolean {
  return (
    ts.isIfStatement(stmt) ||
    ts.isTryStatement(stmt) ||
    ts.isSwitchStatement(stmt) ||
    ts.isWithStatement(stmt) ||
    ts.isWhileStatement(stmt) ||
    ts.isDoStatement(stmt) ||
    ts.isForStatement(stmt) ||
    ts.isForInStatement(stmt) ||
    ts.isForOfStatement(stmt)
  );
}

/**
 * (#4515 wave-5) §14.15.3 step 5 — a `finally` block that completes NORMALLY
 * contributes nothing: *"If F.[[type]] is normal, let F be C"*, where `C` is
 * the try/catch completion. So the finally's own value must be discarded:
 *
 * ```js
 * eval('4; try { }   catch (e) { } finally { 5; }')   // undefined, not 5
 * eval('6; try { 7; }                finally { 8; }') // 7,         not 8
 * ```
 *
 * Snapshot `V` before the block and write it back after — three rows
 * (`language/statements/try/cptn-finally-{wo-catch,skip-catch,from-catch}`).
 *
 * Placing the restore at the END of the protected instruction sequence is what
 * makes the ABRUPT arm right for free: a `break`/`continue`/`return` inside the
 * finally branches PAST the restore, so `V` keeps the finally's value — which
 * is step 7's *"If F.[[value]] is not empty, return Completion(F)"*.
 *
 * The pair is emitted into the pre-compiled finally instruction list that
 * `compileTryStatement` CLONES into each control-flow path, so every path saves
 * and restores through the same two locals. They are never live simultaneously:
 * the clones are alternative paths, and a nested try/finally allocates its own.
 */
export function beginFinallyCompletionSnapshot(fctx: FunctionContext): number | undefined {
  const target = fctx.evalCompletionLocal;
  if (target === undefined) return undefined;
  const slot = allocLocal(fctx, `__eval_v_fin_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.get", index: target }, { op: "local.set", index: slot });
  return slot;
}

/** Write the snapshot back — see {@link beginFinallyCompletionSnapshot}. */
export function endFinallyCompletionSnapshot(fctx: FunctionContext, slot: number | undefined): void {
  const target = fctx.evalCompletionLocal;
  if (target === undefined || slot === undefined) return;
  fctx.body.push({ op: "local.get", index: slot }, { op: "local.set", index: target });
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
