// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Miscellaneous expression compilation: conditionals, generators/yield,
 * struct name resolution, and static analysis helpers.
 */
import { ts } from "../../ts-api.js";
import { isStringType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { TypeFact } from "../../checker/oracle.js";
import { pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureI32Condition, isAnyValue } from "../index.js";
import {
  getIteratorResultValueType,
  isGeneratorIteratorResultLike,
  resolveStructName,
  resolveStructNameForExpr,
} from "../property-access.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, valTypesMatch } from "../shared.js";
import { evaluateConstantCondition } from "../statements/control-flow.js";

// Re-export for backward compatibility — these helpers now live in property-access.ts.
export { getIteratorResultValueType, isGeneratorIteratorResultLike, resolveStructName, resolveStructNameForExpr };

function compileConditionalExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ConditionalExpression,
): ValType | null {
  // Constant-folding: if the condition is a compile-time constant, emit only the taken branch.
  const constResult = evaluateConstantCondition(expr.condition);
  if (constResult !== undefined) {
    return compileExpression(ctx, fctx, constResult ? expr.whenTrue : expr.whenFalse);
  }

  const condType = compileExpression(ctx, fctx, expr.condition);
  if (!condType) {
    // void condition — JS treats undefined as falsy, so push i32.const 0
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    ensureI32Condition(fctx, condType, ctx);
  }

  const savedBody = pushBody(fctx);
  const thenResultType = compileExpression(ctx, fctx, expr.whenTrue);
  // If the then-branch is void (no value on stack), push a default value
  // so the ternary has a consistent result. JS treats void as undefined → NaN for numbers.
  if (!thenResultType) {
    fctx.body.push({ op: "f64.const", value: NaN });
  }
  let thenInstrs = fctx.body;

  // Park the completed then branch while the else branch compiles. Late imports
  // registered by the else branch shift every defined-function index; detached
  // branch bodies must be visible to that shift walker as well. Large bundles
  // such as ReactDOM otherwise left the then branch calling a neighbouring
  // function after the else branch pulled in a helper.
  fctx.savedBodies.push(thenInstrs);
  fctx.body = [];
  const elseResultType = compileExpression(ctx, fctx, expr.whenFalse);
  if (!elseResultType) {
    fctx.body.push({ op: "f64.const", value: NaN });
  }
  let elseInstrs = fctx.body;

  // Keep both completed branches parked through the common-type coercion below:
  // coercion can itself register late imports and shift call indices.
  fctx.savedBodies.push(elseInstrs);
  fctx.body = savedBody;

  const thenType: ValType = thenResultType ?? { kind: "f64" };
  const elseType: ValType = elseResultType ?? { kind: "f64" };

  // Determine the common result type for both branches
  let resultValType: ValType = thenType;

  const sameKind = thenType.kind === elseType.kind;
  const sameRefIdx =
    sameKind &&
    (thenType.kind === "ref" || thenType.kind === "ref_null") &&
    (thenType as { typeIdx: number }).typeIdx === (elseType as { typeIdx: number }).typeIdx;

  if (!sameKind || ((thenType.kind === "ref" || thenType.kind === "ref_null") && !sameRefIdx)) {
    // Types differ — find a common type and coerce both branches
    if ((thenType.kind === "i32" || thenType.kind === "f64") && (elseType.kind === "i32" || elseType.kind === "f64")) {
      // Both numeric — coerce to f64
      resultValType = { kind: "f64" };
    } else if (
      (thenType.kind === "ref" || thenType.kind === "ref_null") &&
      (elseType.kind === "ref" || elseType.kind === "ref_null") &&
      isAnyValue(thenType, ctx) === isAnyValue(elseType, ctx)
    ) {
      // Both refs but different typeIdx — use ref_null of the then type
      resultValType =
        thenType.kind === "ref"
          ? {
              kind: "ref_null",
              typeIdx: (thenType as { typeIdx: number }).typeIdx,
            }
          : thenType;
    } else if (
      ctx.unionAnyRep &&
      ctx.anyValueTypeIdx >= 0 &&
      ((f: TypeFact): boolean =>
        f.kind === "union" &&
        f.parts.every((p) => p.kind === "number" || p.kind === "string" || p.kind === "boolean") &&
        new Set(f.parts.map((p) => p.kind)).size >= 2)(ctx.oracle.typeFactOf(expr))
    ) {
      // (#745 S4, flag-gated) A mixed-kind ternary whose own type is a
      // heterogeneous primitive union (`k > 0 ? 7 : "neg"` in a
      // `number | string` position) joins on the `$AnyValue` carrier, NOT
      // externref: each arm boxes via its statically-known kind (f64 →
      // tag-3, native string → tag-5, boolean-branded i32 → tag-4), so the
      // runtime tag is honest. The old externref join re-boxed at the
      // return/assignment coercion through the legacy #1888 tag-5 default —
      // a returned NUMBER became a tag-5 "string" and `typeof r ===
      // "number"` answered false (the S4 retUnion row).
      resultValType = { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
    } else {
      // Fallback: coerce both to externref
      resultValType = { kind: "externref" };
    }

    // Coerce then-branch to the common type
    if (!valTypesMatch(thenType, resultValType)) {
      const coerceBody: Instr[] = [];
      fctx.body = coerceBody;
      coerceType(ctx, fctx, thenType, resultValType);
      fctx.body = savedBody;
      thenInstrs = [...thenInstrs, ...coerceBody];
    }

    // Coerce else-branch to the common type
    if (!valTypesMatch(elseType, resultValType)) {
      const coerceBody: Instr[] = [];
      fctx.body = coerceBody;
      coerceType(ctx, fctx, elseType, resultValType);
      fctx.body = savedBody;
      elseInstrs = [...elseInstrs, ...coerceBody];
    }
  } else {
    // Same type — just pass the then-type through
    resultValType = thenType;
  }

  // Conditional results must be nullable — either branch could produce null
  if (resultValType.kind === "ref") {
    resultValType = {
      kind: "ref_null",
      typeIdx: (resultValType as { typeIdx: number }).typeIdx,
    };
  }

  // Unpark else, then, and the original body registered by pushBody above.
  fctx.savedBodies.pop();
  fctx.savedBodies.pop();
  fctx.savedBodies.pop();
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultValType },
    then: thenInstrs,
    else: elseInstrs,
  });

  return resultValType;
}

