// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Expression compilation dispatcher.
 *
 * This file is the public interface for expression compilation.
 * All heavy implementations live in the sub-modules under ./expressions/.
 * This dispatcher:
 *   1. Re-exports the public API from sub-modules (preserving external consumers)
 *   2. Provides the top-level compileExpression / compileExpressionBody / compileExpressionInner
 *      dispatcher (depth guard, fast-paths, coercion)
 *   3. Provides emitCoercedLocalSet and coerceType (used by statements and index)
 *   4. Registers delegates in shared.ts (registerCompileExpression, etc.)
 */
import { ts } from "../ts-api.js";
import { isBooleanType, isPromiseType, mapTsTypeToWasm } from "../checker/type-mapper.js";
import { classifyAsyncConsumer } from "./async-cps.js";
import type { Instr, ValType } from "../ir/types.js";
import {
  emitStandalonePromiseReject,
  emitStandalonePromiseResolve,
  getOrRegisterPromiseType,
  isStandalonePromiseActive,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_REJECTED,
} from "./async-scheduler.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { allocTempLocal, getLocalType, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { InnerResult } from "./shared.js";
import {
  ensureAnyHelpers,
  isAnyValue,
  registerCompileExpression,
  registerEnsureLateImport,
  registerFlushLateImportShifts,
  valTypesMatch,
  VOID_RESULT,
} from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";
import { coerceType as coerceTypeImpl, pushDefaultValue } from "./type-coercion.js";

// ── Sub-module imports ─────────────────────────────────────────────────

import { wasmFuncReturnsVoid, wasmFuncTypeReturnsVoid } from "./expressions/helpers.js";

import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

import { compileHostInstanceOf, compileIdentifier, resolveInstanceOfRHS } from "./expressions/identifiers.js";
import { emitLazyClassObjectGet } from "./expressions/extern.js";

import { compilePostfixUnary, compilePrefixUnary } from "./expressions/unary.js";

import { compileCallExpression } from "./expressions/calls.js";

import { compileClassExpression, compileNewExpression } from "./expressions/new-super.js";
import { emitNewTargetClassId } from "./new-target.js"; // (#2023)

import { compileConditionalExpression, compileYieldExpression } from "./expressions/misc.js";

// Closures (used inside compileExpressionInner)
import { compileArrowFunction } from "./closures.js";

// Property access + binary ops (used inside compileExpressionInner)
import { compileBinaryExpression } from "./binary-ops.js";
import { compileArrayLiteral, compileObjectLiteral } from "./literals.js";
import { compileElementAccess, compilePropertyAccess } from "./property-access.js";
import { compileTaggedTemplateExpression, compileTemplateExpression } from "./string-ops.js";
import { compileDeleteExpression, compileRegExpLiteral, compileTypeofExpression } from "./typeof-delete.js";

// ── Public re-exports (preserves the external API) ────────────────────

export {
  compileArrayMethodCall,
  compileArrayPrototypeCall,
  emitBoundsCheckedArrayGet,
  emitClampIndex,
  emitClampNonNeg,
} from "./array-methods.js";
export { compileNumericBinaryOp } from "./binary-ops.js";
export { collectReferencedIdentifiers, collectWrittenIdentifiers } from "./closures.js";
export { getWellKnownSymbolId, resolveComputedKeyExpression, resolveConstantExpression } from "./literals.js";
export {
  compileObjectDefineProperties,
  compileObjectDefineProperty,
  compileObjectKeysOrValues,
  compilePropertyIntrospection,
} from "./object-ops.js";
export {
  compileElementAccess,
  compileOptionalPropertyAccess,
  compilePropertyAccess,
  emitNullCheckThrow,
  isProvablyNonNull,
} from "./property-access.js";
export { getCol, getLine, valTypesMatch, VOID_RESULT } from "./shared.js";
export {
  compileNativeStringLiteral,
  compileNativeStringMethodCall,
  compileNativeTemplateExpression,
  compileStringBinaryOp,
  compileStringLiteral,
  compileTaggedTemplateExpression,
  compileTemplateExpression,
  emitBoolToString,
} from "./string-ops.js";
export { coercionInstrs, defaultValueInstrs, pushDefaultValue, pushParamSentinel } from "./type-coercion.js";
export { compileInstanceOf, compileTypeofComparison } from "./typeof-delete.js";

// Re-exports from sub-modules
export {
  compileAssignment,
  compileCompoundAssignment,
  compileLogicalAssignment,
  isCompoundAssignment,
} from "./expressions/assignment.js";
export { compileCallExpression, compileIIFE, compileOptionalCallExpression } from "./expressions/calls.js";
export { emitLazyProtoGet, findExternInfoForMember } from "./expressions/extern.js";
export { emitThrowString, getFuncParamTypes } from "./expressions/helpers.js";
export {
  analyzeTdzAccessByPos,
  compileIdentifier,
  computeElidableTopLevelTdzNames,
  narrowTypeToUnbox,
} from "./expressions/identifiers.js";
export {
  emitUndefined,
  ensureExternIsUndefinedImport,
  ensureGetUndefined,
  ensureLateImport,
  flushLateImportShifts,
  patchStructNewForAddedField,
  shiftLateImportIndices,
} from "./expressions/late-imports.js";
export { compileLogicalAnd, compileLogicalOr, compileNullishCoalescing } from "./expressions/logical-ops.js";
export {
  getIteratorResultValueType,
  isGeneratorIteratorResultLike,
  resolveStructName,
  tryStaticToNumber,
} from "./expressions/misc.js";
export {
  compileClassExpression,
  compileNewExpression,
  compileSuperElementAccess,
  compileSuperPropertyAccess,
  resolveEnclosingClassName,
} from "./expressions/new-super.js";
export { compileMemberIncDec, compilePostfixUnary, compilePrefixUnary } from "./expressions/unary.js";

// ── Dispatcher helpers (used only within this file) ────────────────────

/**
 * Check if a call expression targets an async function/method.
 * Used to determine whether the result needs Promise.resolve() wrapping (#919).
 */
