// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Binary operations extracted from expressions.ts.
 * Handles binary expression compilation including numeric, i32, i64,
 * bitwise, modulo, boolean, and any-typed binary operations.
 */
import { ts } from "../ts-api.js";
import {
  getNullablePrimitiveInfo,
  isBigIntType,
  isBooleanType,
  isNumberType,
  isStringType,
  isWrapperObjectType,
} from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { isAnyValue, undefinedSingletonActive } from "./any-helpers.js";
import { reportError } from "./context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  compileAssignment,
  compileCompoundAssignment,
  compileLogicalAssignment,
  isCompoundAssignment,
} from "./expressions/assignment.js";
import {
  emitPrivateBrandPredicate,
  emitThrowTypeError,
  resolveDeclaringClassForPrivateName,
} from "./expressions/helpers.js";
import { ensureExternIsUndefinedImport, ensureLateImport } from "./expressions/late-imports.js";
import { ensureFmod } from "./fmod.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { emitNewTargetClassId, getOrAssignClassNewTargetId } from "./new-target.js"; // (#2023)
import { compileLogicalAnd, compileLogicalOr, compileNullishCoalescing } from "./expressions/logical-ops.js";
import { tryStaticToNumber } from "./expressions/misc.js";
import { emitNativeParseNumber } from "./parse-number-native.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringImports, addUnionImports, resolveNativeTypeAnnotation, resolveWasmType } from "./index.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, ensureAnyHelpers, flushLateImportShifts, VOID_RESULT } from "./shared.js";
import { isLogicalAssignNamedEvalNameRead, resolveStructNameForExpr } from "./property-access.js";
import { compileStringBinaryOp, emitHoistedCharCodeAtRead, matchHoistedCharRead } from "./string-ops.js";
import { emitAnyEqFromExternTemps, emitLooseEq, emitStrictEq } from "./coercion-engine.js";
import { compileInstanceOf, compileTypeofComparison } from "./typeof-delete.js";

// ── Binary operations ─────────────────────────────────────────────────

/**
 * (#2712 I1) Binary operators whose result is ALWAYS a JS boolean: relational
 * (`<` `>` `<=` `>=`), equality (`==` `===` `!=` `!==`), `in`, `instanceof`.
 * Their `compileBinaryExpression` result is a bare `{kind:"i32"}` today (only
 * literals #2795 + declared storage brand); branding it at the single dispatch
 * chokepoint (`brandBooleanBinaryResult`, called from expressions.ts) makes the
 * boolean brand TOTAL for computed predicates so downstream boxing (Set/Map
 * keys, property keys, Object.values) reifies a boolean, not the number 1/0.
 * Arithmetic/bitwise/logical (`&&`/`||` return the operand type) are deliberately
 * excluded — branding a number as boolean would be a bug.
 */
const BOOLEAN_PRODUCING_BINARY_OPS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.InstanceOfKeyword,
]);

/**
 * (#2712 I1) Brand a comparison/equality/relational/`in`/`instanceof` result as
 * a boolean. No-op for a non-boolean operator, a null/VOID result, or an already
 * -branded / non-i32 result. Idempotent + structurally inert (the brand still
 * matches every `.kind === "i32"` check). Called at the single dispatch site in
 * expressions.ts so all boolean-producing binary results are branded uniformly.
 */
export function brandBooleanBinaryResult(op: ts.SyntaxKind, result: InnerResult): InnerResult {
  if (
    result !== null &&
    result !== VOID_RESULT &&
    result.kind === "i32" &&
    result.boolean !== true &&
    BOOLEAN_PRODUCING_BINARY_OPS.has(op)
  ) {
    return { ...result, boolean: true };
  }
  return result;
}

/**
 * (#2741) `key in rval` throws a TypeError when `Type(rval)` is not Object
 * (§13.10.1 step 5). Returns true when the RHS static type is EXCLUSIVELY a
 * non-object primitive — every constituent is number / string / boolean /
 * bigint / symbol / null / undefined / void — so the runtime value can never be
 * an Object and the throw is statically certain. `any` / `unknown` / `never` /
 * object types and any union with a non-primitive constituent return false (they
 * defer to the runtime `[[HasProperty]]` / `__extern_has` check).
 */
function inRhsIsExclusivelyPrimitive(t: ts.Type): boolean {
  const PRIM =
    ts.TypeFlags.Number |
    ts.TypeFlags.NumberLiteral |
    ts.TypeFlags.String |
    ts.TypeFlags.StringLiteral |
    ts.TypeFlags.Boolean |
    ts.TypeFlags.BooleanLiteral |
    ts.TypeFlags.BigInt |
    ts.TypeFlags.BigIntLiteral |
    ts.TypeFlags.ESSymbol |
    ts.TypeFlags.UniqueESSymbol |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void;
  const parts = t.isUnion() ? t.types : [t];
  if (parts.length === 0) return false;
  for (const p of parts) {
    if ((p.flags & PRIM) === 0) return false;
  }
  return true;
}

/**
 * Binary operators whose evaluation applies ToNumeric / ToPrimitive→(number or
 * string) to their operands. A Symbol operand of any of these throws TypeError
 * per §7.1.3 (ToNumeric step 3) and §7.1.4 (ToNumber). `+` is included because
 * ToPrimitive on a Symbol returns the Symbol and both string/number branches
 * throw. Equality operators (`==`, `===`, `!=`, `!==`) are intentionally absent —
 * they compare Symbols by identity without coercion.
 */
const SYMBOL_TONUMERIC_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/**
 * Operators eligible for chain flattening — arithmetic and bitwise ops that
 * take two numeric operands and produce a numeric result of the same type.
 * We exclude ** (exponentiation) because it calls Math_pow and comparison
 * operators because they produce i32 (boolean), not f64.
 */
const FLATTENABLE_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

/**
 * Try to flatten a left-recursive chain of the same binary operator into an
 * iterative compilation. For expressions like `a + b + c + d` (AST:
 * `((a + b) + c) + d`), this avoids O(n) JS call-stack depth and improves
 * compilation speed for long chains.
 *
 * Returns null if flattening is not applicable (not the same operator
 * throughout, non-numeric operands, chain too short, etc.).
 */
