// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Binary operations extracted from expressions.ts.
 * Handles binary expression compilation including numeric, i32, i64,
 * bitwise, modulo, boolean, and any-typed binary operations.
 */
import { ts } from "../ts-api.js";
import type { TypeFact } from "../checker/oracle.js";
import {
  getNullablePrimitiveInfo,
  isBigIntType,
  isBooleanType,
  isDeclaredHeterogeneousPrimitiveUnion,
  isHeterogeneousPrimitiveUnion,
  isNumberType,
  isStringType,
  isWrapperObjectType,
} from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { ensureAnyFromExternHelper, isAnyValue, undefinedSingletonActive } from "./any-helpers.js";
import { reportError } from "./context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileAssignment } from "./expressions/assignment.js";
import {
  compileCompoundAssignment,
  compileLogicalAssignment,
  isCompoundAssignment,
} from "./expressions/operator-assignment.js";
import {
  emitPrivateBrandPredicate,
  emitThrowTypeError,
  resolveDeclaringClassForPrivateName,
} from "./expressions/helpers.js";
import { ensureExternIsUndefinedImport, ensureLateImport } from "./expressions/late-imports.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { emitNewTargetClassId, getOrAssignClassNewTargetId } from "./new-target.js"; // (#2023)
import { compileLogicalAnd, compileLogicalOr, compileNullishCoalescing } from "./expressions/logical-ops.js";
import { tryStaticToNumber } from "./expressions/misc.js";
import { emitNativeParseNumber } from "./parse-number-native.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { admitsObjectAddition, emitObjectAdd } from "./addition-to-primitive.js";
import { admitsObjectRelational, reduceRelationalOperandsToPrimitive } from "./relational-to-primitive.js";
// (#4491 T4) §13.15.3 `+` over object operands.
import {
  addOperandCallableSourceText,
  admitsObjectAdd,
  emitAddOrdinaryToPrimitiveResidue,
} from "./add-to-primitive.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringImports, addUnionImports, resolveWasmType } from "./index.js";
import { isI32CompatibleOperand, nativeTypeOfExpression } from "./native-type-annotations.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, ensureAnyHelpers, flushLateImportShifts, VOID_RESULT } from "./shared.js";
import { isLogicalAssignNamedEvalNameRead, resolveStructName, resolveStructNameForExpr } from "./property-access.js";
import { compileNullishObservedExpression } from "./property-nullish-read.js";
import { foldVoidOperandEquality } from "./equality-void-operand.js";
import { compileStringBinaryOp, emitHoistedCharCodeAtRead, matchHoistedCharRead } from "./string-ops.js";
import {
  emitAnyEqFromExternTemps,
  emitLooseEq,
  emitStrictEq,
  ensureExternrefToNumberProvider,
} from "./coercion-engine.js";
import { compileInstanceOf, compileTypeofComparison } from "./typeof-delete.js";
import { compileTypedBinaryDispatch } from "./binary-ops-typed-dispatch.js";
import { foldTypeDisjointThenPromote } from "./strict-eq-type-disjoint.js";
import { compileInOperator } from "./binary-ops-in.js";
import { moduleGlobalIsDynamicButStaticallyPrimitive } from "./declarations/heterogeneous-scalar-var-widening.js";
import { emitIsUndefF64 } from "./value-tags.js";

/**
 * (#1930) Keep the nullish AnyValue gate on the oracle side of the checker
 * boundary.  This mirrors `isHeterogeneousPrimitiveUnion` without exposing a
 * `ts.Type`: nullable heterogeneous bindings are the only unions whose
 * non-null parts must retain distinct primitive tags.
 */
function isOracleHeterogeneousPrimitiveUnion(fact: TypeFact): boolean {
  if (fact.kind !== "union" || fact.parts.length < 2) return false;
  const primitiveKinds = new Set<TypeFact["kind"]>();
  for (const part of fact.parts) {
    if (part.kind !== "number" && part.kind !== "string" && part.kind !== "boolean") return false;
    primitiveKinds.add(part.kind);
  }
  return primitiveKinds.size >= 2;
}

function isDeclaredOracleHeterogeneousPrimitiveUnion(ctx: CodegenContext, expr: ts.Expression): boolean {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return false;
  const declaration = ctx.oracle.valueDeclarationOf(current);
  return declaration !== undefined && isOracleHeterogeneousPrimitiveUnion(ctx.oracle.typeFactOf(declaration));
}
import { compileModulo } from "./remainder.js";
export { emitModulo } from "./remainder.js";

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
 * matches every `.kind === "i32"` check). Called at the TAIL of expressions.ts's
 * binary dispatch; its 3 `instanceof` arms return earlier, so they brand themselves.
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
export function inRhsIsExclusivelyPrimitive(t: ts.Type): boolean {
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
  // (#3907) The `!ctx.fast` short-circuit used to leave `allNativeI32` at its
  // optimistic `true` in fast mode, because fast mode narrowed EVERY `number`
  // to i32 anyway. Now that fast mode carries the spec f64 rep, the native
  // annotation must actually be proven here in every mode.
  if (allNativeI32) {
    // (#3673) The annotation only survives on the declaration's type NODE, so
    // resolve each operand through the declaration it reads. An int32 literal
    // is exactly representable in both domains and therefore does not break the
    // chain — without that, `this.pos + 1` on an `i32` field would still be
    // computed in f64 and truncated back on store.
    let sawNative = false;
    for (const operand of operands) {
      if (nativeTypeOfExpression(ctx.checker, operand)?.kind === "i32") {
        sawNative = true;
        continue;
      }
      if (isI32CompatibleOperand(ctx.checker, operand)) continue;
      allNativeI32 = false;
      break;
    }
    if (!sawNative) allNativeI32 = false;
  }
  // (#3907) `ctx.fast` is NOT a licence to evaluate the chain in i32 — see the
  // note on `numericHint` in `compileBinaryExpression`. Only the proof-carrying
  // `allNativeI32` (every operand explicitly `type i32 = number`-annotated)
  // narrows the hint.
  const numericHint: ValType = { kind: allNativeI32 && !isDivOrPow ? "i32" : "f64" };

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
      allNativeI32 &&
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

/**
 * (#3481) Compact opcode for `__host_bigint_binop`, the JS-host delegation used
 * when a BigInt is combined with a dynamically-object/any operand that ToNumeric
 * may reduce to a BigInt (`Object(2n) * 2n`, `{valueOf(){return 2n}} - 2n`, …).
 * Returns `undefined` for operators that never reach the mixed-BigInt arithmetic
 * throw (equality/relational are handled earlier), so the caller keeps its
 * existing path. The numbering is a private ABI shared only with the
 * `host_bigint_binop` runtime intent — keep the two in lockstep.
 */
function bigIntHostBinopOpcode(op: ts.SyntaxKind): number | undefined {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      return 0;
    case ts.SyntaxKind.MinusToken:
      return 1;
    case ts.SyntaxKind.AsteriskToken:
      return 2;
    case ts.SyntaxKind.SlashToken:
      return 3;
    case ts.SyntaxKind.PercentToken:
      return 4;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return 5;
    case ts.SyntaxKind.AmpersandToken:
      return 6;
    case ts.SyntaxKind.BarToken:
      return 7;
    case ts.SyntaxKind.CaretToken:
      return 8;
    case ts.SyntaxKind.LessThanLessThanToken:
      return 9;
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return 10;
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return 11;
    default:
      return undefined;
  }
}