function isAsyncCallExpression(ctx: CodegenContext, expr: ts.CallExpression): boolean {
  // Built-in Promise static methods already return a Promise object. Wrapping
  // `Promise.resolve(v)` in another `Promise.resolve(...)` is harmless in the
  // JS host due to native assimilation, but standalone `$Promise` currently has
  // no assimilation step, so the callback would receive the inner Promise
  // object instead of `v` (#1326).
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Promise"
  ) {
    return false;
  }
  if (
    isStandalonePromiseActive(ctx) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    (expr.expression.name.text === "then" ||
      // (#2165) `.catch` lowers to the same native `$Promise` then-machinery
      // in standalone mode (`.catch(f)` ≡ `.then(undefined, f)`); it already
      // returns a `$Promise`, so it must NOT be re-wrapped by `wrapAsyncReturn`
      // (double-wrapping yields a Promise-of-Promise → illegal cast / NaN when
      // the chained result is consumed).
      expr.expression.name.text === "catch")
  ) {
    const receiverType = ctx.checker.getTypeAtLocation(expr.expression.expression);
    const receiverSym = receiverType.getSymbol()?.name;
    const apparentSym = ctx.checker.getApparentType(receiverType).getSymbol()?.name;
    if (receiverSym === "Promise" || apparentSym === "Promise") {
      return false;
    }
  }

  if (ts.isIdentifier(expr.expression)) {
    if (ctx.asyncFunctions.has(expr.expression.text)) return true;
  }

  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const decl = sig.getDeclaration();
    if (decl && (decl as any).modifiers) {
      // Exclude async generators — they return AsyncGenerator objects, not Promises.
      if (ts.isFunctionLike(decl) && (decl as ts.FunctionLikeDeclaration).asteriskToken) return false;
      for (const mod of (decl as any).modifiers) {
        if (mod.kind === ts.SyntaxKind.AsyncKeyword) return true;
      }
    }
  }

  // (#1151 Gap A1) Detector fallback for async calls the decl-modifier check
  // above misses: a callee with no reachable declaration / no `async` modifier
  // but whose call signature returns `Promise<T>`. Covers callbacks typed
  // `() => Promise<T>`, variables holding async refs whose declared type is the
  // function type (not the `async function` decl), and anonymous IIFEs. A
  // function that *returns a Promise* must still convert a synchronous throw
  // into a rejection (same contract), so wrapping these is correct.
  //
  // Excluded by construction:
  //   - constructors — `getCallSignatures()` returns CALL signatures only, not
  //     construct signatures, so `new Foo()` callees contribute nothing here.
  //   - async generators — their call signatures return AsyncGenerator, not
  //     Promise, so `isPromiseType` is already false for them.
  const calleeType = ctx.checker.getTypeAtLocation(expr.expression);
  for (const callSig of calleeType.getCallSignatures()) {
    if (isPromiseType(callSig.getReturnType())) return true;
  }

  return false;
}

/**
 * Decide whether an async call's result is consumed as a raw value (`T`) rather
 * than as a `Promise<T>` (#1727).
 *
 * In the synchronous-wasm async model the async function body already returns
 * the unwrapped `T` (e.g. an f64), and the export boundary calls it directly to
 * get that raw value. But for an INTERNAL call (`f()` inside another wasm fn)
 * the default lowering runs `wrapAsyncReturn` — boxing the f64 and wrapping it
 * in a real `Promise.resolve(...)` object. When the surrounding code then
 * consumes the result as a primitive (`f() as unknown as number` feeding a
 * numeric return / arithmetic), the consuming `coerceType(externref → f64)`
 * emits `__unbox_number(Promise{42})` === `Number(Promise{42})` === **NaN**.
 *
 * The existing `await` consumer (handled at the call site) skips the wrap and
 * leaves the raw `T` on the stack. This helper generalises that skip to the
 * primitive/non-Promise cast sink: walk the wrapper chain
 * (`Parenthesized`/`As`/`NonNull`/`TypeAssertion`) from `expr.parent` and
 * return `true` when the immediate semantic consumer is:
 *
 *   1. an `AwaitExpression` (the existing case), or
 *   2. a cast/assertion (`as T`, `<T>x`, `x!`) whose target type is NOT
 *      `Promise<…>` — e.g. `as any`, `as unknown as number`, `as number`.
 *      `as any`/`as unknown` resolve to the `any`/`unknown` type → not a
 *      Promise → treated as a value consumer. This is the repro and the 7
 *      `tests/equivalence/async-function.test.ts` cases.
 *
 * Returning `true` means: skip both `wrapAsyncReturn` and
 * `wrapAsyncCallInTryCatch`, leaving the raw `f64`/`T` the sink wants. Genuine
 * Promise consumers (`f().then(...)`, `const p: Promise<T> = f();`,
 * `Promise.all([f()])`, a bare `return f()` from an async/Promise-returning fn)
 * have NO non-Promise cast in the chain, so this returns `false` and the
 * Promise wrap fires as before. The cast gate keeps the blast radius minimal:
 * we only skip when an explicit non-Promise cast/assertion is present (#1727
 * minimal-diff variant — scope 2).
 */
function asyncResultConsumedAsValue(ctx: CodegenContext, expr: ts.CallExpression): boolean {
  // (#1936) Single source of truth: the three-state census classifier lives in
  // async-cps.ts so the offline census script reuses the same logic. The legacy
  // boolean is exactly `kind !== "thenable"` — `await` and `value` consumers
  // both take the raw-T passthrough today; only the `thenable` consumer wraps.
  // This stays behaviour-identical until #1796 changes the value/thenable
  // dispatch. The rich rationale for each case is documented above.
  return classifyAsyncConsumer(ctx.checker, expr) !== "thenable";
}

/**
 * Wrap the current stack value in Promise.resolve() for async function calls (#919).
 *
 * `resultType` is the TypeScript-level result from compileCallExpression; when
 * the TS signature says `Promise<void>` that helper returns `VOID_RESULT` even
 * though the underlying wasm function still leaves an externref on the stack.
 * Check the last emitted call against the wasm type table — if a value is
 * already on the stack, skip the `ref.null.extern` push (otherwise the later
 * stack-balance pass would drop the Promise we just built).
 */