function tryFlattenBinaryChain(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): InnerResult | null {
  // Only flatten operators that produce the same type as their inputs
  if (!FLATTENABLE_OPS.has(op)) return null;

  // Must have at least 3 operands (i.e., left is also a binary expr with same op)
  if (!ts.isBinaryExpression(expr.left) || expr.left.operatorToken.kind !== op) {
    return null;
  }

  // Collect all leaf operands by walking the left-recursive spine
  const operands: ts.Expression[] = [];
  let node: ts.Expression = expr;
  while (ts.isBinaryExpression(node) && node.operatorToken.kind === op) {
    operands.push(node.right);
    node = node.left;
  }
  operands.push(node); // leftmost operand
  operands.reverse(); // now in left-to-right order

  // Verify all operands are numeric (not string, not any, not bigint)
  // If plus and any operand is a string type, bail out — it's string concat
  for (const operand of operands) {
    const tsType = ctx.checker.getTypeAtLocation(operand);
    if (isStringType(tsType)) return null;
    if (isBigIntType(tsType)) return null;
    if ((tsType.flags & ts.TypeFlags.Any) !== 0) return null;
  }

  // Determine numeric hint — also check if all operands use native i32 type annotations
  const isDivOrPow = op === ts.SyntaxKind.SlashToken || op === ts.SyntaxKind.AsteriskAsteriskToken;
  let allNativeI32 = !isDivOrPow;
  if (allNativeI32 && !ctx.fast) {
    for (const operand of operands) {
      const tsType = ctx.checker.getTypeAtLocation(operand);
      const native = resolveNativeTypeAnnotation(tsType);
      if (native?.kind !== "i32") {
        allNativeI32 = false;
        break;
      }
    }
  }
  const numericHint: ValType = { kind: (ctx.fast || allNativeI32) && !isDivOrPow ? "i32" : "f64" };

  // Compile first operand
  let resultType = compileExpression(ctx, fctx, operands[0], numericHint);
  if (!resultType) return null;

  // Compile subsequent operands, emitting the operator after each pair
  for (let i = 1; i < operands.length; i++) {
    let rightType = compileExpression(ctx, fctx, operands[i], numericHint);
    if (!rightType) return null;

    // Coerce ref/externref operands to f64 for numeric operations
    const leftIsRef = resultType.kind === "externref" || resultType.kind === "ref" || resultType.kind === "ref_null";
    const rightIsRef = rightType.kind === "externref" || rightType.kind === "ref" || rightType.kind === "ref_null";
    if (leftIsRef || rightIsRef) {
      if (rightIsRef) {
        const tmpR = allocTempLocal(fctx, rightType);
        fctx.body.push({ op: "local.set", index: tmpR });
        if (leftIsRef) {
          coerceType(ctx, fctx, resultType, { kind: "f64" });
        }
        fctx.body.push({ op: "local.get", index: tmpR });
        coerceType(ctx, fctx, rightType, { kind: "f64" });
        releaseTempLocal(fctx, tmpR);
      } else {
        const tmpR = allocTempLocal(fctx, rightType);
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, resultType, { kind: "f64" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      resultType = { kind: "f64" };
      rightType = { kind: "f64" };
    }

    // Promote i32/f64 mismatch
    if (resultType.kind === "i32" && rightType.kind === "f64") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
      resultType = { kind: "f64" };
      rightType = { kind: "f64" };
    } else if (resultType.kind === "f64" && rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      rightType = { kind: "f64" };
    }

    // i32 path: fast mode or native type annotations.
    // #1817: `>>>` must NOT use compileI32BinaryOp here — its bare i32 result
    // (`i32.shr_u`) is later widened with the signed `f64.convert_i32_s`,
    // dropping ToUint32's unsignedness. compileNumericBinaryOp routes `>>>`
    // through compileBitwiseBinaryOp, which uses `f64.convert_i32_u`.
    if (
      (ctx.fast || allNativeI32) &&
      op !== ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken &&
      resultType.kind === "i32" &&
      rightType.kind === "i32"
    ) {
      resultType = compileI32BinaryOp(ctx, fctx, op, expr);
    } else {
      resultType = compileNumericBinaryOp(ctx, fctx, op, expr);
    }
  }

  return resultType;
}

export function compileBinaryExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): InnerResult {
  const op = expr.operatorToken.kind;

  // Handle assignment
  if (op === ts.SyntaxKind.EqualsToken) {
    return compileAssignment(ctx, fctx, expr);
  }

  // Handle logical assignment operators (??=, ||=, &&=)
  if (
    op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    op === ts.SyntaxKind.BarBarEqualsToken ||
    op === ts.SyntaxKind.AmpersandAmpersandEqualsToken
  ) {
    return compileLogicalAssignment(ctx, fctx, expr, op);
  }

  // Handle compound assignments
  if (isCompoundAssignment(op)) {
    return compileCompoundAssignment(ctx, fctx, expr, op);
  }

  // Handle logical && and ||
  if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
    return compileLogicalAnd(ctx, fctx, expr);
  }
  if (op === ts.SyntaxKind.BarBarToken) {
    return compileLogicalOr(ctx, fctx, expr);
  }

  // Nullish coalescing: a ?? b
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    return compileNullishCoalescing(ctx, fctx, expr);
  }

  // §7.1.3 ToNumeric / §13.x operator evaluation — a Symbol operand of an
  // arithmetic, bitwise, shift, or relational operator (or `+`) must throw a
  // TypeError ("Cannot convert a Symbol value to a number"). For `+`, ToPrimitive
  // on a Symbol yields the Symbol itself, and both the string and number branches
  // throw. Equality (`==`, `===`, `!=`, `!==`) is deliberately excluded — those
  // compare Symbols by identity and never coerce. Symbols are lowered to i32 ids,
  // so without this guard the operator would silently treat the id as a number.
  if (SYMBOL_TONUMERIC_OPS.has(op)) {
    // (#1930 Slice 2) oracle fold: was a direct isSymbolType check on the
    // checker type — flag-identical (ESSymbol|UniqueESSymbol → "symbol")
    // through the boundary.
    const leftSym = ctx.oracle.staticJsTypeOf(expr.left) === "symbol";
    const rightSym = ctx.oracle.staticJsTypeOf(expr.right) === "symbol";
    if (leftSym || rightSym) {
      // Evaluate operands left-to-right for side effects, then throw.
      const lt = compileExpression(ctx, fctx, expr.left);
      if (lt !== null) fctx.body.push({ op: "drop" });
      const rt = compileExpression(ctx, fctx, expr.right);
      if (rt !== null) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
      return { kind: "f64" };
    }
  }

  // ── Fast path: `expr | 0` → pure ToInt32 coercion ──
  // In JavaScript, `x | 0` is idiomatically used to coerce a number to int32.
  // Since OR-ing with 0 is the identity for the bit pattern, we can skip
  // compiling the right operand entirely and just emit ToInt32 on the left.
  // This avoids the expensive double-ToInt32 + i32.or + f64.convert sequence
  // that compileBitwiseBinaryOp would generate.
  //
  // #1120: when the left operand is already i32 (e.g. an i32-coerced
  // local from collectI32CoercedLocals, or another `| 0` expression),
  // return i32 directly — the f64.convert_i32_s round-trip would be
  // immediately undone by the receiving local's ToInt32 coercion.
  // Callers that need an f64 (function args, f64 locals, etc.) still go
  // through coerceType which handles the i32 → f64 widening.
  if (op === ts.SyntaxKind.BarToken && ts.isNumericLiteral(expr.right) && expr.right.text === "0") {
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (!leftType) return null;
    if (leftType.kind === "f64") {
      emitToInt32(fctx);
      return { kind: "i32" };
    } else if (leftType.kind === "i32") {
      // Already i32 — `x | 0` is identity, no work to do.
      return { kind: "i32" };
    } else if (leftType.kind === "externref") {
      // externref → coerce to f64 first, then ToInt32
      const pfIdx = ctx.funcMap.get("parseFloat");
      if (pfIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: pfIdx });
      } else {
        coerceType(ctx, fctx, leftType, { kind: "f64" }, "number");
      }
      emitToInt32(fctx);
      return { kind: "i32" };
    } else {
      // ref/ref_null — coerce to f64 via valueOf, then ToInt32
      coerceType(ctx, fctx, leftType, { kind: "f64" }, "number");
      emitToInt32(fctx);
      return { kind: "i32" };
    }
  }

  // Comma operator: (a, b) — evaluate a, drop its value, evaluate b
  if (op === ts.SyntaxKind.CommaToken) {
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) {
      fctx.body.push({ op: "drop" });
    }
    return compileExpression(ctx, fctx, expr.right);
  }

  // instanceof: compile left value, resolve right to struct type, emit ref.test
  if (op === ts.SyntaxKind.InstanceOfKeyword) {
    return compileInstanceOf(ctx, fctx, expr);
  }

  // typeof x === "type" / typeof x !== "type"
  if (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken
  ) {
    const typeofResult = compileTypeofComparison(ctx, fctx, expr);
    if (typeofResult !== null) return typeofResult;
  }

  // (#2023) `new.target === SomeClass` / `new.target !== SomeClass` (either
  // operand order). `new.target` is the class-id of the outermost `new` site;
  // compare it against the named class's stable id. Must run before the operands
  // are compiled (a bare class identifier `SomeClass` does not lower to a value).
  if (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken
  ) {
    const ntResult = compileNewTargetClassComparison(ctx, fctx, expr, op);
    if (ntResult !== null) return ntResult;
  }

  // Null comparison shortcut: x === null, x !== null, null === x, null !== x
  // Must be detected before compiling both sides to avoid pushing unnecessary null
  const isEqOp = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeqOp = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  const isStrictEqOp = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const isStrictNeqOp = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const isLooseEqOp = op === ts.SyntaxKind.EqualsEqualsToken;
  const isLooseNeqOp = op === ts.SyntaxKind.ExclamationEqualsToken;
  if (isEqOp || isNeqOp) {
    const rightIsNullKeyword = expr.right.kind === ts.SyntaxKind.NullKeyword;
    const rightIsUndefinedId = ts.isIdentifier(expr.right) && expr.right.text === "undefined";
    const rightIsNullish = rightIsNullKeyword || rightIsUndefinedId;
    const leftIsNullKeyword = expr.left.kind === ts.SyntaxKind.NullKeyword;
    const leftIsUndefinedId = ts.isIdentifier(expr.left) && expr.left.text === "undefined";
    const leftIsNullish = leftIsNullKeyword || leftIsUndefinedId;
    if (rightIsNullish || leftIsNullish) {
      // Determine which side is the literal null/undefined and which is the expression
      const nonNullExpr = rightIsNullish ? expr.left : expr.right;

      // Check if the non-null side is also a null/undefined literal
      const nonNullIsNullKeyword = rightIsNullish ? leftIsNullKeyword : rightIsNullKeyword;
      const nonNullIsUndefinedId = rightIsNullish ? leftIsUndefinedId : rightIsUndefinedId;
      const nullSideIsNullKeyword = rightIsNullish ? rightIsNullKeyword : leftIsNullKeyword;
      const nullSideIsUndefinedId = rightIsNullish ? rightIsUndefinedId : leftIsUndefinedId;

      // Both sides are null/undefined literals
      if (nonNullIsNullKeyword || nonNullIsUndefinedId) {
        // For strict equality: null === null or undefined === undefined → true;
        //                      null === undefined → false
        if (isStrictEqOp || isStrictNeqOp) {
          const sameKind =
            (nonNullIsNullKeyword && nullSideIsNullKeyword) || (nonNullIsUndefinedId && nullSideIsUndefinedId);
          fctx.body.push({ op: "i32.const", value: isStrictEqOp ? (sameKind ? 1 : 0) : sameKind ? 0 : 1 });
          return { kind: "i32" };
        }
        // For loose equality: null == undefined → true
        fctx.body.push({ op: "i32.const", value: isLooseEqOp ? 1 : 0 });
        return { kind: "i32" };
      }

      // Check the TS type of the non-null side to detect undefined/null-typed variables
      const nonNullTsType = ctx.checker.getTypeAtLocation(nonNullExpr);
      const nonNullIsUndefinedType =
        (nonNullTsType.flags & ts.TypeFlags.Undefined) !== 0 || (nonNullTsType.flags & ts.TypeFlags.Void) !== 0;
      const nonNullIsNullType = (nonNullTsType.flags & ts.TypeFlags.Null) !== 0;

      // Compile the non-null side
      const valType = compileExpression(ctx, fctx, nonNullExpr);
      if (valType === null) {
        // Void expression (e.g. void function call) compared to null/undefined:
        // void returns undefined, so undefined == undefined/null is true (loose)
        // undefined === undefined is true, undefined === null is false (strict)
        if (isStrictEqOp || isStrictNeqOp) {
          const sameKind = nullSideIsUndefinedId; // void = undefined
          fctx.body.push({ op: "i32.const", value: isStrictEqOp ? (sameKind ? 1 : 0) : sameKind ? 0 : 1 });
        } else {
          fctx.body.push({ op: "i32.const", value: isEqOp ? 1 : 0 });
        }
        return { kind: "i32" };
      }
      if (valType.kind === "externref") {
        // Strict equality: null and undefined are distinct types in JS
        if (isStrictEqOp || isStrictNeqOp) {
          if (nullSideIsNullKeyword) {
            // x === null: only ref.null.extern is null
            fctx.body.push({ op: "ref.is_null" });
            if (isStrictNeqOp) fctx.body.push({ op: "i32.eqz" });
            return { kind: "i32" };
          }
          // x === undefined: check via __extern_is_undefined host import
          const isUndefIdx = ensureExternIsUndefinedImport(ctx);
          if (isUndefIdx !== undefined) {
            flushLateImportShifts(ctx, fctx);
            fctx.body.push({ op: "call", funcIdx: isUndefIdx });
            if (isStrictNeqOp) fctx.body.push({ op: "i32.eqz" });
            return { kind: "i32" };
          }
          // Fallback (standalone): ref.is_null (can't distinguish null/undefined)
          fctx.body.push({ op: "ref.is_null" });
          if (isStrictNeqOp) fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        // Loose equality: null == undefined is true in JS, so check both
        const isUndefIdx = ensureExternIsUndefinedImport(ctx);
        if (isUndefIdx !== undefined) {
          flushLateImportShifts(ctx, fctx);
          const tmpLocal = allocTempLocal(fctx, { kind: "externref" });
          fctx.body.push({ op: "local.tee", index: tmpLocal });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "call", funcIdx: isUndefIdx });
          fctx.body.push({ op: "i32.or" } as Instr);
          releaseTempLocal(fctx, tmpLocal);
          if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        fctx.body.push({ op: "ref.is_null" });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
      // Non-externref type compared with null/undefined:
      // If the TS type is undefined or null, it's a nullish value stored as i32
      if (nonNullIsUndefinedType || nonNullIsNullType) {
        fctx.body.push({ op: "drop" });
        // Loose equality: undefined/null == null/undefined → true
        if (isLooseEqOp || isLooseNeqOp) {
          fctx.body.push({ op: "i32.const", value: isLooseEqOp ? 1 : 0 });
          return { kind: "i32" };
        }
        // Strict equality: only true if same kind
        const sameKind =
          (nonNullIsUndefinedType && nullSideIsUndefinedId) || (nonNullIsNullType && nullSideIsNullKeyword);
        fctx.body.push({ op: "i32.const", value: isStrictEqOp ? (sameKind ? 1 : 0) : sameKind ? 0 : 1 });
        return { kind: "i32" };
      }
      // For ref/ref_null struct types:
      // Strict: refs can be null but never undefined
      // Loose: null == undefined, so ref.is_null covers both
      if (valType.kind === "ref" || valType.kind === "ref_null") {
        // #1105: a nullable native-string ref models `string | undefined`
        // (e.g. String.prototype.at out-of-range → undefined). For that ONE
        // type, a null ref IS the `undefined` value, so `x === undefined`
        // must reduce to ref.is_null rather than the always-false struct rule
        // below. Gate strictly on the AnyString type index so class-instance
        // struct refs keep `struct === undefined → false` semantics.
        // (#2161 B0) Accept the non-null-CLAIMED `ref` kind too: a `string`-
        // typed local is physically nullable (null = the undefined sentinel —
        // e.g. an undefined element of a `(string|undefined)[]` that the
        // non-strict checker typed as `string[]`), so `s === undefined` must
        // runtime-test ref.is_null, not constant-fold to false. For a
        // genuinely-assigned string the is_null test is simply false — same
        // result as the old fold.
        const isNullableNativeString =
          (valType.kind === "ref_null" || valType.kind === "ref") &&
          ctx.nativeStrings &&
          valType.typeIdx === ctx.anyStrTypeIdx;
        if ((isStrictEqOp || isStrictNeqOp) && nullSideIsUndefinedId && !isNullableNativeString) {
          // struct === undefined → always false; struct !== undefined → always true
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: isStrictNeqOp ? 1 : 0 });
          return { kind: "i32" };
        }
        fctx.body.push({ op: "ref.is_null" });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
      // For other non-externref types (number, boolean), always not-equal to null/undefined
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: isNeqOp ? 1 : 0 });
      return { kind: "i32" };
    }
  }

  // `key in obj` — compile-time property existence check
  if (op === ts.SyntaxKind.InKeyword) {
    // #1365 — `#x in obj` is a RUNTIME brand check, not a compile-time
    // property-name lookup. Per ES2022 §12.10.3 (RelationalExpression :
    // PrivateIdentifier `in` ShiftExpression), the result is `true` iff
    // `obj` carries the brand of the class that lexically declared `#x`,
    // and `false` otherwise (no throw, even when obj isn't an object).
    //
    // Today the generic `in` path returns a compile-time `i32.const` based
    // on whether the receiver type's struct happens to have `__priv_<name>`
    // as a field. That conflates two unrelated classes both declaring a
    // private named the same — `#x in instanceOfDifferentClass` returns
    // true when it should return false.
    //
    // Fix: emit a runtime `ref.test` against the declaring class's struct.
    // Falls through to the legacy path if the resolver can't find the
    // declaring class (defensive — well-formed source always finds it).
    if (ts.isPrivateIdentifier(expr.left)) {
      const declared = resolveDeclaringClassForPrivateName(ctx, expr.left);
      if (declared) {
        // Compile the receiver. Coerce externref → anyref and save it so
        // the brand predicate can combine structural ref.test with class-tag
        // ancestry.
        const objResult = compileExpression(ctx, fctx, expr.right);
        if (objResult?.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" } as Instr);
        }
        const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
        fctx.body.push({ op: "local.set", index: tmpAny });
        emitPrivateBrandPredicate(ctx, fctx, tmpAny, declared.className, declared.structTypeIdx);
        releaseTempLocal(fctx, tmpAny);
        return { kind: "i32" };
      }
      // No declaring class found — fall through to the legacy compile-time
      // path. The compile-time bool will be wrong but at least won't trap.
    }

    const rightType = ctx.checker.getTypeAtLocation(expr.right);
    let rightWasm = resolveWasmType(ctx, rightType);

    // (#2741) §13.10.1 step 5 — `key in rval` throws a **TypeError** when
    // `Type(rval)` is not Object. When the RHS static type is EXCLUSIVELY a
    // non-object primitive (number / string / boolean / bigint / symbol / null /
    // undefined, or a literal/union thereof), its runtime value can never be an
    // Object, so emit a runtime throw rather than statically folding to a boolean
    // (which is what the path below would do, e.g. `"toString" in true → true`).
    // Spec evaluation order (steps 1-4): evaluate the LHS (key) then the RHS for
    // side effects, THEN throw. `any` / `unknown` / object / `never` / a union
    // containing a non-primitive constituent are NOT caught here — they defer to
    // the runtime [[HasProperty]] / `__extern_has` path, which throws for a
    // genuinely-primitive runtime value via the native `key in obj`.
    if (inRhsIsExclusivelyPrimitive(rightType)) {
      const lt = compileExpression(ctx, fctx, expr.left);
      if (lt !== null) fctx.body.push({ op: "drop" });
      const rt = compileExpression(ctx, fctx, expr.right);
      if (rt !== null) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Cannot use 'in' operator to search for property in a non-object");
      return { kind: "i32" };
    }

    // (#2617) The TS type of a `new Proxy(...)`-bound identifier is its TARGET
    // type (ProxyConstructor returns T), so `resolveWasmType` yields the target
    // struct and the static `in` fold below would constant-fold `'k' in p` to
    // the target's field membership — never calling `__extern_has`, so a `has`
    // trap (incl. one that throws, #2617) never runs. But #2615 slots that
    // variable as `externref`. Trust the ACTUAL slot type: if the receiver is an
    // identifier whose local slot is externref/anyref, treat the RHS as externref
    // so the `in` routes through `__extern_has` (the host Proxy MOP).
    if (
      (rightWasm.kind === "ref" || rightWasm.kind === "ref_null") &&
      ts.isIdentifier(expr.right) &&
      fctx.localMap.has(expr.right.text)
    ) {
      const idx = fctx.localMap.get(expr.right.text)!;
      const entry = idx < fctx.params.length ? fctx.params[idx] : fctx.locals[idx - fctx.params.length];
      const slotType =
        entry && typeof entry === "object" && "type" in entry
          ? (entry as { type: ValType }).type
          : (entry as ValType | undefined);
      if (slotType?.kind === "externref" || slotType?.kind === "anyref") {
        rightWasm = slotType;
      }
    }

    // Get struct field names if available; detect vec (array) types
    let structFieldNames: string[] | null = null;
    let isVecType = false;
    let vecTypeIdx = -1;
    if (rightWasm.kind === "ref" || rightWasm.kind === "ref_null") {
      const typeIdx = (rightWasm as { typeIdx: number }).typeIdx;
      const structDef = ctx.mod.types[typeIdx];
      if (structDef?.kind === "struct") {
        if (structDef.name?.startsWith("__vec_")) {
          isVecType = true;
          vecTypeIdx = typeIdx;
        } else {
          structFieldNames = structDef.fields.map((f) => f.name).filter((n): n is string => n !== undefined);
        }
      }
    }

    // Resolve the key to a compile-time string if possible.
    // For comma expressions like (x = y, "key"), extract the last element.
    // For PrivateIdentifier (#field in obj), extract the field name without '#'.
    let staticKey: string | null = null;
    const leftExpr: ts.Expression = expr.left;
    if (ts.isPrivateIdentifier(leftExpr)) {
      staticKey = leftExpr.text.startsWith("#") ? "__priv_" + leftExpr.text.slice(1) : leftExpr.text;
    } else if (ts.isStringLiteral(leftExpr)) {
      staticKey = leftExpr.text;
    } else if (ts.isNumericLiteral(leftExpr)) {
      staticKey = leftExpr.text;
    } else if (ts.isBinaryExpression(leftExpr) && leftExpr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      // Comma expression: extract the last element for the static key
      let last: ts.Expression = leftExpr.right;
      while (ts.isBinaryExpression(last) && last.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        last = last.right;
      }
      if (ts.isStringLiteral(last)) {
        staticKey = last.text;
      } else if (ts.isNumericLiteral(last)) {
        staticKey = last.text;
      }
    } else if (ts.isParenthesizedExpression(leftExpr)) {
      // Parenthesized expression: unwrap and check for comma or literal
      const inner = leftExpr.expression;
      if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        let last: ts.Expression = inner.right;
        while (ts.isBinaryExpression(last) && last.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          last = last.right;
        }
        if (ts.isStringLiteral(last)) {
          staticKey = last.text;
        } else if (ts.isNumericLiteral(last)) {
          staticKey = last.text;
        }
      } else if (ts.isStringLiteral(inner)) {
        staticKey = inner.text;
      } else if (ts.isNumericLiteral(inner)) {
        staticKey = inner.text;
      }
    }

    // Also check the TypeScript type system for property existence.
    // This handles built-in constructors (Number.MAX_VALUE), prototype methods
    // (valueOf, toString), and dynamically assigned properties.
    let tsTypeHasProperty = false;
    if (staticKey !== null) {
      // Check direct properties on the TypeScript type
      const prop = rightType.getProperty(staticKey);
      if (prop) {
        tsTypeHasProperty = true;
      }
      // Check the right side's type for comma expressions too
      if (
        !tsTypeHasProperty &&
        ts.isBinaryExpression(expr.right) &&
        expr.right.operatorToken.kind === ts.SyntaxKind.CommaToken
      ) {
        let lastRight: ts.Expression = expr.right.right;
        while (ts.isBinaryExpression(lastRight) && lastRight.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          lastRight = lastRight.right;
        }
        const lastRightType = ctx.checker.getTypeAtLocation(lastRight);
        const prop2 = lastRightType.getProperty(staticKey);
        if (prop2) tsTypeHasProperty = true;
      }
      // Also check apparent type (includes prototype methods like valueOf, toString)
      if (!tsTypeHasProperty) {
        const apparentType = ctx.checker.getApparentType(rightType);
        const apparentProp = apparentType.getProperty(staticKey);
        if (apparentProp) tsTypeHasProperty = true;
      }
    }

    // Array (vec) index bounds check: `index in arr` → 0 <= index < arr.length
    if (isVecType && staticKey !== null) {
      const numIdx = Number(staticKey);
      if (Number.isFinite(numIdx) && numIdx >= 0 && Number.isInteger(numIdx)) {
        // Evaluate left for side effects, drop result
        const leftResult = compileExpression(ctx, fctx, expr.left);
        if (leftResult) {
          fctx.body.push({ op: "drop" });
        }
        // Compile the array expression to get the vec struct
        const rightResult = compileExpression(ctx, fctx, expr.right);
        if (rightResult) {
          // Read length field (field 0 of vec struct)
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
          // Compare: numIdx < length
          fctx.body.push({ op: "i32.const", value: numIdx });
          fctx.body.push({ op: "i32.gt_s" }); // length > index  <==>  index < length
        } else {
          fctx.body.push({ op: "i32.const", value: 0 });
        }
        return { kind: "i32" };
      }
      // Non-numeric key like "length" on array — check TS type
      if (staticKey === "length") {
        const leftResult = compileExpression(ctx, fctx, expr.left);
        if (leftResult) {
          fctx.body.push({ op: "drop" });
        }
        const rightResult = compileExpression(ctx, fctx, expr.right);
        if (rightResult) {
          fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
    }

    // Static resolution: key is known at compile time
    if (staticKey !== null) {
      const hasInStruct = structFieldNames !== null && structFieldNames.includes(staticKey);
      const has = hasInStruct || tsTypeHasProperty;
      // (#1444) When RHS is externref/anyref AND static analysis came up empty
      // (no struct field, no TS-typed prop), the answer is NOT reliably false
      // — the host object may carry dynamic keys (e.g. regex `result.groups`).
      // Route through `__extern_has` for the real `in` check instead of
      // emitting an unconditional `false`.
      if (!has && (rightWasm.kind === "externref" || rightWasm.kind === "anyref")) {
        const hasIdx = ensureLateImport(
          ctx,
          "__extern_has",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "i32" }],
        );
        if (hasIdx !== undefined) {
          flushLateImportShifts(ctx, fctx);
          // (#2741) §13.10.1 evaluates the LHS (key, steps 1-2) BEFORE the RHS
          // (object, steps 3-4). Evaluate the key first into a temp, then the
          // object, then re-push the key so the call args are `(obj, key)`.
          // Use coerceType (not a bare extern.convert_any) so a non-ref key
          // (e.g. `Infinity` → f64) is boxed to externref via __box_number.
          const leftResult = compileExpression(ctx, fctx, expr.left, { kind: "externref" });
          if (leftResult === null) {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (leftResult.kind !== "externref") {
            coerceType(ctx, fctx, leftResult, { kind: "externref" });
          }
          const keyTmp = allocTempLocal(fctx, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: keyTmp });
          const rightResult = compileExpression(ctx, fctx, expr.right, { kind: "externref" });
          if (rightResult === null) {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (rightResult.kind !== "externref") {
            coerceType(ctx, fctx, rightResult, { kind: "externref" });
          }
          fctx.body.push({ op: "local.get", index: keyTmp });
          releaseTempLocal(fctx, keyTmp);
          fctx.body.push({ op: "call", funcIdx: hasIdx });
          return { kind: "i32" };
        }
      }
      // Evaluate both operands for side effects (needed for comma expressions like
      // (NUMBER = Number, "MAX_VALUE") in NUMBER). Drop the produced values.
      const leftResult = compileExpression(ctx, fctx, expr.left);
      if (leftResult) {
        fctx.body.push({ op: "drop" });
      }
      const rightResult = compileExpression(ctx, fctx, expr.right);
      if (rightResult) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "i32.const", value: has ? 1 : 0 });
      return { kind: "i32" };
    }

    // Dynamic key with known struct fields: runtime string comparison.
    // (#2741) Gate to a REFERENCE-like key (string / externref / anyref). A
    // value-typed key (`Infinity`/`true`/a number → f64/i32) cannot be fed to
    // `__str_eq` (it expects a string/externref) — doing so produced a malformed
    // module ("call expected externref, found f64"). Such keys (now reachable
    // because the §13.10.1 ToPropertyKey 2322 is downgraded) fall through to the
    // defined fallback below instead of crashing wasm validation.
    const leftKeyWasm = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(expr.left));
    const keyIsRefLike =
      leftKeyWasm.kind === "externref" ||
      leftKeyWasm.kind === "anyref" ||
      leftKeyWasm.kind === "ref" ||
      leftKeyWasm.kind === "ref_null";
    if (structFieldNames !== null && structFieldNames.length > 0 && keyIsRefLike) {
      // Compile the key expression (should produce a string/externref)
      const keyType = compileExpression(ctx, fctx, expr.left);
      if (keyType) {
        // Compare key against each field name using wasm:js-string equals
        const equalsIdx = ctx.funcMap.get("__str_eq") ?? ctx.funcMap.get("string_equals");
        const jsStrEquals = ctx.mod.imports.findIndex(
          (imp) => imp.module === "wasm:js-string" && imp.name === "equals",
        );
        const eqFunc = jsStrEquals >= 0 ? jsStrEquals : equalsIdx;
        if (eqFunc !== undefined && eqFunc >= 0) {
          const keyLocal = allocLocal(fctx, `__in_key_${fctx.locals.length}`, keyType);
          fctx.body.push({ op: "local.set", index: keyLocal });
          // Start with false (0)
          fctx.body.push({ op: "i32.const", value: 0 });
          for (const fieldName of structFieldNames) {
            // Load the key and the field name string, compare
            fctx.body.push({ op: "local.get", index: keyLocal });
            const strGlobal = ctx.stringGlobalMap.get(fieldName);
            if (strGlobal !== undefined) {
              fctx.body.push({ op: "global.get", index: strGlobal });
              fctx.body.push({ op: "call", funcIdx: eqFunc });
              fctx.body.push({ op: "i32.or" }); // OR with accumulated result
            }
          }
          return { kind: "i32" };
        }
      }
    }

    // Dynamic key with no struct fields — try TS type system for known properties
    // Compile both sides for side effects, then use TS type system if the key
    // can be resolved from its type (e.g., a string variable with a known literal type).
    {
      // (#1444) When RHS is externref-backed (host object — e.g. regex
      // `result.groups`, untyped JS values), route through `__extern_has` so
      // `'key' in hostObj` reflects the actual JS `in` semantics instead of
      // the unconditional `false` fallback. The static path above still
      // covers WasmGC structs / vec types / TS-typed properties where the
      // compile-time answer is reliable.
      if (rightWasm.kind === "externref" || rightWasm.kind === "anyref") {
        const hasIdx = ensureLateImport(
          ctx,
          "__extern_has",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "i32" }],
        );
        if (hasIdx !== undefined) {
          flushLateImportShifts(ctx, fctx);
          // (#2741) §13.10.1 evaluates the LHS (key, steps 1-2) BEFORE the RHS
          // (object, steps 3-4) — e.g. `x() in y()` must throw from `x()` first,
          // and an unresolvable LHS reference (`undef in obj`) must throw before
          // the object is evaluated. Evaluate the key first into a temp, then the
          // object, then re-push the key so the call args stay `(obj, key)`.
          // coerceType (not a bare extern.convert_any) boxes a non-ref key.
          const leftResult = compileExpression(ctx, fctx, expr.left, { kind: "externref" });
          if (leftResult === null) {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (leftResult.kind !== "externref") {
            coerceType(ctx, fctx, leftResult, { kind: "externref" });
          }
          const keyTmp = allocTempLocal(fctx, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: keyTmp });
          const rightResult = compileExpression(ctx, fctx, expr.right, { kind: "externref" });
          if (rightResult === null) {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (rightResult.kind !== "externref") {
            coerceType(ctx, fctx, rightResult, { kind: "externref" });
          }
          fctx.body.push({ op: "local.get", index: keyTmp });
          releaseTempLocal(fctx, keyTmp);
          fctx.body.push({ op: "call", funcIdx: hasIdx });
          return { kind: "i32" };
        }
      }

      const leftResult = compileExpression(ctx, fctx, expr.left);
      if (leftResult) {
        fctx.body.push({ op: "drop" });
      }
      const rightResult = compileExpression(ctx, fctx, expr.right);
      if (rightResult) {
        fctx.body.push({ op: "drop" });
      }

      // Try to resolve key from the TS type of the left expression
      const leftType = ctx.checker.getTypeAtLocation(expr.left);
      if (leftType.isStringLiteral()) {
        const key = leftType.value;
        const prop = rightType.getProperty(key);
        const apparentType = ctx.checker.getApparentType(rightType);
        const apparentProp = apparentType.getProperty(key);
        const has = !!(prop || apparentProp || (structFieldNames && structFieldNames.includes(key)));
        fctx.body.push({ op: "i32.const", value: has ? 1 : 0 });
        return { kind: "i32" };
      }

      // Fully dynamic — emit false as safe fallback
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }
  }

  // ── Flatten long chains of same numeric operator ──
  // For expressions like a + b + c + d (left-recursive AST), flatten into an
  // iterative loop to avoid deep JS recursion and improve compilation speed.
  {
    const flatResult = tryFlattenBinaryChain(ctx, fctx, expr, op);
    if (flatResult !== null) return flatResult;
  }

  // ── Constant folding: emit a single constant when both operands are compile-time known ──
  {
    const folded = tryStaticToNumber(ctx, expr);
    if (folded !== undefined) {
      fctx.body.push({ op: "f64.const", value: folded });
      return { kind: "f64" };
    }
  }

  // Regular binary ops: evaluate both sides
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
  const rightTsType = ctx.checker.getTypeAtLocation(expr.right);

  // ── Loose equality (== / !=) with mixed types ──
  // JS loose equality coerces types before comparing. Handle common cases:
  //   number == boolean / boolean == number → coerce boolean to number
  //   string == number / number == string → coerce string to number (parseFloat)
  //   string == boolean / boolean == string → coerce both to number
  const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
  const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
  if (isLooseEq || isLooseNeq) {
    const leftIsNum = isNumberType(leftTsType);
    const leftIsBool = isBooleanType(leftTsType);
    const leftIsStr = isStringType(leftTsType);
    const rightIsNum = isNumberType(rightTsType);
    const rightIsBool = isBooleanType(rightTsType);
    const rightIsStr = isStringType(rightTsType);

    // number == boolean: coerce boolean (i32) → f64, then f64.eq
    if (leftIsNum && rightIsBool) {
      compileExpression(ctx, fctx, expr.left, { kind: "f64" });
      compileExpression(ctx, fctx, expr.right);
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: isLooseEq ? "f64.eq" : "f64.ne" });
      return { kind: "i32" };
    }
    // boolean == number: coerce boolean (i32) → f64, then f64.eq
    if (leftIsBool && rightIsNum) {
      compileExpression(ctx, fctx, expr.left);
      fctx.body.push({ op: "f64.convert_i32_s" });
      compileExpression(ctx, fctx, expr.right, { kind: "f64" });
      fctx.body.push({ op: isLooseEq ? "f64.eq" : "f64.ne" });
      return { kind: "i32" };
    }
    // (#1134) string == number / number == string and string == boolean /
    // boolean == string: route through `__host_loose_eq` (JS `==`).
    //
    // The previous codegen called `parseFloat(string)` then `f64.eq`, but
    // parseFloat doesn't match ECMA-262 §7.2.15 + §7.1.4 ToNumber semantics:
    //   parseFloat("0xff") === NaN     // hex strings: parseFloat fails
    //   parseFloat("")     === NaN     // empty string: parseFloat fails
    //   Number("0xff")     === 255     // ToNumber parses hex
    //   Number("")         === 0       // ToNumber treats empty as 0
    // So `255 == "0xff"`, `0 == ""`, `false == ""` etc. silently returned
    // false. Routing through the host gets JS `==` for free.
    if (
      (leftIsStr && rightIsNum) ||
      (leftIsNum && rightIsStr) ||
      (leftIsStr && rightIsBool) ||
      (leftIsBool && rightIsStr)
    ) {
      // (#2073) Standalone / WASI has no JS host, so the `__host_loose_eq`
      // delegation below leaks an unsatisfiable `env::__host_loose_eq` import
      // and the module fails to instantiate. Compile these mixed string⇄number
      // and string⇄boolean `==` comparisons to a pure-Wasm numeric compare:
      // per §7.2.15 IsLooselyEqual, a string-vs-Number/Boolean comparison
      // applies ToNumber to BOTH sides (Number→Number, Boolean→ToNumber, and
      // §7.2.15 step 4/6 ToNumber the string), then compares numerically. The
      // native `__str_to_number` scanner is §7.1.4.1 StringToNumber (NaN for a
      // non-numeric string, 0 for empty), and `f64.eq` reproduces +0===-0 and
      // NaN≠NaN — so `"1"==1`, `0==""`, `false==""`, `"x"==1` all match Node.
      const noJsHost = ctx.standalone === true || ctx.wasi === true;
      if (noJsHost && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        // Ensure the native StringToNumber scanner exists. Its signature is
        // `(externref) -> f64`; it converts the externref back to ref $AnyString
        // internally (any.convert_extern + ref.cast).
        if (!ctx.funcMap.has("__str_to_number")) {
          emitNativeParseNumber(ctx, new Set(["__str_to_number"]));
        }
        const strToNumIdx = ctx.funcMap.get("__str_to_number");
        if (strToNumIdx !== undefined) {
          // Emit ToNumber(operand) as f64 for a string / number / boolean side.
          const emitToNumber = (operand: ts.Expression, isStr: boolean, isBool: boolean): void => {
            if (isStr) {
              // native string ref → externref → __str_to_number → f64
              compileExpression(ctx, fctx, operand);
              fctx.body.push({ op: "extern.convert_any" } as Instr);
              fctx.body.push({ op: "call", funcIdx: strToNumIdx });
            } else if (isBool) {
              compileExpression(ctx, fctx, operand);
              fctx.body.push({ op: "f64.convert_i32_s" });
            } else {
              compileExpression(ctx, fctx, operand, { kind: "f64" });
            }
          };
          emitToNumber(expr.left, leftIsStr, leftIsBool);
          emitToNumber(expr.right, rightIsStr, rightIsBool);
          fctx.body.push({ op: isLooseEq ? "f64.eq" : "f64.ne" });
          return { kind: "i32" };
        }
      }

      compileExpression(ctx, fctx, expr.left);
      if (!leftIsStr) {
        coerceType(ctx, fctx, leftIsBool ? { kind: "i32" } : { kind: "f64" }, { kind: "externref" });
      }
      const tmpL = allocTempLocal(fctx, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: tmpL });
      compileExpression(ctx, fctx, expr.right);
      if (!rightIsStr) {
        coerceType(ctx, fctx, rightIsBool ? { kind: "i32" } : { kind: "f64" }, { kind: "externref" });
      }
      const tmpR2 = allocTempLocal(fctx, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: tmpR2 });
      fctx.body.push({ op: "local.get", index: tmpL });
      fctx.body.push({ op: "local.get", index: tmpR2 });
      releaseTempLocal(fctx, tmpR2);
      releaseTempLocal(fctx, tmpL);
      const hostIdx = ensureLateImport(
        ctx,
        "__host_loose_eq",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalHostIdx = ctx.funcMap.get("__host_loose_eq") ?? hostIdx;
      if (finalHostIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: finalHostIdx });
        if (isLooseNeq) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
    }
  }

  // ── Any-typed operand dispatch ──
  // When both operands are `any`, use AnyValue dispatch ONLY for operators that
  // may have non-numeric semantics (+ can do string concat, equality needs type
  // awareness). For strictly numeric ops (-, *, /, %, **, comparisons, bitwise),
  // skip AnyValue and compile with a numeric hint so operands unbox to f64
  // directly, avoiding the overhead of AnyValue tag dispatch.
  if (ctx.anyValueTypeIdx >= 0) {
    const leftIsAny = (leftTsType.flags & ts.TypeFlags.Any) !== 0;
    const rightIsAny = (rightTsType.flags & ts.TypeFlags.Any) !== 0;
    if (leftIsAny && rightIsAny) {
      const isPlusOp = op === ts.SyntaxKind.PlusToken;
      const isEqualityOp =
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      // Only dispatch through AnyValue for + (string concat possible) and equality
      if (isPlusOp || isEqualityOp) {
        const anyDispatch = compileAnyBinaryDispatch(ctx, fctx, expr, op);
        if (anyDispatch !== null) return anyDispatch;
      }
      // For strictly numeric ops, fall through to compile with numeric hint
    }
  }

  // String operations — string triggers string concat for +, or string comparison when both strings
  const isRelational =
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken;
  // Equality ops involving a wrapper object (Number/String/Boolean) are not
  // simple string/number ops — they have object-identity / ToPrimitive
  // semantics. Route them through the externref/wrapper path below (#1111).
  const isEqualityOp =
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const leftIsWrapperObj = isWrapperObjectType(leftTsType);
  const rightIsWrapperObj = isWrapperObjectType(rightTsType);
  const wrapperEquality = isEqualityOp && (leftIsWrapperObj || rightIsWrapperObj);

  // (#1961) In nativeStrings mode a `string | undefined` / `string | null`
  // operand (e.g. `"x".at(i)`, optional chains/params) lowers to a NULLABLE
  // `$AnyString` ref. `isStringType` returns false for the union, so an equality
  // like `"hello".at(1) === "e"` fell through to generic struct ref-equality
  // (always false for equal content). Treat a nullable-string operand as a
  // string operand for equality so it routes to `__str_equals` (content compare,
  // null-tolerant). Only for equality ops — relational/`+` on nullable strings
  // keep their existing handling.
  const isStringOrNullableString = (t: ts.Type): boolean =>
    isStringType(t) || getNullablePrimitiveInfo(t)?.primitiveKind === "string";

  // (#2192) A caught Error's `.message`/`.name`/`.stack` read in standalone/WASI
  // lowers (via the property-access `$Error`-struct guard) to a native-string
  // ref — but the receiver `e` is typed `any` (the `catch (e)` binding), so the
  // operand's *TS* type is `any` and the string-equality dispatch below misses
  // it, falling through to `ref.eq` (struct identity → always false for equal
  // content). So `e.message === "hi"` was false even though the string is right
  // (`const m = e.message; m === "hi"` worked because the typed local re-typed
  // it to `string`). Recognise the property-read shape at the AST level and
  // treat it as a string operand so the comparison routes to `__str_equals`.
  const isStandaloneErrorStringPropRead = (node: ts.Expression): boolean => {
    if (!(ctx.standalone || ctx.wasi)) return false;
    if (!ts.isPropertyAccessExpression(node)) return false;
    const p = node.name.text;
    if (p !== "message" && p !== "name" && p !== "stack") return false;
    const recv = node.expression;
    if (!ts.isIdentifier(recv)) return false;
    const sym = ctx.checker.getSymbolAtLocation(recv);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    return decl !== undefined && ts.isVariableDeclaration(decl) && ts.isCatchClause(decl.parent);
  };
  // (#2201) ES §13.15.2 NamedEvaluation: `id.name` where `id` is the target of a
  // logical-assignment with an anonymous fn/arrow/class RHS (`id &&=/||=/??= fn`)
  // lowers (via the property-access `.name` static resolver) to a native-string
  // ref, but the receiver `id` is typed `number`/`any`, so the operand's *TS*
  // type isn't `string` and the string-equality dispatch below misses it,
  // falling through to `ref.eq` (struct identity → always false for equal
  // content). Recognise the read shape at the AST level so `id.name === "x"`
  // routes to content-based string equality.
  // (#2873) A `+` binary expression is a STRING concatenation — always a string
  // at runtime — whenever either operand is statically string- or String-wrapper
  // typed (`isStringType` covers both). TypeScript infers `new String("1") + 1`
  // (and `new String("1") + new String("1")`, `1 + new String("1")`) as `any`,
  // NOT `string`: only `String-wrapper + primitive-string` narrows to `string`.
  // So an outer `=== "11"` / `!== "11"` sees an `any` LEFT, misses the native
  // string-equality dispatch, and falls to `ref.eq`/tag-dispatch → a spurious
  // `false` even though the concat itself is correct ("11"). This de-masked the
  // standalone `language/expressions/addition/S11.6.1_A3.2_T{1.1,2.1-2.4}`
  // cluster (String/Number/Boolean wrapper `+` operands). Recognise the concat
  // shape at the AST level and treat it as a string operand so the comparison
  // routes to `__str_equals`. Standalone/WASI (native-string) only — mirrors the
  // `isStandaloneErrorStringPropRead` augmentation above and the #2888 relational
  // String-wrapper lowering.
  const isStringConcatExpr = (node: ts.Expression): boolean => {
    if (!(ctx.standalone || ctx.wasi)) return false;
    let cur: ts.Expression = node;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = (cur as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.TypeAssertion).expression;
    }
    if (!ts.isBinaryExpression(cur) || cur.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
    const lt = ctx.checker.getTypeAtLocation(cur.left);
    const rt = ctx.checker.getTypeAtLocation(cur.right);
    if (isBigIntType(lt) || isBigIntType(rt)) return false;
    return isStringType(lt) || isStringType(rt);
  };
  const leftIsStrLike =
    isStringOrNullableString(leftTsType) ||
    isStandaloneErrorStringPropRead(expr.left) ||
    isStringConcatExpr(expr.left) ||
    isLogicalAssignNamedEvalNameRead(ctx, expr.left);
  const rightIsStrLike =
    isStringOrNullableString(rightTsType) ||
    isStandaloneErrorStringPropRead(expr.right) ||
    isStringConcatExpr(expr.right) ||
    isLogicalAssignNamedEvalNameRead(ctx, expr.right);
  if (
    ctx.nativeStrings &&
    ctx.nativeStrTypeIdx >= 0 &&
    isEqualityOp &&
    !wrapperEquality &&
    leftIsStrLike &&
    rightIsStrLike &&
    // At least one side is the union/error-read/named-eval form (else the plain-string path below handles it)
    (!isStringType(leftTsType) || !isStringType(rightTsType))
  ) {
    return compileStringBinaryOp(ctx, fctx, expr, op);
  }

  // (#2503) The FORWARD shape `"lit" == any` (static-string LEFT against an
  // `any`/`unknown`/object RIGHT) is the mirror of the #2503b reverse shape and
  // has the SAME hazard: routing it to `compileStringBinaryOp` does a pure
  // native-string content compare, which is WRONG under §7.2.15 whenever the
  // `any` holds a non-string at runtime — a number (`"5.0" == 5` must be `true`
  // via ToNumber, not `false`), or an object (must ToPrimitive then recurse, so
  // `"x" == {valueOf:()=>"x"}` is `true`). The catch-all third disjunct below
  // (`!isRelational && !isNumber && !isBoolean && !isBigInt`) used to grab these
  // because `any`/object satisfies it, returning a spurious `false` for the
  // entire standalone "Cannot convert object to primitive value" / loose-eq
  // cluster. So for LOOSE `==`/`!=` we exclude an `any`/`unknown`/object RIGHT
  // from the string route and let it fall through to the standalone
  // abstract-equality cascade (~line 1990), which boxes the string ref to
  // externref and dispatches on the RUNTIME tag (string⇄string content compare,
  // string⇄number ToNumber, nullish guard, Object→ToPrimitive — the same
  // §7.2.15 handling #2503b gives the reverse shape). STRICT `===`/`!==` keeps
  // the content-compare route (a string is never `===` a non-string, which
  // `__str_equals` already yields), as do `+` and relational ops.
  const isLooseEqNeqForward = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  const rightIsAbstractNonString =
    !rightIsStrLike &&
    (rightTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 &&
    ctx.nativeStrings &&
    ctx.anyStrTypeIdx >= 0;
  if (
    !wrapperEquality &&
    isStringType(leftTsType) &&
    !(isLooseEqNeqForward && rightIsAbstractNonString) &&
    (isStringType(rightTsType) ||
      op === ts.SyntaxKind.PlusToken ||
      (!isRelational && !isNumberType(rightTsType) && !isBooleanType(rightTsType) && !isBigIntType(rightTsType)))
  ) {
    return compileStringBinaryOp(ctx, fctx, expr, op);
  }
  if (!wrapperEquality && op === ts.SyntaxKind.PlusToken && isStringType(rightTsType) && !isBigIntType(leftTsType)) {
    return compileStringBinaryOp(ctx, fctx, expr, op);
  }
  // (#2503b) The reversed shape `any == "lit"` (a non-numeric/`any` LEFT against
  // a statically string-typed RIGHT) is deliberately NOT routed to
  // `compileStringBinaryOp` here. A pure string-content compare would break
  // §7.2.15 whenever the `any` actually holds a non-string at runtime:
  //   - a number: `5 == "5.0"` must be `true` via ToNumber, not `false` via
  //     `String(5) === "5.0"`;
  //   - null / undefined: `null == "ab"` is always `false` (never coerces);
  //   - an object: ToPrimitive then recurse.
  // Routing on the *static* type alone (as a mirror of the left-string arm)
  // mis-coerced all three, which is the −3 test262 regression of the first
  // attempt. Instead the native-string ref operand is boxed to externref by the
  // loose-equality guard in the struct-ref block below, and the standalone
  // abstract-equality cascade (~line 1990) dispatches on the *runtime* tag
  // (string⇄string content compare, string⇄number ToNumber, nullish guard,
  // Object→ToPrimitive). The left-string arm above already handles a statically
  // string-typed LEFT (where a content/§7.2.15-aware compare IS correct).

  // BigInt operations — handle both pure bigint and mixed bigint/number cases
  if (isBigIntType(leftTsType) || isBigIntType(rightTsType)) {
    const leftIsBigInt = isBigIntType(leftTsType);
    const rightIsBigInt = isBigIntType(rightTsType);

    // Mixed BigInt + Number/String: comparison and equality operators (#227, #228, #295)
    if (leftIsBigInt !== rightIsBigInt) {
      const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
      const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;

      // Strict equality: BigInt and Number/String are different types → always false/true
      if (isStrictEq || isStrictNeq) {
        // Compile both sides for side effects, then drop them
        const lt = compileExpression(ctx, fctx, expr.left);
        if (lt) fctx.body.push({ op: "drop" });
        const rt = compileExpression(ctx, fctx, expr.right);
        if (rt) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
        return { kind: "i32" };
      }

      // Loose equality and comparisons: convert both operands to f64, then compare
      // For BigInt vs Number: i64 → f64 via f64.convert_i64_s
      // For BigInt vs String: string → f64 via ToNumber (§7.1.4), i64 → f64
      //   (#295, #2109). Incomparable strings (ToNumber returns NaN) make all
      //   comparisons false, matching the JS spec for BigInt vs a
      //   non-numeric-string.
      const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
      const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
      const isComparison =
        op === ts.SyntaxKind.LessThanToken ||
        op === ts.SyntaxKind.LessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanEqualsToken;

      // #1827 — BigInt × Number loose (in)equality must use EXACT
      // mathematical-value equality, not an f64 collapse. `f64.convert_i64_s`
      // rounds a BigInt outside ±2^53 (e.g. 9007199254740993n → ...992.0), so
      // `f64.eq` would wrongly report `9007199254740993n == 9007199254740992`
      // as true. Spec §7.2.13: BigInt x == Number y iff y is finite & integral
      // & ℝ(x) === ℝ(y). We compile the Number to f64 and the BigInt to i64,
      // then test: y is integral (f64.nearest(y) == y, which also rejects NaN/±∞)
      // AND y in [-2^63, 2^63) AND i64.trunc_sat_f64_s(y) == bigint.
      const numberIsExactlyComparable =
        (isLooseEq || isLooseNeq) &&
        ((leftIsBigInt && isNumberType(rightTsType)) || (rightIsBigInt && isNumberType(leftTsType)));
      if (numberIsExactlyComparable) {
        // Compile the BigInt operand → i64, the Number operand → f64.
        const bigintExpr = leftIsBigInt ? expr.left : expr.right;
        const numberExpr = leftIsBigInt ? expr.right : expr.left;
        // Evaluate left-to-right for side effects; store both in temps.
        const bi = allocTempLocal(fctx, { kind: "i64" });
        const nf = allocTempLocal(fctx, { kind: "f64" });
        if (leftIsBigInt) {
          const lt = compileExpression(ctx, fctx, bigintExpr, { kind: "i64" });
          if (!lt) return null;
          if (lt.kind !== "i64") coerceType(ctx, fctx, lt, { kind: "i64" });
          fctx.body.push({ op: "local.set", index: bi });
          const rt = compileExpression(ctx, fctx, numberExpr, { kind: "f64" });
          if (!rt) return null;
          if (rt.kind !== "f64") coerceType(ctx, fctx, rt, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: nf });
        } else {
          const lt = compileExpression(ctx, fctx, numberExpr, { kind: "f64" });
          if (!lt) return null;
          if (lt.kind !== "f64") coerceType(ctx, fctx, lt, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: nf });
          const rt = compileExpression(ctx, fctx, bigintExpr, { kind: "i64" });
          if (!rt) return null;
          if (rt.kind !== "i64") coerceType(ctx, fctx, rt, { kind: "i64" });
          fctx.body.push({ op: "local.set", index: bi });
        }
        // eq = (nearest(nf) == nf) && (nf >= -2^63) && (nf < 2^63) &&
        //      (trunc_sat_f64_s(nf) == bi)
        // integral & finite check (NaN/±Inf fail nearest==self or the range test)
        fctx.body.push({ op: "local.get", index: nf });
        fctx.body.push({ op: "f64.nearest" });
        fctx.body.push({ op: "local.get", index: nf });
        fctx.body.push({ op: "f64.eq" }); // integral?
        // range low: nf >= -2^63 (= -9223372036854775808). Written as
        // -(2 ** 63) because the decimal literal is not exactly representable
        // as an f64 token (biome noPrecisionLoss); 2 ** 63 evaluates to
        // exactly that f64 value, so this is behavior-identical.
        fctx.body.push({ op: "local.get", index: nf });
        fctx.body.push({ op: "f64.const", value: -(2 ** 63) });
        fctx.body.push({ op: "f64.ge" });
        fctx.body.push({ op: "i32.and" });
        // range high: nf < 2^63 (= 9223372036854775808); see note above.
        fctx.body.push({ op: "local.get", index: nf });
        fctx.body.push({ op: "f64.const", value: 2 ** 63 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "i32.and" });
        // value: trunc_sat_f64_s(nf) == bi
        fctx.body.push({ op: "local.get", index: nf });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
        fctx.body.push({ op: "local.get", index: bi });
        fctx.body.push({ op: "i64.eq" });
        fctx.body.push({ op: "i32.and" });
        releaseTempLocal(fctx, bi);
        releaseTempLocal(fctx, nf);
        if (isLooseNeq) {
          fctx.body.push({ op: "i32.eqz" });
        }
        return { kind: "i32" };
      }

      if (isLooseEq || isLooseNeq || isComparison) {
        const leftIsStr = isStringType(leftTsType);
        const rightIsStr = isStringType(rightTsType);

        // Compile left operand
        const leftType = compileExpression(ctx, fctx, expr.left, leftIsBigInt ? { kind: "i64" } : undefined);
        if (!leftType) return null;
        // Convert left to f64
        if (leftType.kind === "i64") {
          fctx.body.push({ op: "f64.convert_i64_s" });
        } else if (leftType.kind === "externref") {
          // (#2109) String/externref → f64 via ToNumber (§7.1.4), NOT parseFloat.
          // parseFloat accepts trailing garbage and rejects the 0x/0o/0b and
          // empty-string forms, so `"10abc" == 10n` wrongly became true and
          // `"0x10" == 16n` wrongly became false — but ONLY when the module also
          // used parseFloat (which registered it in funcMap and took this
          // branch). ToNumber (`__unbox_number` = JS `Number()`) is spec
          // StringToNumber: Number("10abc")=NaN, Number("0x10")=16, Number("")=0.
          coerceType(ctx, fctx, leftType, { kind: "f64" }, "number");
        } else if (leftType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        } else if (leftType.kind === "ref" || leftType.kind === "ref_null") {
          // Object wrapper (e.g. Object(0n)) → coerce via valueOf (#997)
          coerceType(ctx, fctx, leftType, { kind: "f64" }, "number");
        }

        // Compile right operand
        const rightType = compileExpression(ctx, fctx, expr.right, rightIsBigInt ? { kind: "i64" } : undefined);
        if (!rightType) return null;
        // Convert right to f64
        if (rightType.kind === "i64") {
          fctx.body.push({ op: "f64.convert_i64_s" });
        } else if (rightType.kind === "externref") {
          // (#2109) String/externref → f64 via ToNumber (§7.1.4), NOT parseFloat.
          // parseFloat accepts trailing garbage and rejects the 0x/0o/0b and
          // empty-string forms, so `10n == "10abc"` wrongly became true and
          // `16n == "0x10"` wrongly became false — but ONLY when the module also
          // used parseFloat (which registered it in funcMap and took this
          // branch). ToNumber (`__unbox_number` = JS `Number()`) is spec
          // StringToNumber: Number("10abc")=NaN, Number("0x10")=16, Number("")=0.
          coerceType(ctx, fctx, rightType, { kind: "f64" }, "number");
        } else if (rightType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        } else if (rightType.kind === "ref" || rightType.kind === "ref_null") {
          // Object wrapper (e.g. Object(0n)) → coerce via valueOf (#997)
          coerceType(ctx, fctx, rightType, { kind: "f64" }, "number");
        }

        // Emit f64 comparison
        if (isLooseEq) {
          fctx.body.push({ op: "f64.eq" });
        } else if (isLooseNeq) {
          fctx.body.push({ op: "f64.ne" });
        } else {
          return compileNumericBinaryOp(ctx, fctx, op, expr);
        }
        return { kind: "i32" };
      }

      // Mixed BigInt + Number arithmetic (e.g. 1n + 1): per spec §6.1.6.2.1
      // (and §13.15 ApplyStringOrNumericBinaryOperator), throw a real
      // TypeError instance (so `assert.throws(TypeError, …)` catches it).
      // Special case: `+` with a string operand is *concatenation*, not
      // numeric add — route to the string path which calls ToString on the
      // BigInt side (`1n + "" === "1"` per §13.15.4).
      if (op === ts.SyntaxKind.PlusToken && (isStringType(leftTsType) || isStringType(rightTsType))) {
        return compileStringBinaryOp(ctx, fctx, expr, op);
      }
      // Compile both sides for side effects, drop their values, then throw.
      const lt = compileExpression(ctx, fctx, expr.left);
      if (lt) fctx.body.push({ op: "drop" });
      const rt = compileExpression(ctx, fctx, expr.right);
      if (rt) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Cannot mix BigInt and other types, use explicit conversions");
      return { kind: "i32" };
    }

    // Both operands are BigInt — compile as i64
    const i64Hint: ValType = { kind: "i64" };
    let leftType2 = compileExpression(ctx, fctx, expr.left, i64Hint);
    let rightType2 = compileExpression(ctx, fctx, expr.right, i64Hint);
    if (!leftType2 || !rightType2) return null;
    // Object(bigint) compiles to a struct ref, not i64. Coerce via valueOf (#997).
    const leftIsRef2 = leftType2.kind === "ref" || leftType2.kind === "ref_null";
    const rightIsRef2 = rightType2.kind === "ref" || rightType2.kind === "ref_null";
    if (leftIsRef2 || rightIsRef2) {
      // For strict equality: ref and i64 are never the same → always false/true
      const isStrictEq2 = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
      const isStrictNeq2 = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (isStrictEq2 || isStrictNeq2) {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq2 ? 1 : 0 });
        return { kind: "i32" };
      }
      // Coerce ref operands to f64 via valueOf, convert i64 to f64
      if (rightIsRef2) {
        coerceType(ctx, fctx, rightType2, { kind: "f64" }, "number");
        rightType2 = { kind: "f64" };
      }
      if (leftIsRef2) {
        const tmpR2 = allocTempLocal(fctx, rightType2);
        fctx.body.push({ op: "local.set", index: tmpR2 });
        coerceType(ctx, fctx, leftType2, { kind: "f64" }, "number");
        fctx.body.push({ op: "local.get", index: tmpR2 });
        releaseTempLocal(fctx, tmpR2);
        leftType2 = { kind: "f64" };
      }
      // Convert remaining i64 operand to f64
      if (rightType2.kind === "i64") {
        fctx.body.push({ op: "f64.convert_i64_s" });
      }
      if (leftType2.kind === "i64") {
        const tmpR3 = allocTempLocal(fctx, rightType2);
        fctx.body.push({ op: "local.set", index: tmpR3 });
        fctx.body.push({ op: "f64.convert_i64_s" });
        fctx.body.push({ op: "local.get", index: tmpR3 });
        releaseTempLocal(fctx, tmpR3);
      }
      return compileNumericBinaryOp(ctx, fctx, op, expr);
    }
    // (#1644 §2.4) Both operands are bigint, so an i64-valued result is itself
    // brand-bigint — propagate the brand so it boxes as a JS bigint downstream.
    // Comparison ops return i32 (a boolean) and are left unbranded.
    const i64Result = compileI64BinaryOp(ctx, fctx, op, expr);
    if (i64Result?.kind === "i64") {
      return { kind: "i64", bigint: true };
    }
    return i64Result;
  }

  // Determine expected operand type from operator and context
  const isNumericOp =
    op === ts.SyntaxKind.PlusToken ||
    op === ts.SyntaxKind.MinusToken ||
    op === ts.SyntaxKind.AsteriskToken ||
    op === ts.SyntaxKind.AsteriskAsteriskToken ||
    op === ts.SyntaxKind.SlashToken ||
    op === ts.SyntaxKind.PercentToken ||
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken ||
    op === ts.SyntaxKind.AmpersandToken ||
    op === ts.SyntaxKind.BarToken ||
    op === ts.SyntaxKind.CaretToken ||
    op === ts.SyntaxKind.LessThanLessThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;

  // (#2058) `+` where an operand is statically `any`/`unknown` (so it lowers to a
  // dynamic externref that may hold a runtime string). §13.15.3 requires
  // concatenation when either ToPrimitive result is a string, but the numeric
  // paths below compile both operands with an f64 hint — ToNumber-coercing a
  // runtime string, so `1 + "2"` wrongly produced `3` instead of `"12"`. Route
  // these through a runtime-dispatched add BEFORE the f64 hint is applied. We
  // require at least one `any`/`unknown` operand: provably-numeric and
  // provably-string `+` were already handled above (string concat at the
  // isStringType gate, numeric via the typed fast paths), so this leaves their
  // codegen untouched. `ctx.fast` mode keeps its i32/f64 numeric semantics for
  // statically-typed operands and is unaffected (those aren't `any`/`unknown`).
  //
  // Fast mode (`anyValueTypeIdx >= 0`) is excluded: there `any + any` is routed
  // through `compileAnyBinaryDispatch` (the AnyValue `__any_add` helper) earlier,
  // and the `__host_add` host import isn't part of that ABI. Per the #2058 design
  // rule, this per-site recovery is **default-mode only**.
  if (op === ts.SyntaxKind.PlusToken && ctx.anyValueTypeIdx < 0) {
    const leftIsAnyish = (leftTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const rightIsAnyish = (rightTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    if ((leftIsAnyish || rightIsAnyish) && !isBigIntType(leftTsType) && !isBigIntType(rightTsType)) {
      return emitAnyAdd(ctx, fctx, expr);
    }
  }

  // (#2059) Relational (`<`,`<=`,`>`,`>=`) where an operand is statically
  // `any`/`unknown` (so it lowers to a dynamic externref that may hold a runtime
  // string). §7.2.13 IsLessThan compares two strings lexicographically, but the
  // numeric paths below ToNumber-coerce both sides — `Number("a")` is NaN, so
  // `("a" as any) < ("b" as any)` wrongly yielded `false`. Route these through a
  // runtime-dispatched compare BEFORE the f64 hint is applied.
  //
  // CRITICAL (#1374 lesson): gate on **statically any/unknown** operands only,
  // NOT on "any non-numeric TS type". The closed PR #1374 gated on
  // `!isPrimNumericish` (both sides), which routed object/class relationals to
  // the host comparator — host `<` then threw on opaque WasmGC structs (14
  // runtime_error regressions). A concrete object/class operand is NOT
  // any/unknown, so it keeps its existing relational path.
  //
  // Fast mode (`anyValueTypeIdx >= 0`) is excluded for the same reason as the
  // `+` gate — the AnyValue helpers own that ABI. Per-site recovery is
  // default-mode only.
  if (isRelational && ctx.anyValueTypeIdx < 0) {
    const leftIsAnyish = (leftTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const rightIsAnyish = (rightTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    if ((leftIsAnyish || rightIsAnyish) && !isBigIntType(leftTsType) && !isBigIntType(rightTsType)) {
      return emitAnyRelational(ctx, fctx, expr, op);
    }
  }

  // In fast mode, numeric hint is i32 (unless division/power which promotes to f64).
  // Also use i32 hint when operands have native i32 type annotations (type i32 = number).
  const isDivOrPow = op === ts.SyntaxKind.SlashToken || op === ts.SyntaxKind.AsteriskAsteriskToken;
  const leftNativeType = resolveNativeTypeAnnotation(leftTsType);
  const rightNativeType = resolveNativeTypeAnnotation(rightTsType);
  const bothNativeI32 = leftNativeType?.kind === "i32" && rightNativeType?.kind === "i32";
  // Use i32 hint for relational comparisons where one operand is a known i32 local.
  // This avoids f64 conversion churn in for-loop conditions like `i < 10000` where
  // detectI32LoopVar already promoted the loop variable to i32.
  const isI32LocalRef = (e: ts.Expression): boolean => {
    if (!ts.isIdentifier(e)) return false;
    const idx = fctx.localMap.get(e.text);
    if (idx === undefined) return false;
    const entry = idx < fctx.params.length ? fctx.params[idx] : fctx.locals[idx - fctx.params.length];
    const type =
      entry && typeof entry === "object" && "type" in entry
        ? (entry as { type: ValType }).type
        : (entry as ValType | undefined);
    return type?.kind === "i32";
  };
  // Whether a relational op may use the i32 fast path. Computed below, once
  // `isI32PureExpr` is in scope: it is only safe when BOTH operands are
  // provably i32-pure. If only one side is an i32 local and the other is a
  // fractional / non-integral f64 (e.g. `i < 2.5`, `i < n/2`), forcing the i32
  // hint truncates that operand via i32.trunc_sat_f64_s before the compare,
  // silently producing the wrong result (#2055).
  let hasI32LocalOperand = false;
  // #1120: when an arithmetic expression is the operand of `expr | 0`
  // (ToInt32 coercion), AND both operands are already i32 locals, hint
  // i32 so we emit native i32 arithmetic. The i32-overflow wrap is
  // semantically identical to f64 + ToInt32 here because the receiving
  // context is i32 by construction. This is what lets the iterative
  // Fibonacci body collapse to `i32.add` + `i32.add` + `local.set` in
  // the hot loop instead of the heavy f64-ToInt32 round-trip.
  //
  // #1179: extend to ANY bitwise op as parent (not just `| 0`) and to
  // recursive subtrees of i32-pure operands (literals, nested arith /
  // bitwise expressions on i32 leaves), and add a parallel i32 fast
  // path for bitwise ops themselves. Together these collapse the hot
  // body of `((i*17) ^ (i>>>3)) & 1023` to a clean i32 chain instead
  // of the per-op double-ToInt32 + f64 round-trip currently emitted.
  const isArithOp =
    op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.AsteriskToken;
  const isBitwiseOpKind = (k: ts.SyntaxKind): boolean =>
    k === ts.SyntaxKind.AmpersandToken ||
    k === ts.SyntaxKind.BarToken ||
    k === ts.SyntaxKind.CaretToken ||
    k === ts.SyntaxKind.LessThanLessThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
  // Skip past parens / `as` casts / non-null asserts when looking for the
  // enclosing context — `((a + b)) | 0` is the same shape as `(a + b) | 0`
  // for our purposes.
  let walk: ts.Node = expr;
  let parent: ts.Node | undefined = expr.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent))
  ) {
    walk = parent;
    parent = parent.parent;
  }
  // Parent ToInt32-coerces our result iff the parent is a bitwise op.
  // All bitwise ops apply ToInt32 to both operands per JS spec, so an
  // arith op nested inside a bitwise op can wrap mod 2^32 safely without
  // changing observable semantics. `| 0` is the canonical case but `^`,
  // `&`, `<<`, `>>`, `>>>` all share this property.
  const parentIsToInt32Bitwise =
    !!parent && ts.isBinaryExpression(parent) && isBitwiseOpKind(parent.operatorToken.kind);
  const wrappedInToInt32 = isArithOp && parentIsToInt32Bitwise;
  // Helper: peel parens/as/non-null wrappers off `e`.
  const peel = (e: ts.Expression): ts.Expression => {
    let inner: ts.Expression = e;
    while (
      ts.isParenthesizedExpression(inner) ||
      ts.isAsExpression(inner) ||
      ts.isTypeAssertionExpression(inner) ||
      ts.isNonNullExpression(inner)
    ) {
      inner = ts.isParenthesizedExpression(inner)
        ? inner.expression
        : ts.isAsExpression(inner)
          ? inner.expression
          : ts.isNonNullExpression(inner)
            ? inner.expression
            : (inner as ts.TypeAssertion).expression;
    }
    return inner;
  };
  // #1179-followup: a "small" integer literal — magnitude strictly below 2^21.
  // Used to guard the i32 multiplication fast path (see `isI32MulSafe`).
  // The exact bound is `1 << 21` = 2097152; we accept |n| ≤ 2097151. Two
  // i32 values where one's magnitude is ≤ 2^21 produce a true product
  // bounded by 2^21 × 2^31 = 2^52 < 2^53, which is exactly representable
  // in f64. f64.mul of these inputs equals the true integer product, and
  // ToInt32 of the f64 result equals i32.mul of the inputs — so the i32
  // fast path matches the JS spec value bit-for-bit.
  const isSmallIntLit = (e: ts.Expression): boolean => {
    const inner = peel(e);
    if (!ts.isNumericLiteral(inner)) return false;
    const n = Number(inner.text.replace(/_/g, ""));
    return Number.isInteger(n) && Math.abs(n) < 1 << 21;
  };
  // #1179-followup: spec-faithful i32 multiplication is safe iff at least
  // one operand is provably small (|n| < 2^21). Without this guard the
  // i32.mul fast path can deviate from JS spec when the true integer
  // product exceeds 2^53 — f64 (53-bit mantissa) loses precision, so
  // f64.mul + ToInt32 disagrees with i32.mul on the low bits.
  // Example divergence: `(0x7FFFFFFF * 0x7FFFFFFF) | 0` is `0` per spec,
  // `1` via i32.mul. Guarding `*` with this check preserves the array-sum
  // win (`i * 17` etc. — the small-literal multiplier is the common case)
  // while restoring spec conformance for unbounded inputs.
  const isI32MulSafe = (l: ts.Expression, r: ts.Expression): boolean => {
    return isSmallIntLit(l) || isSmallIntLit(r);
  };
  // #1179: predicate for "this expression compiles to i32 cheaply with
  // an i32 hint" — leaves are i32 locals or i32-range integer literals,
  // and internal nodes are bitwise / `| 0` (always i32) or arithmetic
  // (i32 IF the result is ToInt32-wrapped, which our caller guarantees
  // by only invoking this from a bitwise / `| 0` context).
  //
  // #1179-followup: the multiplication arm is guarded by `isI32MulSafe`
  // — see comment on that helper for the rationale.
  const isI32PureExpr = (e: ts.Expression): boolean => {
    const inner = peel(e);
    if (ts.isIdentifier(inner)) return isI32LocalRef(inner);
    if (ts.isNumericLiteral(inner)) {
      const n = Number(inner.text.replace(/_/g, ""));
      return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
    }
    // #1105: `String.prototype.charCodeAt` is not an i32-pure leaf.
    // ECMA-262 §22.1.3.3 returns NaN when the position is out of range, and
    // §7.1.7 ToInt32 maps that NaN to 0 only after the surrounding expression
    // has evaluated. Treating `x.charCodeAt(i)` as a direct i32 leaf inside
    // `(a + x.charCodeAt(i)) | 0` would incorrectly preserve `a` for OOB reads.
    //
    // #2682 EXCEPTION: inside a recognised canonical read loop, `recv.charCodeAt(i)`
    // is PROVEN in-bounds (`0 <= i < len`) so it can never return NaN — it is a
    // genuine i32 leaf (an unsigned 16-bit code unit). `matchHoistedCharRead`
    // gates this to exactly that proven receiver+index; every other charCodeAt
    // stays excluded (falls through to `return false`), preserving #1105.
    if (ts.isCallExpression(inner) && matchHoistedCharRead(fctx, inner)) {
      return true;
    }
    if (ts.isBinaryExpression(inner)) {
      const k = inner.operatorToken.kind;
      // `expr | 0` always produces i32 cleanly when its operand does.
      if (k === ts.SyntaxKind.BarToken && ts.isNumericLiteral(inner.right) && inner.right.text === "0") {
        return isI32PureExpr(inner.left);
      }
      // Bitwise ops always produce i32 (their own ToInt32 covers operands).
      if (isBitwiseOpKind(k)) {
        return isI32PureExpr(inner.left) && isI32PureExpr(inner.right);
      }
      // Arith add/sub: i32 wrap is correct under the parent's ToInt32
      // guarantee — f64 add/sub of two i32 values is exact (|a±b| ≤ 2^32
      // < 2^53), so ToInt32 of the f64 result equals i32.add/sub mod 2^32.
      if (k === ts.SyntaxKind.PlusToken || k === ts.SyntaxKind.MinusToken) {
        return isI32PureExpr(inner.left) && isI32PureExpr(inner.right);
      }
      // Arith mul: i32 wrap is only spec-faithful when the true product
      // stays within 2^53. Without range tracking, the cheap proof is
      // "at least one operand is a small integer literal" — see
      // `isI32MulSafe`. Without this guard, large-input multiplications
      // would observably deviate from JS spec.
      if (k === ts.SyntaxKind.AsteriskToken) {
        return isI32PureExpr(inner.left) && isI32PureExpr(inner.right) && isI32MulSafe(inner.left, inner.right);
      }
    }
    return false;
  };
  // #2055: a relational op only takes the i32 fast path when BOTH operands are
  // provably i32-pure (the for-header fast path `i < N` with integer literal N,
  // or two i32 locals). When one side is a fractional/derived f64 the i32 hint
  // would truncate it before the compare, so we fall back to f64 comparison
  // (promoting the i32 local via f64.convert_i32_s, which is cheap and exact).
  // `isI32PureExpr` already treats an i32 local as a pure leaf, so this still
  // covers the original `i < 10000` loop-condition optimisation.
  hasI32LocalOperand =
    isRelational &&
    !isDivOrPow &&
    (isI32LocalRef(expr.left) || isI32LocalRef(expr.right)) &&
    isI32PureExpr(expr.left) &&
    isI32PureExpr(expr.right);
  // #1746: emit a *proven-i32-pure* expression directly as an i32 instruction
  // chain, leaving the result as i32 on the stack. The caller MUST have verified
  // `isI32PureExpr(e)` first — this mirrors that predicate's structure exactly.
  //
  // Why this exists: `compileBinaryExpression` recomputes its i32 decision
  // per-node by walking UP to find an enclosing bitwise/`| 0` context, and the
  // incoming `hint` is dropped (compileExpression → compileBinaryExpression
  // ignores it). So for `(hash*31 + charCodeAt) | 0`, the outer `+` is i32 (its
  // parent is `| 0`), but the inner `hash*31`'s parent is `+` (not bitwise) — it
  // would re-derive f64 and force a round-trip, defeating the whole point. This
  // emitter keeps the entire pure subtree in i32 regardless of nesting depth,
  // which is the lever that collapses the string-hash hot loop to pure i32.
  const emitI32PureExpr = (e: ts.Expression): void => {
    const inner = peel(e);
    if (ts.isIdentifier(inner)) {
      const idx = fctx.localMap.get(inner.text)!;
      fctx.body.push({ op: "local.get", index: idx });
      return;
    }
    if (ts.isNumericLiteral(inner)) {
      fctx.body.push({ op: "i32.const", value: Number(inner.text.replace(/_/g, "")) | 0 });
      return;
    }
    // #2682: proven-in-bounds `recv.charCodeAt(i)` — emit the direct i32 read
    // from the hoisted descriptor (no flatten / struct.get / OOB branch / f64
    // round-trip). This is what keeps the whole `(h*31 + charCodeAt) | 0` chain
    // in i32 and drops the f64 |0 emulation. Gated by `matchHoistedCharRead`.
    if (ts.isCallExpression(inner)) {
      const hoisted = matchHoistedCharRead(fctx, inner);
      if (hoisted) {
        emitHoistedCharCodeAtRead(ctx, fctx, hoisted, inner.arguments[0]!);
        return;
      }
    }
    if (ts.isBinaryExpression(inner)) {
      const k = inner.operatorToken.kind;
      // `expr | 0` — the `| 0` is a no-op once its operand is i32.
      if (k === ts.SyntaxKind.BarToken && ts.isNumericLiteral(inner.right) && inner.right.text === "0") {
        emitI32PureExpr(inner.left);
        return;
      }
      emitI32PureExpr(inner.left);
      emitI32PureExpr(inner.right);
      compileI32BinaryOp(ctx, fctx, k, inner);
      return;
    }
    // Unreachable when the caller respects the isI32PureExpr precondition.
    // Fall back to compileExpression for safety (keeps codegen total).
    compileExpression(ctx, fctx, inner, { kind: "i32" });
  };
  // Arith op with ToInt32-wrapping parent: fire if both operands are i32-pure.
  // Subsumes the original i32-locals-only check; literals and nested chains now apply too.
  // #1179-followup: when the OUTER op is `*`, additionally require the
  // small-literal guard — same rationale as the recursive case above.
  const outerMulI32Safe = op !== ts.SyntaxKind.AsteriskToken || isI32MulSafe(expr.left, expr.right);
  const arithI32WithToInt32Wrap =
    wrappedInToInt32 && isI32PureExpr(expr.left) && isI32PureExpr(expr.right) && outerMulI32Safe;
  // Bitwise op with i32-pure operands: emit native i32 op directly,
  // skipping the f64-ToInt32 round-trip in compileBitwiseBinaryOp.
  //
  // #1817: `>>>` is excluded as the *result* op. compileI32BinaryOp returns a
  // bare i32 for `>>>` (`i32.shr_u`), which the consumer widens to f64 with the
  // signed `f64.convert_i32_s` — wrong, since ToUint32 makes `>>>` unsigned
  // (a high-bit result would read back negative). Routing `>>>` through
  // compileBitwiseBinaryOp instead uses `f64.convert_i32_u`. `>>>` stays a
  // valid i32-pure *leaf* (isI32PureExpr) so nested chains like `(x >>> 3) & m`
  // keep the fast path — there the intermediate i32 bit pattern feeds another
  // bitwise op and is never signed-widened.
  const bitwiseI32 =
    isBitwiseOpKind(op) &&
    op !== ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken &&
    isI32PureExpr(expr.left) &&
    isI32PureExpr(expr.right);
  const numericHint: ValType | undefined = isNumericOp
    ? {
        kind:
          (ctx.fast || bothNativeI32 || hasI32LocalOperand || arithI32WithToInt32Wrap || bitwiseI32) && !isDivOrPow
            ? "i32"
            : "f64",
      }
    : undefined;

  // #1746: when both operands are proven i32-pure and the result is ToInt32-
  // wrapped (arith under `| 0`/bitwise) or this op is itself bitwise, emit the
  // operand subtrees via the self-contained i32 emitter. This keeps nested
  // arith-under-arith nodes in i32 — the per-node parent-walk in
  // compileBinaryExpression can't (the parent of an inner `*` inside a `+` is
  // not bitwise, so it would re-derive f64). Without this the whole pure chain
  // collapses back to the f64 round-trip the predicate was meant to eliminate.
  const useI32PureEmit = arithI32WithToInt32Wrap || bitwiseI32;
  // (#3024) An identifier operand's local slot type can be PROMOTED to externref
  // *mid-expression* — e.g. `x * eval("var x = 2;")`, where the direct-eval body
  // redeclares `x`, forcing its slot from f64 to the dynamic externref
  // representation (the re-declaration re-type in statements/variables.ts, whose
  // `wasmType` resolves to externref because the inlined eval body is a foreign
  // `ts.createSourceFile` node the checker cannot type). That promotion happens
  // when the OTHER operand (the eval call) compiles — AFTER this identifier was
  // already emitted as a raw `local.get` of the then-f64 slot with no unbox. The
  // stale read now loads an externref, so a following `f64.mul`/`f64.sub`/… fails
  // Wasm validation ("expected fN, found externref"). Snapshot each identifier
  // operand's slot kind BEFORE compiling so a genuine mid-expression
  // primitive→externref flip can be recognised below. (A slot that was ALREADY
  // externref and that `compileIdentifier` unboxed to f64 keeps the same slot
  // before/after, so it is left untouched — no double-unbox.)
  const identSlotKind = (e: ts.Expression): ValType["kind"] | undefined => {
    if (!ts.isIdentifier(e)) return undefined;
    const idx = fctx.localMap.get(e.text);
    if (idx === undefined) return undefined;
    const entry = idx < fctx.params.length ? fctx.params[idx] : fctx.locals[idx - fctx.params.length];
    const t =
      entry && typeof entry === "object" && "type" in entry
        ? (entry as { type: ValType }).type
        : (entry as ValType | undefined);
    return t?.kind;
  };
  const leftSlotBefore = identSlotKind(expr.left);
  const rightSlotBefore = identSlotKind(expr.right);
  let leftType: ValType | null;
  let rightType: ValType | null;
  if (useI32PureEmit) {
    emitI32PureExpr(expr.left);
    emitI32PureExpr(expr.right);
    leftType = { kind: "i32" };
    rightType = { kind: "i32" };
  } else {
    leftType = compileExpression(ctx, fctx, expr.left, numericHint);
    rightType = compileExpression(ctx, fctx, expr.right, numericHint);
    // (#3024) If an identifier operand's slot flipped from a concrete primitive
    // to externref while (or after) it was compiled, its emitted value is a raw
    // externref `local.get` with no unbox, yet the reported operand type stayed
    // primitive. Re-label it externref so the numeric externref-unbox path
    // (~line 2255 below) inserts the `externref → f64` coercion. Guarded on an
    // actual primitive→externref flip, so ordinary operands are byte-inert.
    const isPrimKind = (k: ValType["kind"] | undefined): boolean => k === "f64" || k === "i32" || k === "i64";
    if (
      leftType &&
      isPrimKind(leftType.kind) &&
      isPrimKind(leftSlotBefore) &&
      identSlotKind(expr.left) === "externref"
    ) {
      leftType = { kind: "externref" };
    }
    if (
      rightType &&
      isPrimKind(rightType.kind) &&
      isPrimKind(rightSlotBefore) &&
      identSlotKind(expr.right) === "externref"
    ) {
      rightType = { kind: "externref" };
    }
  }

  if (!leftType || !rightType) return null;

  // Promote i32↔f64 mismatch (e.g. string.length:i32 !== 8:f64)
  if (leftType.kind === "i32" && rightType.kind === "f64") {
    const tmpR = allocTempLocal(fctx, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: tmpR });
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.get", index: tmpR });
    releaseTempLocal(fctx, tmpR);
    leftType = { kind: "f64" };
  } else if (leftType.kind === "f64" && rightType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    rightType = { kind: "f64" };
  }

  // ── Struct ref valueOf coercion (#138/#139) ──
  // When operands are struct refs (objects with valueOf), coerce them to f64
  // before performing numeric/comparison/equality operations.
  // For strict equality (===, !==): compare struct refs by reference identity.
  {
    const leftIsRef = leftType.kind === "ref" || leftType.kind === "ref_null";
    const rightIsRef = rightType.kind === "ref" || rightType.kind === "ref_null";
    if (leftIsRef || rightIsRef) {
      // Strict equality: reference identity comparison (no valueOf coercion)
      const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
      const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (isStrictEq || isStrictNeq) {
        if (leftIsRef && rightIsRef) {
          // (#3037 CS1b(ii)) When BOTH operands are the tagged `$AnyValue` box (in
          // standalone), raw `ref.eq` is the WRONG strict-eq: `$AnyValue` is a
          // discriminated union, so two boxes of the same logical value have
          // distinct struct identity but must compare by TAG (a tag-3 number by
          // value, a tag-5 string by content, a tag-6 object by `refval` identity).
          // This pair reaches here only when binary-ops' line-1086 any-dispatch was
          // skipped because `anyValueTypeIdx` was still unregistered at the binary
          // expression's entry, yet an operand later became `$AnyValue` (the CS1b
          // element/member-read carrier registers the type lazily). Route to the
          // tag-aware `__any_strict_eq` so `const a: any = [5,5]; a[0] === a[1]`
          // (and the string analogue) stay correct. Non-`$AnyValue` ref pairs
          // (class instances, nominal structs) keep genuine `ref.eq` identity.
          const bothAnyValue =
            ctx.standalone &&
            ctx.anyValueTypeIdx >= 0 &&
            leftType.kind === "ref" &&
            rightType.kind === "ref" &&
            leftType.typeIdx === ctx.anyValueTypeIdx &&
            rightType.typeIdx === ctx.anyValueTypeIdx;
          if (bothAnyValue) {
            ensureAnyHelpers(ctx);
            const strictEqIdx = ctx.funcMap.get("__any_strict_eq");
            if (strictEqIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: strictEqIdx });
              if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
              return { kind: "i32" };
            }
          }
          fctx.body.push({ op: "ref.eq" });
          if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        // (#1395) Mixed ref + externref strict equality: bridge via anyref so
        // identity is preserved. This fires for cases like a static method
        // that returns `this` (typed as `(ref null $C)`) compared against the
        // bare class identifier (typed as externref of the `__class_<Name>`
        // singleton). Both reference the SAME underlying struct allocation,
        // so `ref.eq` produces the right answer once we get both sides into
        // eqref. Without this bridge, the catch-all below dropped both
        // operands and emitted `i32.const 0`, breaking
        // `static m() { return this; } … C.m() === C` and similar
        // `this`-returns-class-object tests.
        //
        // Uses the same `EQ_HEAP_TYPE = -19` constant + ref.test guard as the
        // externref-vs-externref identity fast-path further down (see comment
        // at line ~1517). When the externref isn't eqref-shaped (e.g. a host
        // string, a number externref), we conservatively return 0 for === or
        // 1 for !== — those cases shouldn't conflate identity anyway.
        const otherType = leftIsRef ? rightType : leftType;
        // (#1914) Mixed externref + native-string-ref strict equality compares
        // string CONTENT (§7.2.16 "If x is a String"), not identity. This is
        // the shape of `anyParam === "literal"` (e.g. the test262 runner's
        // `assert_sameValue_str(actual: any, expected: string)`): the `any`
        // side is externref, the string side is a `(ref $AnyString)` struct.
        // The identity bridge below returns false for equal strings from
        // distinct allocations — every string literal materializes a fresh
        // struct, so even `"a" === "a"` failed through this path.
        if (
          otherType.kind === "externref" &&
          ctx.nativeStrings &&
          ctx.anyStrTypeIdx >= 0 &&
          ((leftIsRef && isStringType(leftTsType)) || (rightIsRef && isStringType(rightTsType)))
        ) {
          ensureNativeStringHelpers(ctx);
          const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
          const strEqIdx = ctx.nativeStrHelpers.get("__str_equals");
          if (flattenIdx !== undefined && strEqIdx !== undefined) {
            // Stack: [left, right] → anyref temps.
            const tmpRightAny = allocTempLocal(fctx, { kind: "anyref" });
            if (!rightIsRef) fctx.body.push({ op: "any.convert_extern" } as Instr);
            fctx.body.push({ op: "local.set", index: tmpRightAny });
            if (!leftIsRef) fctx.body.push({ op: "any.convert_extern" } as Instr);
            const tmpLeftAny = allocTempLocal(fctx, { kind: "anyref" });
            fctx.body.push({ op: "local.set", index: tmpLeftAny });
            // Both sides strings → content equality; otherwise strict
            // string-vs-non-string is definitively unequal — EXCEPT when both
            // sides are null. (#2161 B0) A null native-string ref is the
            // in-band `undefined` sentinel (a `(string|undefined)[]` element,
            // an unmatched capture group), and a null externref is standalone
            // `undefined` — so `undefined === undefined` must be TRUE through
            // this mixed shape (the test262 harness's
            // `assert_sameValue_str(m[i], expected[i])` with both `undefined`).
            // `ref.test` is false for null, so the old blanket `0` else-arm
            // reported unequal. One-null-one-value stays unequal.
            fctx.body.push({ op: "local.get", index: tmpLeftAny });
            fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx } as Instr);
            fctx.body.push({ op: "local.get", index: tmpRightAny });
            fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx } as Instr);
            fctx.body.push({ op: "i32.and" } as Instr);
            fctx.body.push({
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: tmpLeftAny } as Instr,
                { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
                { op: "call", funcIdx: flattenIdx } as Instr,
                { op: "local.get", index: tmpRightAny } as Instr,
                { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
                { op: "call", funcIdx: flattenIdx } as Instr,
                { op: "call", funcIdx: strEqIdx } as Instr,
              ],
              else: [
                { op: "local.get", index: tmpLeftAny } as Instr,
                { op: "ref.is_null" } as Instr,
                { op: "local.get", index: tmpRightAny } as Instr,
                { op: "ref.is_null" } as Instr,
                { op: "i32.and" } as Instr,
              ],
            } as Instr);
            releaseTempLocal(fctx, tmpLeftAny);
            releaseTempLocal(fctx, tmpRightAny);
            if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
            return { kind: "i32" };
          }
        }
        if (otherType.kind === "externref") {
          const EQ_HEAP_TYPE_BR = -19;
          // Stack: [left, right]. Save right (as anyref), then handle left.
          const tmpRightAny = allocTempLocal(fctx, { kind: "anyref" });
          if (rightIsRef) {
            fctx.body.push({ op: "local.set", index: tmpRightAny });
          } else {
            fctx.body.push({ op: "any.convert_extern" });
            fctx.body.push({ op: "local.set", index: tmpRightAny });
          }
          // Now stack: [left]. Convert left to anyref.
          if (leftIsRef) {
            // left is (ref T) — already anyref-compatible by subtyping.
          } else {
            fctx.body.push({ op: "any.convert_extern" });
          }
          // Stack: [leftAnyref]. Save and probe.
          const tmpLeftAny = allocTempLocal(fctx, { kind: "anyref" });
          fctx.body.push({ op: "local.tee", index: tmpLeftAny });
          fctx.body.push({ op: "ref.test", typeIdx: EQ_HEAP_TYPE_BR });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: tmpRightAny } as Instr,
              { op: "ref.test", typeIdx: EQ_HEAP_TYPE_BR },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  { op: "local.get", index: tmpLeftAny } as Instr,
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE_BR },
                  { op: "local.get", index: tmpRightAny } as Instr,
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE_BR },
                  { op: "ref.eq" } as Instr,
                ],
                else: [{ op: "i32.const", value: 0 } as Instr],
              },
            ],
            else: [{ op: "i32.const", value: 0 } as Instr],
          });
          releaseTempLocal(fctx, tmpLeftAny);
          releaseTempLocal(fctx, tmpRightAny);
          if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        // Strict equality with one ref and one primitive → always false (===) or true (!==)
        // since objects and primitives are different types in JS strict equality
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
        return { kind: "i32" };
      }

      // (#2503b) Loose equality `==`/`!=` between a native-string ref and an
      // externref (`any`/object) operand: do NOT ToNumber-coerce the string (the
      // `isNumericOp || isEqOp || isNeqOp` block below would, turning a
      // non-numeric string into NaN → `any == "ab"` wrongly false). The strict
      // `===`/`!==` counterpart is already handled above by the #1914 mixed
      // externref+native-string arm; loose equality has no such arm and fell
      // straight into the numeric coercion. Box the string ref to externref so
      // BOTH operands are externref, then fall through to the standalone
      // abstract-equality cascade (~line 1990), which dispatches on the runtime
      // tag: string⇄string content compare, string⇄number ToNumber (§7.2.15
      // steps 4-7), nullish guard (`null == "ab"` → false), Object→ToPrimitive.
      // This is what makes `any == "lit"` order-independent with the working
      // `"lit" == any` (left-string arm) WITHOUT the over-broad static routing
      // that regressed number-holding `any` (the −3, #2503b first attempt).
      const isLooseEqNeq = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
      const otherEqType = leftIsRef ? rightType : leftType;
      // (#2503) The OTHER operand may arrive as an `externref` (an `any`-typed
      // parameter that lost its typeIdx) OR as a nominal STRUCT ref (the static
      // `"x" == (obj as any)` shape, where the AsExpression keeps the concrete
      // `(ref $T)`). Both must be boxed to externref so the abstract-equality
      // cascade can reduce an Object operand via `__to_primitive`. For the
      // struct-ref case the box goes through `coerceType(structRef→externref)`,
      // which materializes a user-ToPrimitive struct as a `$Object` (#2358) so
      // the native helper recognises it. Plain data structs are boxed by plain
      // `extern.convert_any` and the cascade's identity arm handles them.
      const otherIsBoxableRef =
        otherEqType.kind === "externref" || otherEqType.kind === "ref" || otherEqType.kind === "ref_null";
      // (#2503) A wrapper object (`new Boolean`/`new Number`/`new String`) on the
      // OTHER side: in JS-host mode it keeps its dedicated `__host_loose_eq`
      // routing (the wrapper arm ~line 2483). But in STANDALONE/WASI there is no
      // JS host — the wrapper arm's `__host_loose_eq` import is unsatisfiable, so
      // a `string == wrapper` must instead go through the native abstract-equality
      // cascade, whose `__to_primitive` already reduces a wrapper via its
      // WRAPPER_PRIMITIVE_KEY slot short-circuit (this is what makes `"1" == new
      // Boolean(true)` / `"-1" == new Number(-1)` work). Without taking THIS arm
      // for the wrapper case, `wrapperEquality` falls to the `else if (isEqOp)`
      // f64 path below, which `__str_to_number`s the string operand → NaN →
      // wrong `false` (the `"x" == new String("x")` residual). So permit a
      // string-ref-vs-wrapper pairing through the externref box when noJsHost.
      const noJsHostEq = ctx.standalone === true || ctx.wasi === true;
      const wrapperOverStringAllowed = noJsHostEq && wrapperEquality;
      if (
        isLooseEqNeq &&
        (!wrapperEquality || wrapperOverStringAllowed) &&
        ctx.nativeStrings &&
        ctx.anyStrTypeIdx >= 0 &&
        otherIsBoxableRef &&
        ((leftIsRef && isStringType(leftTsType)) || (rightIsRef && isStringType(rightTsType)))
      ) {
        // Box the native-string ref operand → externref (extern.convert_any).
        // Stack is [left, right]; right is on top.
        if (rightIsRef) {
          coerceType(ctx, fctx, rightType, { kind: "externref" });
          rightType = { kind: "externref" };
        }
        if (leftIsRef) {
          const tmpR = allocTempLocal(fctx, rightType);
          fctx.body.push({ op: "local.set", index: tmpR });
          coerceType(ctx, fctx, leftType, { kind: "externref" });
          fctx.body.push({ op: "local.get", index: tmpR });
          releaseTempLocal(fctx, tmpR);
          leftType = { kind: "externref" };
        }
        // Both operands are now externref — fall through to the externref
        // equality cascade below (does NOT re-enter this struct-ref block).
      } else if (isNumericOp || isEqOp || isNeqOp) {
        // For numeric, comparison, and loose equality ops: coerce struct refs → f64 via valueOf
        // Per JS spec, binary + uses ToPrimitive with hint "default",
        // while other numeric/comparison ops use hint "number".
        const hint: "number" | "default" = op === ts.SyntaxKind.PlusToken ? "default" : "number";
        // Coerce right operand (top of stack) first
        if (rightIsRef) {
          coerceType(ctx, fctx, rightType, { kind: "f64" }, hint);
          rightType = { kind: "f64" };
        }
        // Coerce left operand (below right on stack) — save right to local
        if (leftIsRef) {
          const tmpR = allocTempLocal(fctx, rightType);
          fctx.body.push({ op: "local.set", index: tmpR });
          coerceType(ctx, fctx, leftType, { kind: "f64" }, hint);
          fctx.body.push({ op: "local.get", index: tmpR });
          releaseTempLocal(fctx, tmpR);
          leftType = { kind: "f64" };
        }
        // After valueOf coercion, one side may be f64 (from ref) and the other
        // may still be i32 (boolean/integer). Promote i32 → f64 to avoid type mismatch. (#433)
        if (leftType.kind === "i32" && rightType.kind === "f64") {
          const tmpR = allocTempLocal(fctx, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: tmpR });
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "local.get", index: tmpR });
          releaseTempLocal(fctx, tmpR);
          leftType = { kind: "f64" };
        } else if (leftType.kind === "f64" && rightType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          rightType = { kind: "f64" };
        }
        // Now both operands are f64 — fall through to numeric dispatch below
      }
    }
  }

  // i32 numeric operations: fast mode, native type annotations, known i32 local
  // comparison, — #1120 — arithmetic of two i32 locals whose result is
  // ToInt32-coerced by an enclosing `| 0`, or — #1179 — a bitwise op with
  // i32-pure operands (skip the f64 round-trip entirely).
  if (
    leftType.kind === "i32" &&
    rightType.kind === "i32" &&
    ((ctx.fast && isNumberType(leftTsType)) ||
      bothNativeI32 ||
      hasI32LocalOperand ||
      arithI32WithToInt32Wrap ||
      bitwiseI32)
  ) {
    return compileI32BinaryOp(ctx, fctx, op, expr);
  }

  // i64 operations (bigint detected by compiled type, e.g. from variables)
  if (leftType.kind === "i64" && rightType.kind === "i64") {
    return compileI64BinaryOp(ctx, fctx, op, expr);
  }

  // Mixed i64/f64 (BigInt vs Number detected by compiled type) — convert i64 to f64 (#227, #228)
  if ((leftType.kind === "i64" && rightType.kind === "f64") || (leftType.kind === "f64" && rightType.kind === "i64")) {
    const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
    const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (isStrictEq || isStrictNeq) {
      // Different types → always false (===) or true (!==)
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
      return { kind: "i32" };
    }
    // Convert i64 operand to f64 — right is on top of stack
    if (rightType.kind === "i64") {
      fctx.body.push({ op: "f64.convert_i64_s" });
    } else {
      // left is i64, need to swap: save right, convert left, restore right
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    // Now both are f64 — use numeric comparison
    const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
    const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
    if (isLooseEq) {
      fctx.body.push({ op: "f64.eq" });
      return { kind: "i32" };
    }
    if (isLooseNeq) {
      fctx.body.push({ op: "f64.ne" });
      return { kind: "i32" };
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  if (
    (isNumberType(leftTsType) || leftType.kind === "f64") &&
    leftType.kind !== "externref" &&
    rightType.kind !== "externref"
  ) {
    // (#1558) Both operands need to be f64 for compileNumericBinaryOp, which
    // emits f64.eq/f64.add/etc. The left operand can be i32 even when the TS
    // type is `number` — e.g. `string.length` returns i32 directly via the
    // wasm:js-string `length` import. Without this coercion, `f64.eq[0]`
    // (operand 0) fails Wasm validation with "expected f64, found i32".
    //
    // The no-cast comparison `a.length === b.length` happens to take the IR
    // path (which already coerces both sides to the f64 hint), but
    // `a.length === (b as string).length` and similar AsExpression / non-null
    // assertion forms fall back to this legacy path. (#1558 was reported on
    // ESLint `Linter.verifyAndFix` for `currentText.length ===
    // secondPreviousText.length` after the latter went through narrowing.)
    if (leftType.kind === "i32" && rightType.kind === "i32") {
      // Both i32 — convert each to f64 in-place. Right is on top of stack.
      fctx.body.push({ op: "f64.convert_i32_s" });
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    } else if (leftType.kind === "i32") {
      // Only left is i32 — convert via temp. Right is already f64-ish.
      const tmpR = allocTempLocal(fctx, rightType);
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    } else if (rightType.kind === "i32") {
      // Only right is i32 — convert in place (top of stack).
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }
  if (
    (isBooleanType(leftTsType) || leftType.kind === "i32") &&
    leftType.kind !== "externref" &&
    rightType.kind !== "externref"
  ) {
    // Ensure both operands are i32; if right is f64, promote left to f64 and use numeric path
    if (rightType.kind === "f64") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
      return compileNumericBinaryOp(ctx, fctx, op, expr);
    }
    // For arithmetic / bitwise ops on two i32 operands, use compileI32BinaryOp
    // which emits the matching i32 instruction (i32.add, i32.sub, …).
    // compileBooleanBinaryOp only handles comparison/equality — its `default:`
    // arm falls through silently on `+ - * %` etc., leaving both operands on
    // the stack with no combining op (#1211: caused recursive `f(n - 1)` in
    // any-typed fast-mode functions to be miscompiled into `f(1)` because the
    // TS-checker types the recursive param as `any`, so the i32-arith guard at
    // line ~1202 above (which requires `isNumberType(leftTsType)`) doesn't
    // fire and the dispatch falls into this branch instead).
    if (leftType.kind === "i32" && rightType.kind === "i32" && isNumericOp) {
      return compileI32BinaryOp(ctx, fctx, op, expr);
    }
    return compileBooleanBinaryOp(ctx, fctx, op);
  }

  // Externref in numeric context: unbox externref operands to f64
  if ((leftType.kind === "externref" || rightType.kind === "externref") && isNumericOp) {
    if (rightType.kind === "externref") {
      coerceType(ctx, fctx, rightType, { kind: "f64" }, "number");
    }
    if (leftType.kind === "externref") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      coerceType(ctx, fctx, leftType, { kind: "f64" }, "number");
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  // Externref equality: when either operand is a known string type, use
  // string content comparison instead of numeric unboxing (#225).
  // For strict equality (===, !==), cross-type comparisons always return false/true (#296).
  if ((leftType.kind === "externref" || rightType.kind === "externref") && (isEqOp || isNeqOp)) {
    const isStrict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const leftIsString = isStringType(leftTsType);
    const rightIsString = isStringType(rightTsType);
    const leftIsNumber = isNumberType(leftTsType);
    const rightIsNumber = isNumberType(rightTsType);
    const leftIsBool = isBooleanType(leftTsType);
    const rightIsBool = isBooleanType(rightTsType);

    // #1776: standalone / WASI (no-JS-host) dynamic equality.
    //
    // The JS-host equality fallbacks below import `__host_eq` / `__host_loose_eq`
    // and delegate to JS `===` / `==`. Under `--target standalone` (and WASI)
    // there is no JS host, so emitting those calls leaks an unsatisfiable
    // `env::__host_eq` import — the module then fails `WebAssembly.instantiate`
    // ("Import #0 env: module is not an object or function"). That broke the
    // test262 harness helper `isSameValue` for ~1,436 standalone tests (#1776):
    // `isSameValue(a: any, b: any)` compiles both params to `externref`, so its
    // `a === b` / `a !== a` comparisons all reach this externref-equality path.
    //
    // We replace the host delegation with a Wasm-native tag dispatch on the two
    // boxed operands (left in $l, right in $r):
    //   1. both typeof number  → unbox to f64, compare (f64.eq / f64.ne).
    //      Recovers equal numbers boxed in DISTINCT structs (ref.eq is identity,
    //      not value) AND makes NaN self-comparison work (`a !== a`).
    //   2. both typeof boolean → unbox to i32, compare.
    //   3. otherwise           → reference identity via any.convert_extern +
    //      ref.test/ref.eq on the WasmGC eq heap type; non-eqref or mismatched
    //      tags compare unequal. Per §7.2.16 two distinct non-primitive
    //      references that are not identical are not `===`.
    // This needs no host import and never feeds an externref into an f64/i32
    // helper (acceptance criteria #1776).
    const noJsHost = ctx.standalone === true || ctx.wasi === true;
    if (noJsHost && (leftType.kind === "externref" || rightType.kind === "externref")) {
      const EQ_HEAP = -19; // WasmGC `eq` abstract heap type (signed LEB 0x6d)
      // (#1910 R1) §7.2.13 IsLooselyEqual steps 11-12 — the Object↔primitive arm
      // is LOOSE-only (strict `===` never coerces, §7.2.16). Register the native
      // ToPrimitive engine BEFORE `addUnionImports` / the typeof funcIdx reads so
      // any late imports it adds can't desync the in-progress body — this is the
      // #1890 finalization-shift class, and doing it after the funcIdx reads
      // corrupted the strict `===` path (#1776 isSameValue regressed). Gated on
      // `isLoose` so the strict path is byte-identical to before.
      const isLoose =
        !isStrict && (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken);
      // (#2106 S1) The singleton-regime nullish guard below needs the
      // `__extern_is_nullish` / `__extern_is_undefined` natives for BOTH
      // strict and loose, so pull in the object runtime under the flag too
      // (flag-off: the legacy `isLoose`-only pull, byte-identical).
      const s1Regime = undefinedSingletonActive(ctx);
      if (isLoose || s1Regime) ensureObjectRuntime(ctx);
      addUnionImports(ctx);
      const s1IsNullishIdx = s1Regime ? ctx.funcMap.get("__extern_is_nullish") : undefined;
      const s1IsUndefIdx = s1Regime ? ctx.funcMap.get("__extern_is_undefined") : undefined;
      const typeofNum = ctx.funcMap.get("__typeof_number")!;
      const typeofBool = ctx.funcMap.get("__typeof_boolean")!;
      const typeofBigint = ctx.funcMap.get("__typeof_bigint")!;
      const unboxNum = ctx.funcMap.get("__unbox_number")!;
      const unboxBool = ctx.funcMap.get("__unbox_boolean")!;
      const toBigint = ctx.funcMap.get("__to_bigint")!;

      // (#2605) Box an operand to externref for the tag-dispatch below. A
      // **boolean** i32 MUST be boxed via `__box_boolean` so its runtime tag is
      // `boolean`, not `number`: the default `coerceType` i32→externref path uses
      // `f64.convert_i32_s` + `__box_number`, which turns `true` into the number
      // `1`. The other operand (e.g. an `any`-typed boxed boolean `true`, tag
      // `boolean`) would then mismatch on tag and fall through to reference
      // identity → wrong `false`. This is the dominant cause of standalone
      // `assert.sameValue(x instanceof Set, true)`-style rows failing: the harness
      // passes a boolean into an `any` param and compares it with `===`/`!==`
      // against a `boolean` literal (#2605). Boxing booleans as booleans makes the
      // "both typeof boolean → unbox i32, compare" arm fire correctly.
      const boxOperandToExternref = (operandType: ValType, isBoolOperand: boolean): void => {
        if (operandType.kind === "externref") return;
        if (operandType.kind === "i32" && isBoolOperand) {
          // addUnionImports (already called above) installs __box_boolean.
          const boxBoolIdx = ctx.funcMap.get("__box_boolean");
          if (boxBoolIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
            return;
          }
        }
        coerceType(ctx, fctx, operandType, { kind: "externref" });
      };

      // Coerce both operands to externref temps (right is on top of stack).
      const rTmp = allocTempLocal(fctx, { kind: "externref" });
      boxOperandToExternref(rightType, rightIsBool);
      fctx.body.push({ op: "local.set", index: rTmp });
      const lTmp = allocTempLocal(fctx, { kind: "externref" });
      boxOperandToExternref(leftType, leftIsBool);
      fctx.body.push({ op: "local.set", index: lTmp });

      // (#1910 R1) §7.2.13 steps 11-12 — reduce an Object operand to a primitive
      // for LOOSE equality. We overwrite lTmp/rTmp in place with
      // ToPrimitive(operand, default) when EXACTLY ONE side is an Object:
      //   - both Objects → SameType(x,y) (step 1) → IsStrictlyEqual = reference
      //     identity, NEVER ToPrimitive (so we must NOT reduce — the eqref arm at
      //     the bottom of the cascade handles it). The XOR gate preserves this.
      //   - neither Object → no reduction (the `if` is false), primitives flow on.
      // `__to_primitive` is the identity on a primitive (its leading
      // returnIfPrimitive guard returns null/number/boolean/string unchanged), so
      // reducing BOTH operands inside the one-object branch only transforms the
      // object side; the primitive side is untouched. The single ToPrimitive call
      // matches the spec's single recursion: after it both operands are primitive
      // and the recursion bottoms out in the number/string/bigint/boolean arms.
      const toPrimIdx = ctx.funcMap.get("__to_primitive");
      const typeofObject = ctx.funcMap.get("__typeof_object");
      if (isLoose && toPrimIdx !== undefined && typeofObject !== undefined) {
        const reduceOperand = (externLocal: number): Instr[] => [
          { op: "local.get", index: externLocal },
          { op: "ref.null.extern" } as Instr, // default hint
          { op: "call", funcIdx: toPrimIdx } as Instr,
          { op: "local.set", index: externLocal },
        ];
        fctx.body.push(
          // lIsObj XOR rIsObj  ≡  lIsObj !== rIsObj
          { op: "local.get", index: lTmp },
          { op: "call", funcIdx: typeofObject } as Instr,
          { op: "local.get", index: rTmp },
          { op: "call", funcIdx: typeofObject } as Instr,
          { op: "i32.ne" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...reduceOperand(lTmp), ...reduceOperand(rTmp)],
          } as Instr,
        );
      }

      // (#2081) LOOSE null/undefined arm (§7.2.15 steps 2-3): `null == undefined`
      // (and null==null / undefined==undefined) ⇒ true; a nullish vs a
      // non-nullish ⇒ false (never coerces — `null == 0` is false). Under this
      // representation both null and undefined are `ref.null extern`, so a
      // both-nullish test captures all three nullish pairings. LOOSE only — strict
      // `null === undefined` is handled by the type-aware path and must stay
      // false; gate on `!isStrict`. The numeric/bool/string/identity cascade
      // below is the `else`.
      const looseNullish =
        !isStrict && (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken);
      // (#2081) ToNumber for the LOOSE numeric arm: a boxed boolean coerces to
      // 0/1 (§7.2.15 step 8 / §7.1.4 ToNumber(Boolean)), a number unboxes. Used
      // only when the arm has already established the operand is number-or-bool.
      const looseToNum = (externLocal: number): Instr[] => [
        { op: "local.get", index: externLocal },
        { op: "call", funcIdx: typeofBool } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [
            { op: "local.get", index: externLocal },
            { op: "call", funcIdx: unboxBool },
            { op: "f64.convert_i32_s" },
          ],
          else: [
            { op: "local.get", index: externLocal },
            { op: "call", funcIdx: unboxNum },
          ],
        } as Instr,
      ];
      const coreEqInstrs: Instr[] = [
        // ── number (loose: number-or-boolean — §7.2.15 step 8 Boolean→ToNumber,
        //    so `true == 1`, `false == 0` compare numerically; strict keeps
        //    number-only since `true === 1` is false by type)? ──
        { op: "local.get", index: lTmp },
        { op: "call", funcIdx: typeofNum } as Instr,
        ...(looseNullish
          ? ([{ op: "local.get", index: lTmp }, { op: "call", funcIdx: typeofBool }, { op: "i32.or" }] as Instr[])
          : []),
        { op: "local.get", index: rTmp },
        { op: "call", funcIdx: typeofNum } as Instr,
        ...(looseNullish
          ? ([{ op: "local.get", index: rTmp }, { op: "call", funcIdx: typeofBool }, { op: "i32.or" }] as Instr[])
          : []),
        { op: "i32.and" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: looseNullish
            ? [...looseToNum(lTmp), ...looseToNum(rTmp), { op: "f64.eq" } as Instr]
            : [
                { op: "local.get", index: lTmp },
                { op: "call", funcIdx: unboxNum },
                { op: "local.get", index: rTmp },
                { op: "call", funcIdx: unboxNum },
                { op: "f64.eq" } as Instr,
              ],
          else: [
            // ── boolean? ──
            { op: "local.get", index: lTmp },
            { op: "call", funcIdx: typeofBool } as Instr,
            { op: "local.get", index: rTmp },
            { op: "call", funcIdx: typeofBool } as Instr,
            { op: "i32.and" } as Instr,
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: lTmp },
                { op: "call", funcIdx: unboxBool },
                { op: "local.get", index: rTmp },
                { op: "call", funcIdx: unboxBool },
                { op: "i32.eq" } as Instr,
              ],
              else: [
                // ── bigint? ──
                { op: "local.get", index: lTmp },
                { op: "call", funcIdx: typeofBigint } as Instr,
                { op: "local.get", index: rTmp },
                { op: "call", funcIdx: typeofBigint } as Instr,
                { op: "i32.and" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [
                    { op: "local.get", index: lTmp },
                    { op: "call", funcIdx: toBigint },
                    { op: "local.get", index: rTmp },
                    { op: "call", funcIdx: toBigint },
                    { op: "i64.eq" } as Instr,
                  ],
                  else: [
                    // ── reference identity ──
                    // Both must be WasmGC eqref for ref.eq; otherwise unequal.
                    { op: "local.get", index: lTmp },
                    { op: "any.convert_extern" } as Instr,
                    { op: "local.get", index: rTmp },
                    { op: "any.convert_extern" } as Instr,
                    ...(() => {
                      const lAny = allocTempLocal(fctx, { kind: "anyref" });
                      const rAny = allocTempLocal(fctx, { kind: "anyref" });
                      // ── eqref identity ── (the final fallback arm)
                      const identityArm: Instr[] = [
                        { op: "local.get", index: lAny },
                        { op: "ref.test", typeIdx: EQ_HEAP } as Instr,
                        { op: "local.get", index: rAny },
                        { op: "ref.test", typeIdx: EQ_HEAP } as Instr,
                        { op: "i32.and" } as Instr,
                        {
                          op: "if",
                          blockType: { kind: "val", type: { kind: "i32" } },
                          then: [
                            { op: "local.get", index: lAny },
                            { op: "ref.cast", typeIdx: EQ_HEAP } as Instr,
                            { op: "local.get", index: rAny },
                            { op: "ref.cast", typeIdx: EQ_HEAP } as Instr,
                            { op: "ref.eq" } as Instr,
                          ],
                          // (#2161 B0) `ref.test` is FALSE for null, so two
                          // nullish operands (both `ref.null` — the standalone
                          // undefined/null representation, e.g. two `undefined`
                          // array elements in the test262 compareArray harness)
                          // used to land here and report UNEQUAL. Both-null ⇒
                          // equal (`undefined === undefined` / `null === null`);
                          // one-null-one-value stays 0 via the i32.and.
                          else: [
                            { op: "local.get", index: lAny },
                            { op: "ref.is_null" } as Instr,
                            { op: "local.get", index: rAny },
                            { op: "ref.is_null" } as Instr,
                            { op: "i32.and" } as Instr,
                          ],
                        } as Instr,
                      ];
                      // ── string? ── (#1914) Native strings are VALUE-compared
                      // (§7.2.16 "If x is a String"). Without this, `a === b` over
                      // `any`-typed string operands (e.g. the test262 harness's
                      // `isSameValue`) fell to ref.eq identity and returned false
                      // for equal strings from distinct allocations. Falls back to
                      // the eqref identity arm when not both strings.
                      const stringAndIdentityArm = (): Instr[] => {
                        if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
                          ensureNativeStringHelpers(ctx);
                          const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
                          const strEqIdx = ctx.nativeStrHelpers.get("__str_equals");
                          if (flattenIdx !== undefined && strEqIdx !== undefined) {
                            return [
                              { op: "local.get", index: lAny },
                              { op: "ref.test", typeIdx: ctx.anyStrTypeIdx } as Instr,
                              { op: "local.get", index: rAny },
                              { op: "ref.test", typeIdx: ctx.anyStrTypeIdx } as Instr,
                              { op: "i32.and" } as Instr,
                              {
                                op: "if",
                                blockType: { kind: "val", type: { kind: "i32" } },
                                then: [
                                  { op: "local.get", index: lAny },
                                  { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
                                  { op: "call", funcIdx: flattenIdx },
                                  { op: "local.get", index: rAny },
                                  { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
                                  { op: "call", funcIdx: flattenIdx },
                                  { op: "call", funcIdx: strEqIdx },
                                ],
                                else: identityArm,
                              } as Instr,
                            ];
                          }
                        }
                        return identityArm;
                      };
                      const seq: Instr[] = [
                        { op: "local.set", index: rAny },
                        { op: "local.set", index: lAny },
                      ];
                      // ── (#2081) LOOSE String ⇄ Number arm (§7.2.15 steps 4-7) ──
                      // For `==`/`!=` only (NOT strict — `"1" === 1` is false by
                      // type), when EXACTLY one operand is a native string and the
                      // other is a number, compare ToNumber(both): ToNumber(string)
                      // via the §7.1.4.1 `__str_to_number` scanner (NaN for
                      // unparseable, 0 for empty, hex/inf), `__unbox_number` for the
                      // numeric side, then `f64.eq`. Without this, `"1" == 1` fell
                      // through the string==string arm (right isn't a string) to
                      // ref.eq identity → wrong `false`. The boolean side is already
                      // covered by the typeof-boolean arm above (`true == 1`).
                      // `parseFloat` is deliberately NOT used (Number("0xff")=255 vs
                      // parseFloat("0xff")=NaN — §7.1.4.1).
                      let looseStrNumEmitted = false;
                      if (
                        !isStrict &&
                        ctx.nativeStrings &&
                        ctx.anyStrTypeIdx >= 0 &&
                        (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken)
                      ) {
                        if (!ctx.funcMap.has("__str_to_number")) {
                          emitNativeParseNumber(ctx, new Set(["__str_to_number"]));
                        }
                        const strToNumIdx = ctx.funcMap.get("__str_to_number");
                        if (strToNumIdx !== undefined) {
                          looseStrNumEmitted = true;
                          // ToNumber(side): native string → __str_to_number(extern);
                          // a boxed boolean → §7.1.4 ToNumber(Boolean) = 0/1; else
                          // (a boxed number) → __unbox_number.
                          // (#2503) The boolean arm matters once an Object operand
                          // reduces to a boolean via ToPrimitive (e.g. `"1" == new
                          // Boolean(true)` → §7.2.15 step 8 String⇄Boolean: compare
                          // ToNumber both → `1 == 1`). Before this, the reduced
                          // boolean fell to the identity arm → spurious `false`.
                          const toNumberOf = (anyLocal: number, externLocal: number): Instr[] => [
                            { op: "local.get", index: anyLocal },
                            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx } as Instr,
                            {
                              op: "if",
                              blockType: { kind: "val", type: { kind: "f64" } },
                              then: [
                                { op: "local.get", index: externLocal },
                                { op: "call", funcIdx: strToNumIdx },
                              ],
                              else: [
                                // boolean → 0/1, else unbox the number.
                                { op: "local.get", index: externLocal },
                                { op: "call", funcIdx: typeofBool } as Instr,
                                {
                                  op: "if",
                                  blockType: { kind: "val", type: { kind: "f64" } },
                                  then: [
                                    { op: "local.get", index: externLocal },
                                    { op: "call", funcIdx: unboxBool },
                                    { op: "f64.convert_i32_s" },
                                  ],
                                  else: [
                                    { op: "local.get", index: externLocal },
                                    { op: "call", funcIdx: unboxNum },
                                  ],
                                } as Instr,
                              ],
                            } as Instr,
                          ];
                          // §7.2.15: String⇄Number (steps 4-7) and String⇄Boolean
                          // (step 8 — ToNumber the boolean) both ToNumber-compare.
                          // Fire when exactly one side is a native string and the
                          // OTHER is a number or a boolean.
                          const isNumOrBool = (externLocal: number): Instr[] => [
                            { op: "local.get", index: externLocal },
                            { op: "call", funcIdx: typeofNum } as Instr,
                            { op: "local.get", index: externLocal },
                            { op: "call", funcIdx: typeofBool } as Instr,
                            { op: "i32.or" } as Instr,
                          ];
                          // (lIsStr && rIsNumOrBool) || (rIsStr && lIsNumOrBool)
                          seq.push(
                            { op: "local.get", index: lAny },
                            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx } as Instr,
                            ...isNumOrBool(rTmp),
                            { op: "i32.and" } as Instr,
                            { op: "local.get", index: rAny },
                            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx } as Instr,
                            ...isNumOrBool(lTmp),
                            { op: "i32.and" } as Instr,
                            { op: "i32.or" } as Instr,
                            {
                              op: "if",
                              blockType: { kind: "val", type: { kind: "i32" } },
                              then: [...toNumberOf(lAny, lTmp), ...toNumberOf(rAny, rTmp), { op: "f64.eq" } as Instr],
                              else: stringAndIdentityArm(),
                            } as Instr,
                          );
                        }
                      }
                      if (!looseStrNumEmitted) seq.push(...stringAndIdentityArm());
                      releaseTempLocal(fctx, lAny);
                      releaseTempLocal(fctx, rAny);
                      return seq;
                    })(),
                  ],
                } as Instr,
              ],
            } as Instr,
          ],
        } as Instr,
      ];
      // For loose equality, wrap the core cascade in the nullish guard
      // (§7.2.15 steps 2-3): both nullish ⇒ true; nullish-vs-non-nullish ⇒ false.
      //
      // (#2106 S1) Under the `undefinedSingleton` regime the guard applies to
      // BOTH strict and loose — and is keyed on the regime predicates, not bare
      // `ref.is_null` (which no longer catches the non-null singleton):
      //   loose:  both nullish (`__extern_is_nullish`) ⇒ true.
      //   strict (§7.2.16 via SameType, null and undefined now DISTINCT):
      //     (both null) ∨ (both undefined) ⇒ true; any other nullish pairing ⇒
      //     false. This is the #1961 `bothNullishGuard` re-keyed on the
      //     singleton, exactly as the S1 spec prescribed — it fixes dynamic
      //     `undefined === undefined` / `null === null` (the legacy identity
      //     arm answers 0 for null refs) while keeping `null === undefined`
      //     false.
      const s1NullishGuard = s1Regime && s1IsNullishIdx !== undefined && s1IsUndefIdx !== undefined;
      const eqInstrs: Instr[] = s1NullishGuard
        ? [
            { op: "local.get", index: lTmp },
            { op: "call", funcIdx: s1IsNullishIdx! } as Instr,
            { op: "local.get", index: rTmp },
            { op: "call", funcIdx: s1IsNullishIdx! } as Instr,
            { op: "i32.or" } as Instr,
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: isStrict
                ? [
                    { op: "local.get", index: lTmp },
                    { op: "ref.is_null" } as Instr,
                    { op: "local.get", index: rTmp },
                    { op: "ref.is_null" } as Instr,
                    { op: "i32.and" } as Instr,
                    { op: "local.get", index: lTmp },
                    { op: "call", funcIdx: s1IsUndefIdx! } as Instr,
                    { op: "local.get", index: rTmp },
                    { op: "call", funcIdx: s1IsUndefIdx! } as Instr,
                    { op: "i32.and" } as Instr,
                    { op: "i32.or" } as Instr,
                  ]
                : [
                    { op: "local.get", index: lTmp },
                    { op: "call", funcIdx: s1IsNullishIdx! } as Instr,
                    { op: "local.get", index: rTmp },
                    { op: "call", funcIdx: s1IsNullishIdx! } as Instr,
                    { op: "i32.and" } as Instr,
                  ],
              else: coreEqInstrs,
            } as Instr,
          ]
        : looseNullish
          ? [
              { op: "local.get", index: lTmp },
              { op: "ref.is_null" } as Instr,
              { op: "local.get", index: rTmp },
              { op: "ref.is_null" } as Instr,
              // (lNull || rNull): if EITHER is nullish, the result is whether BOTH
              // are nullish (true) or not (false) — never coerce against a nullish.
              { op: "i32.or" } as Instr,
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  { op: "local.get", index: lTmp },
                  { op: "ref.is_null" } as Instr,
                  { op: "local.get", index: rTmp },
                  { op: "ref.is_null" } as Instr,
                  { op: "i32.and" } as Instr,
                ],
                else: coreEqInstrs,
              } as Instr,
            ]
          : coreEqInstrs;
      for (const ins of eqInstrs) fctx.body.push(ins);
      if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
      releaseTempLocal(fctx, rTmp);
      releaseTempLocal(fctx, lTmp);
      return { kind: "i32" };
    }

    // Wrapper object semantics (#1111): `new Number(n)`, `new String(s)`,
    // `new Boolean(b)` are OBJECTS (typeof x === "object"), not primitives.
    // Strict equality between a wrapper and any primitive is always false.
    // Equality between two wrappers is reference identity.
    // Route through JS host == / === with NO numeric fallback so the answer
    // matches JS spec exactly (the numeric fallback below is only safe when
    // both operands are boxed primitives, not when either is a real JS object).
    const leftIsWrapper = isWrapperObjectType(leftTsType);
    const rightIsWrapper = isWrapperObjectType(rightTsType);
    if (leftIsWrapper || rightIsWrapper) {
      // Coerce operands to externref (right is on top of stack).
      if (rightType.kind !== "externref") {
        coerceType(ctx, fctx, rightType, { kind: "externref" });
      }
      if (leftType.kind !== "externref") {
        const tmpR = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, leftType, { kind: "externref" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      const hostFn = isStrict ? "__host_eq" : "__host_loose_eq";
      const hostIdx = ensureLateImport(ctx, hostFn, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      const finalHostIdx = ctx.funcMap.get(hostFn) ?? hostIdx;
      if (finalHostIdx === undefined) throw new Error(`Missing import after ensureLateImport: ${hostFn}`);
      fctx.body.push({ op: "call", funcIdx: finalHostIdx });
      if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
      return { kind: "i32" };
    }

    // Strict equality: different JS types → always false (===) or true (!==)
    if (isStrict) {
      const leftJsKind = leftIsString ? "string" : leftIsNumber ? "number" : leftIsBool ? "boolean" : "other";
      const rightJsKind = rightIsString ? "string" : rightIsNumber ? "number" : rightIsBool ? "boolean" : "other";
      if (leftJsKind !== "other" && rightJsKind !== "other" && leftJsKind !== rightJsKind) {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
        return { kind: "i32" };
      }
    }

    // (#1986/#1987) Strict equality where exactly one side is an `any`-typed
    // externref and the other is a known primitive (number / boolean) — or both
    // sides are externref `any`. The numeric fallback further down unboxes the
    // externref to f64 via ToNumber (null→0, false→0, "1"→1) and emits f64.eq,
    // which makes `===` behave LOOSER than `==` (`null === 0` → true). Per §7.2.16
    // IsStrictlyEqual must short-circuit to false on a type mismatch with no
    // coercion. Route through `__host_eq` (JS `===`) instead — it gets the spec
    // exactly right, including +0 === -0 (true) and NaN !== NaN. JS-host only; the
    // standalone/WASI path is handled above (the `noJsHost` tag-dispatch block).
    // Strings keep their dedicated `wasm:js-string equals` path below. A
    // boolean-typed side is also excluded: `coerceType(i32 → externref)` boxes
    // it as a JS *number* (`__box_number`), so `__host_eq(true, 1)` would be
    // false — boolean operands keep the existing (correct) lowering, and a
    // boolean `any` compared to a boolean falls through to it.
    if (isStrict && !noJsHost && !leftIsString && !rightIsString && !leftIsBool && !rightIsBool) {
      if (rightType.kind !== "externref") {
        coerceType(ctx, fctx, rightType, { kind: "externref" });
      }
      if (leftType.kind !== "externref") {
        const tmpR = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, leftType, { kind: "externref" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      const hostIdx = ensureLateImport(
        ctx,
        "__host_eq",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalHostIdx = ctx.funcMap.get("__host_eq") ?? hostIdx;
      if (finalHostIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: finalHostIdx });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
    }

    const eitherIsString = leftIsString || rightIsString;
    const bothAreStrings = leftIsString && rightIsString;
    // (#1134) For LOOSE equality where exactly ONE side is a string and the
    // other is a primitive, route through `__host_loose_eq` instead of
    // `wasm:js-string equals`. The wasm equals does strict string===string
    // and never coerces — it silently returns false for `1 == "1"`,
    // `255 == "0xff"`, `0 == ""`, etc.
    if (eitherIsString && !isStrict && !bothAreStrings) {
      if (rightType.kind !== "externref") {
        coerceType(ctx, fctx, rightType, { kind: "externref" });
      }
      if (leftType.kind !== "externref") {
        const tmpR = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, leftType, { kind: "externref" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      const hostIdx = ensureLateImport(
        ctx,
        "__host_loose_eq",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalHostIdx = ctx.funcMap.get("__host_loose_eq") ?? hostIdx;
      if (finalHostIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: finalHostIdx });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
    }
    if (eitherIsString) {
      // Both strings (or strict equality where one is string): use
      // `wasm:js-string equals` — fast string-string compare.
      if (rightType.kind !== "externref") {
        coerceType(ctx, fctx, rightType, { kind: "externref" });
      }
      if (leftType.kind !== "externref") {
        const tmpR = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, leftType, { kind: "externref" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      addStringImports(ctx);
      const equalsIdx = ctx.jsStringImports.get("equals");
      if (equalsIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: equalsIdx });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
    }

    // Reference identity fast-path for externref equality.
    // When both operands are externref (e.g. objects stored as any), check if they
    // are the same GC reference before falling back to numeric unboxing.
    // This fixes `var a = {}; var b = a; a === b` which was incorrectly returning false
    // because numeric unboxing of objects produces NaN, and NaN !== NaN.
    // Uses any.convert_extern to get anyref, then ref.test/ref.cast to eqref for ref.eq.
    // The eq abstract heap type is encoded as -19 in signed LEB128 (= 0x6d).
    const EQ_HEAP_TYPE = -19;
    if (
      leftType.kind === "externref" &&
      rightType.kind === "externref" &&
      !leftIsString &&
      !rightIsString &&
      !leftIsNumber &&
      !rightIsNumber &&
      !leftIsBool &&
      !rightIsBool
    ) {
      // Save both externrefs to temp locals for potential reuse in numeric fallback
      const tmpRight = allocTempLocal(fctx, { kind: "externref" });
      const tmpLeft = allocTempLocal(fctx, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: tmpRight });
      fctx.body.push({ op: "local.set", index: tmpLeft });

      // Convert left to anyref and test if it's an eqref (GC ref)
      fctx.body.push({ op: "local.get", index: tmpLeft });
      fctx.body.push({ op: "any.convert_extern" });
      const tmpAnyLeft = allocTempLocal(fctx, { kind: "anyref" });
      fctx.body.push({ op: "local.tee", index: tmpAnyLeft });
      fctx.body.push({ op: "ref.test", typeIdx: EQ_HEAP_TYPE });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // Left is eqref-compatible — check right too
          { op: "local.get", index: tmpRight },
          { op: "any.convert_extern" },
          ...(() => {
            const tmpAnyRight = allocTempLocal(fctx, { kind: "anyref" });
            const instrs: Instr[] = [
              { op: "local.tee", index: tmpAnyRight },
              { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  // Both are eqref — cast and compare with ref.eq
                  { op: "local.get", index: tmpAnyLeft },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "local.get", index: tmpAnyRight },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "ref.eq" },
                ],
                else: [
                  // Right is not eqref. For STRICT equality (===), a GC eqref
                  // and a non-eqref host externref cannot be ===, so 0 is
                  // definitive. For LOOSE equality (==), JS coercion may still
                  // make them equal — e.g. `0 == -0` where the i31ref +0 is
                  // eqref and the HeapNumber -0 is not. Push -1 sentinel so
                  // the outer `if (i32.ne result -1)` branches into the host
                  // fallback (`__host_loose_eq`) which calls JS `==`. (#1134)
                  { op: "i32.const", value: isStrict ? 0 : -1 },
                ],
              },
            ];
            releaseTempLocal(fctx, tmpAnyRight);
            return instrs;
          })(),
        ],
        else: [
          // Left is not eqref — fall through to numeric / host comparison
          // by pushing -1 as sentinel to indicate "not handled"
          { op: "i32.const", value: -1 },
        ],
      });
      releaseTempLocal(fctx, tmpAnyLeft);

      // Check if the identity comparison produced a definitive result (0 or 1)
      // vs the sentinel -1 (meaning we need numeric fallback)
      const identityResult = allocTempLocal(fctx, { kind: "i32" });
      fctx.body.push({ op: "local.tee", index: identityResult });
      fctx.body.push({ op: "i32.const", value: -1 });
      fctx.body.push({ op: "i32.ne" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // Identity check produced 0 or 1 — use it directly
          // For != / !==, negate
          { op: "local.get", index: identityResult },
          ...(isNeqOp ? [{ op: "i32.eqz" } as Instr] : []),
        ],
        else: (() => {
          // Host equality fallback — two host externrefs (e.g. functions
          // like `Array === Array`) are not WasmGC eqrefs, so ref.eq cannot
          // compare them. For strict equality, `__host_eq` calls JS `===`.
          // For loose equality, `__host_loose_eq` calls JS `==` which
          // handles null==undefined and type coercion per §7.2.15. (#1065, #1134)
          addUnionImports(ctx);
          if (isStrict) {
            // Strict equality: __host_eq (JS ===) for reference identity.
            // If that returns false, fall through to numeric unboxing for
            // boxed numbers that differ in identity but have the same value. (#1065)
            //
            // (#1383) Gate the numeric-unbox fallback on a runtime typeof
            // check — only fire it when BOTH operands are typeof === "number".
            // The fallback was load-bearing for genuinely-different-identity
            // boxed numbers (V8 sometimes returns different externref ids for
            // numerically-equal JS numbers), but it incorrectly succeeded for
            // cross-type strict comparisons too: `null === 0` produced
            // `__unbox_number(null) === 0`, `__unbox_number(0) === 0`, true.
            // Spec §7.2.16 says strict equality between values of different
            // types is always false.
            //
            // Earlier PR #272 tried to drop the fallback entirely and caused
            // -12 net test262 — the fallback was masking unrelated mismatches
            // (boolean / undefined externrefs that also happen to land in
            // the externref-vs-externref path). Gating with a typeof check
            // preserves the load-bearing same-type case AND fixes the
            // cross-type leak.
            const hostEqIdx = ensureLateImport(
              ctx,
              "__host_eq",
              [{ kind: "externref" }, { kind: "externref" }],
              [{ kind: "i32" }],
            );
            flushLateImportShifts(ctx, fctx);
            const finalHostEqIdx = ctx.funcMap.get("__host_eq") ?? hostEqIdx;
            const typeofNumIdx = ctx.funcMap.get("__typeof_number")!;
            const unboxIdx = ctx.funcMap.get("__unbox_number")!;
            return [
              { op: "local.get", index: tmpLeft },
              { op: "local.get", index: tmpRight },
              { op: "call", funcIdx: finalHostEqIdx } as Instr,
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "i32.const", value: isNeqOp ? 0 : 1 } as Instr],
                else: [
                  // Both operands must be JS numbers for the numeric-unbox
                  // fallback to be sound. Otherwise host_eq's `false` is
                  // definitive (cross-type strict equality is always false).
                  { op: "local.get", index: tmpLeft },
                  { op: "call", funcIdx: typeofNumIdx } as Instr,
                  { op: "local.get", index: tmpRight },
                  { op: "call", funcIdx: typeofNumIdx } as Instr,
                  { op: "i32.and" } as Instr,
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "i32" } },
                    then: [
                      // Both numbers: numeric-unbox compare is safe and
                      // recovers same-value-different-identity cases.
                      { op: "local.get", index: tmpLeft },
                      { op: "call", funcIdx: unboxIdx },
                      { op: "local.get", index: tmpRight },
                      { op: "call", funcIdx: unboxIdx },
                      { op: isEqOp ? "f64.eq" : "f64.ne" } as Instr,
                    ] as Instr[],
                    else: [
                      // Cross-type or non-number: host_eq's false is final.
                      { op: "i32.const", value: isNeqOp ? 1 : 0 } as Instr,
                    ] as Instr[],
                  } as Instr,
                ] as Instr[],
              } as Instr,
            ] as Instr[];
          } else {
            // Loose equality fallback for two externref `any` operands that are
            // not eqref-identical.
            //
            // (#2081) STANDALONE/WASI has no JS host, so `__host_loose_eq` is an
            // unsatisfiable import — it leaked into the module and made
            // `("1" as any) == (1 as any)` either fail instantiation or return a
            // wrong `false` (ref-identity never coerces string⇄number). Route
            // through the NATIVE IsLooselyEqual instead: box both externrefs to
            // `$AnyValue` (`__any_from_extern` → tag5 string / tag3 number / tag4
            // bool / tag1 null) and call `__any_eq`, whose §7.2.15 arms
            // (incl. the String⇄Number arm added in this PR) implement the spec
            // coercion natively. Host mode keeps `__host_loose_eq` (JS `==`),
            // unchanged.
            // (#1917 E6) The standalone native IsLooselyEqual tail — box both
            // externrefs to `$AnyValue` and call the keystone `__any_eq` — is the
            // same tag-5-sensitive dispatch the coercion engine owns for E3, so it
            // lives in `emitAnyEqFromExternTemps`. `null` ⇒ helpers unavailable
            // (should not happen) → fall through to the host import below.
            const noJsHost = ctx.standalone === true || ctx.wasi === true;
            if (noJsHost) {
              const nativeLooseEq = emitAnyEqFromExternTemps(ctx, tmpLeft, tmpRight, isNeqOp);
              if (nativeLooseEq !== null) {
                return nativeLooseEq;
              }
            }
            // Loose equality: __host_loose_eq (JS ==) handles all coercion
            // rules including null==undefined per §7.2.15. The result is
            // definitive — no numeric fallback needed. (#1134)
            const hostLooseEqIdx = ensureLateImport(
              ctx,
              "__host_loose_eq",
              [{ kind: "externref" }, { kind: "externref" }],
              [{ kind: "i32" }],
            );
            flushLateImportShifts(ctx, fctx);
            const finalHostLooseEqIdx = ctx.funcMap.get("__host_loose_eq") ?? hostLooseEqIdx;
            return [
              { op: "local.get", index: tmpLeft },
              { op: "local.get", index: tmpRight },
              { op: "call", funcIdx: finalHostLooseEqIdx } as Instr,
              ...(isNeqOp ? [{ op: "i32.eqz" } as Instr] : []),
            ] as Instr[];
          }
        })(),
      });
      releaseTempLocal(fctx, identityResult);
      releaseTempLocal(fctx, tmpRight);
      releaseTempLocal(fctx, tmpLeft);
      return { kind: "i32" };
    }

    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number")!;
    // Coerce/unbox right side (top of stack) to f64
    if (rightType.kind === "externref") {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    } else if (rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    // Coerce/unbox left side (below right on stack) to f64
    if (leftType.kind === "externref") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    } else if (leftType.kind === "i32") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    fctx.body.push({ op: isEqOp ? "f64.eq" : "f64.ne" });
    return { kind: "i32" };
  }

  // ── Fallback: coerce remaining type mismatches to f64 for numeric ops ──
  // When operand types don't match any specific path above (e.g. ref + externref,
  // i64 + externref, or other ambiguous combos), try to coerce both to f64.
  if (isNumericOp) {
    // Coerce right operand (top of stack) to f64
    if (rightType.kind === "externref") {
      coerceType(ctx, fctx, rightType, { kind: "f64" }, "number");
    } else if (rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (rightType.kind === "i64") {
      fctx.body.push({ op: "f64.convert_i64_s" });
    } else if (rightType.kind === "ref" || rightType.kind === "ref_null") {
      coerceType(ctx, fctx, rightType, { kind: "f64" });
    }
    // Coerce left operand (below right on stack) — save right to local
    if (
      leftType.kind === "externref" ||
      leftType.kind === "i32" ||
      leftType.kind === "i64" ||
      leftType.kind === "ref" ||
      leftType.kind === "ref_null"
    ) {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      if (leftType.kind === "externref") {
        coerceType(ctx, fctx, leftType, { kind: "f64" }, "number");
      } else if (leftType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      } else if (leftType.kind === "i64") {
        fctx.body.push({ op: "f64.convert_i64_s" });
      } else if (leftType.kind === "ref" || leftType.kind === "ref_null") {
        coerceType(ctx, fctx, leftType, { kind: "f64" });
      }
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  reportError(ctx, expr, `Unsupported binary operator for type`);
  return null;
}

/**
 * Compile a binary expression where both operands are `any`-typed.
 * Emits both operands as ref $AnyValue and calls the appropriate __any_* helper.
 */
function compileAnyBinaryDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): InnerResult {
  // (#1917 Step E3) Equality (`==`/`===`/`!=`/`!==`) is the dispatch layer the
  // coercion engine owns: `emitStrictEq`/`emitLooseEq` select the helper, box
  // both operands, emit the call, and negate for `!=`/`!==`. This is a
  // byte-neutral extraction of the four equality arms below — same helper, same
  // operand boxing, same `i32.eqz` negation — so the engine becomes the single
  // home for equality dispatch while the tag-5 classifier stays in the
  // `__any_eq`/`__any_strict_eq` helper bodies (any-helpers.ts).
  switch (op) {
    case ts.SyntaxKind.EqualsEqualsToken:
      return emitLooseEq(ctx, fctx, expr, /*negate*/ false);
    case ts.SyntaxKind.ExclamationEqualsToken:
      return emitLooseEq(ctx, fctx, expr, /*negate*/ true);
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      return emitStrictEq(ctx, fctx, expr, /*negate*/ false);
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return emitStrictEq(ctx, fctx, expr, /*negate*/ true);
    default:
      break;
  }

  // Map operator to helper name and result type
  let helperName: string | null = null;
  let resultIsI32 = false; // true for comparison/equality operators

  switch (op) {
    case ts.SyntaxKind.PlusToken:
      helperName = "__any_add";
      break;
    case ts.SyntaxKind.MinusToken:
      helperName = "__any_sub";
      break;
    case ts.SyntaxKind.AsteriskToken:
      helperName = "__any_mul";
      break;
    case ts.SyntaxKind.SlashToken:
      helperName = "__any_div";
      break;
    case ts.SyntaxKind.PercentToken:
      helperName = "__any_mod";
      break;
    // NOTE: `==`/`===`/`!=`/`!==` are handled above by emitLooseEq/emitStrictEq
    // (the coercion engine owns equality dispatch, #1917 Step E3) and never reach
    // this switch.
    case ts.SyntaxKind.LessThanToken:
      helperName = "__any_lt";
      resultIsI32 = true;
      break;
    case ts.SyntaxKind.GreaterThanToken:
      helperName = "__any_gt";
      resultIsI32 = true;
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      helperName = "__any_le";
      resultIsI32 = true;
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      helperName = "__any_ge";
      resultIsI32 = true;
      break;
    default:
      return null; // Not a supported operator for any dispatch
  }

  ensureAnyHelpers(ctx);
  const funcIdx = ctx.funcMap.get(helperName);
  if (funcIdx === undefined) return null;

  // Compile both operands. The helpers (`__any_add`, `__any_eq`, …) all take
  // `(ref null $AnyValue, ref null $AnyValue)` parameters, so any operand
  // that didn't naturally produce an AnyValue must be boxed before the call.
  // Without this coercion, recursive `any`-typed functions whose body
  // contains `f(...) + f(...)` validate as "call param types must match"
  // because the recursive call returns f64 (or i32) while the helper
  // expects ref $AnyValue (#1211).
  const anyValueTarget: ValType = { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) return null;
  if (!isAnyValue(leftType, ctx)) {
    coerceType(ctx, fctx, leftType, anyValueTarget);
  }
  const rightType = compileExpression(ctx, fctx, expr.right);
  if (!rightType) return null;
  if (!isAnyValue(rightType, ctx)) {
    coerceType(ctx, fctx, rightType, anyValueTarget);
  }

  fctx.body.push({ op: "call", funcIdx });

  // NOTE: the `!=` / `!==` negation that used to live here is now applied by
  // `emitLooseEq`/`emitStrictEq` (the equality ops return early above and never
  // reach this point — #1917 Step E3). The remaining ops here are arithmetic /
  // relational, which need no negation.

  if (resultIsI32) {
    return { kind: "i32" };
  }
  return { kind: "ref", typeIdx: ctx.anyValueTypeIdx };
}

/**
 * (#2358) A typed object literal / class instance compiles to a NOMINAL WasmGC
 * struct (`__anon_N` / `ClassName`), whose concrete `typeIdx` carries the static
 * `valueOf` / `@@toPrimitive` the `coerceType(ref-struct → f64)` engine
 * (`type-coercion.ts:1723`) can dispatch at compile time. The moment that struct
 * is coerced to externref (`extern.convert_any`), the typeIdx is erased and the
 * standalone native `__to_primitive` helper — which only recognises the dynamic
 * `$Object` runtime struct via `ref.test objectTypeIdx` — can no longer reduce
 * it (it returns the object unchanged → caller `__unbox_number` → NaN/null).
 *
 * So when an `emitAnyAdd` operand is a nominal struct with a *static*
 * number-producing ToPrimitive (a `valueOf` or `@@toPrimitive`), reduce it to a
 * primitive HERE, while the typeIdx is still known, reusing the single #1917
 * coercion engine — then box. The result is an already-primitive externref, so
 * the later `__to_primitive` call in the §13.15.3 dispatch is a no-op on it.
 *
 * Scoped to valueOf/@@toPrimitive (number-producing) only: a `toString`-only
 * struct stays on the existing `extern.convert_any` path (no behaviour change),
 * because the f64 reduction would lossily NaN a string-returning `toString`.
 */
function structHasStaticNumericToPrimitive(ctx: CodegenContext, name: string | undefined): boolean {
  if (name === undefined || !ctx.structMap.has(name)) return false;
  // Class / standalone-function form: ClassName_@@toPrimitive / ClassName_valueOf.
  if (ctx.funcMap.get(`${name}_@@toPrimitive`) !== undefined) return true;
  if (ctx.funcMap.get(`${name}_valueOf`) !== undefined) return true;
  // Object-literal form: a `valueOf` field holding a callable zero-arg closure
  // tracked for this struct (the eqref/ref closure path coerceType dispatches).
  const fields = ctx.structFields.get(name);
  if (fields) {
    const vof = fields.find((f) => f.name === "valueOf");
    if (vof) {
      const tracked = ctx.valueOfClosureTypes.get(name);
      if (tracked && tracked.length > 0) return true;
      // A `valueOf` field holding a closure ref is still reduced by the static
      // engine's closure-ref subpath even without separately-tracked types.
      if (vof.type.kind === "ref" || vof.type.kind === "ref_null" || vof.type.kind === "eqref") return true;
    }
  }
  return false;
}

/**
 * (#2358) Compile one `+` operand into a fresh externref temp and return its
 * index (or null if the operand failed to compile).
 *
 * The common case keeps the status-quo `{externref}` expectedType, which keeps a
 * runtime string boxed (no ToNumber coercion) so §13.15.3 can concatenate —
 * byte-identical to before. The ONLY divergence is when the operand statically
 * resolves (through `as`/parenthesized/non-null wrappers) to a NOMINAL object
 * struct with a number-producing ToPrimitive (`valueOf`/`@@toPrimitive`): then it
 * is compiled WITHOUT the hint (so the concrete `typeIdx` survives) and reduced
 * to a boxed primitive via the shared #1917 coercion engine, while the typeIdx is
 * still known. Crossing the externref boundary unreduced would strand the struct
 * — the native `__to_primitive` helper only recognises the dynamic `$Object`, so
 * it passes a nominal struct through → `__unbox_number` → NaN/null.
 *
 * Scoped to valueOf/@@toPrimitive (number-producing) so the §13.15.3 string-vs-
 * numeric decision still sees the right primitive; a `toString`-only struct stays
 * on the existing boxed-externref path (string concat unaffected).
 */
function emitAddOperand(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): number | null {
  const noJsHost = ctx.standalone === true || ctx.wasi === true;
  // Unwrap `as`/parenthesized/non-null/satisfies wrappers (e.g. `(o as any)`):
  // the wrappers are type-only / identity, but they make TS report the operand
  // type as `any` (so the struct name can't be resolved) and make
  // `compileExpression` coerce the struct to externref internally (erasing the
  // typeIdx). Resolving + compiling the UNWRAPPED inner expression recovers both.
  let inner: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = (inner as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  const structName = noJsHost ? resolveStructNameForExpr(ctx, fctx, inner) : undefined;
  if (noJsHost && structHasStaticNumericToPrimitive(ctx, structName)) {
    const opType = compileExpression(ctx, fctx, inner);
    if (!opType) return null;
    if (opType.kind === "ref" || opType.kind === "ref_null") {
      // Static ToPrimitive(default) → f64 (valueOf/@@toPrimitive ordering), box.
      coerceType(ctx, fctx, opType, { kind: "f64" }, "default");
      addUnionImports(ctx);
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        coerceType(ctx, fctx, { kind: "f64" }, { kind: "externref" });
      }
    } else if (opType.kind !== "externref") {
      // The struct collapsed to a non-ref scalar (e.g. inlined) — coerce normally.
      coerceType(ctx, fctx, opType, { kind: "externref" });
    }
    const tmp = allocTempLocal(fctx, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: tmp });
    return tmp;
  }
  // Status-quo path: externref hint keeps runtime strings boxed for §13.15.3.
  const opType = compileExpression(ctx, fctx, expr, { kind: "externref" });
  if (!opType) return null;
  if (opType.kind !== "externref") {
    coerceType(ctx, fctx, opType, { kind: "externref" });
  }
  const tmp = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: tmp });
  return tmp;
}