// ── Optional chaining ────────────────────────────────────────────────

/**
 * Optional property access: obj?.prop
 * Compiles obj, checks if null → returns null, else accesses property normally.
 */
// Object/array/tuple/symbol literal compilation has been extracted to ./literals.ts (#688 step 7).

// Object.defineProperty flag helpers, compileObjectDefineProperty,
// compileObjectKeysOrValues, and compilePropertyIntrospection have been
// extracted to ./object-ops.ts (#688 step 6).

// resolveStructName, isGeneratorIteratorResultLike, getIteratorResultValueType have been
// moved to property-access.ts (re-exported above for backward compatibility).

// ── Generator yield expression ────────────────────────────────────────

/**
 * Compile a `yield expr` expression inside a generator function.
 * Pushes the yielded value into the __gen_buffer (a JS array managed by the host).
 * The yield expression itself evaluates to void (we don't support receiving
 * values via yield in this initial implementation).
 */
function compileYieldExpression(ctx: CodegenContext, fctx: FunctionContext, expr: ts.YieldExpression): InnerResult {
  // Ensure we're inside a generator function
  if (!fctx.isGenerator) {
    reportError(ctx, expr, "yield expression outside of generator function");
    return null;
  }

  // Get the buffer local
  const bufferIdx = fctx.localMap.get("__gen_buffer");
  if (bufferIdx === undefined) {
    reportError(ctx, expr, "Internal error: __gen_buffer not found in generator function");
    return null;
  }

  // ── yield* delegation: iterate inner generator and push all values into outer buffer ──
  if (expr.asteriskToken) {
    if (!expr.expression) {
      reportError(ctx, expr, "yield* requires an expression");
      return null;
    }
    // Compile the inner iterable expression (returns the generator/iterable object)
    const innerType = compileExpression(ctx, fctx, expr.expression);
    if (innerType === null) {
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" } as ValType;
    }
    // Coerce to externref if needed
    const coerced = coerceType(ctx, fctx, innerType, { kind: "externref" } as ValType);
    // Store in temp, then call __gen_yield_star(buffer, iterable)
    const tmpLocal = allocLocal(fctx, `__yield_star_tmp_${fctx.locals.length}`, { kind: "externref" } as ValType);
    fctx.body.push({ op: "local.set", index: tmpLocal });
    fctx.body.push({ op: "local.get", index: bufferIdx });
    fctx.body.push({ op: "local.get", index: tmpLocal });
    const yieldStarIdx = ctx.funcMap.get("__gen_yield_star");
    if (yieldStarIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: yieldStarIdx });
    }
    // yield* evaluates to undefined in our eager model
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" } as ValType;
  }

  if (!expr.expression) {
    // yield with no value: push undefined
    const pushRefIdx = ctx.funcMap.get("__gen_push_ref");
    if (pushRefIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: bufferIdx });
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "call", funcIdx: pushRefIdx });
    }
    // In the eager generator model, yield always "receives" undefined from .next().
    // Push ref.null extern so callers that use yield as an expression get a value.
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" } as ValType;
  }

  // Compile the yielded expression
  const yieldedType = compileExpression(ctx, fctx, expr.expression);
  if (yieldedType === null) {
    // Even if the yielded expression produced nothing, yield itself is an
    // expression that returns the value from .next() — push undefined.
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" } as ValType;
  }

  // Store the yielded value in a temp local, then push to buffer
  const tmpLocal = allocLocal(fctx, `__yield_tmp_${fctx.locals.length}`, yieldedType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Push to buffer based on type
  fctx.body.push({ op: "local.get", index: bufferIdx });
  fctx.body.push({ op: "local.get", index: tmpLocal });

  if (yieldedType.kind === "f64") {
    const pushIdx = ctx.funcMap.get("__gen_push_f64");
    if (pushIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: pushIdx });
    }
  } else if (yieldedType.kind === "i32") {
    const pushIdx = ctx.funcMap.get("__gen_push_i32");
    if (pushIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: pushIdx });
    }
  } else if (yieldedType.kind === "i64") {
    // #2993: a `yield <bigint>` (or native `i64`) lowers the yielded value to a
    // raw i64, but the generic buffer slot is `__gen_push_ref(externref, externref)`.
    // Without boxing, the i64 lands in the externref parameter slot and the module
    // fails WasmGC validation ("expected type externref, found local.get of type i64"
    // in the generator closure body, e.g. `__closure_0`). Box the i64 → externref via
    // `coerceType`, which picks `__box_bigint` for a bigint-branded i64 (round-trips as
    // a JS bigint) and `__box_number` for a native `type i64 = number` value. The value
    // is already on the stack (with only the buffer operand beneath it), so the coercion
    // ops apply to it in place before the push call. `coerceType` may add late union
    // imports (index-shifting), so resolve the `__gen_push_ref` funcIdx AFTER it runs.
    coerceType(ctx, fctx, yieldedType, { kind: "externref" } as ValType);
    const pushIdx = ctx.funcMap.get("__gen_push_ref");
    if (pushIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: pushIdx });
    }
  } else {
    // externref, ref, ref_null — all pass as externref
    const pushIdx = ctx.funcMap.get("__gen_push_ref");
    if (pushIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: pushIdx });
    }
  }

  // In the eager generator model, yield always "receives" undefined from .next().
  // Push ref.null extern so callers that use yield as an expression get a value.
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" } as ValType;
}