function wrapAsyncReturn(ctx: CodegenContext, fctx: FunctionContext, resultType: InnerResult): ValType {
  const lastInstr = fctx.body[fctx.body.length - 1];
  let wasmStackHasValue = false;
  if (lastInstr) {
    const op = (lastInstr as any).op;
    if (op === "call" && (lastInstr as any).funcIdx !== undefined) {
      wasmStackHasValue = !wasmFuncReturnsVoid(ctx, (lastInstr as any).funcIdx);
    } else if (op === "call_ref" && (lastInstr as any).typeIdx !== undefined) {
      wasmStackHasValue = !wasmFuncTypeReturnsVoid(ctx, (lastInstr as any).typeIdx);
    }
  }
  if (resultType === null || resultType === VOID_RESULT) {
    if (!wasmStackHasValue) fctx.body.push({ op: "ref.null.extern" });
  } else if (resultType.kind !== "externref") {
    coerceType(ctx, fctx, resultType, { kind: "externref" });
  }
  // (#1326 Phase 1B) In standalone (WASI) mode, replace
  // `call $Promise_resolve_import` with a Wasm-native `$Promise`
  // struct.new fulfilled with the value already on the stack. The host
  // import `Promise_resolve` is unsatisfiable in WASI; this branch
  // avoids the missing-import error at module instantiation.
  //
  // Wasm `struct.new` pops fields in declaration order (state | value |
  // callbacks); the value is already on the stack but state must come
  // BEFORE it. Stash via a temp local, then emit in the correct order.
  if (isStandalonePromiseActive(ctx)) {
    const valueLocal = allocTempLocal(fctx, { kind: "externref" });
    const promiseTypeIdx = getOrRegisterPromiseType(ctx);
    fctx.body.push({ op: "local.set", index: valueLocal });
    fctx.body.push({ op: "i32.const", value: PROMISE_STATE_FULFILLED });
    fctx.body.push({ op: "local.get", index: valueLocal });
    fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
    fctx.body.push({ op: "extern.convert_any" });
    releaseTempLocal(fctx, valueLocal);
    return { kind: "externref" };
  }
  const resolveIdx = ensureLateImport(ctx, "Promise_resolve", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (resolveIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: resolveIdx });
  }
  return { kind: "externref" };
}

/**
 * Splice instructions [start..end) from fctx.body and re-emit them inside a
 * try/catch that converts synchronous throws into a rejected Promise. Used for
 * async function calls so that a throw during default-param evaluation or body
 * execution surfaces as `f().then(_, onRej)` rather than an uncaught wasm
 * exception (#1150).
 */
function wrapAsyncCallInTryCatch(ctx: CodegenContext, fctx: FunctionContext, start: number): void {
  // (#1326 Phase 1B) Standalone-mode rejection. The host
  // `Promise_reject` import + `__get_caught_exception` are
  // unsatisfiable in WASI; emit a Wasm-native rejected `$Promise`
  // construction in the catch_all instead.
  if (isStandalonePromiseActive(ctx)) {
    const promiseTypeIdx = getOrRegisterPromiseType(ctx);
    const inner = fctx.body.splice(start);
    // The thrown value is on the catch_all stack as externref (the
    // `__exn` tag's externref payload); standalone catch_all consumes
    // it and uses it as the rejection reason. We don't have access to
    // the wasm exception payload op without `ensureExnTag`, so fall
    // back to `ref.null.extern` as the reason — Phase 1B doesn't
    // yet wire the catch-payload binding (Phase 1C will). Most async
    // throws produce undefined-typed rejections at this stage, so
    // null-extern is safe.
    const catchAll: Instr[] = [
      { op: "i32.const", value: PROMISE_STATE_REJECTED },
      { op: "ref.null.extern" } as Instr,
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: promiseTypeIdx } as Instr,
      { op: "extern.convert_any" } as Instr,
    ];
    fctx.body.push({
      op: "try",
      blockType: { kind: "val", type: { kind: "externref" } },
      body: inner,
      catches: [],
      catchAll,
    });
    return;
  }
  const rejectIdx = ensureLateImport(ctx, "Promise_reject", [{ kind: "externref" }], [{ kind: "externref" }]);
  const getCaughtIdx = ensureLateImport(ctx, "__get_caught_exception", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (rejectIdx === undefined || getCaughtIdx === undefined) return;
  const inner = fctx.body.splice(start);
  const catchAll: Instr[] = [
    { op: "call", funcIdx: getCaughtIdx } as Instr,
    { op: "call", funcIdx: rejectIdx } as Instr,
  ];
  fctx.body.push({
    op: "try",
    blockType: { kind: "val", type: { kind: "externref" } },
    body: inner,
    catches: [],
    catchAll,
  });
}

/**
 * Check whether the last instruction emitted since bodyLenBefore is a
 * void-returning call.
 */
function _isLastInstrVoidCall(ctx: CodegenContext, fctx: FunctionContext, bodyLenBefore: number): boolean {
  if (fctx.body.length <= bodyLenBefore) return true;
  const lastInstr = fctx.body[fctx.body.length - 1];
  if (!lastInstr) return false;
  const op = (lastInstr as any).op;
  if (op === "call" && (lastInstr as any).funcIdx !== undefined) {
    return wasmFuncReturnsVoid(ctx, (lastInstr as any).funcIdx);
  }
  if (op === "call_ref" && (lastInstr as any).typeIdx !== undefined) {
    return wasmFuncTypeReturnsVoid(ctx, (lastInstr as any).typeIdx);
  }
  return false;
}

// ── Recursion depth guard ──────────────────────────────────────────────

let __compileDepth = 0;
const MAX_COMPILE_DEPTH = 500;
export function resetCompileDepth(): void {
  __compileDepth = 0;
}

// ── Main entry points ──────────────────────────────────────────────────