/**
 * (#2058) Emit `+` for two operands where at least one is a dynamic externref
 * (an `any`/`unknown`/boxed value). The operands are already on the Wasm stack
 * (left below right). Per §13.15.3 ApplyStringOrNumericBinaryOperator a runtime
 * string on either side must CONCATENATE, not coerce to f64 — so we cannot take
 * the externref-numeric f64 fast path.
 *
 * JS-host mode delegates to `__host_add` (JS `+`), which gives ToPrimitive, the
 * string-if-either-is-string rule, and object valueOf/toString ordering for
 * free. Standalone/WASI has no JS host, so we build the operation in-module from
 * the union-native typeof/unbox probes + native string concat. If neither host
 * nor native-string support is available we fall back to the legacy f64 add
 * (status quo — no regression).
 *
 * Returns the value type left on the stack (`externref` for the host/native
 * paths — a boxed number-or-string the caller stores into the `any` slot — or
 * `f64` for the legacy numeric fallback).
 */
export function emitAnyAdd(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  const noJsHost = ctx.standalone === true || ctx.wasi === true;

  // #1988: in standalone/WASI the §13.15.3 string-vs-numeric decision must be
  // made on the ToPrimitive(default) results, not the raw operands — an object
  // or array reduces (valueOf→toString) to a STRING, which forces string
  // concatenation. The native `__to_primitive` helper that performs that
  // reduction is registered by `ensureObjectRuntime`. Run it here, BEFORE the
  // operands are compiled into `fctx.body`, so any one-time funcIdx setup it
  // does cannot desync the current function body. It registers only defined
  // funcs (no import shift) and is idempotent, so this is a no-op when the
  // object runtime is already present.
  if (noJsHost && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    ensureObjectRuntime(ctx);
  }

  // Compile both operands to externref temps. Passing the externref hint keeps a
  // runtime string boxed (no ToNumber coercion) so §13.15.3 can concatenate.
  // (#2358) EXCEPT when the operand statically resolves to a nominal object
  // struct with a number-producing ToPrimitive (`valueOf`/`@@toPrimitive`): then
  // compile it WITHOUT the externref hint (so its concrete typeIdx survives) and
  // reduce it to a boxed primitive via the shared coercion engine, while the
  // typeIdx is still known. Crossing the externref boundary unreduced strands the
  // struct — the native `__to_primitive` helper only recognises the dynamic
  // `$Object`, so it would pass the nominal struct through → `__unbox_number` →
  // NaN/null. Every other operand keeps the exact status-quo `{externref}`-hint
  // path (byte-identical), so string concat is unaffected.
  const lTmp = emitAddOperand(ctx, fctx, expr.left);
  if (lTmp === null) return { kind: "externref" };
  const rTmp = emitAddOperand(ctx, fctx, expr.right);
  if (rTmp === null) {
    releaseTempLocal(fctx, lTmp);
    return { kind: "externref" };
  }

  // ── JS-host: JS `+` via __host_add ──
  if (!noJsHost) {
    fctx.body.push({ op: "local.get", index: lTmp });
    fctx.body.push({ op: "local.get", index: rTmp });
    releaseTempLocal(fctx, rTmp);
    releaseTempLocal(fctx, lTmp);
    const hostIdx = ensureLateImport(
      ctx,
      "__host_add",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    const finalIdx = ctx.funcMap.get("__host_add") ?? hostIdx;
    if (finalIdx === undefined) throw new Error("Missing import after ensureLateImport: __host_add");
    fctx.body.push({ op: "call", funcIdx: finalIdx });
    return { kind: "externref" };
  }

  // ── Standalone / WASI: build §13.15.3 in-module ──
  // Requires native-string support for the concat arm; otherwise fall back.
  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    ensureNativeStringHelpers(ctx);
    addUnionImports(ctx);
    const typeofStr = ctx.funcMap.get("__typeof_string");
    const unboxNum = ctx.funcMap.get("__unbox_number");
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
    // #1988: the native ToPrimitive helper registered by `ensureObjectRuntime`
    // (called at the top of this function). Reducing the operands to primitives
    // BEFORE the string-vs-numeric test is what §13.15.3 requires — an object /
    // array operand becomes its toString string, forcing concatenation. When it
    // is unavailable (older minimal standalone path) we degrade to the previous
    // raw-operand dispatch rather than failing.
    const toPrimIdx = ctx.funcMap.get("__to_primitive");
    if (typeofStr !== undefined && unboxNum !== undefined && concatIdx !== undefined) {
      // ToString(externref) → ref $AnyString, via the runtime walker (handles
      // boxed strings, numbers, null/undefined, and struct valueOf/toString).
      const externToStr = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      const finalToStr = ctx.funcMap.get("__extern_toString") ?? externToStr;

      // §13.15.3 step 1-2: lprim = ToPrimitive(left, default); rprim =
      // ToPrimitive(right, default). The "default" hint maps to valueOf→toString
      // ordering; `__to_primitive` treats a null hint as default. Plain objects
      // and arrays (no exotic valueOf) reduce to their toString string, so the
      // string test below then forces concatenation. Reduce into fresh temps so
      // both the typeof test and the two arms operate on the SAME primitives
      // (no double-evaluation of valueOf/toString).
      const lPrim = allocTempLocal(fctx, { kind: "externref" });
      const rPrim = allocTempLocal(fctx, { kind: "externref" });
      if (toPrimIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: lTmp });
        fctx.body.push({ op: "ref.null.extern" } as Instr); // default hint
        fctx.body.push({ op: "call", funcIdx: toPrimIdx } as Instr);
        fctx.body.push({ op: "local.set", index: lPrim });
        fctx.body.push({ op: "local.get", index: rTmp });
        fctx.body.push({ op: "ref.null.extern" } as Instr);
        fctx.body.push({ op: "call", funcIdx: toPrimIdx } as Instr);
        fctx.body.push({ op: "local.set", index: rPrim });
      } else {
        // Degrade: no ToPrimitive available — carry the raw operands through.
        fctx.body.push({ op: "local.get", index: lTmp });
        fctx.body.push({ op: "local.set", index: lPrim });
        fctx.body.push({ op: "local.get", index: rTmp });
        fctx.body.push({ op: "local.set", index: rPrim });
      }

      const emitToAnyString = (tmp: number): Instr[] => [
        { op: "local.get", index: tmp },
        { op: "call", funcIdx: finalToStr } as Instr,
        { op: "any.convert_extern" } as Instr,
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
      ];

      // if (__typeof_string(lprim) | __typeof_string(rprim)) → concat both as
      //                                            strings
      //                                      else            → f64.add(unbox, unbox)
      const concatArm: Instr[] = [
        ...emitToAnyString(lPrim),
        ...emitToAnyString(rPrim),
        { op: "call", funcIdx: concatIdx } as Instr,
        { op: "extern.convert_any" } as Instr,
      ];
      const numericArm: Instr[] = [
        { op: "local.get", index: lPrim },
        { op: "call", funcIdx: unboxNum } as Instr,
        { op: "local.get", index: rPrim },
        { op: "call", funcIdx: unboxNum } as Instr,
        { op: "f64.add" } as Instr,
      ];
      // Box the numeric arm's f64 result back to externref so both arms agree.
      const boxNum = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      const finalBoxNum = ctx.funcMap.get("__box_number") ?? boxNum;
      numericArm.push({ op: "call", funcIdx: finalBoxNum } as Instr);

      fctx.body.push({ op: "local.get", index: lPrim });
      fctx.body.push({ op: "call", funcIdx: typeofStr } as Instr);
      fctx.body.push({ op: "local.get", index: rPrim });
      fctx.body.push({ op: "call", funcIdx: typeofStr } as Instr);
      fctx.body.push({ op: "i32.or" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: concatArm,
        else: numericArm,
      } as Instr);
      releaseTempLocal(fctx, rPrim);
      releaseTempLocal(fctx, lPrim);
      releaseTempLocal(fctx, rTmp);
      releaseTempLocal(fctx, lTmp);
      return { kind: "externref" };
    }
  }

  // ── Fallback: no host, no native strings → legacy f64 add (status quo) ──
  fctx.body.push({ op: "local.get", index: lTmp });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" }, "number");
  fctx.body.push({ op: "local.get", index: rTmp });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" }, "number");
  releaseTempLocal(fctx, rTmp);
  releaseTempLocal(fctx, lTmp);
  fctx.body.push({ op: "f64.add" });
  return { kind: "f64" };
}

