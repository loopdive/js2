// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Non-update prefix unary operator compilation: `+`, `-`, `!`, `~`.
 *
 * Prefix and postfix update expressions (`++` / `--`) — including all of
 * `compileMemberIncDec`, `compilePostfixUnary`, and the helpers for
 * property/element targets — live in ./unary-updates.ts. This file's
 * `compilePrefixUnary` delegates to `compilePrefixUpdate` for the
 * `PlusPlusToken` / `MinusMinusToken` cases.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import { emitToInt32 } from "../binary-ops.js";
import { reportError } from "../context/errors.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureAnyHelpers, ensureI32Condition, isAnyValue } from "../index.js";
import { coerceType, compileExpression } from "../shared.js";
import { emitThrowTypeError } from "./helpers.js";
import { tryStaticToNumber } from "./misc.js";
import { compileMemberIncDec, compilePostfixUnary, compilePrefixUpdate } from "./unary-updates.js";

/**
 * §7.1.4 ToNumber / §7.1.3 ToNumeric step 3 — a Symbol operand in any numeric
 * coercion context MUST throw a TypeError ("Cannot convert a Symbol value to a
 * number"). Symbols are lowered to i32 ids, so without this guard a numeric
 * unary/binary operator would silently turn the id into a number. Returns true
 * (and emits the operand-drop + throw) when the operand's TS type is Symbol.
 */
function emitSymbolToNumberThrow(ctx: CodegenContext, fctx: FunctionContext, operand: ts.Expression): boolean {
  // (#1930 Slice-1 pilot) The first oracle-migrated site: was
  // `isSymbolType(ctx.checker.getTypeAtLocation(operand))` — flag-identical
  // semantics through the boundary (ESSymbol|UniqueESSymbol → "symbol").
  if (ctx.oracle.staticJsTypeOf(operand) !== "symbol") return false;
  const t = compileExpression(ctx, fctx, operand);
  if (t !== null) fctx.body.push({ op: "drop" });
  emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
  return true;
}