export function compileExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
): ValType | null {
  __compileDepth++;
  if (__compileDepth > MAX_COMPILE_DEPTH) {
    __compileDepth--;
    reportError(ctx, expr, `compilation depth exceeded (${MAX_COMPILE_DEPTH}) — possible infinite recursion`);
    const fallbackType = expectedType ?? { kind: "externref" as const };
    if (fallbackType.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
    else if (fallbackType.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else fctx.body.push({ op: "ref.null.extern" } as any);
    return fallbackType;
  }
  try {
    return compileExpressionBody(ctx, fctx, expr, expectedType);
  } finally {
    __compileDepth--;
  }
}

function compileExpressionBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
): ValType | null {
  if (expr) ctx.lastKnownNode = expr;

  if (!expr) {
    reportErrorNoNode(ctx, "unexpected undefined AST node in compileExpression");
    const fallbackType = expectedType ?? { kind: "f64" as const };
    pushDefaultValue(fctx, fallbackType, ctx);
    return fallbackType;
  }

  // Fast-path: null/undefined in numeric context
  if (expectedType?.kind === "f64" || expectedType?.kind === "i32") {
    let inner: ts.Expression = expr;
    while (
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isParenthesizedExpression(inner) ||
      ts.isTypeAssertionExpression(inner)
    ) {
      inner = ts.isParenthesizedExpression(inner)
        ? inner.expression
        : ts.isAsExpression(inner)
          ? inner.expression
          : ts.isNonNullExpression(inner)
            ? inner.expression
            : (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined =
      inner.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(inner) && inner.text === "undefined") ||
      ts.isOmittedExpression(inner);
    if (isNull || isUndefined) {
      if (expectedType.kind === "f64") {
        if (isNull) {
          fctx.body.push({ op: "f64.const", value: 0 });
        } else {
          fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den });
          fctx.body.push({ op: "f64.reinterpret_i64" });
        }
        return { kind: "f64" };
      }
      if (expectedType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
    }
    if (expectedType.kind === "i32" && ts.isNumericLiteral(inner)) {
      const litVal = Number(inner.text.replace(/_/g, ""));
      if (Number.isInteger(litVal) && litVal >= -2147483648 && litVal <= 2147483647) {
        fctx.body.push({ op: "i32.const", value: litVal });
        return { kind: "i32" };
      }
    }
    if (ts.isVoidExpression(inner)) {
      const bodyLenBefore = fctx.body.length;
      const operandType = compileExpressionInner(ctx, fctx, inner.expression);
      if (operandType !== null && operandType !== VOID_RESULT) {
        if (!_isLastInstrVoidCall(ctx, fctx, bodyLenBefore)) {
          fctx.body.push({ op: "drop" });
        }
      }
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den });
        fctx.body.push({ op: "f64.reinterpret_i64" });
        return { kind: "f64" };
      }
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }
  }

  // Fast-path: null/undefined in struct ref context (skip for $AnyValue — handled below)
  if (
    expectedType &&
    (expectedType.kind === "ref_null" || expectedType.kind === "ref") &&
    !isAnyValue(expectedType, ctx)
  ) {
    let inner: ts.Expression = expr;
    while (
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isParenthesizedExpression(inner) ||
      ts.isTypeAssertionExpression(inner)
    ) {
      inner = ts.isParenthesizedExpression(inner)
        ? inner.expression
        : ts.isAsExpression(inner)
          ? inner.expression
          : ts.isNonNullExpression(inner)
            ? inner.expression
            : (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined =
      inner.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(inner) && inner.text === "undefined") ||
      ts.isOmittedExpression(inner);
    if (isNull || isUndefined) {
      const typeIdx = (expectedType as { typeIdx: number }).typeIdx;
      fctx.body.push({ op: "ref.null", typeIdx });
      return { kind: "ref_null", typeIdx };
    }
  }

  // Fast-path: null/undefined/boolean literals in AnyValue context
  if (expectedType && isAnyValue(expectedType, ctx)) {
    let inner: ts.Expression = expr;
    while (
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isParenthesizedExpression(inner) ||
      ts.isTypeAssertionExpression(inner)
    ) {
      inner = ts.isParenthesizedExpression(inner)
        ? inner.expression
        : ts.isAsExpression(inner)
          ? inner.expression
          : ts.isNonNullExpression(inner)
            ? inner.expression
            : (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined =
      inner.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(inner) && inner.text === "undefined") ||
      ts.isOmittedExpression(inner);
    if (isNull || isUndefined) {
      ensureAnyHelpers(ctx);
      const helperName = isNull ? "__any_box_null" : "__any_box_undefined";
      const funcIdx = ctx.funcMap.get(helperName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return expectedType;
      }
    }
    if (ts.isVoidExpression(inner)) {
      const bodyLenBefore2 = fctx.body.length;
      const operandType = compileExpressionInner(ctx, fctx, inner.expression);
      if (operandType !== null && operandType !== VOID_RESULT) {
        if (!_isLastInstrVoidCall(ctx, fctx, bodyLenBefore2)) {
          fctx.body.push({ op: "drop" });
        }
      }
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_box_undefined");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return expectedType;
      }
    }
    if (inner.kind === ts.SyntaxKind.TrueKeyword || inner.kind === ts.SyntaxKind.FalseKeyword) {
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_box_bool");
      if (funcIdx !== undefined) {
        fctx.body.push({
          op: "i32.const",
          value: inner.kind === ts.SyntaxKind.TrueKeyword ? 1 : 0,
        });
        fctx.body.push({ op: "call", funcIdx });
        return expectedType;
      }
    }
  }

  const bodyLenBefore = fctx.body.length;
  let result: InnerResult;
  try {
    result = compileExpressionInner(ctx, fctx, expr, expectedType);
  } catch (e) {
    fctx.body.length = bodyLenBefore;
    const msg = e instanceof Error ? e.message : String(e);
    reportErrorNoNode(ctx, `Internal error compiling expression: ${msg}`);
    const fallbackType = expectedType ?? { kind: "f64" as const };
    pushDefaultValue(fctx, fallbackType, ctx);
    return fallbackType;
  }
  if (result === VOID_RESULT) {
    if (expectedType) {
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: NaN });
      } else {
        pushDefaultValue(fctx, expectedType, ctx);
      }
      return expectedType;
    }
    return null;
  }
  if (result !== null && fctx.body.length > bodyLenBefore) {
    const lastInstr = fctx.body[fctx.body.length - 1];
    if (lastInstr) {
      const op = (lastInstr as any).op;
      let isVoidCall = false;
      if (op === "call" && (lastInstr as any).funcIdx !== undefined) {
        isVoidCall = wasmFuncReturnsVoid(ctx, (lastInstr as any).funcIdx);
      } else if (op === "call_ref" && (lastInstr as any).typeIdx !== undefined) {
        isVoidCall = wasmFuncTypeReturnsVoid(ctx, (lastInstr as any).typeIdx);
      }
      if (isVoidCall) {
        if (expectedType) {
          pushDefaultValue(fctx, expectedType, ctx);
          return expectedType;
        }
        return null;
      }
    }
  }
  if (result !== null && (typeof result !== "object" || result === null || !("kind" in result))) {
    const fallbackType = expectedType ?? { kind: "f64" as const };
    pushDefaultValue(fctx, fallbackType, ctx);
    return fallbackType;
  }
  if (result !== null) {
    if (expectedType && result.kind !== expectedType.kind) {
      if (result.kind === "i32" && isAnyValue(expectedType, ctx)) {
        const tsType = ctx.checker.getTypeAtLocation(expr);
        if (tsType.flags & ts.TypeFlags.BooleanLike) {
          ensureAnyHelpers(ctx);
          const funcIdx = ctx.funcMap.get("__any_box_bool");
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return expectedType;
          }
        }
      }
      if (result.kind === "i32" && expectedType.kind === "externref") {
        const tsType = ctx.checker.getTypeAtLocation(expr);
        if (isBooleanType(tsType)) {
          const boxBoolIdx = ensureLateImport(ctx, "__box_boolean", [{ kind: "i32" }], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          if (boxBoolIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
            return expectedType;
          }
        }
      }
      if (result.kind === "i32" && expectedType.kind === "externref") {
        const tsType = ctx.checker.getTypeAtLocation(expr);
        if (tsType.flags & ts.TypeFlags.ESSymbolLike) {
          const boxSymIdx = ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [{ kind: "externref" }]);
          if (boxSymIdx !== undefined) {
            flushLateImportShifts(ctx, fctx);
            fctx.body.push({ op: "call", funcIdx: boxSymIdx });
            return expectedType;
          }
        }
      }
      coerceType(ctx, fctx, result, expectedType);
      return expectedType;
    }
    if (
      expectedType &&
      (result.kind === "ref" || result.kind === "ref_null") &&
      (expectedType.kind === "ref" || expectedType.kind === "ref_null")
    ) {
      const resultIdx = (result as { typeIdx: number }).typeIdx;
      const expectedIdx = (expectedType as { typeIdx: number }).typeIdx;
      if (resultIdx !== expectedIdx) {
        coerceType(ctx, fctx, result, expectedType);
        return expectedType;
      }
    }
    return result;
  }

  fctx.body.length = bodyLenBefore;
  let wasmType: ValType;
  if (expectedType) {
    wasmType = expectedType;
  } else {
    try {
      wasmType = mapTsTypeToWasm(ctx.checker.getTypeAtLocation(expr), ctx.checker);
    } catch {
      wasmType = { kind: "f64" };
    }
  }
  pushDefaultValue(fctx, wasmType, ctx);
  return wasmType;
}