/**
 * (#2059) Emit a relational (`<`,`<=`,`>`,`>=`) for two operands where at least
 * one is a dynamic externref (an `any`/`unknown` value). Operands are compiled
 * here (not yet on the stack). Per §7.2.13 IsLessThan two string operands compare
 * lexicographically and a string-vs-number compares numerically — the f64 paths
 * would ToNumber both sides (`Number("a")` → NaN) and yield `false`.
 *
 * JS-host delegates to `__host_compare` (JS `<`/`>`), which returns a 4-way
 * result -1/0/1/2 (2 = NaN/undefined-incomparable). Standalone builds §7.2.13 in
 * module: both-string → native `__str_compare`, else ToNumber + f64. Returns i32
 * (the boolean relational result).
 */
export function emitAnyRelational(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType {
  const noJsHost = ctx.standalone === true || ctx.wasi === true;

  // Compile both operands to externref temps (keep runtime strings boxed).
  const lType = compileExpression(ctx, fctx, expr.left, { kind: "externref" });
  if (!lType) return { kind: "i32" };
  if (lType.kind !== "externref") coerceType(ctx, fctx, lType, { kind: "externref" });
  const lTmp = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: lTmp });
  const rType = compileExpression(ctx, fctx, expr.right, { kind: "externref" });
  if (!rType) {
    releaseTempLocal(fctx, lTmp);
    return { kind: "i32" };
  }
  if (rType.kind !== "externref") coerceType(ctx, fctx, rType, { kind: "externref" });
  const rTmp = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: rTmp });

  // Map a -1/0/1/2 `cmp` (or an f64 comparison) to the operator's boolean result.
  // The `2` (incomparable) sentinel must make ALL four operators yield 0, so we
  // test the concrete values explicitly rather than `cmp <= 0` / `cmp >= 0`.
  const mapCmpToOp = (cmpTmp: number): void => {
    switch (op) {
      case ts.SyntaxKind.LessThanToken: // cmp == -1
        fctx.body.push({ op: "local.get", index: cmpTmp });
        fctx.body.push({ op: "i32.const", value: -1 });
        fctx.body.push({ op: "i32.eq" });
        break;
      case ts.SyntaxKind.GreaterThanToken: // cmp == 1
        fctx.body.push({ op: "local.get", index: cmpTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.eq" });
        break;
      case ts.SyntaxKind.LessThanEqualsToken: // cmp == -1 || cmp == 0
        fctx.body.push({ op: "local.get", index: cmpTmp });
        fctx.body.push({ op: "i32.const", value: -1 });
        fctx.body.push({ op: "i32.eq" });
        fctx.body.push({ op: "local.get", index: cmpTmp });
        fctx.body.push({ op: "i32.eqz" }); // cmp == 0
        fctx.body.push({ op: "i32.or" });
        break;
      case ts.SyntaxKind.GreaterThanEqualsToken: // cmp == 1 || cmp == 0
        fctx.body.push({ op: "local.get", index: cmpTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.eq" });
        fctx.body.push({ op: "local.get", index: cmpTmp });
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({ op: "i32.or" });
        break;
    }
  };

  // ── JS-host: __host_compare → -1/0/1/2 ──
  if (!noJsHost) {
    fctx.body.push({ op: "local.get", index: lTmp });
    fctx.body.push({ op: "local.get", index: rTmp });
    const hostIdx = ensureLateImport(
      ctx,
      "__host_compare",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    const finalIdx = ctx.funcMap.get("__host_compare") ?? hostIdx;
    if (finalIdx === undefined) throw new Error("Missing import after ensureLateImport: __host_compare");
    fctx.body.push({ op: "call", funcIdx: finalIdx });
    const cmpTmp = allocTempLocal(fctx, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: cmpTmp });
    mapCmpToOp(cmpTmp);
    releaseTempLocal(fctx, cmpTmp);
    releaseTempLocal(fctx, rTmp);
    releaseTempLocal(fctx, lTmp);
    return { kind: "i32" };
  }

  // ── Standalone / WASI: §7.2.13 in-module ──
  // both strings → lexicographic __str_compare; else ToNumber both + f64 compare.
  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    ensureNativeStringHelpers(ctx);
    addUnionImports(ctx);
    const typeofStr = ctx.funcMap.get("__typeof_string");
    const unboxNum = ctx.funcMap.get("__unbox_number");
    const strCompare = ctx.nativeStrHelpers.get("__str_compare");
    const strFlatten = ctx.nativeStrHelpers.get("__str_flatten");
    if (typeofStr !== undefined && unboxNum !== undefined && strCompare !== undefined && strFlatten !== undefined) {
      // ToString-free lexicographic compare of two boxed native strings → -1/0/1.
      const toFlatNativeStr = (tmp: number): Instr[] => [
        { op: "local.get", index: tmp },
        { op: "any.convert_extern" } as Instr,
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
        { op: "call", funcIdx: strFlatten } as Instr,
      ];
      const strArm: Instr[] = [
        ...toFlatNativeStr(lTmp),
        ...toFlatNativeStr(rTmp),
        { op: "call", funcIdx: strCompare } as Instr,
      ];
      // Numeric arm: ToNumber(unbox) both sides, then derive a -1/0/1/2 sign.
      const lf = allocTempLocal(fctx, { kind: "f64" });
      const rf = allocTempLocal(fctx, { kind: "f64" });
      const numSign: Instr[] = [
        { op: "local.get", index: lTmp },
        { op: "call", funcIdx: unboxNum } as Instr,
        { op: "local.set", index: lf },
        { op: "local.get", index: rTmp },
        { op: "call", funcIdx: unboxNum } as Instr,
        { op: "local.set", index: rf },
        // (l < r) ? -1 : (l > r ? 1 : (l == r ? 0 : 2))
        { op: "local.get", index: lf },
        { op: "local.get", index: rf },
        { op: "f64.lt" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: -1 } as Instr],
          else: [
            { op: "local.get", index: lf },
            { op: "local.get", index: rf },
            { op: "f64.gt" } as Instr,
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [{ op: "i32.const", value: 1 } as Instr],
              else: [
                { op: "local.get", index: lf },
                { op: "local.get", index: rf },
                { op: "f64.eq" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [{ op: "i32.const", value: 0 } as Instr],
                  else: [{ op: "i32.const", value: 2 } as Instr], // NaN → incomparable
                } as Instr,
              ],
            } as Instr,
          ],
        } as Instr,
      ];
      const cmpTmp = allocTempLocal(fctx, { kind: "i32" });
      // if (__typeof_string(l) && __typeof_string(r)) strArm else numSign
      fctx.body.push({ op: "local.get", index: lTmp });
      fctx.body.push({ op: "call", funcIdx: typeofStr } as Instr);
      fctx.body.push({ op: "local.get", index: rTmp });
      fctx.body.push({ op: "call", funcIdx: typeofStr } as Instr);
      fctx.body.push({ op: "i32.and" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: strArm,
        else: numSign,
      } as Instr);
      fctx.body.push({ op: "local.set", index: cmpTmp });
      mapCmpToOp(cmpTmp);
      releaseTempLocal(fctx, cmpTmp);
      releaseTempLocal(fctx, rf);
      releaseTempLocal(fctx, lf);
      releaseTempLocal(fctx, rTmp);
      releaseTempLocal(fctx, lTmp);
      return { kind: "i32" };
    }
  }

  // ── Fallback: no host, no native strings → legacy f64 compare (status quo) ──
  fctx.body.push({ op: "local.get", index: lTmp });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" }, "number");
  fctx.body.push({ op: "local.get", index: rTmp });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" }, "number");
  releaseTempLocal(fctx, rTmp);
  releaseTempLocal(fctx, lTmp);
  switch (op) {
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "f64.lt" });
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "f64.le" });
      break;
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "f64.gt" });
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "f64.ge" });
      break;
  }
  return { kind: "i32" };
}

