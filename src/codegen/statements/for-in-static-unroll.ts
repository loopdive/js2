// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4561) The `for-in` STATIC-UNROLL fallback, and the break/continue targets it
 * was missing.
 *
 * When no enumeration primitive is available — the standalone/WASI lane with a
 * CLOSED-shape receiver, where the `__for_in_*` host imports are deliberately
 * absent (#2572) and a WasmGC struct does not lower to the dynamic `$Object` —
 * `for (k in o)` is unrolled: the static key set is exact for a shape that
 * cannot gain or lose keys, so the body is emitted once per property.
 *
 * ## The defect
 *
 * The unroll emitted those bodies as a bare STRAIGHT-LINE SEQUENCE — no
 * enclosing `block`, and no `breakStack`/`continueStack` entry — so the loop had
 * no break target at all:
 *
 *     var o = {a:1, b:2, c:3};
 *     var n = 0;
 *     for (var k in o) { n = n + 1; break; }
 *     n   // 3 — every iteration ran, and statements after the `break` too
 *
 * The three observed symptoms are all this one omission:
 *
 *   - an UNLABELED `break` takes `breakStack.length - 1`. With nothing pushed
 *     that is `-1` at top level, so `compileBreakStatement` reads `undefined`
 *     and returns silently — the no-op. Inside an enclosing loop it is worse
 *     than a no-op: it resolves to that OUTER loop's depth and breaks the wrong
 *     one.
 *   - a LABELED `break outer` fails identically but for a different reason:
 *     `compileLabeledStatement` records `breakIdx = breakStack.length` for a
 *     loop, i.e. the index the loop is ABOUT to push. Nothing is pushed, so the
 *     index is past the end and the lookup is `undefined`.
 *   - `continue` shares both, which is why it was a no-op too.
 *
 * `return` worked throughout, which is what made this look like a break-only
 * bug rather than a missing loop scaffold: an unrolled body is still inside the
 * enclosing function, so a `return` needs no loop target.
 *
 * ## The shape
 *
 *     block $break {
 *       block $continue { <key := "a">  <body> }
 *       block $continue { <key := "b">  <body> }
 *       …
 *     }
 *
 * `continue` is `br 0` — it exits that iteration's block and falls into the
 * NEXT one, which materialises its own key, so the enumeration still advances.
 * `break` is `br 1` — it exits `$break` past every remaining iteration. Two
 * nesting levels, hence the `shiftLoopDepths(2)`; the real-loop paths in
 * `loops.ts` use 3 because they also carry a `loop`.
 *
 * Both stack entries are pushed for the whole unroll (not per iteration), so
 * the label a `compileLabeledStatement` reserved resolves to exactly one entry,
 * the way it does for every other loop form.
 */
import { ts } from "../../ts-api.js";
import type { Instr } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { shiftLoopDepths } from "./shared.js";

/**
 * Emit the unrolled `for-in`. `emitCallTargetWrite` performs the web-compat
 * `for (f() in o)` assignment (passed in so this module does not depend on the
 * assignment-target emitter), and `compileBody` compiles the user statement.
 */
export function emitForInStaticUnroll(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForInStatement,
  keyLocal: number,
  emitCallTargetWrite: (() => void) | undefined,
  compileBody: () => void,
): void {
  // (#4138) Strip null/undefined before reading the static shape: a receiver
  // that flowed through `Array.pop()` / an optional access types as
  // `T | undefined`, and a UNION's getProperties() is the COMMON property
  // set — empty here — so the loop silently enumerated nothing (the runtime
  // null case is already handled by the guards the loop emits). This is the
  // narrow slice of #4138; a receiver that is genuinely POLYMORPHIC at
  // runtime still unrolls one static shape, and closed structs remain
  // non-enumerable through the dynamic runtime — both stay open in #4138.
  const exprType = ctx.checker.getTypeAtLocation(stmt.expression).getNonNullableType();
  const props = exprType.getProperties();
  if (props.length === 0) return;

  const savedBody = pushBody(fctx);
  shiftLoopDepths(fctx, 2);
  fctx.breakStack.push(1); // break = exit $break, past every remaining iteration
  fctx.continueStack.push(0); // continue = exit this iteration's block

  for (const prop of props) {
    const savedIteration = pushBody(fctx);
    // (#51) Materialize each enumerated key via the dual-mode helper. Under
    // nativeStrings `stringGlobalMap` holds a `-1` sentinel global, so the old
    // `global.get <sentinel>` reached binary emit as "global index out of
    // range — -1". `stringConstantExternrefInstrs` emits the NativeString
    // inline (externref) standalone and a host `global.get` only under GC.
    addStringConstantGlobal(ctx, prop.name);
    for (const instr of stringConstantExternrefInstrs(ctx, prop.name)) fctx.body.push(instr);
    fctx.body.push({ op: "local.set", index: keyLocal });
    emitCallTargetWrite?.();
    compileBody();
    const iterationBody = fctx.body;
    popBody(fctx, savedIteration);
    fctx.body.push({ op: "block", blockType: { kind: "empty" }, body: iterationBody });
  }

  fctx.breakStack.pop();
  fctx.continueStack.pop();
  shiftLoopDepths(fctx, -2);
  const unrolled: Instr[] = fctx.body;
  popBody(fctx, savedBody);
  fctx.body.push({ op: "block", blockType: { kind: "empty" }, body: unrolled });
}