/**
 * Emit a local.set with automatic type coercion.
 */
export function emitCoercedLocalSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  localIdx: number,
  stackType: ValType,
): void {
  const localType = getLocalType(fctx, localIdx);
  if (localType && !valTypesMatch(stackType, localType)) {
    const sameRefTypeIdx =
      (stackType.kind === "ref" || stackType.kind === "ref_null") &&
      (localType.kind === "ref" || localType.kind === "ref_null") &&
      (stackType as { typeIdx: number }).typeIdx === (localType as { typeIdx: number }).typeIdx;
    if (sameRefTypeIdx && stackType.kind === "ref_null" && localType.kind === "ref") {
      widenLocalToNullable(fctx, localIdx);
    } else if (sameRefTypeIdx) {
      // ref -> ref_null: subtype, no coercion needed
    } else if (
      (stackType.kind === "ref" || stackType.kind === "ref_null") &&
      (localType.kind === "ref" || localType.kind === "ref_null")
    ) {
      const bodyLenBefore = fctx.body.length;
      coerceType(ctx, fctx, stackType, localType);
      if (fctx.body.length === bodyLenBefore) {
        updateLocalType(fctx, localIdx, stackType);
      }
    } else {
      coerceType(ctx, fctx, stackType, localType);
    }
  }
  fctx.body.push({ op: "local.set", index: localIdx });
}

function updateLocalType(fctx: FunctionContext, localIdx: number, newType: ValType): void {
  if (localIdx < fctx.params.length) {
    const param = fctx.params[localIdx];
    if (param) param.type = newType;
  } else {
    const local = fctx.locals[localIdx - fctx.params.length];
    if (local) local.type = newType;
  }
}

function widenLocalToNullable(fctx: FunctionContext, localIdx: number): void {
  if (localIdx < fctx.params.length) {
    const param = fctx.params[localIdx];
    if (param && param.type.kind === "ref") {
      param.type = {
        kind: "ref_null",
        typeIdx: (param.type as { typeIdx: number }).typeIdx,
      };
    }
  } else {
    const local = fctx.locals[localIdx - fctx.params.length];
    if (local && local.type.kind === "ref") {
      local.type = {
        kind: "ref_null",
        typeIdx: (local.type as { typeIdx: number }).typeIdx,
      };
    }
  }
}

/** Coerce a value on the stack from one type to another */
export function coerceType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
  toPrimitiveHint?: "number" | "string" | "default",
): void {
  // biome-ignore lint/correctness/noVoidTypeReturn: delegates to void impl
  return coerceTypeImpl(ctx, fctx, from, to, toPrimitiveHint);
}