export function compileNumericBinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
  expr: ts.BinaryExpression,
): ValType {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      fctx.body.push({ op: "f64.add" });
      return { kind: "f64" };
    case ts.SyntaxKind.MinusToken:
      fctx.body.push({ op: "f64.sub" });
      return { kind: "f64" };
    case ts.SyntaxKind.AsteriskToken:
      fctx.body.push({ op: "f64.mul" });
      return { kind: "f64" };
    case ts.SyntaxKind.AsteriskAsteriskToken: {
      const funcIdx = ctx.funcMap.get("Math_pow");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "f64" };
      }
      reportError(ctx, expr, "Math_pow import not found for ** operator");
      return { kind: "f64" };
    }
    case ts.SyntaxKind.SlashToken:
      fctx.body.push({ op: "f64.div" });
      return { kind: "f64" };
    case ts.SyntaxKind.PercentToken:
      return compileModulo(ctx, fctx, expr);
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      fctx.body.push({ op: "f64.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      fctx.body.push({ op: "f64.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "f64.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "f64.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "f64.lt" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "f64.le" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "f64.gt" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "f64.ge" });
      return { kind: "i32" };
    case ts.SyntaxKind.AmpersandToken:
      return compileBitwiseBinaryOp(fctx, "i32.and", false);
    case ts.SyntaxKind.BarToken:
      return compileBitwiseBinaryOp(fctx, "i32.or", false);
    case ts.SyntaxKind.CaretToken:
      return compileBitwiseBinaryOp(fctx, "i32.xor", false);
    case ts.SyntaxKind.LessThanLessThanToken:
      return compileBitwiseBinaryOp(fctx, "i32.shl", false);
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return compileBitwiseBinaryOp(fctx, "i32.shr_s", false);
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return compileBitwiseBinaryOp(fctx, "i32.shr_u", true);
    default:
      reportError(ctx, expr, `Unsupported numeric binary operator: ${ts.SyntaxKind[op]}`);
      return { kind: "f64" };
  }
}