/**
 * (#4178) Does this expression statically resolve to a STRING value?
 *
 * `tryStaticToNumber` refuses to fold `+` when an operand is a string (the
 * operator is concatenation, not addition), but it only tested two things: the
 * operand being a *syntactic* string literal, and the checker saying the
 * operand's type is `string`. Neither fires for
 *
 *   const a: any = "1"; const b: any = 2; a + b
 *
 * — `a` is an identifier, and its declared type is `any`. Yet the identifier
 * arm at the BOTTOM of `tryStaticToNumber` happily traces `a` back through its
 * `const` initializer and answers `Number("1") === 1`, so the whole expression
 * folded to `f64.const 3` instead of concatenating to `"12"`. The *value*
 * resolution traced const bindings; the *string-ness* guard did not, and that
 * asymmetry is the bug.
 *
 * This predicate closes it by tracing the same way, with the same `const`-only
 * and self-reference (`#1607`) restrictions, so the guard can never be weaker
 * than the folder it guards. Deliberately conservative — it answers `true` only
 * for values it can prove are strings, so an unresolvable operand still folds
 * exactly as before.
 */
function resolvesToStringConstant(ctx: CodegenContext, expr: ts.Expression, visited?: Set<ts.Node>): boolean {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return true;
  // A template with substitutions is always a string, however it evaluates.
  if (ts.isTemplateExpression(expr)) return true;
  if (ts.isParenthesizedExpression(expr)) return resolvesToStringConstant(ctx, expr.expression, visited);
  if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    return resolvesToStringConstant(ctx, expr.expression, visited);
  }
  // `s1 + s2` is itself a string when either side is — concatenation is
  // string-producing, so a nested concat poisons the enclosing fold too.
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return resolvesToStringConstant(ctx, expr.left, visited) || resolvesToStringConstant(ctx, expr.right, visited);
  }
  if (ts.isIdentifier(expr)) {
    // `ctx.oracle.constInitializerOf` is the checker boundary for exactly this
    // query (#1930) and enforces the `const`-only restriction itself — `let`/
    // `var` are reassignable, so their initializer is not their value.
    const init = ctx.oracle.constInitializerOf(expr);
    if (!init) return false;
    const seen = visited ?? new Set<ts.Node>();
    if (seen.has(init)) return false; // #1607 self-referential initializer
    seen.add(init);
    return resolvesToStringConstant(ctx, init, seen);
  }
  return false;
}

