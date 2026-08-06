// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ValType } from "../ir/types.js";
/**
 * (#2663 Slice 3) Read-modify-write of a bare identifier through a `with` scope:
 * compound assignment (`x += v`, `x *= v`, `x >>>= v`, …) and the update
 * expressions (`++x`, `x--`, …).
 *
 * WHY THIS IS ITS OWN STEP (and not just "read then write").
 * ---------------------------------------------------------
 * §13.15.2 (CompoundAssignment) and §13.4 (Update) both evaluate the LHS to a
 * *Reference* ONCE, then perform GetValue and PutValue **on that same
 * Reference**. For an Object Environment Record the Reference's base is decided
 * by HasBinding (§9.1.1.2.1), so the decision must be captured before the read
 * and reused for the write. The entire `S11.13.2_A5.*` /
 * `S11.4.4_A5_*` / `S11.4.5_A5_*` / `S11.3.1_A5_*` / `S11.3.2_A5_*` test262
 * family is built to catch exactly this: the with-object exposes
 *
 *     get x() { delete this.x; return 2; }
 *
 * so the property is GONE by the time the write happens. Re-deciding HasBinding
 * at the write would send it to the surrounding (global / function / outer
 * object) environment record — which those tests assert must stay untouched.
 *
 * Before this slice, neither `compileCompoundAssignment` nor the update-
 * expression paths consulted `withScopes` at all: `with (scope) { x /= 3 }`
 * read and wrote the OUTER `x`, leaving both bindings wrong.
 *
 * The value domain here is `externref` end to end (the with-object's property
 * is an arbitrary JS value), mirroring `compilePropertyCompoundAssignmentExternref`:
 * `__unbox_number` → f64 op → `__box_number`, with `+=` routed through the
 * §13.15.3 string-or-numeric `+` dispatch instead.
 */
import { ts } from "../ts-api.js";
import { emitAnyAddFromExternTemps } from "./binary-ops.js";
import { reportError } from "./context/errors.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitDynamicWithIdentifierWrite } from "./expressions/assignment.js";
import { emitCompoundOp } from "./expressions/operator-assignment.js";
import { addUnionImports } from "./index.js";
import { coerceType, compileExpression } from "./shared.js";
import { captureDynamicWithHasBindings, emitDynamicWithCascadeRead, resolveWithBinding } from "./with-scope.js";

/** Park the externref value on the stack into a fresh local and return its index. */
function parkExternref(fctx: FunctionContext, tag: string): number {
  const idx = allocLocal(fctx, `__with_${tag}_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: idx });
  return idx;
}

/**
 * Emit `externref -> f64` via `__unbox_number`. Returns false when the helper is
 * unavailable (the caller then bails to the pre-existing lowering).
 */
function emitUnboxToF64(ctx: CodegenContext, fctx: FunctionContext): boolean {
  addUnionImports(ctx);
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (unboxIdx === undefined) return false;
  fctx.body.push({ op: "call", funcIdx: unboxIdx });
  return true;
}

/** Emit `f64 -> externref` via `__box_number`. */
function emitBoxFromF64(ctx: CodegenContext, fctx: FunctionContext): boolean {
  const boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) return false;
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  return true;
}

/**
 * Compound assignment (`x <op>= rhs`) where `x` resolves to a `with` scope.
 *
 * Returns `null` on a hard error and `undefined` when this path declines the
 * shape (the caller then falls back to its pre-existing lowering, so declining
 * is never worse than main).
 */
export function compileWithCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null | undefined {
  if (!resolveWithBinding(fctx, id.text)) return undefined;

  // (1) Resolve the Reference: capture HasBinding for every dynamic scope on the
  //     cascade, BEFORE any of the read / RHS side effects run.
  const captures = captureDynamicWithHasBindings(ctx, fctx, id.text);

  // (2) GetValue through that same Reference.
  emitDynamicWithCascadeRead(ctx, fctx, id, captures);
  const lhsTmp = parkExternref(fctx, "rmw_l");

  // (3) Evaluate the RHS and apply the operator.
  if (op === ts.SyntaxKind.PlusEqualsToken) {
    // §13.15.3: `+` is string-or-numeric, not numeric-only.
    const rhsType = compileExpression(ctx, fctx, rhs, { kind: "externref" });
    if (!rhsType) return null;
    if (rhsType.kind !== "externref") coerceType(ctx, fctx, rhsType, { kind: "externref" });
    const rhsTmp = parkExternref(fctx, "rmw_r");
    const addType = emitAnyAddFromExternTemps(ctx, fctx, lhsTmp, rhsTmp);
    if (addType.kind !== "externref") coerceType(ctx, fctx, addType, { kind: "externref" });
  } else {
    fctx.body.push({ op: "local.get", index: lhsTmp });
    if (!emitUnboxToF64(ctx, fctx)) {
      reportError(ctx, id, "#2663: missing __unbox_number for a compound assignment through `with`");
      return null;
    }
    const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
    if (!rhsType) return null;
    if (rhsType.kind !== "f64") coerceType(ctx, fctx, rhsType, { kind: "f64" });
    emitCompoundOp(ctx, fctx, op);
    if (!emitBoxFromF64(ctx, fctx)) {
      reportError(ctx, id, "#2663: missing __box_number for a compound assignment through `with`");
      return null;
    }
  }
  const resultTmp = parkExternref(fctx, "rmw_res");

  // (4) PutValue through the SAME Reference (the captured HasBinding decisions).
  emitDynamicWithIdentifierWrite(ctx, fctx, id, resultTmp, captures);
  fctx.body.push({ op: "local.get", index: resultTmp });
  return { kind: "externref" };
}

/**
 * Update expression (`++x` / `--x` / `x++` / `x--`) where `x` resolves to a
 * `with` scope. §13.4: `oldValue = ToNumeric(GetValue(ref))`, `newValue =
 * oldValue ± 1`, `PutValue(ref, newValue)`; a PREFIX form evaluates to
 * `newValue`, a POSTFIX form to `oldValue`.
 *
 * Returns `undefined` when the name is not with-bound (caller keeps its own
 * lowering).
 */
export function compileWithUpdateExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  increment: boolean,
  prefix: boolean,
): ValType | null | undefined {
  if (!resolveWithBinding(fctx, id.text)) return undefined;

  const captures = captureDynamicWithHasBindings(ctx, fctx, id.text);

  emitDynamicWithCascadeRead(ctx, fctx, id, captures);
  if (!emitUnboxToF64(ctx, fctx)) {
    reportError(ctx, id, "#2663: missing __unbox_number for an update expression through `with`");
    return null;
  }
  // oldValue (ToNumeric'd) — the postfix result.
  const oldTmp = allocLocal(fctx, `__with_upd_old_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.tee", index: oldTmp });
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: increment ? "f64.add" : "f64.sub" });
  const newTmp = allocLocal(fctx, `__with_upd_new_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.tee", index: newTmp });
  if (!emitBoxFromF64(ctx, fctx)) {
    reportError(ctx, id, "#2663: missing __box_number for an update expression through `with`");
    return null;
  }
  const boxedTmp = parkExternref(fctx, "upd_boxed");

  emitDynamicWithIdentifierWrite(ctx, fctx, id, boxedTmp, captures);
  fctx.body.push({ op: "local.get", index: prefix ? newTmp : oldTmp });
  return { kind: "f64" };
}