/** Fast mode: i32 arithmetic/comparison on two i32 operands */
function compileI32BinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
  expr: ts.BinaryExpression,
): ValType {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      fctx.body.push({ op: "i32.add" });
      return { kind: "i32" };
    case ts.SyntaxKind.MinusToken:
      fctx.body.push({ op: "i32.sub" });
      return { kind: "i32" };
    case ts.SyntaxKind.AsteriskToken:
      fctx.body.push({ op: "i32.mul" });
      return { kind: "i32" };
    case ts.SyntaxKind.PercentToken:
      // Guard the trapping cases of i32.rem_s. Wasm traps on `b == 0` and on
      // `INT_MIN % -1` (signed overflow). JS yields NaN and 0 respectively; in
      // i32 fast mode the result is an i32 (no NaN representation), so emit 0
      // for both trapping cases (0 is the mathematically-correct INT_MIN % -1
      // result, and truncating JS's NaN result to i32 is also 0). See #1825.
      emitSafeI32Rem(fctx);
      return { kind: "i32" };
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "i32.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "i32.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "i32.lt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "i32.le_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "i32.gt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "i32.ge_s" });
      return { kind: "i32" };
    // Bitwise — direct i32 ops (no conversion needed!)
    case ts.SyntaxKind.AmpersandToken:
      fctx.body.push({ op: "i32.and" });
      return { kind: "i32" };
    case ts.SyntaxKind.BarToken:
      fctx.body.push({ op: "i32.or" });
      return { kind: "i32" };
    case ts.SyntaxKind.CaretToken:
      fctx.body.push({ op: "i32.xor" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanLessThanToken:
      fctx.body.push({ op: "i32.shl" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      fctx.body.push({ op: "i32.shr_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      fctx.body.push({ op: "i32.shr_u" });
      return { kind: "i32" };
    default:
      // Fall back to f64 path for division, power, etc.
      return compileNumericBinaryOp(ctx, fctx, op, expr);
  }
}

/** BigInt: i64 arithmetic/comparison on two i64 operands */
function compileI64BinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
  expr: ts.BinaryExpression,
): ValType {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      fctx.body.push({ op: "i64.add" });
      return { kind: "i64" };
    case ts.SyntaxKind.MinusToken:
      fctx.body.push({ op: "i64.sub" });
      return { kind: "i64" };
    case ts.SyntaxKind.AsteriskToken:
      fctx.body.push({ op: "i64.mul" });
      return { kind: "i64" };
    case ts.SyntaxKind.SlashToken:
      fctx.body.push({ op: "i64.div_s" });
      return { kind: "i64" };
    case ts.SyntaxKind.PercentToken:
      fctx.body.push({ op: "i64.rem_s" });
      return { kind: "i64" };
    case ts.SyntaxKind.AsteriskAsteriskToken: {
      // BigInt exponentiation: base ** exp implemented as a loop
      // Stack: [base: i64, exp: i64] → [result: i64]
      const expLocal = allocTempLocal(fctx, { kind: "i64" });
      const baseLocal = allocTempLocal(fctx, { kind: "i64" });
      const resultLocal = allocTempLocal(fctx, { kind: "i64" });
      // Save exponent (top of stack), then base
      fctx.body.push({ op: "local.set", index: expLocal });
      fctx.body.push({ op: "local.set", index: baseLocal });
      // result = 1
      fctx.body.push({ op: "i64.const", value: 1n });
      fctx.body.push({ op: "local.set", index: resultLocal });
      // block $break { loop $continue {
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if exp <= 0 then break
              { op: "local.get", index: expLocal },
              { op: "i64.const", value: 0n },
              { op: "i64.le_s" },
              { op: "br_if", depth: 1 }, // break out of block
              // result = result * base
              { op: "local.get", index: resultLocal },
              { op: "local.get", index: baseLocal },
              { op: "i64.mul" },
              { op: "local.set", index: resultLocal },
              // exp = exp - 1
              { op: "local.get", index: expLocal },
              { op: "i64.const", value: 1n },
              { op: "i64.sub" },
              { op: "local.set", index: expLocal },
              // continue loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      });
      // Push result
      fctx.body.push({ op: "local.get", index: resultLocal });
      releaseTempLocal(fctx, expLocal);
      releaseTempLocal(fctx, baseLocal);
      releaseTempLocal(fctx, resultLocal);
      return { kind: "i64" };
    }
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "i64.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "i64.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "i64.lt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "i64.le_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "i64.gt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "i64.ge_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.AmpersandToken:
      fctx.body.push({ op: "i64.and" });
      return { kind: "i64" };
    case ts.SyntaxKind.BarToken:
      fctx.body.push({ op: "i64.or" });
      return { kind: "i64" };
    case ts.SyntaxKind.CaretToken:
      fctx.body.push({ op: "i64.xor" });
      return { kind: "i64" };
    case ts.SyntaxKind.LessThanLessThanToken:
      fctx.body.push({ op: "i64.shl" });
      return { kind: "i64" };
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      fctx.body.push({ op: "i64.shr_s" });
      return { kind: "i64" };
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      fctx.body.push({ op: "i64.shr_u" });
      return { kind: "i64" };
    default:
      reportError(ctx, expr, `Unsupported BigInt binary operator: ${ts.SyntaxKind[op]}`);
      return { kind: "i64" };
  }
}

/**
 * Emit JS ToInt32: reduce f64 modulo 2^32 then truncate to i32.
 * Handles NaN→0, Infinity→0, and large values that wrap.
 * Stack: [f64] → [i32]
 */
export function emitToInt32(fctx: FunctionContext): void {
  // JS ToInt32 algorithm:
  //   if NaN/Infinity/0 → 0
  //   n = sign(x) * floor(abs(x))
  //   int32bit = n mod 2^32
  //   if int32bit >= 2^31 → int32bit - 2^32
  //
  // In wasm: x - floor(x / 2^32) * 2^32, then trunc_sat
  // For values in i32 range, trunc_sat alone works. We only need the
  // modulo reduction for out-of-range values.
  // Step 1: truncate fractional part toward zero (JS ToInt32 does this first)
  // Step 2: x - floor(x / 2^32) * 2^32 → maps to [0, 2^32)
  // Step 3: trunc_sat_f64_u gives correct bit pattern
  // NaN/Infinity: trunc(NaN)=NaN, Inf-Inf=NaN, trunc_sat_u(NaN)=0. Correct.
  fctx.body.push({ op: "f64.trunc" });
  const tmp = allocTempLocal(fctx, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "f64.const", value: 4294967296 });
  fctx.body.push({ op: "f64.div" });
  fctx.body.push({ op: "f64.floor" });
  fctx.body.push({ op: "f64.const", value: 4294967296 });
  fctx.body.push({ op: "f64.mul" });
  fctx.body.push({ op: "f64.sub" });
  fctx.body.push({ op: "i32.trunc_sat_f64_u" });
  releaseTempLocal(fctx, tmp);
}

/**
 * (#2593) ToUint8Clamp (§7.1.x, the `Uint8ClampedArray` element conversion). Input
 * f64 on the stack → clamped i32 in [0, 255]. NOT modulo: NaN→0, ≤0→0, ≥255→255,
 * else round-HALF-TO-EVEN (1.5→2, 2.5→2, 0.5→0). Differs from every other integer
 * view (which truncate modulo via the packed `array.set`), so `Uint8ClampedArray`
 * writes route through this helper before the store.
 */
export function emitToUint8Clamp(fctx: FunctionContext): void {
  // x on stack (f64) → clamped i32 in [0,255]. Use DEDICATED locals (no reuse) to
  // keep the stack types unambiguous. Result is built as an i32 in `out`.
  const x = allocTempLocal(fctx, { kind: "f64" });
  const f = allocTempLocal(fctx, { kind: "f64" }); // floor(x)
  const d = allocTempLocal(fctx, { kind: "f64" }); // x - floor(x)
  const out = allocTempLocal(fctx, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: x } as Instr);

  // roundHalfEven(x) → i32 (only evaluated when 0 < x < 255, so trunc is exact):
  //   f = floor(x); d = x - f;
  //   d<0.5 → f ; d>0.5 → f+1 ; d==0.5 → (f even ? f : f+1)
  const roundHalfEven: Instr[] = [
    { op: "local.get", index: x } as Instr,
    { op: "f64.floor" } as Instr,
    { op: "local.set", index: f } as Instr,
    { op: "local.get", index: x } as Instr,
    { op: "local.get", index: f } as Instr,
    { op: "f64.sub" } as Instr,
    { op: "local.set", index: d } as Instr,
    // d < 0.5 ?
    { op: "local.get", index: d } as Instr,
    { op: "f64.const", value: 0.5 } as Instr,
    { op: "f64.lt" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } as ValType },
      then: [{ op: "local.get", index: f } as Instr],
      else: [
        // d > 0.5 ?
        { op: "local.get", index: d } as Instr,
        { op: "f64.const", value: 0.5 } as Instr,
        { op: "f64.gt" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } as ValType },
          then: [
            { op: "local.get", index: f } as Instr,
            { op: "f64.const", value: 1 } as Instr,
            { op: "f64.add" } as Instr,
          ],
          else: [
            // tie (d == 0.5): round to even. f even ⇔ floor(f/2) == f/2.
            { op: "local.get", index: f } as Instr,
            { op: "f64.const", value: 0.5 } as Instr,
            { op: "f64.mul" } as Instr,
            { op: "local.set", index: d } as Instr, // d := f/2 (reuse d, no longer needed)
            { op: "local.get", index: d } as Instr,
            { op: "f64.floor" } as Instr,
            { op: "local.get", index: d } as Instr,
            { op: "f64.eq" } as Instr,
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } as ValType },
              then: [{ op: "local.get", index: f } as Instr],
              else: [
                { op: "local.get", index: f } as Instr,
                { op: "f64.const", value: 1 } as Instr,
                { op: "f64.add" } as Instr,
              ],
            } as Instr,
          ],
        } as Instr,
      ],
    } as Instr,
    { op: "i32.trunc_sat_f64_u" } as Instr,
    { op: "local.set", index: out } as Instr,
  ];

  // Clamp: x>=255 → 255 ; x>0 (NaN-false) → round ; else → 0.
  fctx.body.push({ op: "local.get", index: x } as Instr);
  fctx.body.push({ op: "f64.const", value: 255 } as Instr);
  fctx.body.push({ op: "f64.ge" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "i32.const", value: 255 } as Instr, { op: "local.set", index: out } as Instr],
    else: [
      { op: "local.get", index: x } as Instr,
      { op: "f64.const", value: 0 } as Instr,
      { op: "f64.gt" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: roundHalfEven,
        else: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: out } as Instr],
      } as Instr,
    ],
  } as Instr);
  fctx.body.push({ op: "local.get", index: out } as Instr);
  releaseTempLocal(fctx, x);
  releaseTempLocal(fctx, f);
  releaseTempLocal(fctx, d);
  releaseTempLocal(fctx, out);
}

