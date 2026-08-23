// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Operations on a **sloppy implicit global** — a name whose only binding is a
 * property the program created on the realm global object (`this.p = 0` at
 * script top level, or a bare `p = 0` on an otherwise-undeclared name).
 *
 * Two consumers, one predicate:
 *
 *  - (#3966) `x++` / `++x` / `x--` / `--x` — {@link tryEmitImplicitGlobalIncDec}.
 *  - (#3966/#4491) `f()` where `f` is such a name — the CALL path in
 *    `call-identifier.ts` treats the name as a known variable so the generic
 *    dynamic dispatch reads the callee off the global object instead of
 *    throwing ReferenceError / silently answering `undefined`.
 *
 * ## Why this file exists
 *
 * #3956 taught the identifier READ about those names (`emitImplicitGlobalRead`)
 * and #4500 Slice B taught the plain identifier WRITE (`p = v`) about them. The
 * UpdateExpression path was never taught either half, and its terminal fallback
 * for an unrecognised identifier is
 *
 *     fctx.body.push({ op: "f64.const", value: 0 });   // postfix
 *
 * — a silently DROPPED write that also answers `0`. So the whole
 * read-modify-write vanished:
 *
 *     this.position = 0;
 *     seat.move = function () { position++ };
 *     seat.move();
 *     position === 1        // observed 0
 *
 * (`language/types/object/S8.6.2_A5_T1/T2/T4`, and the same shape at script top
 * level.) The read half was already correct — the value `0` came back from the
 * global object — so the defect is exactly "the +1 never lands anywhere".
 *
 * ## What this emits
 *
 * The spec sequence for an implicit global is GetValue → ToNumeric → ±1 →
 * PutValue, where GetValue on an *unresolvable* Reference throws ReferenceError.
 * That first half is `emitImplicitGlobalRead`, which already performs the
 * `__hasOwnProperty` probe and the ReferenceError throw; reusing it rather than
 * re-deriving a read is deliberate — a second spelling of "read an implicit
 * global" is exactly how the read and the write drifted apart in the first
 * place (#3966's own diagnosis).
 *
 * The write half is the `__extern_set` carrier the plain-assignment arm in
 * `assignment.ts` uses, emitted in the same order (object → operation → key →
 * value → call) so both writes land in the storage the read consults and both
 * see the same late-import shift behaviour.
 *
 * ## What this deliberately does NOT do
 *
 * It does not create the binding. A name only reaches here when the pre-scan
 * (`recordSloppyImplicitGlobalNames` + `collectGlobalObjectPropertyNames`)
 * already classified it as a global-object property, and the property itself is
 * created at runtime by the assignment that the pre-scan saw. An update on a
 * genuinely never-assigned name keeps its existing ReferenceError.
 */
import type { ValType } from "../../ir/types.js";
import { emitToNumber } from "../coercion-engine.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  emitGlobalEnvironmentKey,
  emitGlobalEnvironmentObject,
  emitImplicitGlobalRead,
  ensureGlobalEnvironmentOperation,
} from "../global-environment.js";
import { coerceType } from "../shared.js";

/**
 * True when `name` has no declarative carrier and the pre-scan classified it as
 * a property of the realm global object.
 *
 * The caller is expected to have exhausted locals / boxed captures / module
 * globals / captured globals first; the redundant checks here make the
 * predicate safe to reuse from a site that has not.
 */
export function isSloppyImplicitGlobalBinding(ctx: CodegenContext, fctx: FunctionContext, name: string): boolean {
  if (ctx.sloppyImplicitGlobals?.has(name) !== true) return false;
  if (fctx.localMap.get(name) !== undefined) return false;
  if (ctx.moduleGlobals.get(name) !== undefined) return false;
  if (ctx.capturedGlobals.get(name) !== undefined) return false;
  return true;
}

/**
 * Emit the full read-modify-write for `name++` / `++name` on an implicit global.
 *
 * Returns the `f64` result type (old value for `postfix`, new value for
 * `prefix`), or `undefined` when the global-environment carrier is unavailable
 * — in which case NOTHING has been emitted yet and the caller keeps its
 * pre-existing fallback. (`emitImplicitGlobalRead` is the only step that can
 * emit before failing, and it fails only when the environment object itself is
 * unavailable, which is also the condition under which the write half would
 * decline.)
 */
export function tryEmitImplicitGlobalIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  arithOp: "f64.add" | "f64.sub",
  mode: "prefix" | "postfix",
): ValType | undefined {
  // GetValue + ToNumeric. `emitImplicitGlobalRead` throws ReferenceError when
  // the property is absent, which is the spec answer for an unresolvable
  // Reference and matches what a bare read of the same name already does.
  if (!emitImplicitGlobalRead(ctx, fctx, name)) return undefined;
  emitToNumber(ctx, fctx, { kind: "externref" });

  const oldLocal = allocLocal(fctx, `__implicit_global_old_${fctx.locals.length}`, { kind: "f64" });
  const newLocal = allocLocal(fctx, `__implicit_global_new_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: oldLocal });
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: arithOp });
  fctx.body.push({ op: "local.set", index: newLocal });

  if (!emitGlobalEnvironmentObject(ctx, fctx)) return undefined;
  const setIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_set");
  if (setIdx === undefined) {
    // Drop the receiver already on the stack so the body stays well-typed.
    fctx.body.push({ op: "drop" });
    return undefined;
  }
  emitGlobalEnvironmentKey(ctx, fctx, name);
  fctx.body.push({ op: "local.get", index: newLocal });
  coerceType(ctx, fctx, { kind: "f64" }, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: setIdx });
  fctx.body.push({ op: "local.get", index: mode === "postfix" ? oldLocal : newLocal });
  return { kind: "f64" };
}
