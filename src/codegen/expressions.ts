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
import { ts, forEachChild } from "../ts-api.js";
import { isBooleanType, isPromiseType, mapTsTypeToWasm } from "../checker/type-mapper.js";
import {
  classifyAsyncConsumer,
  analyzeAsyncBody,
  asyncFnNeedsCps,
  staticPromiseResolveSettledExpr,
} from "./async-cps.js";
import { asyncGenConsumerNeedsDrive } from "./async-frame.js";
import type { Instr, ValType } from "../ir/types.js";
import {
  emitStandalonePromiseReject,
  emitStandalonePromiseResolve,
  getDrainFuncIdxForWasiStart,
  getOrRegisterPromiseType,
  isStandalonePromiseActive,
  emitDrainMicrotasks,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_REJECTED,
} from "./async-scheduler.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { ensureExnTag } from "./registry/imports.js"; // (#3178) async-call rejection payload
import { allocTempLocal, getLocalType, releaseTempLocal } from "./context/locals.js";
import { snapshotSpeculative, rollbackSpeculative } from "./context/speculative.js";
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
import { compileStringLiteral, emitNativeStringToHostExternref } from "./string-ops.js";
import { compileHostBigIntLiteralText } from "./bigint-host-literal.js";
import { usesHostBigIntCarrier } from "./host-bigint-carrier.js";
import { ensureImportMetaObject } from "./import-meta.js";
import { coerceType as coerceTypeImpl, pushDefaultValue } from "./type-coercion.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
import { emitVoidOperandSideEffects } from "./expressions/void-operand.js";

// ── Sub-module imports ─────────────────────────────────────────────────

import { wasmFuncReturnsVoid, wasmFuncTypeReturnsVoid } from "./expressions/helpers.js";

import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

import { compileHostInstanceOf, compileIdentifier, resolveInstanceOfRHS } from "./expressions/identifiers.js";
import { tryEmitNullishReceiverMemberRead } from "./nullish-receiver-coercible.js"; // (#4484 B) §7.3.2
import { emitLazyClassObjectGet } from "./expressions/extern.js";
import { compileThisKeyword } from "./expressions/this-keyword.js"; // (#4190, #4203, #4555)
import { buildCurrentThisNonNullArm } from "./explicit-null-receiver.js"; // (#4203)
import { emitCachedResolvedThis, recordResolvedThis } from "./receiver-cse.js"; // (#4157 B) receiver CSE

import { compilePostfixUnary, compilePrefixUnary } from "./expressions/unary.js";

import { compileCallExpression } from "./expressions/calls.js";
import { isForeignEvalNode } from "./expressions/eval-source.js";

import { compileClassExpression, compileNewExpression } from "./expressions/new-super.js";
import { emitNewTargetClassId } from "./new-target.js"; // (#2023)

import { compileConditionalExpression, compileYieldExpression } from "./expressions/misc.js";

// Closures (used inside compileExpressionInner)
import { compileArrowFunction } from "./closures.js";

// Property access + binary ops (used inside compileExpressionInner)
import { brandBooleanBinaryResult, compileBinaryExpression } from "./binary-ops.js";
import { compileArrayLiteral, compileObjectLiteral } from "./literals.js";
import { compileElementAccess, compilePropertyAccess, maybeWrapAnyReadEqualityCarrier } from "./property-access.js";
import { compileTaggedTemplateExpression, compileTemplateExpression } from "./string-ops.js";
import { compileDeleteExpression, compileRegExpLiteral, compileTypeofExpression } from "./typeof-delete.js";
import { describeInternalError } from "./internal-error.js";

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
export { getCol, getLine, resolveEnclosingClassName, valTypesMatch, VOID_RESULT } from "./shared.js";
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
export { compileAssignment } from "./expressions/assignment.js";
export {
  compileCompoundAssignment,
  compileLogicalAssignment,
  isCompoundAssignment,
} from "./expressions/operator-assignment.js";
export { compileCallExpression, compileIIFE, compileOptionalCallExpression } from "./expressions/calls.js";
export { emitLazyProtoGet, findExternInfoForMember } from "./expressions/extern.js";
export { getFuncParamTypes } from "./expressions/helpers.js";
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
} from "./expressions/new-super.js";
export { compileMemberIncDec, compilePostfixUnary, compilePrefixUnary } from "./expressions/unary.js";

// ── Dispatcher helpers (used only within this file) ────────────────────

