// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Operations on a **sloppy implicit global** — a name whose only binding is a
 * property the program created on the realm global object (`this.p = 0` at
 * script top level, or a bare `p = 0` on an otherwise-undeclared name).
 *
 * Two consumers share the same binding predicate:
 *
 *  - (#4640) `x += rhs` and the other compound assignments.
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
import { ts } from "../../ts-api.js";
import { ensureAnyFromExternHelper, ensureAnyHelpers, ensureAnyToExternHelper } from "../any-helpers.js";
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
 * (#4640 D3) `name += rhs` / `name -= rhs` / … on an implicit global.
 *
 * The `++`/`--` twin above has existed since #3966; the COMPOUND-assignment
 * spelling had no arm at all, and `compileCompoundAssignment` reached its
 * genuinely-undeclared branch and threw `ReferenceError: <name> is not defined`
 * — for a name the module had just assigned, whose plain read in the very next
 * statement answered correctly. Measured on the base branch:
 *
 * ```js
 * x = 1;  x;      // 1            ✓
 * x = 1;  x += 1; // ReferenceError: x is not defined   ✗
 * ```
 *
 * That is the whole of `language/statements/for/S12.6.3_A10_T1` and `A10.1_T1`:
 * their nested loop heads are all `for (indexN = 0; …; indexN++)` over implicit
 * globals with an `__str += …` accumulator, and it is why the failure reads as
 * "the DEEPEST loop variable is undefined" — the deepest body is simply the
 * first place a compound assignment executes.
 *
 * ## `+=` is not "ToNumber then f64.add"
 *
 * §13.15.2 routes `+=` through §13.10.1 ApplyStringOrNumericBinaryOperator, so
 * `__str += "a"` must CONCATENATE. The `++` helper's ToNumber shape is correct
 * for `++` and wrong here, so `+=` goes through `__any_add` — the same runtime
 * addition the ordinary dynamic `+` uses, which owns the ToPrimitive /
 * string-vs-number decision. Every other compound operator does ToNumber both
 * operands by definition, so those reuse `emitCompoundOp` on f64.
 *
 * Returns `undefined` (nothing emitted) when a dependency is unavailable or the
 * operator is a short-circuit assignment (`&&=` / `||=` / `??=`, whose RHS must
 * not be evaluated unconditionally); the caller keeps its existing path.
 */
export function tryEmitImplicitGlobalCompoundAssign(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  op: ts.SyntaxKind,
  right: ts.Expression,
  compileRight: (e: ts.Expression, hint?: ValType) => ValType | null,
  emitOp: (ctx: CodegenContext, fctx: FunctionContext, op: ts.SyntaxKind) => void,
): ValType | undefined {
  if (
    op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    op === ts.SyntaxKind.BarBarEqualsToken ||
    op === ts.SyntaxKind.QuestionQuestionEqualsToken
  ) {
    return undefined;
  }
  const isPlus = op === ts.SyntaxKind.PlusEqualsToken;

  // Resolve every helper BEFORE emitting: a decline must leave the body
  // untouched, and a late import registered mid-sequence is the #1839 shift.
  let fromExtern: number | undefined;
  let toExtern: number | undefined;
  let anyAdd: number | undefined;
  if (isPlus) {
    ensureAnyHelpers(ctx);
    fromExtern = ensureAnyFromExternHelper(ctx, { forceHonest: true });
    toExtern = ensureAnyToExternHelper(ctx);
    anyAdd = ctx.funcMap.get("__any_add");
    if (fromExtern === undefined || toExtern === undefined || anyAdd === undefined) return undefined;
  }

  // GetValue(lref) FIRST (§13.15.2 step 1.c) — this is also the arm that throws
  // the genuine ReferenceError when the property really is absent.
  if (!emitImplicitGlobalRead(ctx, fctx, name)) return undefined;
  const oldLocal = allocLocal(fctx, `__implicit_global_cold_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: oldLocal });

  const newLocal = allocLocal(fctx, `__implicit_global_cnew_${fctx.locals.length}`, { kind: "externref" });
  if (isPlus) {
    fctx.body.push({ op: "local.get", index: oldLocal });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__any_from_extern_honest") ?? fromExtern! });
    const rhsType = compileRight(right, { kind: "externref" });
    if (rhsType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (rhsType.kind !== "externref") coerceType(ctx, fctx, rhsType, { kind: "externref" });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__any_from_extern_honest") ?? fromExtern! });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__any_add") ?? anyAdd! });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__any_to_extern") ?? toExtern! });
  } else {
    fctx.body.push({ op: "local.get", index: oldLocal });
    emitToNumber(ctx, fctx, { kind: "externref" });
    const rhsType = compileRight(right, { kind: "f64" });
    if (rhsType === null) fctx.body.push({ op: "f64.const", value: Number.NaN });
    else if (rhsType.kind !== "f64") coerceType(ctx, fctx, rhsType, { kind: "f64" });
    emitOp(ctx, fctx, op);
    coerceType(ctx, fctx, { kind: "f64" }, { kind: "externref" });
  }
  fctx.body.push({ op: "local.set", index: newLocal });

  if (!emitGlobalEnvironmentObject(ctx, fctx)) return undefined;
  const setIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_set");
  if (setIdx === undefined) {
    fctx.body.push({ op: "drop" });
    return undefined;
  }
  emitGlobalEnvironmentKey(ctx, fctx, name);
  fctx.body.push({ op: "local.get", index: newLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_set") ?? setIdx });
  // §13.15.2 step 5: the compound assignment evaluates to the NEW value.
  fctx.body.push({ op: "local.get", index: newLocal });
  return { kind: "externref" };
}