/** Check if an expression is statically known to be NaN at compile time */
/**
 * Try to statically determine the numeric value of an expression.
 * Handles: numeric literals, NaN, Infinity, -Infinity, object-with-valueOf, {}.
 * Returns undefined if the value cannot be determined at compile time.
 */
export function tryStaticToNumber(
  ctx: CodegenContext,
  expr: ts.Expression,
  // #1607: guard against self-referential lexical initializers (TDZ), e.g.
  // `const x = x;` or `await using x = x + 1;`. Tracing an identifier back to
  // its own declaration initializer would otherwise recurse forever and blow
  // the JS call stack during codegen. We record each variable-declaration node
  // we trace through and refuse to re-enter one already on the current path.
  visitedDecls?: Set<ts.Node>,
): number | undefined {
  // Numeric literal
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  // String literal → ToNumber: "" → 0, "123" → 123, "abc" → NaN
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return Number(expr.text);
  // null → 0
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 0;
  // undefined → NaN
  if (ts.isIdentifier(expr) && expr.text === "undefined") return NaN;
  // true → 1, false → 0
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 1;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 0;
  // NaN identifier
  if (ts.isIdentifier(expr) && expr.text === "NaN") return NaN;
  // Infinity identifier
  if (ts.isIdentifier(expr) && expr.text === "Infinity") return Infinity;
  // -Infinity: prefix minus on Infinity
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const inner = tryStaticToNumber(ctx, expr.operand, visitedDecls);
    if (inner !== undefined) return -inner;
  }
  // Binary expressions: fold constant operands at compile time
  if (ts.isBinaryExpression(expr)) {
    // Don't fold string + anything as numeric — JS semantics requires string concat
    if (
      expr.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (resolvesToStringConstant(ctx, expr.left) || resolvesToStringConstant(ctx, expr.right))
    ) {
      return undefined;
    }
    const left = tryStaticToNumber(ctx, expr.left, visitedDecls);
    const right = tryStaticToNumber(ctx, expr.right, visitedDecls);
    if (left !== undefined && right !== undefined) {
      switch (expr.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: {
          // For +, check if either operand is a string type in TS.
          // If so, + is string concatenation, not numeric addition,
          // and we cannot fold to a number.
          const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
          const rightTsType = ctx.checker.getTypeAtLocation(expr.right);
          if (isStringType(leftTsType) || isStringType(rightTsType)) return undefined;
          return left + right;
        }
        case ts.SyntaxKind.MinusToken:
          return left - right;
        case ts.SyntaxKind.AsteriskToken:
          return left * right;
        case ts.SyntaxKind.SlashToken:
          return right !== 0 ? left / right : undefined;
        case ts.SyntaxKind.PercentToken:
          return right !== 0 ? left % right : undefined;
        case ts.SyntaxKind.AsteriskAsteriskToken:
          return left ** right;
        case ts.SyntaxKind.AmpersandToken:
          return left & right;
        case ts.SyntaxKind.BarToken:
          return left | right;
        case ts.SyntaxKind.CaretToken:
          return left ^ right;
        case ts.SyntaxKind.LessThanLessThanToken:
          return left << right;
        case ts.SyntaxKind.GreaterThanGreaterThanToken:
          return left >> right;
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
          return left >>> right;
        default:
          break; // non-numeric binary op, fall through
      }
    }
  }
  // Property access on string literals: "hello".length → 5
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "length") {
    const obj = expr.expression;
    if (ts.isStringLiteral(obj) || ts.isNoSubstitutionTemplateLiteral(obj)) {
      return obj.text.length;
    }
    // Also resolve through const variables: const s = "hello"; s.length → 5
    if (ts.isIdentifier(obj)) {
      const sym = ctx.checker.getSymbolAtLocation(obj);
      const decl = sym?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = decl.initializer;
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
          return init.text.length;
        }
      }
    }
  }
  // Object literal: check valueOf, then toString per ToPrimitive spec (#866)
  // Only fold when we can fully statically resolve the return value.
  // If valueOf/toString have side effects (throw, etc.), bail out to runtime.
  if (ts.isObjectLiteralExpression(expr)) {
    // Empty object literal {} → ToNumber({}) = NaN per spec
    if (expr.properties.length === 0) return NaN;
    // Try valueOf first (hint "number")
    const valueOfProp = expr.properties.find(
      (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "valueOf",
    );
    let valueOfReturnsObject = false;
    if (valueOfProp && ts.isPropertyAssignment(valueOfProp)) {
      const init = valueOfProp.initializer;
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
        // Check if valueOf returns a non-primitive (object/array) — ToPrimitive
        // falls through to toString in that case, so we can't use valueOf's result.
        // Unwrap parenthesized expressions: `() => ({})` parses with the body as a
        // ParenthesizedExpression around the ObjectLiteral, not as the literal directly.
        const returnExpr = unwrapParens(getReturnExpression(init));
        if (returnExpr && (ts.isObjectLiteralExpression(returnExpr) || ts.isArrayLiteralExpression(returnExpr))) {
          // valueOf returns a non-primitive → fall through to toString
          valueOfReturnsObject = true;
        } else {
          const retVal = getStaticReturnValue(ctx, init);
          if (retVal !== undefined) return retVal;
          // valueOf exists but can't be statically resolved (may throw, have side effects)
          // → bail out to runtime, don't fold
          return undefined;
        }
      } else {
        // valueOf is not a function literal → can't fold
        return undefined;
      }
    }
    // No valueOf (or valueOf returned non-primitive) → try toString
    // (ToPrimitive falls back to toString per JS spec).
    const toStringProp = expr.properties.find(
      (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "toString",
    );
    if (toStringProp && ts.isPropertyAssignment(toStringProp)) {
      const init = toStringProp.initializer;
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
        // #1253: if toString returns a non-primitive too, ToPrimitive throws TypeError
        // per ECMA-262 §7.1.1.1 step 6. Bail to runtime so the runtime ToPrimitive
        // path can throw (instead of folding to NaN, which silently swallows the
        // spec-required exception).
        const returnExpr = unwrapParens(getReturnExpression(init));
        if (returnExpr && (ts.isObjectLiteralExpression(returnExpr) || ts.isArrayLiteralExpression(returnExpr))) {
          return undefined;
        }
        const retVal = getStaticReturnValue(ctx, init);
        if (retVal !== undefined) return retVal;
        // toString exists but can't be statically resolved → bail to runtime
        return undefined;
      }
      // toString is not a function literal → can't fold
      return undefined;
    }
    // #1253: if valueOf returned a non-primitive AND there is no toString
    // override, ToPrimitive falls back to Object.prototype.toString which
    // returns "[object Object]" → ToNumber → NaN. So `+{ valueOf: () => ({}) }`
    // legitimately produces NaN per spec (no TypeError). The static fold of
    // NaN is fine here. The TypeError path requires both valueOf and toString
    // overrides to return non-primitives; that case is handled above.
    if (valueOfReturnsObject) return NaN;
    // No valueOf or toString → NaN (spec: ToNumber({}) = NaN via prototype chain)
    return NaN;
  }
  // Parenthesized expression: unwrap parentheses
  if (ts.isParenthesizedExpression(expr)) {
    return tryStaticToNumber(ctx, expr.expression, visitedDecls);
  }
  // Unary + (ToNumber coercion): +expr
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.PlusToken) {
    return tryStaticToNumber(ctx, expr.operand, visitedDecls);
  }
  // Variable: trace to initializer (only for const declarations to avoid
  // incorrectly folding mutable variables like `let heapSize = 0`).
  //
  // #1253: Don't trace through object/array literal initializers — the
  // binding is const but the object's properties can still be mutated later
  // (`const o = {}; o.valueOf = ...; +o`). Folding the literal value here
  // would silently bake in the post-initialization snapshot and miss the
  // sidecar overrides that should drive ToPrimitive at runtime.
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const declList = decl.parent;
      if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
        // #1607: self-referential lexical initializer (TDZ). If we are already
        // tracing through this exact declaration, the initializer names the
        // very binding it declares (`const x = x;`, `await using x = x + 1;`).
        // Resolving it statically would recurse forever — bail to runtime,
        // which emits the spec-required TDZ ReferenceError.
        const seen = visitedDecls ?? new Set<ts.Node>();
        if (seen.has(decl)) return undefined;
        seen.add(decl);
        const init = decl.initializer;
        if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
          return undefined;
        }
        return tryStaticToNumber(ctx, init, seen);
      }
    }
  }
  return undefined;
}