/** Check whether a call needs Promise.resolve() wrapping (#919). */
function isAsyncCallExpression(ctx: CodegenContext, expr: ts.CallExpression): boolean {
  // Foreign eval calls have no checker signatures and are always synchronous.
  if (isForeignEvalNode(expr)) return false;
  // (#2903) `.finally(...)` nodes lowered to the NATIVE §27.2.5.3 machinery
  // already return a `$Promise` — the fulfilled-wrap would double-wrap (and
  // its try/catch_all would null a rejection reason). The per-node marker is
  // set by the calls.ts finally arms at lowering time, so this check is in
  // exact lockstep with the route actually emitted; the legacy host route
  // (producer modules, gc/host lane) never marks and KEEPS the wrap.
  if (ctx.standaloneNativeFinallyNodes?.has(expr) === true) return false;
  // (#2623 P-7 / B-5) `.finally(...)` on the gc/host lane must NOT get the
  // fulfilled-wrap either. §27.2.5.3 defines `finally` via
  // `Invoke(promise, "then", «thenFinally, catchFinally»)`: an abrupt
  // completion from reading a poisoned `then` accessor or invoking a throwing
  // patched `then` propagates SYNCHRONOUSLY out of `.finally()`
  // (test262 `finally/this-value-then-{poisoned,throws}.js` assert #2), and
  // the result IS whatever the receiver's own `then` returned
  // (`finally/invokes-then-with-*.js` — `result === returnValue` identity).
  // The wrap broke both: its try/catch_all converted the sync throw into a
  // `Promise_reject`, and its `Promise_resolve(result)` re-wrap destroyed the
  // return-value identity for a patched `then`. The STANDALONE producer-module
  // lane is deliberately excluded — the #2903 measurement found the
  // subclass-`finally` tests pass through that host route only WITH the wrap.
  if (
    ctx.standalone !== true &&
    ctx.wasi !== true &&
    ts.isPropertyAccessExpression(expr.expression) &&
    (expr.expression.name.text === "finally" ||
      // `Promise.prototype.finally.call(target, …)` / `.apply(target, …)` —
      // the same §27.2.5.3 entry reached reflectively.
      ((expr.expression.name.text === "call" || expr.expression.name.text === "apply") &&
        ts.isPropertyAccessExpression(expr.expression.expression) &&
        expr.expression.expression.name.text === "finally"))
  ) {
    return false;
  }
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
    ts.isPropertyAccessExpression(expr.expression) &&
    (expr.expression.name.text === "then" ||
      // (#2165) `.catch` lowers to the same native then-machinery in standalone
      // mode (`.catch(f)` ≡ `.then(undefined, f)`); it already returns a
      // `$Promise`, so it must NOT be re-wrapped by `wrapAsyncReturn` (double-
      // wrapping yields a Promise-of-Promise → illegal cast / NaN when the
      // chained result is consumed). The host Promise_then/Promise_catch
      // imports likewise return the receiver's native Promise directly. The
      // old host wrap converted their synchronous constructor/species errors
      // into rejected promises, violating §27.2.5.4's abrupt-completion
      // contract (`p.then()` must throw before returning a promise).
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

  // (#2612) Apparent-type call signatures unwrap the variable to its function
  // type more reliably than `getTypeAtLocation` for some binding indirections.
  const apparent = ctx.checker.getApparentType(calleeType);
  for (const callSig of apparent.getCallSignatures()) {
    if (isPromiseType(callSig.getReturnType())) return true;
  }

  // (#2612) An async function EXPRESSION bound to a `var`/`let` and consumed as
  // a thenable (`ref(3).then(...)`) is never registered in `ctx.asyncFunctions`
  // (that set only holds async declarations / class methods / object-literal
  // methods). When the variable has no initializer type that surfaces
  // `Promise<T>` (the `var ref; ref = async function …` two-step pattern), the
  // signature/apparent-type fallbacks above all miss it. Resolve the callee's
  // SYMBOL and inspect its bindings: if the variable's initializer — or the RHS
  // of a later `ref = …` assignment to that same symbol — is an `async` function
  // expression / async arrow, the call returns a Promise and must be wrapped.
  if (ts.isIdentifier(expr.expression)) {
    const sym = ctx.checker.getSymbolAtLocation(expr.expression);
    if (sym && symbolBindsAsyncFunction(ctx, sym)) return true;
  }

  return false;
}

/** True when `node` is an `async function`/`async () =>` (not a generator). */
function isAsyncFunctionExpr(node: ts.Node | undefined): node is ts.FunctionExpression | ts.ArrowFunction {
  if (!node || !(ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return false;
  // Exclude async generators — they return AsyncGenerator, not a Promise.
  if ((node as ts.FunctionExpression).asteriskToken) return false;
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

/**
 * (#2612) Determine whether a callee symbol is bound to an async function
 * expression — either as a variable initializer or via a later
 * `name = async function …` assignment. Catches the two-step
 * declare-then-assign pattern that `ctx.asyncFunctions` and the TS signature
 * fallbacks all miss.
 */
function symbolBindsAsyncFunction(ctx: CodegenContext, sym: ts.Symbol): boolean {
  const decls = sym.declarations ?? [];
  for (const decl of decls) {
    // `const ref = async function …` / `let ref = async () => …`
    if (ts.isVariableDeclaration(decl) && isAsyncFunctionExpr(decl.initializer)) return true;
    // `function ref()` async declaration would already be caught by the
    // `ctx.asyncFunctions` / modifier check; binding-element / param defaults
    // with an async initializer:
    if (ts.isBindingElement(decl) && isAsyncFunctionExpr(decl.initializer)) return true;
  }
  // Scan for a later `name = async function …` assignment to this symbol's
  // identifier in the same source file (the `var ref; ref = async function …`
  // pattern, where the declaration carries no initializer).
  //
  // (#3433) The scan is memoized per source file: one walk collects the
  // symbols of ALL `<ident> = <async fn expr>` assignments, and each query is
  // a set-membership test. This fallback runs for every call expression whose
  // earlier async checks fell through — i.e. every ordinary sync call — so the
  // pre-memo per-query full-file walk was O(call-sites × file-size), ~40 % of
  // total compile time on the oracle-v8 test262 harness assemblies.
  // Membership in the memoized set is equivalent to the original per-query
  // scan: it contains exactly the symbols `s` for which some assignment
  // `left = asyncFnExpr` has `getSymbolAtLocation(left) === s`.
  for (const decl of decls) {
    if (asyncAssignedSymbolsInFile(ctx, decl.getSourceFile()).has(sym)) return true;
  }
  return false;
}

/**
 * (#3433) Symbols assigned an async function expression anywhere in `sf`
 * (`x = async function …` / `x = async () => …`), computed once per compile
 * per source file. See `symbolBindsAsyncFunction`.
 */
function asyncAssignedSymbolsInFile(ctx: CodegenContext, sf: ts.SourceFile): ReadonlySet<ts.Symbol> {
  const cache = (ctx.asyncAssignScanCache ??= new Map());
  const cached = cache.get(sf);
  if (cached) return cached;
  const set = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isAsyncFunctionExpr(node.right)
    ) {
      const assigned = ctx.checker.getSymbolAtLocation(node.left);
      if (assigned) set.add(assigned);
    }
    forEachChild(node, visit); // #3437: shared helper so this per-file scan is counted by the compile-work budget meter
  };
  visit(sf);
  cache.set(sf, set);
  return set;
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
 * (#2867 Gap 2 prerequisite) Is the callee of `expr` an async function that is
 * **drive-lowered** under the host-free native-`$Promise` carrier — i.e. it is
 * compiled by the #2895 async-frame drive layer and therefore ALREADY returns a
 * real `$Promise` object (externref), not a raw `T`?
 *
 * The legacy call-site contract (#1313/#1727) assumes an async call leaves a raw
 * `T` on the stack and wraps it in `Promise.resolve(...)` for thenable consumers
 * (`f().then(...)`, `const p: Promise<T> = f()`). That double-wraps a
 * drive-lowered result — the `$Promise` externref is wrapped in a SECOND native
 * `$Promise` (`wrapAsyncReturn`'s `struct.new` arm), so `.then`/assignment sees a
 * Promise-of-Promise and reads NaN / illegal-casts. When the callee is
 * drive-lowered we must leave its `$Promise` result un-wrapped.
 *
 * Mirrors the drive-layer gate in `function-body.ts` exactly: carrier active +
 * the callee is a plain async (non-generator) `function` declaration whose body
 * genuinely suspends (`asyncFnNeedsCps`). Inert off the carrier (gc/host).
 */
function calleeIsDriveLowered(ctx: CodegenContext, expr: ts.CallExpression): boolean {
  const sig = ctx.checker.getResolvedSignature(expr);
  const decl = sig?.getDeclaration();
  if (!decl || !ts.isFunctionDeclaration(decl) || decl.body === undefined) return false;
  if (decl.asteriskToken) return false; // async generator — returns AsyncGenerator, not Promise
  const isAsyncDecl = (decl.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  if (!isAsyncDecl) return false;
  // Carrier lane (wasi): a genuinely-suspending async fn is frame-driven and
  // already returns a real `$Promise`.
  if (isStandalonePromiseActive(ctx)) return asyncFnNeedsCps(decl, analyzeAsyncBody(ctx, decl));
  // (#3132) `--target standalone` with the native-`$Promise` CARRIER still OFF
  // (#2980): the async-gen-CONSUMER drive lane (`for await (x of asyncGen)`) is
  // carrier-independent — every suspension awaits a promise MINTED by the
  // producer's own `__async_gen_next_<name>` driver (a native `$Promise` on
  // every lane), and the driven consumer settles its result via native
  // `__promise_fulfill`. So its CALL result is already a native `$Promise` and
  // must pass through UN-wrapped: the HOST try/catch wrap
  // (`Promise_reject`/`__get_caught_exception`) was the last host dependency for
  // the for-await-over-async-gen files whose consumer drives natively but whose
  // call site still pulled in the host Promise machinery. Plain awaits / Promise
  // statics stay on the legacy path pending the #2980 carrier widen.
  if (ctx.standalone === true) return asyncGenConsumerNeedsDrive(ctx, decl, analyzeAsyncBody(ctx, decl));
  return false;
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
    // (#3220) PromiseResolve idempotence (§25.6.4.5.1 / §27.2.4.7): a value that
    // is ALREADY a native `$Promise` must pass through UNCHANGED, not be
    // re-wrapped in a SECOND `$Promise`. The unconditional fulfilled-mint below
    // double-wrapped a callee that already returns a native `$Promise` on the
    // carrier lane — e.g. a plain `function mk(): Promise<number>` whose result
    // is consumed as a thenable (`yield mk()`, `const pv = mk(); yield pv`,
    // `mk().then(...)`). `isAsyncCallExpression` classifies such a call as an
    // "async call" via its `Promise<T>` return type (#1151), so it reaches this
    // wrap even though the raw `$Promise` is already on the stack; the second
    // `$Promise{FULFILLED, <innerPromise>, null}` made a later `ref.test
    // $Promise` (the await/yield suspend arm) adopt the OUTER wrapper and
    // deliver the inner promise OBJECT raw → NaN (`calleeIsDriveLowered` only
    // skips the wrap for drive-lowered async *declarations*, not a plain
    // `$Promise`-returning fn). A runtime `ref.test $Promise` guard makes the
    // wrap idempotent: an existing `$Promise` passes through; a raw value takes
    // the unchanged fulfilled-mint (byte-identical to pre-#3220 in that arm).
    fctx.body.push({ op: "local.get", index: valueLocal });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.test", typeIdx: promiseTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "local.get", index: valueLocal }],
      else: [
        { op: "i32.const", value: PROMISE_STATE_FULFILLED },
        { op: "local.get", index: valueLocal },
        { op: "ref.null.extern" },
        { op: "ref.null.extern" },
        { op: "struct.new", typeIdx: promiseTypeIdx },
        { op: "extern.convert_any" },
      ],
    });
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
 * (#2865 AG0) Emit a one-level native-`$Promise` await unwrap, host-free.
 * Consumes one externref on the stack and leaves one externref:
 *   - if it is a `$Promise` struct → push its `value` field (the resolved
 *     value the awaiter wants);
 *   - otherwise → push the original externref unchanged (a plain value / a
 *     non-Promise thenable is already "the value" under the standalone
 *     synchronous-settlement model).
 *
 * A runtime `ref.test (ref $Promise)` discriminates — the non-null test means a
 * null externref (or any non-`$Promise`) takes the passthrough arm. This fixes
 * the standalone identity-passthrough NaN bug (`await <fulfilled $Promise>`
 * previously returned the promise object itself, which the consumer coerced to
 * f64 → NaN). Genuinely-pending awaits (a promise that only settles on a later
 * microtask) need true frame suspension — deferred to #2865 AG1 (PATH B).
 */
function emitStandaloneAwaitUnwrap(ctx: CodegenContext, fctx: FunctionContext): void {
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const tmp = allocTempLocal(fctx, { kind: "externref" });
  // stack: externref(operand) → stash, then test the stashed copy.
  fctx.body.push({ op: "local.set", index: tmp });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: promiseTypeIdx });
  const thenBody: Instr[] = [
    { op: "local.get", index: tmp },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: promiseTypeIdx },
    // $Promise field 1 = `value` (externref). See getOrRegisterPromiseType.
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
  ];
  const elseBody: Instr[] = [{ op: "local.get", index: tmp }];
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: thenBody,
    else: elseBody,
  });
  releaseTempLocal(fctx, tmp);
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
    // (#3178) Complete the #1326 Phase-1C payload wiring this arm deferred:
    // catch the native `__exn` tag and use its externref payload — the thrown
    // JS value (e.g. the TypeError instance a sync-unwound async body threw) —
    // as the rejection reason ($Promise.value). Before this, the reason was
    // ALWAYS `ref.null.extern`, so every synchronously-unwinding async-fn
    // throw rejected with NULL: handlers destructuring the reason
    // (`({ constructor }) => …`, the for-await-dstr test262 template tail)
    // then threw their OWN "Cannot destructure 'null' or 'undefined'" — the
    // ~81-test cluster in the F2 harvest (#3417). catch_all stays as the
    // reason-less fallback for foreign (non-`__exn`) exceptions only.
    const tagIdx = ensureExnTag(ctx);
    const reasonLocal = allocTempLocal(fctx, { kind: "externref" });
    const inner = fctx.body.splice(start);
    const catchExn: Instr[] = [
      { op: "local.set", index: reasonLocal },
      { op: "i32.const", value: PROMISE_STATE_REJECTED },
      { op: "local.get", index: reasonLocal },
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: promiseTypeIdx },
      { op: "extern.convert_any" },
    ];
    const catchAll: Instr[] = [
      { op: "i32.const", value: PROMISE_STATE_REJECTED },
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: promiseTypeIdx },
      { op: "extern.convert_any" },
    ];
    fctx.body.push(
      buildTargetTaggedTry(
        ctx,
        { kind: "val", type: { kind: "externref" } },
        inner,
        [{ tagIdx, body: catchExn }],
        catchAll,
      ),
    );
    releaseTempLocal(fctx, reasonLocal);
    return;
  }
  const rejectIdx = ensureLateImport(ctx, "Promise_reject", [{ kind: "externref" }], [{ kind: "externref" }]);
  const getCaughtIdx = ensureLateImport(ctx, "__get_caught_exception", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (rejectIdx === undefined || getCaughtIdx === undefined) return;
  const tagIdx = ensureExnTag(ctx);
  const inner = fctx.body.splice(start);
  // A compiler-native JS throw uses the module's `$exn` tag and carries the
  // original JS value as its externref payload. Feed that payload directly to
  // Promise.reject. `__get_caught_exception` is only populated by a throwing
  // host import, so using catch_all for both forms leaked a stale/undefined
  // value (or the raw WebAssembly.Exception) after direct eval began emitting
  // native SyntaxErrors.
  const catchExn: Instr[] = [{ op: "call", funcIdx: rejectIdx }];
  const catchAll: Instr[] = [
    { op: "call", funcIdx: getCaughtIdx },
    { op: "call", funcIdx: rejectIdx },
  ];
  fctx.body.push(
    buildTargetTaggedTry(
      ctx,
      { kind: "val", type: { kind: "externref" } },
      inner,
      [{ tagIdx, body: catchExn }],
      catchAll,
    ),
  );
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
  __compileDepth = ctx.irBodyRouteAuditSession?.enterExpression(fctx, expr, __compileDepth) ?? __compileDepth + 1;
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
    const isUndefined = (ts.isIdentifier(inner) && inner.text === "undefined") || ts.isOmittedExpression(inner);
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
      emitVoidOperandSideEffects(ctx, fctx, () => compileExpressionInner(ctx, fctx, inner.expression));
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
    const isUndefined = (ts.isIdentifier(inner) && inner.text === "undefined") || ts.isOmittedExpression(inner);
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
    const isUndefined = (ts.isIdentifier(inner) && inner.text === "undefined") || ts.isOmittedExpression(inner);
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
      emitVoidOperandSideEffects(ctx, fctx, () => compileExpressionInner(ctx, fctx, inner.expression));
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

  // #1919 — transactional wrapper around the inner compile. The snapshot is O(1)
  // and the two rollback exits below (a thrown inner compile; an inner that
  // produced no usable value) discard the partial body AND any locals / late
  // imports / errors it leaked, then emit a clean fallback value. The successful
  // path simply drops the snapshot, so legitimately-registered imports persist.
  const snap = snapshotSpeculative(ctx, fctx);
  const bodyLenBefore = snap.bodyLen;
  let result: InnerResult;
  try {
    result = compileExpressionInner(ctx, fctx, expr, expectedType);
  } catch (e) {
    rollbackSpeculative(ctx, fctx, snap);
    // (#4030) Name the innermost `src/` frame. An exception here is a compiler
    // bug, and the bare message alone is not actionable — see #4038.
    reportErrorNoNode(ctx, `Internal error compiling expression: ${describeInternalError(e)}`);
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

  // Inner compile produced no usable value — roll back its partial emission
  // (#1919: body + locals + late imports + errors) and emit a default instead.
  // (#3725) Diagnostics marked `sticky` survive this unwind: a deliberate
  // target refusal is not a probe miss, and substituting a default for it
  // produced a clean compile that trapped at runtime.
  rollbackSpeculative(ctx, fctx, snap);
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

function compileBigIntLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BigIntLiteral,
  expectedType: ValType | undefined,
): ValType | null {
  const text = expr.text.replace(/_/g, "").replace(/n$/i, "");
  const hostBigIntRef =
    usesHostBigIntCarrier(ctx) &&
    (expectedType?.kind === "externref" || (expectedType !== undefined && isAnyValue(expectedType, ctx)));
  if (hostBigIntRef) {
    const stringType = compileHostBigIntLiteralText(ctx, fctx, text);
    if (!stringType) return null;
    if (stringType.kind !== "externref") {
      // `fast`/native-strings still targets the JS host. Convert the native
      // `$AnyString` value to a real host string before calling BigInt; a bare
      // `extern.convert_any` would expose an opaque WasmGC object and the host
      // constructor would throw `Cannot convert [object Object] to a BigInt`.
      if (!emitNativeStringToHostExternref(ctx, fctx)) {
        coerceType(ctx, fctx, stringType, { kind: "externref" });
      }
    }
    const ctorIdx = ensureLateImport(ctx, "__bigint_ctor_ref", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    const finalIdx = ctx.funcMap.get("__bigint_ctor_ref") ?? ctorIdx;
    if (finalIdx === undefined) throw new Error("Missing import after ensureLateImport: __bigint_ctor_ref");
    fctx.body.push({ op: "call", funcIdx: finalIdx });
    return { kind: "externref" };
  }
  const value = BigInt(text);
  fctx.body.push({ op: "i64.const", value });
  return { kind: "i64", bigint: true };
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
    return compileBigIntLiteral(ctx, fctx, expr, expectedType);
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return compileStringLiteral(ctx, fctx, expr.text, expr);
  }

  if (ts.isTemplateExpression(expr)) {
    return compileTemplateExpression(ctx, fctx, expr);
  }

  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    fctx.body.push({ op: "i32.const", value: 1 });
    // (#2795) Brand the i32 as a boolean so a later i32→externref box (e.g. a
    // conditional/return that unifies `true` with an `any` operand, as in a
    // mutually-recursive boolean kernel) picks `__box_boolean` and the value
    // crosses to the host as `true`, not the number 1. Mirrors the #2016/#2030
    // boolean brand carried by i32 comparison predicates.
    return { kind: "i32", boolean: true };
  }

  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32", boolean: true };
  }

  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    fctx.body.push({ op: "ref.null.extern" });
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
    return compileThisKeyword(ctx, fctx, expr);
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
        return brandBooleanBinaryResult(expr.operatorToken.kind, compileHostInstanceOf(ctx, fctx, expr));
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
          return { kind: "i32", boolean: true };
        }
        // (#1455) LHS type could not be resolved statically (TS often infers
        // `any` for `class Sub extends WeakRef {}` because WeakRef<T> requires
        // type args). Fall through to the host runtime check, which consults
        // the user-class tag registry attached at construction time.
        return brandBooleanBinaryResult(expr.operatorToken.kind, compileHostInstanceOf(ctx, fctx, expr));
      }
    }
    return brandBooleanBinaryResult(expr.operatorToken.kind, compileBinaryExpression(ctx, fctx, expr, expectedType));
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
    // (#2895 PATH B) `__drain_microtasks()` intrinsic — lets the test262 harness
    // (and standalone entrypoints) pump the microtask ring so genuinely-pending
    // async-frame continuations run before a settled value is observed. On the
    // host-free targets it lowers to the native drain; on the JS-host target
    // there is no native microtask ring (async is synchronous there), so it is a
    // void no-op — keeping the gc lane byte-identical.
    if (ts.isIdentifier(expr.expression) && expr.expression.text === "__drain_microtasks") {
      // Gate on the native-`$Promise` CARRIER (not merely `isAsyncDriveActive`):
      // emit the real drain only where the drive layer actually produces native
      // promises. With the carrier `wasi`-only today the gc lane gets a void
      // no-op (no microtask infra registered, output unchanged).
      //
      // (#2865) `--target standalone` addendum: the async-GENERATOR drive is now
      // active under standalone (carrier-independent — its promises are minted
      // by `__async_gen_next_*`), so when THIS module has already registered the
      // native microtask queue, emit the real drain too. Modules with no driven
      // machinery keep the byte-identical no-op (`getDrainFuncIdxForWasiStart`
      // is null when the queue was never registered). Function bodies compile in
      // source order, so a harness-appended `__drain_microtasks()` call compiles
      // after every producer/consumer registration.
      if (isStandalonePromiseActive(ctx) || getDrainFuncIdxForWasiStart(ctx) !== null) {
        emitDrainMicrotasks(ctx, fctx);
      }
      return VOID_RESULT;
    }
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
      // (#2867) A drive-lowered async callee already returns a real `$Promise`
      // (externref) — the #2895 frame driver settled it. Re-wrapping it via
      // `wrapAsyncReturn` would build a Promise-of-Promise (the native
      // `struct.new` arm), so `.then`/assignment reads NaN / illegal-casts. Leave
      // the `$Promise` un-wrapped for the thenable consumer. Carrier-gated → inert
      // on gc/host.
      if (calleeIsDriveLowered(ctx, expr)) {
        if (callResult !== null && callResult !== VOID_RESULT && (callResult as ValType).kind !== "externref") {
          coerceType(ctx, fctx, callResult as ValType, { kind: "externref" });
        }
        return { kind: "externref" };
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
    return compileConditionalExpression(ctx, fctx, expr, expectedType);
  }

  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    // (#4484 B) §7.3.2 RequireObjectCoercible on a syntactic `null`/`undefined`
    // receiver. `null.foo` already threw; `undefined.foo` silently produced a
    // value. Placed ahead of both access arms so the property and element forms
    // agree. Declines for every non-syntactic receiver — see the module header.
    const coercible = tryEmitNullishReceiverMemberRead(ctx, fctx, expr);
    if (coercible !== undefined) return coercible;
  }

  if (ts.isPropertyAccessExpression(expr)) {
    // (#2128) Property reads can dispatch a host GETTER callback whose
    // mutable captures live in ref cells (see the assignment arm above for
    // the setter counterpart) — re-sync the outer locals after the read.
    // (#3037 CS1b) Re-classify a dynamic `any`-member read that is a direct
    // operand of a standalone `any`-equality into the `$AnyValue` tag-6 carrier
    // (object identity), byte-inert off that exact shape. Applied BEFORE the
    // getter-writeback resync so the classifier consumes the read result while
    // it is still on top of the stack (the writebacks are net-zero local
    // re-syncs that leave the carrier value in place).
    const readResult = maybeWrapAnyReadEqualityCarrier(ctx, fctx, expr, compilePropertyAccess(ctx, fctx, expr));
    if (fctx.persistentCallbackWritebacks && fctx.persistentCallbackWritebacks.length > 0) {
      fctx.body.push(...fctx.persistentCallbackWritebacks.map((instr) => structuredClone(instr)));
    }
    return readResult;
  }

  if (ts.isElementAccessExpression(expr)) {
    // (#2128) Same getter-dispatch re-sync as the property-access arm above.
    // (#3037 CS1b(ii)) Re-classify a dynamic `any`-element read (`a[i]`, `o[key]`)
    // that is a direct operand of a standalone `any`-equality into the `$AnyValue`
    // tag-6 carrier (object identity) — the SAME context-aware carrier the
    // property-access arm applies, now at the ElementAccessExpression choke point
    // (`arr[i] === arr[j]`). Byte-inert off that exact shape: the wrapper is a
    // no-op unless the read compiled to a bare externref AND both `===` operands
    // are statically `any` (see maybeWrapAnyReadEqualityCarrier). Applied BEFORE
    // the getter-writeback resync so the classifier consumes the read result while
    // it is still on top of the stack (the writebacks are net-zero local re-syncs
    // that leave the carrier value in place).
    if (fctx.persistentCallbackWritebacks && fctx.persistentCallbackWritebacks.length > 0) {
      const readResult = maybeWrapAnyReadEqualityCarrier(
        ctx,
        fctx,
        expr,
        compileElementAccess(ctx, fctx, expr, expectedType),
      );
      fctx.body.push(...fctx.persistentCallbackWritebacks.map((instr) => structuredClone(instr)));
      return readResult;
    }
    // (#2760 F1) Forward the value-context hint so the primitive OOB→undefined
    // widening is suppressed in a numeric (f64/i32) context (avoids boxing + a
    // late-import shift under a funcIdx already captured by a numeric caller).
    return maybeWrapAnyReadEqualityCarrier(ctx, fctx, expr, compileElementAccess(ctx, fctx, expr, expectedType));
  }

  if (ts.isObjectLiteralExpression(expr)) {
    // (#3536) Forward the Wasm-level expected type: a literal in call-ARGUMENT
    // position whose callee param was call-site-narrowed to this literal's own
    // shape struct must construct THAT struct, not divert to the dynamic
    // $Object path off its `any` TS-contextual type (see compileObjectLiteral).
    return compileObjectLiteral(ctx, fctx, expr, expectedType);
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return compileArrayLiteral(ctx, fctx, expr);
  }

  // (#4458) All three type-erased wrappers — the operand IS the value, so
  // forward `expectedType` unchanged and let the operand compile into exactly
  // the context the wrapper occupied. `<T>x` and `x satisfies T` used to have no
  // arm here and fell through to the `Unsupported expression` reporter; the
  // #1919 speculative rollback in `compileExpressionBody` then discarded that
  // diagnostic along with the partial body and pushed a default instead, so both
  // silently compiled to 0 rather than erroring. IR unwraps all three (#3583),
  // so only bodies the IR selector rejects were affected.
  if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression, expectedType);
  }

  if (ts.isNonNullExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression, expectedType);
  }

  if (ts.isAwaitExpression(expr)) {
    const deliveredLocal = fctx.asyncAwaitValueLocals?.get(expr);
    if (deliveredLocal !== undefined) {
      const deliveredType = getLocalType(fctx, deliveredLocal);
      fctx.body.push({ op: "local.get", index: deliveredLocal });
      return deliveredType ?? { kind: "externref" };
    }

    // (#2967 2c) The legacy async-CPS lane (`asyncCpsActive` /
    // `emitAsyncStateMachine`) is DELETED — an await in an ACTIVATED async fn
    // is consumed by the $AsyncFrame planners (`planLinearAwaits` / the CFG
    // plans) inside the resume-fn emitter and never reaches this expression
    // path. What remains here is the legacy passthrough for bodies no engine
    // claims (non-linear shapes pending the slice-3 widening).
    // (#2865 AG0) Host-free standalone/WASI await. Async fns are compiled
    // synchronously here (no CPS — function-body.ts gates it off for these
    // targets) and the awaited operand, when it is a Promise, is the Wasm-native
    // `$Promise` carrier. The legacy identity passthrough returned that promise
    // OBJECT unchanged, so `await <fulfilled $Promise>` yielded the struct where
    // the consumer expected the resolved value → coerced to f64 = NaN. Instead,
    // compile the operand to its NATURAL type (do NOT force `expectedType` — that
    // would coerce a $Promise externref to f64/NaN before we can read it) and, if
    // it is an externref, unwrap one level of native `$Promise`. Non-externref
    // operands (f64/i32 — e.g. `await someSyncAsyncCall()` already returning the
    // unwrapped number) are passed through. Genuinely-pending awaits still need
    // true frame suspension (#2865 AG1 / PATH B).
    if (isStandalonePromiseActive(ctx)) {
      const operandType = compileExpressionInner(ctx, fctx, expr.expression);
      if (operandType !== null && operandType !== VOID_RESULT && operandType.kind === "externref") {
        emitStandaloneAwaitUnwrap(ctx, fctx);
        return { kind: "externref" };
      }
      return operandType;
    }
    // (#2613) JS-host path: `await <thenable>` / `await <non-Promise>`
    // assimilation is owned by the async-CPS state machine (`async-cps.ts`); a
    // genuinely-suspending body is driven by `emitAsyncStateMachine`
    // (`Promise_resolve` → `Promise_then2` → continuation), so it never reaches
    // this legacy passthrough. Keep the identity passthrough for the await
    // shapes CPS does not claim (statically-resolved operands, bodies
    // `splitBodyAtAwait` rejects).
    // (#3227 S2) BUT "already the resolved value on the stack" was false for
    // `await Promise.resolve(x)`: the operand compiles to a HOST call returning
    // the Promise OBJECT (externref), not x — a numeric consumer's
    // externref→f64 coercion then read NaN, synchronously (the await-NaN
    // cluster: ~875 honest fails in the S1 census). Substitute the settled
    // value: the resolve argument (or undefined for the zero-arg form).
    {
      const settled = staticPromiseResolveSettledExpr(expr.expression);
      if (settled === "undefined") {
        emitUndefined(ctx, fctx);
        return { kind: "externref" };
      }
      if (settled !== null) {
        return compileExpressionInner(ctx, fctx, settled, expectedType);
      }
    }
    return compileExpressionInner(ctx, fctx, expr.expression, expectedType);
  }

  if (ts.isYieldExpression(expr)) {
    return compileYieldExpression(ctx, fctx, expr);
  }

  if (ts.isVoidExpression(expr)) {
    emitVoidOperandSideEffects(ctx, fctx, () => compileExpressionInner(ctx, fctx, expr.expression));
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
    // (#2970) A bare `import.meta` VALUE read yields a distinct per-module
    // object with stable reference identity — one immutable `$ImportMeta`
    // global per source file. (`import.meta.<prop>` reads are intercepted
    // upstream in trySuperAndImportMetaRead, so this object needs no fields.)
    const globalIdx = ensureImportMetaObject(ctx, expr.getSourceFile().fileName);
    fctx.body.push({ op: "global.get", index: globalIdx });
    return { kind: "ref", typeIdx: ctx.importMetaTypeIdx! };
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