function compilePrefixUnary(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PrefixUnaryExpression,
): ValType | null {
  switch (expr.operator) {
    case ts.SyntaxKind.PlusToken: {
      // Unary + is ToNumber coercion
      // ToNumber(Symbol) must throw TypeError (§7.1.4).
      if (emitSymbolToNumberThrow(ctx, fctx, expr.operand)) {
        return { kind: "f64" };
      }
      // Try static resolution first (handles objects with valueOf, {}, NaN, etc.)
      const staticVal = tryStaticToNumber(ctx, expr.operand);
      if (staticVal !== undefined) {
        fctx.body.push({ op: "f64.const", value: staticVal });
        return { kind: "f64" };
      }
      const operandType = compileExpression(ctx, fctx, expr.operand);
      if (operandType?.kind === "externref") {
        // ToNumber (ECMA-262 §7.1.4): route through `__unbox_number` (#1434).
        // This is the centralized ToNumber funnel — it implements
        // ToPrimitive → Number for objects (including WasmGC struct
        // valueOf/toString/@@toPrimitive via _toPrimitive #1319) and
        // delegates to `Number(v)` for primitives. Critically, `Number()`
        // throws TypeError on Symbol and BigInt operands per spec, and
        // since #1434 the runtime no longer swallows that exception.
        //
        // The previous fallback to `parseFloat` was incorrect:
        //   parseFloat("")  = NaN  (spec: Number("")  = 0)
        //   parseFloat(Symbol()) ≠ throw (spec: TypeError)
        // Use coerceType which auto-registers the import via
        // addUnionImports if it wasn't already loaded.
        coerceType(ctx, fctx, operandType, { kind: "f64" });
        return { kind: "f64" };
      }
      // Struct ref → f64: coerce via valueOf (JS ToNumber semantics)
      if (operandType && (operandType.kind === "ref" || operandType.kind === "ref_null")) {
        coerceType(ctx, fctx, operandType, { kind: "f64" });
        return { kind: "f64" };
      }
      // i32 (boolean) → f64 conversion for ToNumber
      if (operandType?.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
        return { kind: "f64" };
      }
      // Already numeric — no-op
      return operandType;
    }
    case ts.SyntaxKind.MinusToken: {
      // Unary - applies ToNumber (§7.1.4); Symbol operand must throw TypeError.
      if (emitSymbolToNumberThrow(ctx, fctx, expr.operand)) {
        return { kind: "f64" };
      }
      // Try static resolution first (handles strings, null, undefined, booleans, etc.)
      const staticVal = tryStaticToNumber(ctx, expr.operand);
      if (staticVal !== undefined) {
        fctx.body.push({ op: "f64.const", value: -staticVal });
        return { kind: "f64" };
      }
      const operandType = compileExpression(ctx, fctx, expr.operand);
      if (!operandType) return null;
      // any-typed negate: call __any_neg
      if (isAnyValue(operandType, ctx)) {
        ensureAnyHelpers(ctx);
        const negIdx = ctx.funcMap.get("__any_neg");
        if (negIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: negIdx });
          return { kind: "ref", typeIdx: ctx.anyValueTypeIdx };
        }
      }
      if (ctx.fast && operandType?.kind === "i32") {
        // i32 can't represent -0, so convert to f64 and use f64.neg.
        // This ensures -(0) correctly produces IEEE 754 negative zero.
        fctx.body.push({ op: "f64.convert_i32_s" });
        fctx.body.push({ op: "f64.neg" });
        return { kind: "f64" };
      }
      if (operandType?.kind === "i64") {
        // i64 negate: 0 - x
        const tmp = allocLocal(fctx, `__neg_${fctx.locals.length}`, {
          kind: "i64",
        });
        fctx.body.push({ op: "local.set", index: tmp });
        fctx.body.push({ op: "i64.const", value: 0n });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "i64.sub" });
        // (#3173) Preserve the bigint brand: `-1n` must stay a bigint carrier
        // so any-boxing picks `__box_bigint` (a stripped brand boxed −1n as a
        // NUMBER, so `dv.getBigInt64(0) === -1n` compared bigint-box vs
        // number-box and was always false).
        return operandType.bigint ? { kind: "i64", bigint: true } : { kind: "i64" };
      }
      // Non-f64 operand → coerce to f64 before negating
      if (operandType?.kind !== "f64") {
        coerceType(ctx, fctx, operandType!, { kind: "f64" });
      }
      fctx.body.push({ op: "f64.neg" });
      return { kind: "f64" };
    }
    case ts.SyntaxKind.ExclamationToken: {
      const operandType = compileExpression(ctx, fctx, expr.operand);
      ensureI32Condition(fctx, operandType, ctx);
      fctx.body.push({ op: "i32.eqz" });
      // (#3557) `!x` (and `!!x`) is ALWAYS a JS boolean — brand the i32 result so
      // downstream boxing at the host boundary reifies a JS `true`/`false`
      // (`__box_boolean`) rather than the number `1`/`0` (`__box_number`), and
      // `typeof (!x) === "boolean"` holds. This is the missing prefix-unary
      // member of the boolean-producing operator family that
      // `brandBooleanBinaryResult` already brands for `===`/`<`/`in`/… (#2712).
      // Lane-agnostic: `coerceType(i32→externref)` honours `boolean:true` in both
      // gc/host and standalone. Structurally inert — still matches every
      // `.kind === "i32"` check.
      return { kind: "i32", boolean: true };
    }
    case ts.SyntaxKind.TildeToken: {
      // Bitwise ~ applies ToNumber (§7.1.4) → ToInt32; Symbol must throw TypeError.
      if (emitSymbolToNumberThrow(ctx, fctx, expr.operand)) {
        return ctx.fast ? { kind: "i32" } : { kind: "f64" };
      }
      const operandType = compileExpression(ctx, fctx, expr.operand);
      if (operandType?.kind === "i64") {
        // ~bigint => bigint ^ -1n
        fctx.body.push({ op: "i64.const", value: -1n });
        fctx.body.push({ op: "i64.xor" });
        // (#3173) Preserve the bigint brand (see MinusToken above).
        return operandType.bigint ? { kind: "i64", bigint: true } : { kind: "i64" };
      }
      if (ctx.fast) {
        if (operandType?.kind !== "i32") coerceType(ctx, fctx, operandType!, { kind: "i32" });
        fctx.body.push({ op: "i32.const", value: -1 });
        fctx.body.push({ op: "i32.xor" });
        return { kind: "i32" };
      }
      // ~x => f64.convert_i32_s(i32.xor(ToInt32(x), -1))
      if (operandType?.kind !== "f64") coerceType(ctx, fctx, operandType!, { kind: "f64" });
      emitToInt32(fctx);
      fctx.body.push({ op: "i32.const", value: -1 });
      fctx.body.push({ op: "i32.xor" });
      fctx.body.push({ op: "f64.convert_i32_s" });
      return { kind: "f64" };
    }
    case ts.SyntaxKind.PlusPlusToken:
    case ts.SyntaxKind.MinusMinusToken:
      return compilePrefixUpdate(ctx, fctx, expr);
  }

  reportError(ctx, expr, `Unsupported prefix unary operator: ${ts.SyntaxKind[expr.operator]}`);
  return null;
}

export { compileMemberIncDec, compilePostfixUnary, compilePrefixUnary };
