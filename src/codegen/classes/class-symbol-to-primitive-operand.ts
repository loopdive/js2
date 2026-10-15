// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6982) `[Symbol.toPrimitive]` on a CLASS-instance operand of the native
 * regime's object `+` (§13.15.3) and relational (§7.2.12) cascades.
 *
 * ## The defect
 *
 * ```ts
 * class N { constructor(public v: number) {} [Symbol.toPrimitive]() { return this.v; } }
 * new N(10) + new N(3);   // NaN — must be 13
 * new N(5) > new N(3);    // false — must be true
 * ```
 *
 * Both cascades (`emitObjectAdd`, `emitAnyRelational`) compile each operand
 * straight to externref and reduce it with the runtime `__to_primitive`. A
 * class instance is a nominal WasmGC struct, and its `[Symbol.toPrimitive]`
 * METHOD is a plain `${Class}_@@toPrimitive` function with no runtime
 * dispatch in the native regime (`__call_@@toPrimitive` is host-only, and
 * `__class_to_primitive` walks valueOf/toString only). So the reduction
 * returned the struct unchanged, and ToNumber of it was NaN. Unary `+` was
 * right all along because `coerceType(struct → f64)` calls the method while
 * the operand's typeIdx is still known; the JS-host lane takes that same
 * static path.
 *
 * ## The fix
 *
 * When an operand is statically such a class instance, compile it RAW (keeping
 * its typeIdx), and at its ToPrimitive point reduce it with
 * `coerceType(struct → externref, hint)` — the same engine unary `+`,
 * `String()` and template literals already use, which calls the method with
 * the right hint and boxes a numeric result (a string result stays a string,
 * so `+` still concatenates). The reduced value is a primitive, so the rest of
 * the cascade is unchanged. Every other operand keeps its existing lowering
 * byte for byte: the predicate emits nothing when it declines.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocTempLocal, releaseTempLocal } from "../context/locals.js";
import { resolveStructNameForExpr } from "../property-access.js";
import { compileExpression } from "../shared.js";
import { coerceType } from "../type-coercion.js";

/** A class-instance operand held raw until its ToPrimitive point. */
export interface RawToPrimitiveOperand {
  readonly local: number;
  readonly type: ValType;
}

function unwrapTypeOnly(expr: ts.Expression): ts.Expression {
  let inner = expr;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/**
 * If `expr` is statically an instance of a class with a `[Symbol.toPrimitive]`
 * method (native regime only), compile it raw into a fresh local and return
 * it. Otherwise emit NOTHING and return undefined — the caller's existing
 * lowering runs unchanged.
 */
export function tryCompileClassToPrimitiveOperand(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): RawToPrimitiveOperand | undefined {
  if (ctx.targetProfile.semanticProviders !== "native-first") return undefined;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return undefined;
  const inner = unwrapTypeOnly(expr);
  const name = resolveStructNameForExpr(ctx, fctx, inner);
  if (name === undefined || ctx.funcMap.get(`${name}_@@toPrimitive`) === undefined) return undefined;
  let type = compileExpression(ctx, fctx, inner);
  if (!type) return undefined;
  const isNamedStruct =
    (type.kind === "ref" || type.kind === "ref_null") && ctx.typeIdxToStructName.get(type.typeIdx) === name;
  if (!isNamedStruct && type.kind !== "externref") {
    coerceType(ctx, fctx, type, { kind: "externref" });
    type = { kind: "externref" };
  }
  const local = allocTempLocal(fctx, type);
  fctx.body.push({ op: "local.set", index: local });
  return { local, type };
}

/**
 * Reduce a raw operand with ToPrimitive(`hint`) into the externref `target`.
 * A struct operand calls its `[Symbol.toPrimitive]` method statically; one
 * that lost its static type falls back to the runtime `runtimeInstrs`.
 */
export function reduceClassToPrimitiveOperand(
  ctx: CodegenContext,
  fctx: FunctionContext,
  raw: RawToPrimitiveOperand,
  hint: "number" | "default",
  target: number,
  runtimeInstrs: readonly Instr[] | null,
): void {
  fctx.body.push({ op: "local.get", index: raw.local });
  if (raw.type.kind === "externref") {
    if (runtimeInstrs) fctx.body.push(...runtimeInstrs.map((i) => ({ ...i })));
  } else {
    coerceType(ctx, fctx, raw.type, { kind: "externref" }, hint);
  }
  fctx.body.push({ op: "local.set", index: target });
  releaseTempLocal(fctx, raw.local);
}

/**
 * Compile one operand of the relational cascade into a fresh externref temp —
 * the cascade's existing lowering — except that a class `[Symbol.toPrimitive]`
 * operand is held `raw` and its temp is filled at the ToPrimitive point.
 * Returns null when the operand failed to compile.
 */
export function compileToPrimitiveCascadeOperand(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): { tmp: number; raw?: RawToPrimitiveOperand } | null {
  const externref: ValType = { kind: "externref" };
  const raw = tryCompileClassToPrimitiveOperand(ctx, fctx, expr);
  if (raw) return { tmp: allocTempLocal(fctx, externref), raw };
  const type = compileExpression(ctx, fctx, expr, externref);
  if (!type) return null;
  if (type.kind !== "externref") coerceType(ctx, fctx, type, externref);
  const tmp = allocTempLocal(fctx, externref);
  fctx.body.push({ op: "local.set", index: tmp });
  return { tmp };
}