function compileExpressionInner(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
): InnerResult {
  if (ts.isNumericLiteral(expr)) {
    const value = Number(expr.text.replace(/_/g, ""));
    if (ctx.fast && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      fctx.body.push({ op: "i32.const", value });
      return { kind: "i32" };
    }
    fctx.body.push({ op: "f64.const", value });
    return { kind: "f64" };
  }

  if (ts.isBigIntLiteral(expr)) {
    const text = expr.text.replace(/_/g, "").replace(/n$/i, "");
    const value = BigInt(text);
    fctx.body.push({ op: "i64.const", value });
    return { kind: "i64", bigint: true };
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return compileStringLiteral(ctx, fctx, expr.text, expr);
  }

  if (ts.isTemplateExpression(expr)) {
    return compileTemplateExpression(ctx, fctx, expr);
  }

  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    fctx.body.push({ op: "i32.const", value: 1 });
    return { kind: "i32" };
  }

  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  if (expr.kind === ts.SyntaxKind.UndefinedKeyword) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (ts.isIdentifier(expr) && expr.text === "undefined") {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (ts.isOmittedExpression(expr)) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    const selfIdx = fctx.localMap.get("this");
    if (selfIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: selfIdx });
      if (selfIdx < fctx.params.length) {
        return fctx.params[selfIdx]!.type;
      }
      const localDef = fctx.locals[selfIdx - fctx.params.length];
      return localDef?.type ?? { kind: "externref" };
    }
    // (#1395) Static-context fallback: in a static field initializer or
    // static method body (or in any closure spawned from one), `this`
    // refers to the class constructor object per ECMA-262 §15.7.1.1
    // step 5.b. We emit the lazy class-object singleton load — same
    // singleton used when the class identifier appears as a value, so
    // `C.f() === C` (when `static f = () => this`) holds. Note: the
    // lazy-load is invariant (a global), so no closure-capture wiring
    // is needed — the arrow's body re-emits the load and gets the
    // exact same externref each time.
    if (fctx.isStaticContext && fctx.enclosingClassName && ctx.classObjectGlobals?.has(fctx.enclosingClassName)) {
      if (emitLazyClassObjectGet(ctx, fctx, fctx.enclosingClassName)) {
        return { kind: "externref" };
      }
    }
    // (#1636-S1) Host-dispatched-closure fallback: when no local `this`
    // binding exists and we're not in a static-class context, read the
    // host-supplied receiver from the `__current_this` module global —
    // but ONLY for closure bodies that can actually be dispatched through
    // `__call_fn_method_N` (`fctx.readsCurrentThis`). Those dispatchers
    // install the host receiver into `__current_this` before the inner
    // `call_ref`, so this is the only context in which the global holds a
    // meaningful value.
    //
    // The earlier (#1636-S1) version gated this on `ctx.currentThisGlobalIdx
    // >= 0` alone, but `ensureCurrentThisGlobal` is called eagerly for every
    // module that emits any closure, so that condition was true for the whole
    // module. Named function declarations / methods / constructors (compiled
    // via function-body.ts / class-bodies.ts, NOT through the closure-lift
    // path) are called directly via `call $f`, where `__current_this` is never
    // installed — they read its `ref.null.extern` initial value as `null`
    // instead of the spec-correct `undefined` (strict) / globalObject (sloppy).
    // That regressed 171 test262 cases (`function-code/10.4.3-1-*`,
    // `Array/prototype/*` callback `this`). Gating on `readsCurrentThis`
    // restricts the global read to exactly the lifted-closure / anonymous-
    // callback bodies that the host can dispatch, leaving direct-call `this`
    // to fall through to `undefined` as before.
    if (fctx.readsCurrentThis && ctx.currentThisGlobalIdx >= 0) {
      // (#1702) Null-guard the `__current_this` read. A lifted closure body can
      // be reached two ways:
      //   (a) host dispatch via `__call_fn_method_N` — installs a real receiver
      //       (a non-null externref) into `__current_this` before the call_ref;
      //   (b) a *direct* call (`f1()` where `f1` is a closure local / module
      //       global) — which never installs anything, so `__current_this` still
      //       holds its `ref.null.extern` initial value (or a leftover from an
      //       unrelated host dispatch that has since been restored to null).
      //
      // #1636-S1 / #895 narrowed this fallback to `readsCurrentThis` bodies, but
      // for the *direct-call* case the raw `global.get` surfaces JS `null`, not
      // the spec-correct `undefined`. That made strict free-function /
      // function-expression `this` observe `null` (`typeof this === "object"`,
      // `this === undefined` ⇒ false), regressing the residual
      // `language/function-code/10.4.3-1-*-s` + class-method strict-`this`
      // shapes (#873 follow-up).
      //
      // The receiver a host installs is always a non-null externref, so the
      // null/non-null distinction cleanly separates the two reach paths: when
      // the global is non-null use it (host dispatch), otherwise fall through to
      // `undefined` (direct call — `undefined` for strict, and the prior
      // pre-#1636-S1 fallback for sloppy free functions). This is additive to
      // #895's gating: it only changes the *value* the existing
      // `readsCurrentThis` branch yields when the global is null, never widening
      // which bodies read the global. The Array.prototype.{every,…} callbacks
      // and top-level strict `this` (#873/#895-fixed) are unaffected — those
      // either bind `this` via a local or do not set `readsCurrentThis`.
      const thisTmp = allocTempLocal(fctx, { kind: "externref" });
      fctx.body.push({ op: "global.get", index: ctx.currentThisGlobalIdx } as Instr);
      fctx.body.push({ op: "local.tee", index: thisTmp });
      fctx.body.push({ op: "ref.is_null" });
      const elseBody: Instr[] = [{ op: "local.get", index: thisTmp }];
      const savedBody = fctx.body;
      const thenBody: Instr[] = [];
      fctx.body = thenBody;
      emitUndefined(ctx, fctx);
      fctx.body = savedBody;
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: thenBody,
        else: elseBody,
      } as unknown as Instr);
      releaseTempLocal(fctx, thisTmp);
      return { kind: "externref" };
    }
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (ts.isIdentifier(expr)) {
    return compileIdentifier(ctx, fctx, expr);
  }

  if (ts.isBinaryExpression(expr)) {
    // (#2128) Property writes can dispatch a host setter callback (object
    // literal `set v(x) {...}` defined via __defineProperty_accessor) whose
    // mutable captures live in ref cells. Persistent writebacks are normally
    // re-emitted only after CallExpressions; a setter fired by `o.v = x`
    // (which lowers to an internal __extern_set call, not a ts.CallExpression)
    // left the captured outer locals stale. Mirror the CallExpression
    // re-emission for assignments whose LHS is a property/element access.
    // Identifier-LHS assignments are deliberately excluded — re-syncing right
    // after a direct local write would clobber it with the ref-cell value.
    const isAssignOp =
      expr.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      expr.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    if (
      isAssignOp &&
      (ts.isPropertyAccessExpression(expr.left) || ts.isElementAccessExpression(expr.left)) &&
      fctx.persistentCallbackWritebacks &&
      fctx.persistentCallbackWritebacks.length > 0
    ) {
      const assignResult = compileBinaryExpression(ctx, fctx, expr);
      fctx.body.push(...fctx.persistentCallbackWritebacks.map((instr) => structuredClone(instr)));
      return assignResult;
    }
    if (expr.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      const rhsResult = resolveInstanceOfRHS(ctx, expr.right);
      if (!rhsResult) {
        return compileHostInstanceOf(ctx, fctx, expr);
      }
      // (#1366a) Externref-backed subclasses (extends Error / TypeError / ...)
      // have instances that are real JS Error objects whose host-side
      // [[Prototype]] is the BUILTIN parent (Error.prototype), not
      // MyError.prototype. So `e instanceof MyError` cannot be answered by a
      // host `__instanceof(value, "MyError")` call (globalThis.MyError does
      // not exist). We resolve it statically using the TS type of LHS:
      //
      //   - LHS type ≡ MyError or a registered subclass → constant `true`
      //   - LHS type ≡ unrelated user class → constant `false`
      //   - otherwise (any / externref / parent builtin) → fall back to host
      //     `__instanceof` against the BUILTIN parent name. (`e instanceof
      //     MyError` where e is `any` is unanswerable here; we
      //     conservatively return false to match host semantics.)
      //
      // The WasmGC struct-tag path is wrong for these instances anyway
      // (any.convert_extern + ref.cast to a struct type fails), so we never
      // dispatch to compileInstanceOf for an externref-backed RHS.
      if (ctx.classExternrefBackedSet.has(rhsResult)) {
        const lhsTsType = ctx.checker.getTypeAtLocation(expr.left);
        let lhsName = lhsTsType.getSymbol()?.name;
        // (#1455) TypeScript reports `__class` as the synthetic symbol name
        // for anonymous class expressions (`const Sub = class extends Map {}`).
        // Resolve via `typeToString` — for a const-bound class expression
        // this returns the binding name, which we can look up in
        // `classExprNameMap` to recover the synthetic class id.
        if (lhsName === "__class") {
          const typeStr = ctx.checker.typeToString(lhsTsType);
          const mapped = ctx.classExprNameMap.get(typeStr);
          if (mapped !== undefined) {
            lhsName = mapped;
          } else if (ctx.classTagMap.has(typeStr)) {
            lhsName = typeStr;
          }
        }
        // (#1455) Canonicalize class names through `classExprNameMap` so
        // `const Sub = class extends Map {}` (where the binding name `Sub`
        // and the synthetic name `__anonClass_N` both register independently
        // as classes) compare equal.
        const canon = (n: string | undefined): string | undefined =>
          n === undefined ? undefined : (ctx.classExprNameMap.get(n) ?? n);
        const canonLhs = canon(lhsName);
        const canonRhs = canon(rhsResult);
        let staticAnswer: boolean | undefined;
        if (lhsName !== undefined && ctx.classTagMap.has(lhsName)) {
          if (canonLhs === canonRhs) {
            staticAnswer = true;
          } else {
            // LHS is a known user class. Walk its parent chain — true iff the
            // RHS class is an ancestor of the LHS class.
            let cur: string | undefined = lhsName;
            const guard = new Set<string>();
            while (cur && !guard.has(cur)) {
              guard.add(cur);
              if (cur === rhsResult) {
                staticAnswer = true;
                break;
              }
              cur = ctx.classParentMap.get(cur);
            }
            if (staticAnswer === undefined) staticAnswer = false;
          }
        }
        if (staticAnswer !== undefined) {
          // Compile LHS for side effects, drop, push constant.
          const leftType = compileExpression(ctx, fctx, expr.left);
          if (leftType) fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: staticAnswer ? 1 : 0 });
          return { kind: "i32" };
        }
        // (#1455) LHS type could not be resolved statically (TS often infers
        // `any` for `class Sub extends WeakRef {}` because WeakRef<T> requires
        // type args). Fall through to the host runtime check, which consults
        // the user-class tag registry attached at construction time.
        return compileHostInstanceOf(ctx, fctx, expr);
      }
    }
    return compileBinaryExpression(ctx, fctx, expr);
  }

  if (ts.isTypeOfExpression(expr)) {
    return compileTypeofExpression(ctx, fctx, expr);
  }

  if (ts.isPrefixUnaryExpression(expr)) {
    return compilePrefixUnary(ctx, fctx, expr);
  }

  if (ts.isPostfixUnaryExpression(expr)) {
    return compilePostfixUnary(ctx, fctx, expr);
  }

  if (ts.isParenthesizedExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression, expectedType);
  }

  if (ts.isCallExpression(expr)) {
    const callStart = fctx.body.length;
    const callResult = compileCallExpression(ctx, fctx, expr, expectedType);
    if (fctx.pendingCallbackWritebacks && fctx.pendingCallbackWritebacks.length > 0) {
      fctx.body.push(...fctx.pendingCallbackWritebacks);
      fctx.pendingCallbackWritebacks = undefined;
    }
    // Emit persistent writebacks (#929): for getter/setter callbacks whose mutable
    // captures may be updated by a deferred callback invocation (e.g. a getter
    // defined via Object.defineProperty and later called by Object.defineProperties).
    // These are re-emitted after every call so the outer locals stay up-to-date.
    if (fctx.persistentCallbackWritebacks && fctx.persistentCallbackWritebacks.length > 0) {
      // Shallow-copy each instruction so dead-elimination doesn't multi-remap
      // the same object when it appears multiple times in the function body.
      fctx.body.push(...fctx.persistentCallbackWritebacks.map((instr) => structuredClone(instr)));
      // Do NOT clear — re-emit after every subsequent call
    }
    // Skip async-call detection for `import.defer(...)` / `import.source(...)`:
    // calling `getResolvedSignature` on these triggers a TypeScript Debug.assert
    // ("Trying to get the type of `import.defer` in `import.defer(...)`") because
    // the TS checker explicitly forbids type queries on these meta-properties as
    // call callees. The compileCallExpression dispatcher (calls.ts) already
    // reports a clean unsupported-feature error for these patterns; here we just
    // bypass the async wrap. (#1315)
    if (
      ts.isMetaProperty(expr.expression) &&
      expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      (expr.expression.name.text === "defer" || expr.expression.name.text === "source")
    ) {
      return callResult;
    }
    if (isAsyncCallExpression(ctx, expr)) {
      // (#1313) `await asyncCall()` would otherwise leave a Promise object
      // on the stack — string concatenation / arithmetic / property access
      // on the result then sees `[object Promise]` because js2wasm has no
      // synchronous Promise unwrap (would need JSPI / stack-switching).
      //
      // Workaround: skip the `Promise.resolve(...)` wrap when the call's
      // parent is an `AwaitExpression`. The wasm async function body
      // (`closures.ts:1165`) already returns the raw `T` value (not
      // `Promise<T>`), so leaving it on the stack matches what await's
      // passthrough lowering expects. For non-await consumers
      // (`asyncCall().then(...)`, `const p = asyncCall();`) the wrap still
      // fires and produces a real Promise that JS host code can chain off.
      //
      // This is the asymmetric strategy 1 from the issue: await as
      // raw-T consumer, every other consumer as Promise consumer. Both
      // shapes are observable in test262 today; this PR keeps both
      // working while eliminating the `[object Promise]` stringification.
      //
      // (#1727) Generalised: ALSO skip the wrap when the result is consumed
      // as a raw value through a non-Promise cast/assertion
      // (`f() as unknown as number`, `as any`, `as number`). Otherwise the
      // internal call boxes the f64 and wraps it in a real Promise object, and
      // the consuming numeric sink unboxes `Number(Promise{42})` === NaN. The
      // raw `T` already on the stack is exactly what the sink wants. Genuine
      // Promise consumers (`.then`, `const p: Promise<T> = f()`,
      // `Promise.all`, bare `return f()`) have no non-Promise cast, so the
      // wrap still fires. See `asyncResultConsumedAsValue` above.
      if (asyncResultConsumedAsValue(ctx, expr)) {
        // Skip the wrap; the raw value on the stack is what the consumer
        // (await passthrough or primitive cast sink) expects.
        return callResult;
      }
      const wrappedType = wrapAsyncReturn(ctx, fctx, callResult);
      // Wrap the call+Promise.resolve in try/catch so synchronous throws from
      // the async function body (e.g. TDZ ReferenceError during default param
      // evaluation) become rejected Promises per spec (#1150).
      wrapAsyncCallInTryCatch(ctx, fctx, callStart);
      return wrappedType;
    }
    return callResult;
  }

  if (ts.isNewExpression(expr)) {
    return compileNewExpression(ctx, fctx, expr);
  }

  if (ts.isConditionalExpression(expr)) {
    return compileConditionalExpression(ctx, fctx, expr);
  }

  if (ts.isPropertyAccessExpression(expr)) {
    // (#2128) Property reads can dispatch a host GETTER callback whose
    // mutable captures live in ref cells (see the assignment arm above for
    // the setter counterpart) — re-sync the outer locals after the read.
    if (fctx.persistentCallbackWritebacks && fctx.persistentCallbackWritebacks.length > 0) {
      const readResult = compilePropertyAccess(ctx, fctx, expr);
      fctx.body.push(...fctx.persistentCallbackWritebacks.map((instr) => structuredClone(instr)));
      return readResult;
    }
    return compilePropertyAccess(ctx, fctx, expr);
  }

  if (ts.isElementAccessExpression(expr)) {
    // (#2128) Same getter-dispatch re-sync as the property-access arm above.
    if (fctx.persistentCallbackWritebacks && fctx.persistentCallbackWritebacks.length > 0) {
      const readResult = compileElementAccess(ctx, fctx, expr);
      fctx.body.push(...fctx.persistentCallbackWritebacks.map((instr) => structuredClone(instr)));
      return readResult;
    }
    return compileElementAccess(ctx, fctx, expr);
  }

  if (ts.isObjectLiteralExpression(expr)) {
    return compileObjectLiteral(ctx, fctx, expr);
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return compileArrayLiteral(ctx, fctx, expr);
  }

  if (ts.isAsExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression, expectedType);
  }

  if (ts.isNonNullExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression, expectedType);
  }

  if (ts.isAwaitExpression(expr)) {
    // (#1042) When the async-CPS state machine is driving this function
    // (`asyncCpsActive`), the single tail-position await is consumed by
    // `splitBodyAtAwait` and never reaches this expression path. Any await
    // that DOES reach here under an active state machine is a nested /
    // non-tail await the PR1 lowering doesn't handle yet — fail loudly rather
    // than silently emit the legacy synchronous pass-through (which would
    // desync the continuation). Outside CPS mode (gate off / not async-CPS),
    // keep the legacy pass-through: async fns are compiled synchronously.
    if (fctx.asyncCpsActive) {
      reportError(
        ctx,
        expr,
        "internal: nested/non-tail await under async-CPS not yet supported (#1042 PR1 handles a single tail await)",
      );
      return { kind: "externref" };
    }
    return compileExpressionInner(ctx, fctx, expr.expression, expectedType);
  }

  if (ts.isYieldExpression(expr)) {
    return compileYieldExpression(ctx, fctx, expr);
  }

  if (ts.isVoidExpression(expr)) {
    const voidBodyLen = fctx.body.length;
    const operandType = compileExpressionInner(ctx, fctx, expr.expression);
    if (operandType !== null && operandType !== VOID_RESULT) {
      if (!_isLastInstrVoidCall(ctx, fctx, voidBodyLen)) {
        fctx.body.push({ op: "drop" });
      }
    }
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (ts.isDeleteExpression(expr)) {
    return compileDeleteExpression(ctx, fctx, expr);
  }

  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return compileArrowFunction(ctx, fctx, expr);
  }

  if (ts.isMetaProperty(expr) && expr.keywordToken === ts.SyntaxKind.NewKeyword && expr.name.text === "target") {
    if (fctx.isConstructor) {
      // (#2023) Read the live new.target class-id (set at the outermost `new`
      // site, preserved through super()). Non-zero inside a construction, so
      // truthiness uses (`if (new.target)`) stay correct; identity comparisons
      // (`new.target === SomeClass`) are handled in compileBinaryExpression and
      // never reach here.
      if (ctx.usesNewTarget) {
        emitNewTargetClassId(ctx, fctx.body);
        return { kind: "i32" };
      }
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    } else {
      emitUndefined(ctx, fctx);
      return { kind: "externref" };
    }
  }

  if (ts.isMetaProperty(expr) && expr.keywordToken === ts.SyntaxKind.ImportKeyword && expr.name.text === "meta") {
    return compileStringLiteral(ctx, fctx, "[object Object]");
  }

  if (ts.isMetaProperty(expr) && expr.keywordToken === ts.SyntaxKind.ImportKeyword) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  if (expr.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    return compileRegExpLiteral(ctx, fctx, expr);
  }

  if (ts.isTaggedTemplateExpression(expr)) {
    return compileTaggedTemplateExpression(ctx, fctx, expr);
  }

  if (ts.isClassExpression(expr)) {
    return compileClassExpression(ctx, fctx, expr);
  }

  if (ts.isPrivateIdentifier(expr)) {
    fctx.body.push({ op: "i32.const", value: 1 });
    return { kind: "i32" };
  }

  if (expr.kind === ts.SyntaxKind.SuperKeyword) {
    const selfIdx = fctx.localMap.get("this");
    if (selfIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: selfIdx });
      // (#1824) `this` is param 0, so its ValType lives in `fctx.params`, not
      // `fctx.locals`. Mirror the ThisKeyword branch: params for param-range
      // indices, locals (offset by the param count) otherwise. The old
      // `fctx.locals[selfIdx]` read an unrelated non-param local (or undefined),
      // which mis-drove downstream coercion of a bare `super` value.
      if (selfIdx < fctx.params.length) {
        return fctx.params[selfIdx]!.type;
      }
      const localDef = fctx.locals[selfIdx - fctx.params.length];
      if (localDef) return localDef.type;
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  if (ts.isSpreadElement(expr as any)) {
    return compileExpressionInner(ctx, fctx, (expr as any as ts.SpreadElement).expression, expectedType);
  }

  reportError(ctx, expr, `Unsupported expression: ${ts.SyntaxKind[expr.kind]}`);
  return null;
}

// Register delegates in shared.ts so other modules (array-methods, etc.) can
// call compileExpression / ensureLateImport / flushLateImportShifts without
// creating circular imports.
registerCompileExpression(compileExpression);
registerEnsureLateImport(ensureLateImport);
registerFlushLateImportShifts(flushLateImportShifts);