/**
 * (#3688) An identifier whose value physically cannot be `undefined`: the
 * global `NaN`/`Infinity`, or a binding held in an f64/i32/i64 local slot
 * (an externref slot CAN hold `undefined`, so it does not qualify).
 *
 * The local lookup comes FIRST so a user binding that shadows `NaN` is judged
 * by its slot like any other identifier.
 */
function isNeverUndefinedIdent(fctx: FunctionContext, e: ts.Expression): boolean {
  if (!ts.isIdentifier(e)) return false;
  const idx = fctx.localMap.get(e.text);
  if (idx === undefined) return e.text === "NaN" || e.text === "Infinity";
  const entry = idx < fctx.params.length ? fctx.params[idx] : fctx.locals[idx - fctx.params.length];
  const t =
    entry && typeof entry === "object" && "type" in entry
      ? (entry as { type: ValType }).type
      : (entry as ValType | undefined);
  return t?.kind === "f64" || t?.kind === "i32" || t?.kind === "i64";
}

/**
 * (#3688) Whether `e` — already known to be typed `number` — is guaranteed to
 * hold a real Number at runtime rather than `undefined`.
 *
 * TypeScript's index signatures are unsound (`tk[9]` on a `number[]` is typed
 * `number` but is `undefined` at runtime), and the f64 lowering represents an
 * absent value as NaN. That conflation is harmless for arithmetic and
 * relational operators but NOT for equality: `undefined === undefined` is true
 * while `NaN === NaN` is false. Requiring one such operand makes the narrowed
 * and generic lowerings agree on every input — see the long note at the
 * `bothStaticNumberEq` gate.
 *
 * The whitelist is everything COMPUTED rather than FETCHED, plus identifiers in
 * slots that cannot hold `undefined`. Element access, property access and call
 * results are deliberately excluded: those are exactly the expressions that can
 * hand back `undefined` behind a `number` type.
 */
