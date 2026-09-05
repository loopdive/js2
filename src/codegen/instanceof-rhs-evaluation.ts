// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 T3) §13.10.1 step 3 — the `instanceof` RHS must be EVALUATED and
 * GetValue'd, even when the answer is decided without it.
 *
 * ## The drop
 *
 * `compileHostInstanceOf`'s conservative arms — the ones reached when the RHS
 * names no constructor this backend models — compile the LHS, drop it, and push
 * `i32.const 0`. The RHS expression is never compiled at all. That is fine for
 * the shape those arms were written for (a bare identifier naming an unmodelled
 * builtin: reading it has no effect), and wrong for the one the spec cares
 * about:
 *
 * ```js
 * ({}) instanceof OBJECT   // OBJECT is undeclared
 * ```
 *
 * §13.10.1 evaluates RelationalExpression, GetValues it, then evaluates
 * ShiftExpression and **GetValues it** — and GetValue on an unresolvable
 * Reference is a ReferenceError (§6.2.5.5). Measured on this branch,
 * `--target standalone`, before the fix:
 *
 * | probe                                | answer                       |
 * | ------------------------------------ | ---------------------------- |
 * | `({}) instanceof UNDECLARED_XYZ`     | `false`, no throw  ← wrong   |
 * | `var v = UNDECLARED_ABC`             | ReferenceError     ✓         |
 * | `var w = UNDECLARED_DEF + 1`         | ReferenceError     ✓         |
 *
 * So the identifier lowering already throws correctly everywhere the operand is
 * actually compiled. Only `instanceof`'s RHS was never compiled, which is why
 * `language/expressions/instanceof/S11.8.6_A2.1_T3.js` reported
 * `Actual: [object Object]` — its own `Test262Error` for "did not throw",
 * caught by its own `catch` and failing the `e instanceof ReferenceError` test.
 *
 * ## Why this cannot change a decided answer
 *
 * The emitted sequence is `<rhs>; drop` inserted between the LHS's drop and the
 * constant. It contributes nothing to the stack and does not touch the result.
 * For every RHS whose evaluation is pure — the bare identifier these arms were
 * written for — the only difference is a value computed and discarded, which
 * the optimiser removes. For an RHS that throws or mutates, running it is the
 * spec's requirement, not a new behaviour.
 *
 * ## What it deliberately does NOT fix
 *
 * `x instanceof (y = 0, Object)` still answers `false`. The comma's leading
 * operands now RUN (in the right order — LHS first, per §13.10.1), but the
 * conservative arm still cannot resolve a constructor out of a comma
 * expression, so the answer stays the conservative `0`. Fixing that needs the
 * LHS spilled to a temp before the RHS is dispatched on the comma's LAST
 * operand — a different, larger change, priced in the issue file.
 */
import type { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression } from "./shared.js";

/**
 * Emit `<rhs>` for its evaluation + GetValue effects and discard the value.
 * Call it AFTER the LHS has been compiled and dropped, so the observable order
 * is the spec's.
 */
export function evaluateInstanceOfRhsForEffects(ctx: CodegenContext, fctx: FunctionContext, rhs: ts.Expression): void {
  const rt = compileExpression(ctx, fctx, rhs);
  if (rt) fctx.body.push({ op: "drop" });
}
