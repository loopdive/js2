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
import { resolveWithBinding } from "./with-scope.js";

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
  if (!ctx.oracle.isUnresolvableIdentifier(operand)) return undefined;
  emitStaticTdzThrow(ctx, fctx, operand.text);
  return { kind: "f64" };
}