/** Get the static numeric return value of a simple function (single return statement) */
function getStaticReturnValue(ctx: CodegenContext, fn: ts.FunctionExpression | ts.ArrowFunction): number | undefined {
  const body = fn.body;
  if (!ts.isBlock(body)) {
    // Arrow with expression body: () => 42
    return tryStaticToNumber(ctx, body);
  }
  // Look for a single return statement
  for (const stmt of body.statements) {
    if (ts.isReturnStatement(stmt) && stmt.expression) {
      return tryStaticToNumber(ctx, stmt.expression);
    }
  }
  return undefined;
}

/** Get the return expression of a simple function (single return statement) */
function getReturnExpression(fn: ts.FunctionExpression | ts.ArrowFunction): ts.Expression | undefined {
  const body = fn.body;
  if (!ts.isBlock(body)) return body; // arrow expression body
  for (const stmt of body.statements) {
    if (ts.isReturnStatement(stmt) && stmt.expression) return stmt.expression;
  }
  return undefined;
}

/**
 * Strip surrounding parentheses from an expression. The arrow form
 * `() => ({})` parses as `ParenthesizedExpression(ObjectLiteralExpression)`,
 * which the object-literal/array-literal probes in `tryStaticToNumber` would
 * otherwise miss. Used to recognize "function returns a non-primitive" cases
 * for the ToPrimitive folding logic (#1253).
 */
function unwrapParens(expr: ts.Expression | undefined): ts.Expression | undefined {
  while (expr && ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }
  return expr;
}

function isStaticNaN(ctx: CodegenContext, expr: ts.Expression): boolean {
  // NaN identifier
  if (ts.isIdentifier(expr) && expr.text === "NaN") return true;
  // 0 / 0, 0.0 / 0.0
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.SlashToken &&
    ts.isNumericLiteral(expr.left) &&
    Number(expr.left.text) === 0 &&
    ts.isNumericLiteral(expr.right) &&
    Number(expr.right.text) === 0
  )
    return true;
  // Variable initialized with NaN: trace to declaration — but ONLY for `const`
  // bindings (#2057). A `let`/`var` initialized to NaN can be reassigned to a
  // finite value (`let x = NaN; x = 5; Math.min(x, 3)`), so tracing the
  // initializer unconditionally folded the live value away to a compile-time
  // NaN. The runtime NaN guard emitted for the general Math.min/max path makes
  // this static fold a pure optimization, so restricting it to `const` is safe.
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const declList = decl.parent;
      if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
        return isStaticNaN(ctx, decl.initializer);
      }
    }
  }
  return false;
}

export { compileConditionalExpression, compileYieldExpression, isStaticNaN };