/** Truncate two f64 operands to i32 via ToInt32, apply an i32 bitwise op, convert back to f64 */
function compileBitwiseBinaryOp(
  fctx: FunctionContext,
  i32op: "i32.and" | "i32.or" | "i32.xor" | "i32.shl" | "i32.shr_s" | "i32.shr_u",
  unsigned: boolean,
): ValType {
  // Stack: [left_f64, right_f64]
  const tmpR = allocTempLocal(fctx, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: "local.get", index: tmpR });
  releaseTempLocal(fctx, tmpR);
  emitToInt32(fctx);
  fctx.body.push({ op: i32op });
  fctx.body.push({ op: unsigned ? "f64.convert_i32_u" : "f64.convert_i32_s" });
  return { kind: "f64" };
}

function compileModulo(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  emitModulo(ctx, fctx);
  return { kind: "f64" };
}

/**
 * Emit JS remainder (`a % b`) on f64 operands as a call to the Wasm-native
 * `__fmod` helper, which computes the *exact* IEEE-754 remainder
 * ([Number::remainder §6.1.6.1.6](https://tc39.es/ecma262/#sec-numeric-types-number-remainder)).
 * Stack: [a_f64, b_f64] -> [result_f64].
 *
 * The previous inline formula `a - trunc(a/b)*b` (+ copysign) was not fmod: it
 * drifted by ULPs, collapsed to 0 for large `a/b`, and overflowed to ±Infinity
 * when `a/b` exceeded f64 range. `__fmod` handles all of those plus the #216
 * edge cases (`x % Inf`, `-0 % x`, `Inf % x`, `x % 0`, `NaN % x`) internally.
 * See `fmod.ts` for the algorithm and correctness notes (#2056).
 */