function isNeverUndefinedNumber(fctx: FunctionContext, e: ts.Expression): boolean {
  let inner: ts.Expression = e;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner)
  ) {
    inner = inner.expression;
  }
  // Numeric literal.
  if (ts.isNumericLiteral(inner)) return true;
  // Prefix `-` / `+` / `~` apply ToNumber, so the result is always a Number.
  if (
    ts.isPrefixUnaryExpression(inner) &&
    (inner.operator === ts.SyntaxKind.MinusToken ||
      inner.operator === ts.SyntaxKind.PlusToken ||
      inner.operator === ts.SyntaxKind.TildeToken)
  ) {
    return true;
  }
  // Nested arithmetic / bitwise: likewise always a Number. (`+` here cannot be
  // concatenation — the caller has already established this operand is typed
  // `number`.)
  if (ts.isBinaryExpression(inner)) {
    const k = inner.operatorToken.kind;
    return (
      k === ts.SyntaxKind.PlusToken ||
      k === ts.SyntaxKind.MinusToken ||
      k === ts.SyntaxKind.AsteriskToken ||
      k === ts.SyntaxKind.AsteriskAsteriskToken ||
      k === ts.SyntaxKind.SlashToken ||
      k === ts.SyntaxKind.PercentToken ||
      k === ts.SyntaxKind.AmpersandToken ||
      k === ts.SyntaxKind.BarToken ||
      k === ts.SyntaxKind.CaretToken ||
      k === ts.SyntaxKind.LessThanLessThanToken ||
      k === ts.SyntaxKind.GreaterThanGreaterThanToken ||
      k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken
    );
  }
  return isNeverUndefinedIdent(fctx, inner);
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
      // externref → coerce to f64 first, then ToInt32.
      //
      // (#3673, same class as the #2109 comparison-path fix below) This used to
      // prefer `parseFloat` whenever the module happened to have registered it
      // in `funcMap`, which is wrong twice over:
      //   - SEMANTICS: `x | 0` is ToInt32(ToNumber(x)) (§13.15.3), NOT
      //     ToInt32(parseFloat(ToString(x))). parseFloat takes the longest
      //     numeric PREFIX and does not understand the radix prefixes, so
      //     `"10abc" | 0` wrongly became 10 (spec: NaN → 0) and `"0x10" | 0`
      //     wrongly became 0 (spec: 16) — but only in modules that also used
      //     parseFloat somewhere, which is exactly the kind of action-at-a-
      //     distance #2109 removed from the loose-equality/comparison arms.
      //   - STANDALONE TRAP: the native `parseFloat` opens with an unguarded
      //     `ref.cast $AnyString` on its externref param, so passing a boxed
      //     NUMBER (the overwhelmingly common `x | 0` operand) trapped with
      //     "illegal cast". Compiled acorn hit this on EVERY regex literal —
      //     `RegExpValidationState.prototype.reset` does `this.start = start | 0`
      //     with a numeric `start`.
      // `__unbox_number` is the spec ToNumber frontier and — importantly for a
      // hot operator — a SINGLE call: JS `Number()` under a host, and under
      // `--target standalone` the native `addUnionImports` body (null → 0,
      // i31/boxed number → value, boxed boolean → 0/1, native string →
      // `__str_to_number` = StringToNumber §7.1.4.1, otherwise NaN). The
      // inline `coerceType(..., "number")` ToPrimitive walk is NOT usable here:
      // expanded at every `x | 0` site it made compiled acorn's standalone
      // build time explode from ~18s to >10min.
      const unboxIdx = ensureExternrefToNumberProvider(ctx, fctx);
      if (unboxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: unboxIdx });
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
    const rightType = compileExpression(ctx, fctx, expr.right);
    // `compileExpression` intentionally exposes a successfully-emitted void
    // expression as `null`.  Propagate the inner VOID_RESULT sentinel here so
    // the transactional wrapper around the comma expression commits both
    // operands' side effects instead of treating the whole expression as a
    // failed speculative compile and rolling its body back.  This is observable
    // in statement-position shapes such as `ready && (schedule(), entangle())`.
    return rightType ?? VOID_RESULT;
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
    // A declaration binding whose element type is a heterogeneous primitive
    // union is physically a nullable `$AnyValue`.  Do not consume its
    // null/undefined comparison in the generic ref-null shortcut: tag 0 is
    // boxed null and `ref.is_null` would report false.  Let the AnyValue
    // equality dispatch below compare the carrier tag instead (#4447).
    const nullishComparedExpr = rightIsNullish ? expr.left : expr.right;
    const nullishComparedFact = ctx.oracle.typeFactOf(nullishComparedExpr);
    const nullishUnionCarrier =
      ctx.unionAnyRep &&
      (isOracleHeterogeneousPrimitiveUnion(nullishComparedFact) ||
        isDeclaredOracleHeterogeneousPrimitiveUnion(ctx, nullishComparedExpr));
    if ((rightIsNullish || leftIsNullish) && !nullishUnionCarrier) {
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

      const valType = compileNullishObservedExpression(ctx, fctx, nonNullExpr);
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
          fctx.body.push({ op: "i32.or" });
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
      // (#3369) Numeric arrays carry an omitted/undefined element as the exact
      // signaling-NaN sentinel from value-tags.ts. A read therefore still has
      // Wasm type f64 even though its JavaScript value is `undefined`. Preserve
      // the nullish comparison semantics at this observation boundary:
      //
      //   sentinel === undefined  -> true
      //   sentinel === null       -> false
      //   sentinel == null        -> true
      //
      // Compare the exact bits rather than using f64.eq so an ordinary NaN is
      // never mistaken for undefined.
      if (valType.kind === "f64" && (nullSideIsUndefinedId || isLooseEqOp || isLooseNeqOp)) {
        emitIsUndefF64(fctx.body);
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
    return compileInOperator(ctx, fctx, expr);
  }

  // ── Flatten long chains of same numeric operator ──
  // For expressions like a + b + c + d (left-recursive AST), flatten into an
  // iterative loop to avoid deep JS recursion and improve compilation speed.
  {
    const flatResult = tryFlattenBinaryChain(ctx, fctx, expr, op);
    if (flatResult !== null) return flatResult;
  }

  // Regular binary ops: evaluate both sides
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
  const rightTsType = ctx.checker.getTypeAtLocation(expr.right);

  // ── Constant folding: emit a single constant when both operands are compile-time known ──
  {
    // (#4491 T4) …but NEVER for a `+` whose operands the §13.15.3 object arm
    // owns. `tryStaticToNumber` is a **ToNumber** folder: it answers `NaN` for
    // an object literal, which is right for `+{}` / `Number({})` and wrong for
    // `{} + {}` — that is `"[object Object][object Object]"`, a STRING. The
    // folder runs before any of the operand analysis below, so the literal-vs-
    // literal spelling was decided here while the identical `var a={},b={}; a+b`
    // reached the correct runtime dispatch: one expression, two answers.
    // Gated exactly like `admitsObjectAdd` (standalone, native strings), so the
    // js-host/gc lane keeps folding byte-for-byte and stays the regression guard.
    const objectAddOwned = op === ts.SyntaxKind.PlusToken && admitsObjectAdd(ctx, leftTsType, rightTsType);
    const folded = objectAddOwned ? undefined : tryStaticToNumber(ctx, expr);
    if (folded !== undefined) {
      fctx.body.push({ op: "f64.const", value: folded });
      return { kind: "f64" };
    }
  }
  const isEqualityOp =
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const leftIsWrapperObj = isWrapperObjectType(leftTsType);
  const rightIsWrapperObj = isWrapperObjectType(rightTsType);
  const wrapperEquality = isEqualityOp && (leftIsWrapperObj || rightIsWrapperObj);

  // ── Loose equality (== / !=) with mixed types ──
  // JS loose equality coerces types before comparing. Handle common cases:
  //   number == boolean / boolean == number → coerce boolean to number
  //   string == number / number == string → coerce string to number (parseFloat)
  //   string == boolean / boolean == string → coerce both to number
  const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
  const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
  if ((isLooseEq || isLooseNeq) && !wrapperEquality) {
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
      const nativeSemantics = ctx.targetProfile.semanticProviders === "native-first";
      if (nativeSemantics && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
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
              // native string ref → externref → __str_to_number → f64.
              // (#3395 shape 3) A native `$AnyString` REF operand must be boxed
              // to externref first (`extern.convert_any`), but a string-typed
              // operand that ALREADY compiles to externref — a `new String(x)`
              // wrapper object, or any prior boxing — must NOT be re-converted:
              // `extern.convert_any` on an externref is invalid Wasm
              // ("expected anyref, found ... of type externref", the
              // `true == new String("+1")` residual). Gate the box on the
              // compiled operand's real ValType.
              const ot = compileExpression(ctx, fctx, operand);
              if (ot && ot.kind !== "externref") {
                fctx.body.push({ op: "extern.convert_any" });
              }
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
    // (#3753 S2) An `any`-typed operand the whole-program fixpoint already PROVED
    // numeric is not really `any` for arithmetic purposes. Inside a fnctor
    // prototype method `this` is untyped, so `this.acc + this.nextCode()` reads
    // as any+any and routes to the generic `__any_add` — boxing BOTH operands
    // into `$AnyValue` and tag-dispatching the result back out, five box/unbox
    // operations per iteration on values that are f64 on both sides (#3753).
    //
    // `numericPropertyNames` (#3683 S4a) and `numericFunctionNames` are verdicts
    // from the same fixpoint that already gave `this.acc` a physical f64 slot —
    // so trusting them here is consistent with the representation those fields
    // ALREADY have, not a new claim. Standalone-only, like the verdicts.
    const provenNumericOperand = (e: ts.Expression): boolean => {
      if (!ctx.standalone || process.env.JS2WASM_NUMERIC_OPERANDS === "0") return false;
      const bare = ts.isParenthesizedExpression(e) ? e.expression : e;
      // `this.f` where every write to `f` is numeric.
      if (
        ts.isPropertyAccessExpression(bare) &&
        bare.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ctx.numericPropertyNames?.has(bare.name.text) === true
      ) {
        return true;
      }
      // `<recv>.m()` where `m` provably returns a number on every path.
      //
      // (#3744) The receiver is deliberately NOT constrained to `this`. The
      // verdict is a WHOLE-PROGRAM property of the method NAME — "every function
      // named `m` returns a number on every path" — so it holds for any
      // receiver. Restricting it to `this` was an accident of where #3753 was
      // measured (a tokenizer, whose calls are all `this.next()`); the `method`
      // axis calls `p.inc()` on a plain local and got none of the benefit.
      if (
        ts.isCallExpression(bare) &&
        ts.isPropertyAccessExpression(bare.expression) &&
        ctx.numericFunctionNames?.has(bare.expression.name.text) === true
      ) {
        return true;
      }
      return false;
    };
    const leftIsAny = (leftTsType.flags & ts.TypeFlags.Any) !== 0 && !provenNumericOperand(expr.left);
    const rightIsAny = (rightTsType.flags & ts.TypeFlags.Any) !== 0 && !provenNumericOperand(expr.right);
    // (#745 S3) A local whose static type is (or whose DECLARED symbol type
    // is) a heterogeneous primitive union compiles to `ref_null $AnyValue`
    // under `unionAnyRep` (S2 mapping) — no legacy path (string/numeric/
    // ref-eq) can compare that carrier correctly, so route equality through
    // the tag-aware `__any_strict_eq`/`__any_eq` helpers exactly like a
    // both-`any` operand pair. The declared-type check matters because
    // assignment/literal narrowing re-types the USE SITE (`x = "done";
    // x === "done"` reports `"done"`) while the VALUE stays carried in the
    // $AnyValue local. Statically nullish counter-operands are EXCLUDED —
    // `=== undefined / null` already works via the nullish comparison paths.
    // Flag-off (or no union operand): `unionRepEqInvolved` is false and the
    // gate below is byte-identical to before.
    const isUnionAnyRepUse = (t: ts.Type): boolean => ctx.unionAnyRep && isHeterogeneousPrimitiveUnion(t);
    const declaredHetUnion = (node: ts.Expression): boolean =>
      ctx.unionAnyRep && isDeclaredHeterogeneousPrimitiveUnion(ctx.checker, node);
    const nullishFlags = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;
    const eqSideOk = (t: ts.Type): boolean =>
      (t.flags & nullishFlags) === 0 ||
      // A nullable heterogeneous union is still represented by `$AnyValue`;
      // its tag-0/null case must stay in the same equality dispatch as the
      // numeric/boolean/string cases.  The null shortcut above deliberately
      // skipped this shape (#4447).
      (ctx.unionAnyRep && isHeterogeneousPrimitiveUnion(t));
    const unionRepEqInvolved =
      (isUnionAnyRepUse(leftTsType) ||
        isUnionAnyRepUse(rightTsType) ||
        declaredHetUnion(expr.left) ||
        declaredHetUnion(expr.right)) &&
      eqSideOk(leftTsType) &&
      eqSideOk(rightTsType);
    if ((leftIsAny && rightIsAny) || unionRepEqInvolved) {
      const isPlusOp = op === ts.SyntaxKind.PlusToken;
      const isEqualityOp =
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      // Only dispatch through AnyValue for + (string concat possible) and equality
      if (isPlusOp || isEqualityOp) {
        // (#3169) Record the ACTIVE any-equality dispatch expr so the #3037
        // read-carrier (`maybeWrapAnyReadEqualityCarrier`) fires ONLY for
        // operands whose enclosing equality really routes through
        // `__any_strict_eq`. Without this, an operand compile that lazily
        // registers `$AnyValue` as a SIDE EFFECT (e.g. the #3169 standalone
        // dynamic-index read pulling in the `__unbox_number` union native)
        // flips `ctx.anyValueTypeIdx` ≥ 0 mid-expression: this entry gate saw
        // −1 (no dispatch), but the carrier's own guard then saw ≥ 0 and
        // wrapped the read into a `ref $AnyValue` that the already-chosen
        // externref equality path compares by struct identity → value-equal
        // operands spuriously `!==` (the `obj[idx] !== val` -c-ii family).
        // Save/restore (not clear) so nested equalities keep their own marker.
        const prevAnyEqExpr = ctx.activeAnyEqDispatchExpr;
        if (isEqualityOp) ctx.activeAnyEqDispatchExpr = expr;
        try {
          const anyDispatch = compileAnyBinaryDispatch(ctx, fctx, expr, op);
          if (anyDispatch !== null) return anyDispatch;
        } finally {
          ctx.activeAnyEqDispatchExpr = prevAnyEqExpr;
        }
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
  // (#3688) Statically-`number` equality gets the SAME numeric operand hint the
  // relational ops already get.
  //
  // Root cause this fixes: `isNumericOp` (below, ~line 1371) lists `+ - * / %`,
  // the four relationals and the six bitwise ops — but NOT `=== !== == !=`. So
  // equality compiled its operands with `numericHint === undefined`, i.e. in
  // each operand's *natural* representation. For an operand whose natural
  // representation is boxed — the legacy element-access path emits
  // `array.get` → `__box_number` → externref so it can express the
  // out-of-bounds `undefined` — the typed dispatch then saw externref×f64,
  // boxed the f64 side too, and fell into the inline abstract-equality
  // cascade: `__extern_is_nullish` ×2 → `__extern_is_undefined` ×2 →
  // `__typeof_number` ×2 → `__unbox_number` ×2 → `__typeof_boolean` ×2 →
  // `__unbox_boolean` ×2 → `__typeof_bigint` ×2 → `__to_bigint` ×2 →
  // `__str_flatten` ×2 + `__str_equals` → `ref.eq`. That is ~35 instructions
  // and TWO STRING COMPARISONS for `tk[i] === 40`, on a tokenizer's hottest
  // line. The identical expression with `<` instead of `===` already compiled
  // to bare `array.get` + `f64.lt`, purely because `<` is in `isNumericOp`.
  //
  // The hint is the whole-chain fix, not a peephole: it propagates DOWN into
  // the operand emitters, so the element read is produced unboxed in the first
  // place (`array.get` → f64, NaN for OOB) rather than being boxed and then
  // unboxed back. Narrowing only the comparison while leaving the operands
  // boxed is the partial-narrowing shape that measured as a 2.7x pessimization
  // in #3673 round 36 — this deliberately avoids it.
  //
  // Semantics (§7.2.15): both operands statically `number` ⇒ SameType, so
  // strict and loose equality coincide and reduce to `Number::equal`, which is
  // exactly `f64.eq` — `NaN === NaN` is false (f64.eq on NaN is 0) and
  // `+0 === -0` is true (f64.eq on ±0 is 1). No coercion arm is reachable, so
  // dropping the cascade is not an approximation.
  //
  // Gate part 1: BOTH sides `number`/number-literal per the checker
  // (`isNumberType` rejects unions, `any`, `unknown`, `null`/`undefined`, bigint
  // and string), and not a wrapper-object equality (`new Number(1) === …` keeps
  // object identity). Genuinely dynamic operands are untouched — #3688's stated
  // non-goal.
  //
  // Gate part 2, and the reason this is not just `isNumericOp || isEqualityOp`:
  // TypeScript's index signatures are UNSOUND. `tk[9]` on a `number[]` is typed
  // `number` but is `undefined` at runtime (absent `noUncheckedIndexedAccess`),
  // and the f64 lowering represents that absent value as NaN (the project-wide
  // "null/undefined in f64 context → NaN" convention). NaN and undefined agree
  // under every operator this hint already covers — `undefined + 1`, `undefined
  // < 1` and `NaN + 1`, `NaN < 1` are the same — but they DISAGREE under
  // equality, and in exactly one shape: `undefined === undefined` is TRUE while
  // `NaN === NaN` is FALSE. Measured: `s.tk[9] === s.tk[8]` with both reads out
  // of bounds flips true → false with an unrefined gate. Every other pairing is
  // unaffected, because `undefined === <a real number>` and `NaN === <a real
  // number>` are both false.
  //
  // So require that at least ONE operand can never be `undefined` at runtime.
  // That is sufficient, not merely conservative: with one side a genuine Number
  // the comparison is false on both lowerings whenever the other side is
  // absent, so no observable result can change. It also keeps #3688's entire
  // motivating shape — a tokenizer compares a buffer read against a literal
  // code (`tk[i] === 40`, `c === 95`, `this.tokKind !== 0`), and a literal is
  // the canonical never-undefined operand.
  //
  // The whitelist lives in `isNeverUndefinedNumber` (module scope, so no
  // closure is allocated per binary node). The `process.env` read is LAST in
  // the chain on purpose: it is the most expensive term and only sites that
  // would actually narrow ever reach it.
  const bothStaticNumberEq =
    isEqualityOp &&
    !wrapperEquality &&
    isNumberType(leftTsType) &&
    isNumberType(rightTsType) &&
    (isNeverUndefinedNumber(fctx, expr.left) || isNeverUndefinedNumber(fctx, expr.right)) &&
    process.env.JS2WASM_STATIC_NUMBER_EQ !== "0";

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
  // (#4264) The string route below is chosen from the LEFT operand's CHECKER
  // type, and for a representation-widened module global that type is stale:
  // `var st = "parseInt"` still reads `string` to TypeScript after
  // `with (o) { st = parseInt; }` forced the slot to `externref`. Routing such a
  // compare to `__str_equals` casts a function externref to `$AnyString`, gets
  // null on both sides, and answers `true` — the exact asymmetry the
  // `S12.10_A1.*` battery reports as `#11: myObj.parseInt !== parseInt`
  // (`st === parseInt` was true while `parseInt === st` was false, because only
  // the left operand steers the route). `moduleGlobalIsDynamicButStaticallyPrimitive`
  // is #4204's own name for this disagreement; consult it and fall through to the
  // runtime-tag cascade, which reads the value instead of the stale type.
  //
  // EQUALITY ONLY, deliberately: `+` on such a binding is already correct via the
  // concat path's externref coercion, and re-routing it would change a hot,
  // well-tested lowering for no measured gain.
  const leftIsWidenedPrimitiveGlobal =
    isEqualityOp && ts.isIdentifier(expr.left) && moduleGlobalIsDynamicButStaticallyPrimitive(ctx, expr.left);
  // (#4621 D) …and the same exclusion for a right operand the checker types as a
  // structural OBJECT. The #2503 comment above already named this case — "or an
  // object (must ToPrimitive then recurse, so `"x" == {valueOf:()=>"x"}` is
  // `true`)" — but the flag it wrote only tested `any`/`unknown`, so an operand
  // with a REAL object type (an object literal, the common spelling in the
  // suite) still took the pure content-compare route and answered `false`
  // WITHOUT calling `valueOf` or `toString` at all. Measured on
  // `language/expressions/{equals/S11.9.1_A7.9, does-not-equals/S11.9.2_A7.8}`:
  // `"+1" == {valueOf(){return 1}, toString(){return {}}}` answered false with an empty
  // call log, where §7.2.15 step 9 requires `"+1" == ToPrimitive(y)` → `"+1" ==
  // 1` → true.
  //
  // Deliberately the `object` fact ONLY. `class` / `builtin` / `function`
  // receivers are left on their existing route: their §7.2.15 answer is also
  // reached through ToPrimitive, but re-routing them would change hot, long-
  // tested lowerings (wrapper equality, Date, RegExp) for rows this slice did
  // not measure. Absent-not-wrong — a declined arm keeps today's behaviour.
  const rightIsObjectOperand =
    !rightIsStrLike &&
    ctx.nativeStrings &&
    ctx.anyStrTypeIdx >= 0 &&
    ctx.oracle.typeFactOf(expr.right).kind === "object";
  const rightIsAbstractNonString =
    (!rightIsStrLike &&
      (rightTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 &&
      ctx.nativeStrings &&
      ctx.anyStrTypeIdx >= 0) ||
    rightIsObjectOperand;
  // (#4564) §13.15.3 step 5 reduces BOTH operands BEFORE step 7 asks whether
  // either is a string: `o + ""` must take `valueOf`, but the string routes just
  // below call ToString on the object, which takes `toString`. Standalone only —
  // see addition-to-primitive.ts.
  const objectPlus = op === ts.SyntaxKind.PlusToken && !isBigIntType(leftTsType) && !isBigIntType(rightTsType);
  if (objectPlus && admitsObjectAddition(ctx, leftTsType, rightTsType, expr.left, expr.right)) {
    return emitObjectAdd(ctx, fctx, expr);
  }
  if (
    !wrapperEquality &&
    isStringType(leftTsType) &&
    !leftIsWidenedPrimitiveGlobal &&
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
      // (#3481) BigInt wrapper / ToPrimitive-yields-BigInt. When the NON-bigint
      // operand is dynamically an object/any (`Object(2n)`, `{valueOf(){return
      // 2n}}`, `{[Symbol.toPrimitive](){return 2n}}`), we cannot statically know
      // it is a real "mix": ToNumeric (§7.1.3) may reduce it to a BigInt, in
      // which case the operator is a valid BigInt op (`Object(2n) * 2n === 4n`),
      // not a TypeError. In JS-host mode delegate the whole operator to JS via
      // `__host_bigint_binop` — that gives ToPrimitive (incl. the wrapper /
      // @@toPrimitive / valueOf reduction, with struct operands routed through
      // the in-module dispatcher), the mix TypeError check, and BigInt
      // arithmetic for free. Gate: the non-bigint side is Any|Unknown|Object (a
      // statically number/string/boolean operand is a *provable* mix — keep the
      // cheap throw; JS would throw the same TypeError anyway). Default mode only
      // (`anyValueTypeIdx < 0`), mirroring emitAnyAdd's host-import ABI rule.
      // Standalone/WASI has no JS host, so it keeps the throw (existing
      // limitation — a native ToNumeric reduction is the follow-up slice).
      const noJsHost3481 = ctx.standalone === true || ctx.wasi === true;
      const nonBigIntTsType = leftIsBigInt ? rightTsType : leftTsType;
      const nonBigIntIsObjectish =
        (nonBigIntTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Object)) !== 0;
      const hostBinopCode = bigIntHostBinopOpcode(op);
      if (!noJsHost3481 && ctx.anyValueTypeIdx < 0 && nonBigIntIsObjectish && hostBinopCode !== undefined) {
        // Evaluate operands left→right, box each to externref, store in temps.
        // The statically-bigint side is a branded i64 → __box_bigint yields a JS
        // bigint (force the brand: isBigIntType already proved it is a bigint).
        const lHint: ValType = leftIsBigInt ? { kind: "i64" } : { kind: "externref" };
        const lType = compileExpression(ctx, fctx, expr.left, lHint);
        if (!lType) return null;
        if (lType.kind === "i64") {
          coerceType(ctx, fctx, { kind: "i64", bigint: true }, { kind: "externref" });
        } else if (lType.kind !== "externref") {
          coerceType(ctx, fctx, lType, { kind: "externref" });
        }
        const lTmp = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: lTmp });
        const rHint: ValType = rightIsBigInt ? { kind: "i64" } : { kind: "externref" };
        const rType = compileExpression(ctx, fctx, expr.right, rHint);
        if (!rType) return null;
        if (rType.kind === "i64") {
          coerceType(ctx, fctx, { kind: "i64", bigint: true }, { kind: "externref" });
        } else if (rType.kind !== "externref") {
          coerceType(ctx, fctx, rType, { kind: "externref" });
        }
        const rTmp = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: rTmp });
        const hostIdx = ensureLateImport(
          ctx,
          "__host_bigint_binop",
          [{ kind: "i32" }, { kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        const finalIdx = ctx.funcMap.get("__host_bigint_binop") ?? hostIdx;
        if (finalIdx === undefined) throw new Error("Missing import after ensureLateImport: __host_bigint_binop");
        fctx.body.push({ op: "i32.const", value: hostBinopCode });
        fctx.body.push({ op: "local.get", index: lTmp });
        fctx.body.push({ op: "local.get", index: rTmp });
        releaseTempLocal(fctx, rTmp);
        releaseTempLocal(fctx, lTmp);
        fctx.body.push({ op: "call", funcIdx: finalIdx });
        return { kind: "externref" };
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

  // §13.15.3 reduces BOTH operands with ToPrimitive before choosing between
  // concatenation and numeric addition, but the paths below apply an f64 hint to
  // the RAW operands. Two arms recover that, gated differently and for different
  // reasons — the `any`/`unknown` arm (#2058, host `__host_add`, default-mode
  // only), here, and the OBJECT arm (#4564, in-module, standalone only), which
  // has to sit above the string routes. Both live in addition-to-primitive.ts.
  if (op === ts.SyntaxKind.PlusToken && !isBigIntType(leftTsType) && !isBigIntType(rightTsType)) {
    if (ctx.anyValueTypeIdx < 0) {
      const leftIsAnyish = (leftTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      const rightIsAnyish = (rightTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      if (leftIsAnyish || rightIsAnyish) return emitAnyAdd(ctx, fctx, expr);
    }
  }

  // (#4491 T4) …and the OBJECT arm of the same §13.15.3 dispatch. `emitAnyAdd`
  // is already ToPrimitive-correct; it was simply unreachable for an operand
  // whose static type is a real object type (`Date`, a function, `{}`), which
  // then fell through to the f64 lowering below and unboxed to NaN. Gated
  // exactly like the relational OBJECT arm just below — standalone only, native
  // strings required — so the js-host lane is byte-identical. See
  // add-to-primitive.ts.
  if (op === ts.SyntaxKind.PlusToken && admitsObjectAdd(ctx, leftTsType, rightTsType)) {
    return emitAnyAdd(ctx, fctx, expr);
  }

  // (#2059) Relational where an operand is statically `any`/`unknown`: §7.2.13
  // compares two strings lexicographically, but the numeric paths below
  // ToNumber both sides, so `("a" as any) < ("b" as any)` yielded `false`.
  // Route to the runtime-dispatched compare before the f64 hint is applied.
  //
  // Two arms, deliberately gated differently — see relational-to-primitive.ts:
  //  - ANY arm: unchanged, including its `anyValueTypeIdx < 0` exclusion.
  //  - OBJECT arm (§7.2.12): standalone only, and NOT subject to that exclusion
  //    (the AnyValue helpers do not in fact own this shape). #1374's host
  //    comparator hazard cannot recur there — no host operator is involved.
  if (isRelational) {
    const leftIsAnyish = (leftTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const rightIsAnyish = (rightTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const anyArm = ctx.anyValueTypeIdx < 0 && (leftIsAnyish || rightIsAnyish);
    const objArm = admitsObjectRelational(ctx, leftTsType, rightTsType);
    if ((anyArm || objArm) && !isBigIntType(leftTsType) && !isBigIntType(rightTsType)) {
      return emitAnyRelational(ctx, fctx, expr, op);
    }
  }

  // In fast mode, numeric hint is i32 (unless division/power which promotes to f64).
  // Also use i32 hint when operands have native i32 type annotations (type i32 = number).
  const isDivOrPow = op === ts.SyntaxKind.SlashToken || op === ts.SyntaxKind.AsteriskAsteriskToken;
  // (#3673) node-resolved — see `native-type-annotations.ts`. An int32 literal
  // counts as i32-compatible on either side, but at least one side must carry a
  // real annotation before the i32 hint is taken.
  const leftNativeType = nativeTypeOfExpression(ctx.checker, expr.left);
  const rightNativeType = nativeTypeOfExpression(ctx.checker, expr.right);
  const leftI32ish = leftNativeType?.kind === "i32" || isI32CompatibleOperand(ctx.checker, expr.left);
  const rightI32ish = rightNativeType?.kind === "i32" || isI32CompatibleOperand(ctx.checker, expr.right);
  const bothNativeI32 =
    leftI32ish && rightI32ish && (leftNativeType?.kind === "i32" || rightNativeType?.kind === "i32");
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
  //
  // (#1930 Slice 3 — three-question doctrine.) This is THE **Q-WRAP**
  // matcher: "may this expression be EVALUATED in i32 such that the result
  // is bit-identical to ToInt32(spec value) — GIVEN the caller guarantees an
  // enclosing ToInt32 (bitwise / `| 0`) context?" It legitimately accepts
  // forms the Q-CANON matchers (`isI32SafeExprForArray`,
  // array-element-typing.ts; `isI32SafeExpr`, function-body.ts) must reject:
  // `+`/`-` (exact in f64 ≤ 2^32; wrap ≡ ToInt32 — verdict V2), gated `*`
  // (2^53 proof via `isI32MulSafe`), and `>>>` (uint32 VALUE diverges above
  // 2^31 but the i32 BITS are ToInt32-identical — verdict V3). Do NOT copy
  // arms between the questions; see issue #1930's divergence-verdict table.
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
  // (#3688) `bothStaticNumberEq` joins `isNumericOp` here so equality's operands
  // are emitted in the same unboxed numeric representation the relationals get.
  // It deliberately reuses the SAME i32-vs-f64 term list rather than a bespoke
  // one, so the `type i32 = number` alias work lands `i32.eq` for free through
  // `bothNativeI32`. Note the three remaining i32 terms are self-gating for
  // equality — `hasI32LocalOperand` requires `isRelational`,
  // `arithI32WithToInt32Wrap` requires a ToInt32-coercing bitwise parent, and
  // `bitwiseI32` requires the op itself to be bitwise — so an equality resolves
  // to `(ctx.fast || bothNativeI32) ? i32 : f64`. That is intentional: those
  // three rest on `isI32PureExpr`, whose add/sub/mul arms are only wrap-sound
  // "under the parent's ToInt32 guarantee" (see its comment), which an equality
  // does NOT provide. `(a + b) === c` must not silently compare wrapped i32s.
  // (#3907) `ctx.fast` used to sit at the head of this term list, which made
  // EVERY arithmetic node in fast mode evaluate in i32 — an unconditional
  // narrowing with no proof behind it. `sum = sum + fib(30)` then wrapped at
  // 2^31 (8,320,400,000 read back as -269,534,592) and `a[0] + a[1]` on
  // fractional elements truncated both operands. A TS `number` is an IEEE-754
  // double in every mode; the only sound i32 narrowings are the four
  // proof-carrying terms that remain:
  //   `bothNativeI32`          — explicit `type i32 = number` opt-in (#323/#3673)
  //   `hasI32LocalOperand`     — relational only, both sides proven i32
  //   `arithI32WithToInt32Wrap`— an enclosing ToInt32 makes the wrap observable-equal
  //   `bitwiseI32`             — the op itself is ToInt32-defined
  const numericHint: ValType | undefined =
    isNumericOp || bothStaticNumberEq
      ? {
          kind:
            (bothNativeI32 || hasI32LocalOperand || arithI32WithToInt32Wrap || bitwiseI32) && !isDivOrPow
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

  if (!leftType || !rightType) {
    const v = foldVoidOperandEquality(ctx, fctx, op, leftType, rightType, leftTsType, rightTsType);
    if (v === null || "kind" in v) return v;
    ({ left: leftType, right: rightType } = v); // (#4656) undefined materialised for the void side
  }

  // (#4208 S1) §7.2.16 step 1 then the i32↔f64 promotion — ORDER is the fix.
  const promoted = foldTypeDisjointThenPromote(fctx, expr, op, leftType, rightType, leftTsType, rightTsType);
  if (promoted.folded !== undefined) return promoted.folded;
  leftType = promoted.leftType;
  rightType = promoted.rightType;

  return compileTypedBinaryDispatch(
    ctx,
    fctx,
    expr,
    op,
    leftType,
    rightType,
    leftTsType,
    rightTsType,
    wrapperEquality,
    isNumericOp,
    bothNativeI32,
    hasI32LocalOperand,
    isLooseEq,
    isLooseNeq,
    isEqOp,
    isNeqOp,
    arithI32WithToInt32Wrap,
    bitwiseI32,
  );
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
  const noJsHost = ctx.targetProfile.semanticProviders === "native-first";
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
  // (#4491 T4) §20.2.3.5 step 1 — a top-level function operand reduces to its
  // captured SOURCE TEXT, the same string `fn.toString()` already returns
  // (#1463). Materialize it here so the two spellings agree; without this the
  // runtime residue fallback answers step 3's NativeFunction placeholder and
  // `f1 + 1 === f1.toString() + 1` is false. See add-to-primitive.ts for the
  // four guards that keep the fold honest.
  const callableSource = addOperandCallableSourceText(ctx, fctx, inner);
  if (callableSource !== undefined) {
    addStringConstantGlobal(ctx, callableSource);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, callableSource));
    const srcTmp = allocTempLocal(fctx, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: srcTmp });
    return srcTmp;
  }
  let structName = noJsHost ? resolveStructNameForExpr(ctx, fctx, inner) : undefined;
  if (noJsHost && structName === undefined && ts.isIdentifier(inner)) {
    const localIdx = fctx.localMap.get(inner.text);
    const localType =
      localIdx === undefined
        ? undefined
        : localIdx < fctx.params.length
          ? fctx.params[localIdx]?.type
          : fctx.locals[localIdx - fctx.params.length]?.type;
    if (localType?.kind === "ref" || localType?.kind === "ref_null") {
      structName = ctx.typeIdxToStructName.get(localType.typeIdx);
    }
    if (structName === undefined) {
      const declaration = ctx.checker.getSymbolAtLocation(inner)?.valueDeclaration;
      const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
      if (initializer) {
        structName = resolveStructName(ctx, ctx.checker.getTypeAtLocation(initializer));
        if (structName === undefined && ts.isObjectLiteralExpression(initializer)) {
          const memberNames = initializer.properties
            .map((member) => {
              if (ts.isShorthandPropertyAssignment(member)) return member.name.text;
              if (
                (ts.isPropertyAssignment(member) ||
                  ts.isMethodDeclaration(member) ||
                  ts.isGetAccessorDeclaration(member) ||
                  ts.isSetAccessorDeclaration(member)) &&
                (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name))
              ) {
                return member.name.text;
              }
              return undefined;
            })
            .filter((name): name is string => name !== undefined)
            .sort();
          for (const [candidate, fields] of ctx.structFields) {
            const fieldNames = fields.map((field) => field.name).sort();
            if (
              fieldNames.length === memberNames.length &&
              fieldNames.every((name, index) => name === memberNames[index])
            ) {
              structName = candidate;
              break;
            }
          }
        }
      }
    }
  }
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
  const noJsHost = ctx.targetProfile.semanticProviders === "native-first";

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
  return emitAnyAddFromExternTemps(ctx, fctx, lTmp, rTmp);
}

/**
 * (#3673) The §13.15.3 `+` dispatch for two operands ALREADY evaluated into
 * externref temps — the temps-based twin of {@link emitAnyAdd}, mirroring
 * `emitAnyEqFromExternTemps`.
 *
 * Split out because the compound `obj.prop += rhs` lowering
 * (`operator-assignment.ts`) has no `ts.BinaryExpression` to hand `emitAnyAdd`:
 * its left operand is the value it just READ back out of the property. The host
 * lane could paper over that by calling `__host_add` directly (#2850), but the
 * standalone lane has no such import, so it was left on an unconditional
 * numeric `f64.add` — which silently NaN'd every dynamic string `+=`.
 *
 * Consumes (and releases) both temps; returns the ValType left on the stack —
 * `externref` on the real dispatch, `f64` on the no-native-strings fallback.
 */
export function emitAnyAddFromExternTemps(
  ctx: CodegenContext,
  fctx: FunctionContext,
  lTmp: number,
  rTmp: number,
): ValType {
  const noJsHost = ctx.targetProfile.semanticProviders === "native-first";

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
        fctx.body.push({ op: "ref.null.extern" }); // default hint
        fctx.body.push({ op: "call", funcIdx: toPrimIdx });
        fctx.body.push({ op: "local.set", index: lPrim });
        fctx.body.push({ op: "local.get", index: rTmp });
        fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "call", funcIdx: toPrimIdx });
        fctx.body.push({ op: "local.set", index: rPrim });
        // (#4491 T4) §7.1.1.1 step 6 — `__to_primitive`'s non-`$Object` tail
        // hands a function closure / `Date` struct back UNCHANGED, which the
        // string-vs-numeric test below then unboxes to NaN. Finish the
        // reduction with the ordinary valueOf→toString probe the spec mandates.
        if (finalToStr !== undefined) {
          emitAddOrdinaryToPrimitiveResidue(ctx, fctx, lPrim, finalToStr);
          emitAddOrdinaryToPrimitiveResidue(ctx, fctx, rPrim, finalToStr);
        }
      } else {
        // Degrade: no ToPrimitive available — carry the raw operands through.
        fctx.body.push({ op: "local.get", index: lTmp });
        fctx.body.push({ op: "local.set", index: lPrim });
        fctx.body.push({ op: "local.get", index: rTmp });
        fctx.body.push({ op: "local.set", index: rPrim });
      }

      const emitToAnyString = (tmp: number): Instr[] => [
        { op: "local.get", index: tmp },
        { op: "call", funcIdx: finalToStr! },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      ];

      // if (__typeof_string(lprim) | __typeof_string(rprim)) → concat both as
      //                                            strings
      //                                      else            → f64.add(unbox, unbox)
      const concatArm: Instr[] = [
        ...emitToAnyString(lPrim),
        ...emitToAnyString(rPrim),
        { op: "call", funcIdx: concatIdx },
        { op: "extern.convert_any" },
      ];
      const numericArm: Instr[] = [
        { op: "local.get", index: lPrim },
        { op: "call", funcIdx: unboxNum },
        { op: "local.get", index: rPrim },
        { op: "call", funcIdx: unboxNum },
        { op: "f64.add" },
      ];
      // Box the numeric arm's f64 result back to externref so both arms agree.
      const boxNum = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      const finalBoxNum = ctx.funcMap.get("__box_number") ?? boxNum;
      numericArm.push({ op: "call", funcIdx: finalBoxNum! });

      fctx.body.push({ op: "local.get", index: lPrim });
      fctx.body.push({ op: "call", funcIdx: typeofStr });
      fctx.body.push({ op: "local.get", index: rPrim });
      fctx.body.push({ op: "call", funcIdx: typeofStr });
      fctx.body.push({ op: "i32.or" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: concatArm,
        else: numericArm,
      });
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
  const noJsHost = ctx.targetProfile.semanticProviders === "native-first";
  // Registered before the operands compile, so its setup cannot desync funcIdxs.
  if (noJsHost && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) ensureObjectRuntime(ctx);

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
    // §7.2.12 step 1 — the arm below must be chosen from the PRIMITIVES.
    reduceRelationalOperandsToPrimitive(ctx, fctx, lTmp, rTmp);
    const typeofStr = ctx.funcMap.get("__typeof_string");
    const unboxNum = ctx.funcMap.get("__unbox_number");
    const strCompare = ctx.nativeStrHelpers.get("__str_compare");
    const strFlatten = ctx.nativeStrHelpers.get("__str_flatten");
    if (typeofStr !== undefined && unboxNum !== undefined && strCompare !== undefined && strFlatten !== undefined) {
      // ToString-free lexicographic compare of two boxed native strings → -1/0/1.
      const toFlatNativeStr = (tmp: number): Instr[] => [
        { op: "local.get", index: tmp },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        { op: "call", funcIdx: strFlatten },
      ];
      const strArm: Instr[] = [...toFlatNativeStr(lTmp), ...toFlatNativeStr(rTmp), { op: "call", funcIdx: strCompare }];
      // Numeric arm: ToNumber(unbox) both sides, then derive a -1/0/1/2 sign.
      const lf = allocTempLocal(fctx, { kind: "f64" });
      const rf = allocTempLocal(fctx, { kind: "f64" });
      const numSign: Instr[] = [
        { op: "local.get", index: lTmp },
        { op: "call", funcIdx: unboxNum },
        { op: "local.set", index: lf },
        { op: "local.get", index: rTmp },
        { op: "call", funcIdx: unboxNum },
        { op: "local.set", index: rf },
        // (l < r) ? -1 : (l > r ? 1 : (l == r ? 0 : 2))
        { op: "local.get", index: lf },
        { op: "local.get", index: rf },
        { op: "f64.lt" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: -1 }],
          else: [
            { op: "local.get", index: lf },
            { op: "local.get", index: rf },
            { op: "f64.gt" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [{ op: "i32.const", value: 1 }],
              else: [
                { op: "local.get", index: lf },
                { op: "local.get", index: rf },
                { op: "f64.eq" },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [{ op: "i32.const", value: 0 }],
                  else: [{ op: "i32.const", value: 2 }], // NaN → incomparable
                },
              ],
            },
          ],
        },
      ];
      const cmpTmp = allocTempLocal(fctx, { kind: "i32" });
      // if (__typeof_string(l) && __typeof_string(r)) strArm else numSign
      fctx.body.push({ op: "local.get", index: lTmp });
      fctx.body.push({ op: "call", funcIdx: typeofStr });
      fctx.body.push({ op: "local.get", index: rTmp });
      fctx.body.push({ op: "call", funcIdx: typeofStr });
      fctx.body.push({ op: "i32.and" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: strArm,
        else: numSign,
      });
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
export function compileI32BinaryOp(
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
export function compileI64BinaryOp(
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
 * Emit JS ToInt32 via IEEE-754 bit decomposition (sign/exponent/significand),
 * matching how native JS engines implement it in C++. Deliberately avoids
 * f64.floor/f64.div: a handwritten-Wasm bisection (#3753) found that the
 * floor-based modulo-reduction sequence this replaced never gets tiered up
 * by V8 in a tight loop (stuck at Liftoff baseline speed indefinitely,
 * ~12x slower than an equivalent pure-f64 loop with no floor at all) — an
 * engine limitation, not a codegen bug, but avoidable here since ToInt32
 * doesn't need floor: the exponent already tells us exactly which bits of
 * the significand land in the low 32 bits of floor(|x|).
 * Stack: [f64] → [i32]
 */
export function emitToInt32(fctx: FunctionContext): void {
  // ECMA-262 ToInt32 (7.1.6): NaN/±0/±Infinity → 0; else
  // int32bit = (sign(x) * floor(abs(x))) mod 2^32, wrapped to signed range.
  //
  // bits = i64 reinterpret of x. biasedExp = bits[62:52]; e = biasedExp - 1023
  // (unbiased exponent — negative for |x|<1 and denormals; 1024 for NaN/Inf,
  // both of which fall out of the valid window below and yield 0 for free).
  // significand = 53-bit magnitude (mantissa | implicit leading bit).
  //
  // floor(|x|)'s bit `k` is significand's bit `k - (e - 52)`. Only bits
  // [0,31] of floor(|x|) mod 2^32 matter, so:
  //   e < 0 or e > 83  → those bits are always 0 (either |x|<1, or the
  //                       significand's bits all sit at position >=32)
  //   e >= 52          → shift significand LEFT by (e-52); only 0..31 needed
  //   0 <= e < 52      → shift significand RIGHT (u) by (52-e), truncating
  //                       the fractional bits, matching floor()
  // i32.wrap_i64 keeps exactly the low 32 bits either way. Negate at the end
  // if x's sign bit was set (two's-complement wraparound negation is correct
  // ToInt32 behavior — no separate overflow case to handle).
  const bits = allocTempLocal(fctx, { kind: "i64" });
  const e = allocTempLocal(fctx, { kind: "i64" });
  const significand = allocTempLocal(fctx, { kind: "i64" });
  const magnitude = allocTempLocal(fctx, { kind: "i64" });

  fctx.body.push({ op: "i64.reinterpret_f64" });
  fctx.body.push({ op: "local.set", index: bits });

  fctx.body.push({ op: "local.get", index: bits });
  fctx.body.push({ op: "i64.const", value: 52n });
  fctx.body.push({ op: "i64.shr_u" });
  fctx.body.push({ op: "i64.const", value: 0x7ffn });
  fctx.body.push({ op: "i64.and" });
  fctx.body.push({ op: "i64.const", value: 1023n });
  fctx.body.push({ op: "i64.sub" });
  fctx.body.push({ op: "local.set", index: e });

  fctx.body.push({ op: "local.get", index: bits });
  fctx.body.push({ op: "i64.const", value: 0xfffffffffffffn });
  fctx.body.push({ op: "i64.and" });
  fctx.body.push({ op: "i64.const", value: 0x10000000000000n });
  fctx.body.push({ op: "i64.or" });
  fctx.body.push({ op: "local.set", index: significand });

  const shiftLeft: Instr[] = [
    { op: "local.get", index: significand },
    { op: "local.get", index: e },
    { op: "i64.const", value: 52n },
    { op: "i64.sub" },
    { op: "i64.shl" },
  ];
  const shiftRight: Instr[] = [
    { op: "local.get", index: significand },
    { op: "i64.const", value: 52n },
    { op: "local.get", index: e },
    { op: "i64.sub" },
    { op: "i64.shr_u" },
  ];
  fctx.body.push({ op: "local.get", index: e });
  fctx.body.push({ op: "i64.const", value: 0n });
  fctx.body.push({ op: "i64.ge_s" });
  fctx.body.push({ op: "local.get", index: e });
  fctx.body.push({ op: "i64.const", value: 83n });
  fctx.body.push({ op: "i64.le_s" });
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i64" } as ValType },
    then: [
      { op: "local.get", index: e },
      { op: "i64.const", value: 52n },
      { op: "i64.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } as ValType },
        then: shiftLeft,
        else: shiftRight,
      },
    ],
    else: [{ op: "i64.const", value: 0n }],
  });
  fctx.body.push({ op: "local.set", index: magnitude });

  fctx.body.push({ op: "local.get", index: bits });
  fctx.body.push({ op: "i64.const", value: 0n });
  fctx.body.push({ op: "i64.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } as ValType },
    then: [
      { op: "i32.const", value: 0 },
      { op: "local.get", index: magnitude },
      { op: "i32.wrap_i64" },
      { op: "i32.sub" },
    ],
    else: [{ op: "local.get", index: magnitude }, { op: "i32.wrap_i64" }],
  });

  releaseTempLocal(fctx, bits);
  releaseTempLocal(fctx, e);
  releaseTempLocal(fctx, significand);
  releaseTempLocal(fctx, magnitude);
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
  fctx.body.push({ op: "local.set", index: x });

  // roundHalfEven(x) → i32 (only evaluated when 0 < x < 255, so trunc is exact):
  //   f = floor(x); d = x - f;
  //   d<0.5 → f ; d>0.5 → f+1 ; d==0.5 → (f even ? f : f+1)
  const roundHalfEven: Instr[] = [
    { op: "local.get", index: x },
    { op: "f64.floor" },
    { op: "local.set", index: f },
    { op: "local.get", index: x },
    { op: "local.get", index: f },
    { op: "f64.sub" },
    { op: "local.set", index: d },
    // d < 0.5 ?
    { op: "local.get", index: d },
    { op: "f64.const", value: 0.5 },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } as ValType },
      then: [{ op: "local.get", index: f }],
      else: [
        // d > 0.5 ?
        { op: "local.get", index: d },
        { op: "f64.const", value: 0.5 },
        { op: "f64.gt" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } as ValType },
          then: [{ op: "local.get", index: f }, { op: "f64.const", value: 1 }, { op: "f64.add" }],
          else: [
            // tie (d == 0.5): round to even. f even ⇔ floor(f/2) == f/2.
            { op: "local.get", index: f },
            { op: "f64.const", value: 0.5 },
            { op: "f64.mul" },
            { op: "local.set", index: d }, // d := f/2 (reuse d, no longer needed)
            { op: "local.get", index: d },
            { op: "f64.floor" },
            { op: "local.get", index: d },
            { op: "f64.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } as ValType },
              then: [{ op: "local.get", index: f }],
              else: [{ op: "local.get", index: f }, { op: "f64.const", value: 1 }, { op: "f64.add" }],
            },
          ],
        },
      ],
    },
    { op: "i32.trunc_sat_f64_u" },
    { op: "local.set", index: out },
  ];

  // Clamp: x>=255 → 255 ; x>0 (NaN-false) → round ; else → 0.
  fctx.body.push({ op: "local.get", index: x });
  fctx.body.push({ op: "f64.const", value: 255 });
  fctx.body.push({ op: "f64.ge" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 255 },
      { op: "local.set", index: out },
    ],
    else: [
      { op: "local.get", index: x },
      { op: "f64.const", value: 0 },
      { op: "f64.gt" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: roundHalfEven,
        else: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: out },
        ],
      },
    ],
  });
  fctx.body.push({ op: "local.get", index: out });
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

export function compileBooleanBinaryOp(ctx: CodegenContext, fctx: FunctionContext, op: ts.SyntaxKind): ValType {
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