export function emitModulo(ctx: CodegenContext, fctx: FunctionContext): void {
  const fmodIdx = ensureFmod(ctx);
  fctx.body.push({ op: "call", funcIdx: fmodIdx });
}

/**
 * Emit `a % b` on i32 operands without the Wasm traps of bare `i32.rem_s`.
 *
 * `i32.rem_s` traps when `b == 0` and on the signed-overflow case
 * `INT_MIN % -1`. JS yields NaN and 0 respectively for the corresponding
 * Number operation; in i32 fast mode the result must be an i32 (no NaN
 * representation), so we emit 0 for both trapping cases. 0 is the
 * mathematically-correct value for `INT_MIN % -1`, and the i32 truncation of
 * JS's NaN result is also 0, so this is the least-surprising i32 behaviour.
 *
 * Stack: [a_i32, b_i32] -> [result_i32]. See #1825.
 */
export function emitSafeI32Rem(fctx: FunctionContext): void {
  const tmpB = allocTempLocal(fctx, { kind: "i32" });
  const tmpA = allocTempLocal(fctx, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: tmpB });
  fctx.body.push({ op: "local.set", index: tmpA });

  // safeToRem = (b != 0) && !(a == INT_MIN && b == -1)
  // b == 0  -> trap (div by zero)
  fctx.body.push({ op: "local.get", index: tmpB });
  fctx.body.push({ op: "i32.eqz" });
  // a == INT_MIN
  fctx.body.push({ op: "local.get", index: tmpA });
  fctx.body.push({ op: "i32.const", value: -2147483648 });
  fctx.body.push({ op: "i32.eq" });
  // b == -1
  fctx.body.push({ op: "local.get", index: tmpB });
  fctx.body.push({ op: "i32.const", value: -1 });
  fctx.body.push({ op: "i32.eq" });
  // (a == INT_MIN) & (b == -1)
  fctx.body.push({ op: "i32.and" });
  // (b == 0) | (overflow)  -> the "trapping" condition
  fctx.body.push({ op: "i32.or" });

  // if (trapping) 0 else a % b
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 0 }],
    else: [{ op: "local.get", index: tmpA }, { op: "local.get", index: tmpB }, { op: "i32.rem_s" }],
  });

  releaseTempLocal(fctx, tmpA);
  releaseTempLocal(fctx, tmpB);
}

function compileBooleanBinaryOp(ctx: CodegenContext, fctx: FunctionContext, op: ts.SyntaxKind): ValType {
  switch (op) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "i32.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "i32.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "i32.lt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "i32.le_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "i32.gt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "i32.ge_s" });
      return { kind: "i32" };
    default:
      return { kind: "i32" };
  }
}

/**
 * (#2023) `new.target === SomeClass` / `!==` (either operand order). Returns an
 * i32 (0/1) when one operand is the `new.target` meta-property and the other is
 * an identifier naming a local class; otherwise null (let the generic path run).
 *
 * Inside a constructor, `new.target` is the class-id of the outermost `new`
 * site, so the comparison reduces to `globalNewTargetId (==|!=) classId`.
 * Outside a constructor `new.target` is `undefined`, so it never equals a class:
 * `===` folds to const 0, `!==` to const 1 (operands have no side effects — a
 * bare identifier and a meta-property).
 */
function compileNewTargetClassComparison(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): InnerResult | null {
  const unwrap = (e: ts.Expression): ts.Expression => {
    let cur = e;
    while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
    }
    return cur;
  };
  const isNewTarget = (e: ts.Expression): boolean =>
    ts.isMetaProperty(e) && e.keywordToken === ts.SyntaxKind.NewKeyword && e.name.text === "target";

  const left = unwrap(expr.left);
  const right = unwrap(expr.right);
  let classIdent: ts.Expression | undefined;
  if (isNewTarget(left) && !isNewTarget(right)) classIdent = right;
  else if (isNewTarget(right) && !isNewTarget(left)) classIdent = left;
  else return null;

  if (!ts.isIdentifier(classIdent)) return null;
  // Resolve to a concrete local class name (handle class-expression aliasing).
  let className: string | undefined = classIdent.text;
  if (!ctx.classSet.has(className)) {
    const mapped = ctx.classExprNameMap.get(className);
    className = mapped && ctx.classSet.has(mapped) ? mapped : undefined;
  }
  if (!className) return null;

  const isNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;

  // Outside a constructor, new.target is undefined — never a class.
  if (!fctx.isConstructor || !ctx.usesNewTarget) {
    fctx.body.push({ op: "i32.const", value: isNeq ? 1 : 0 });
    return { kind: "i32" };
  }

  const classId = getOrAssignClassNewTargetId(ctx, className);
  emitNewTargetClassId(ctx, fctx.body);
  fctx.body.push({ op: "i32.const", value: classId });
  fctx.body.push({ op: isNeq ? "i32.ne" : "i32.eq" });
  return { kind: "i32" };
}
