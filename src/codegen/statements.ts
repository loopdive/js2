// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Statement lowering dispatcher.
 *
 * This file serves as the public API for statement compilation.
 * The actual implementation is split into focused sub-modules under statements/:
 *
 *   - statements/tdz.ts            — temporal dead zone helpers
 *   - statements/variables.ts      — variable declaration lowering
 *   - statements/destructuring.ts  — destructuring patterns (object, array, string)
 *   - statements/control-flow.ts   — return, if, switch, break, continue, labeled
 *   - statements/loops.ts          — while, for, do-while, for-of, for-in
 *   - statements/exceptions.ts     — throw and try-catch
 *   - statements/nested-declarations.ts — nested functions/classes, arguments object
 *   - statements/shared.ts         — utilities shared across all sub-modules
 */
import { ts } from "../ts-api.js";
import {
  annexBDeclaringRange,
  annexBUpdatesExistingVarBinding,
  enclosingVarScope,
  hasInterveningLexicalBinder,
} from "./annexb-cancel.js";
import { tryCompileAnnexBModuleBlockFnEvaluation } from "./annexb-global-live-binding.js";
import { mintScopedClassIdentity } from "./class-bodies.js";
import { emitCachedFuncClosureAccess, emitFuncRefAsClosure } from "./closures.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import { attachSourcePos, getSourcePos } from "./context/source-pos.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression, registerCompileStatement } from "./shared.js";
import {
  collectBlockScopedNames,
  discardBlockScopedShadows,
  saveBlockScopedShadowsForNames,
} from "./statements/shared.js";
import { resetCompletionValueForStatement, sinkExpressionStatementValue } from "./statements/eval-completion-value.js";
import { compileWithStatement } from "./with-scope.js";
import { expressionRunsUserCode } from "./module-init-collection.js"; // (#4433) bare `typeof f();`
import { noJsHost } from "./js-errors.js";

// Sub-module imports — statement-family functions
import {
  compileBreakStatement,
  compileContinueStatement,
  compileIfStatement,
  compileLabeledStatement,
  compileReturnStatement,
  compileSwitchStatement,
} from "./statements/control-flow.js";
import { compileThrowStatement, compileTryStatement } from "./statements/exceptions.js";
import {
  compileDoWhileStatement,
  compileForInStatement,
  compileForOfStatement,
  compileForStatement,
  compileWhileStatement,
} from "./statements/loops.js";
import {
  canCompileDistinctAnnexBFunction,
  compileNestedClassDeclaration,
  compileNestedFunctionDeclaration,
} from "./statements/nested-declarations.js";
import { compileVariableStatement } from "./statements/variables.js";
// (#5271 step 2.3) block-entry pre-allocation of the block's own lexical slots.
import { preallocateBlockScopedSlots } from "./index.js";
import { emitLocalTdzInit } from "./statements/tdz.js";
import { definedFuncAt } from "./func-space.js"; // (#1916 S2) positional-read chokepoint
import { coerceType } from "./type-coercion.js";
import { compileClassExpression } from "./expressions/new-super.js";
import { emitLazyClassObjectGet } from "./expressions/extern.js";

// ---------------------------------------------------------------------------
// Re-exports — preserve the existing public API surface
// ---------------------------------------------------------------------------
export {
  compileExternrefArrayDestructuringDecl,
  compileExternrefObjectDestructuringDecl,
  emitDefaultValueCheck,
  emitExternrefDefaultCheck,
  emitNestedBindingDefault,
  ensureBindingLocals,
} from "./statements/destructuring.js";
export { bodyUsesArguments } from "./helpers/body-uses-arguments.js";
export { emitArgumentsObject, hoistFunctionDeclarations } from "./statements/nested-declarations.js";
export { collectInstrs } from "./statements/shared.js";
export { emitTdzCheckAtGlobal } from "./statements/tdz.js";

// ---------------------------------------------------------------------------
// Dispatcher helpers
// ---------------------------------------------------------------------------

/**
 * Mark the first instruction emitted for a statement with its source position.
 */
let traceStmtGlobalSerial = 0;
function markStatementPos(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement, compile: () => void): void {
  const pos = getSourcePos(ctx, stmt);
  if (process.env.JS2WASM_TRACE_LAST_STMT && pos) {
    // Debug-only (env-gated): stream every statement boundary into an exported
    // mutable f64 global so a host harness can read WHERE a standalone module
    // trapped (file index * 1e6 + line). No imports — global writes don't
    // shift function indices.
    const anyCtx = ctx as unknown as { __traceStmtGlobalIdx?: number; __traceStmtFiles?: Map<string, number> };
    if (anyCtx.__traceStmtGlobalIdx === undefined) {
      const idx = ctx.numImportGlobals + ctx.mod.globals.length;
      ctx.mod.globals.push({
        name: "__trace_last_stmt",
        type: { kind: "f64" },
        mutable: true,
        init: [{ op: "f64.const", value: -1 }],
      });
      ctx.mod.exports.push({
        name: `__trace_last_stmt_${traceStmtGlobalSerial++}`,
        desc: { kind: "global", index: idx },
      });
      anyCtx.__traceStmtGlobalIdx = idx;
      anyCtx.__traceStmtFiles = new Map();
    }
    const files = anyCtx.__traceStmtFiles!;
    if (!files.has(pos.file)) files.set(pos.file, files.size);
    fctx.body.push({ op: "f64.const", value: files.get(pos.file)! * 1e6 + pos.line });
    fctx.body.push({ op: "global.set", index: anyCtx.__traceStmtGlobalIdx });
  }
  const bodyLenBefore = fctx.body.length;
  compile();
  if (pos && fctx.body.length > bodyLenBefore) {
    attachSourcePos(fctx.body[bodyLenBefore]!, pos);
  }
}

/**
 * (#4433) For a bare `typeof <expr>;` statement, the operand that must still be
 * evaluated — or `undefined` when the statement should keep its ordinary
 * lowering.
 *
 * `undefined` is returned for a bare-identifier operand (`typeof x;`), whose
 * whole point is that §13.5.3 does NOT evaluate an unresolvable Reference, and
 * for any operand with nothing observable to evaluate, so those statements
 * compile exactly as before.
 */
function bareTypeofStatementOperand(expr: ts.Expression): ts.Expression | undefined {
  let outer: ts.Expression = expr;
  while (ts.isParenthesizedExpression(outer)) outer = outer.expression;
  if (!ts.isTypeOfExpression(outer)) return undefined;
  let operand: ts.Expression = outer.expression;
  while (
    ts.isParenthesizedExpression(operand) ||
    ts.isAsExpression(operand) ||
    ts.isNonNullExpression(operand) ||
    ts.isTypeAssertionExpression(operand)
  ) {
    operand = operand.expression;
  }
  if (ts.isIdentifier(operand)) return undefined;
  if (!expressionRunsUserCode(operand)) return undefined;
  return outer.expression;
}

/**
 * An expression statement: evaluate the expression for its effects and discard
 * whatever it left on the stack.
 *
 * (#4433) The `typeof` special case. `compileTypeofExpression` const-folds on
 * the operand's STATIC TS type and emits only the folded string literal — the
 * operand is never compiled, so `typeof f();` ran no call, in a function body
 * just as much as at module top level. In statement position the `typeof`
 * result is discarded anyway, so §13.5.3 reduces to "evaluate the operand, drop
 * it".
 *
 * A BARE IDENTIFIER operand is excluded: `typeof undeclared` must NOT throw
 * (§13.5.3 short-circuits an unresolvable Reference before GetValue), which is
 * exactly what the const-fold path already gets right. Everything else is gated
 * on `expressionRunsUserCode`, so a statement with nothing to evaluate keeps its
 * previous lowering byte-for-byte.
 */
function compileExpressionStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ExpressionStatement): void {
  const typeofOperand = bareTypeofStatementOperand(stmt.expression);
  const evaluated = typeofOperand ?? stmt.expression;
  sinkExpressionStatementValue(ctx, fctx, compileExpression(ctx, fctx, evaluated));
}

function restoreMapEntry<K, V>(map: Map<K, V>, key: K, hadEntry: boolean, value: V | undefined): void {
  if (hadEntry) map.set(key, value!);
  else map.delete(key);
}

/**
 * Compile a deferred Annex B declaration that replaces an already initialized
 * direct-function binding. Returning true means this statement belongs to that
 * lifecycle even when its conservative distinct-body predicate rejects it.
 */
function tryCompileAnnexBExistingDirectFunctionUpdate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
  funcName: string | undefined,
): boolean {
  if (
    !funcName ||
    !fctx.annexBExistingDirectFunctionBindings?.has(funcName) ||
    !annexBUpdatesExistingVarBinding(stmt)
  ) {
    return false;
  }

  const bindingLocal = fctx.localMap.get(funcName);
  if (bindingLocal === undefined || !canCompileDistinctAnnexBFunction(ctx, fctx, stmt)) return true;
  const cache = (ctx.annexBDistinctFunctionIndices ??= new WeakMap<ts.FunctionDeclaration, number>());
  let innerIdx = cache.get(stmt);
  if (innerIdx === undefined) {
    const hadFunc = ctx.funcMap.has(funcName);
    const savedFunc = ctx.funcMap.get(funcName);
    const hadOwner = ctx.funcMapOwnerDecl.has(funcName);
    const savedOwner = ctx.funcMapOwnerDecl.get(funcName);
    const hadCaptures = ctx.nestedFuncCaptures.has(funcName);
    const savedCaptures = ctx.nestedFuncCaptures.get(funcName);
    const hadOptional = ctx.funcOptionalParams.has(funcName);
    const savedOptional = ctx.funcOptionalParams.get(funcName);
    const hadRest = ctx.funcRestParams.has(funcName);
    const savedRest = ctx.funcRestParams.get(funcName);
    const hadClosure = ctx.closureMap.has(funcName);
    const savedClosure = ctx.closureMap.get(funcName);
    const hadFunctionName = ctx.functionNameMap.has(funcName);
    const savedFunctionName = ctx.functionNameMap.get(funcName);
    const usedArguments = ctx.funcUsesArguments.has(funcName);
    const wasAsync = ctx.asyncFunctions.has(funcName);
    const wasGenerator = ctx.generatorFunctions.has(funcName);
    const wasPreRegistered = ctx.preRegisteredBodyless?.has(funcName) ?? false;

    ctx.funcMap.delete(funcName);
    ctx.funcMapOwnerDecl.delete(funcName);
    ctx.nestedFuncCaptures.delete(funcName);
    ctx.funcOptionalParams.delete(funcName);
    ctx.funcRestParams.delete(funcName);
    ctx.closureMap.delete(funcName);
    ctx.functionNameMap.delete(funcName);
    ctx.funcUsesArguments.delete(funcName);
    ctx.asyncFunctions.delete(funcName);
    ctx.generatorFunctions.delete(funcName);
    ctx.preRegisteredBodyless?.delete(funcName);

    const errorsBefore = ctx.errors.length;
    try {
      compileNestedFunctionDeclaration(ctx, fctx, stmt);
      innerIdx = ctx.funcMapOwnerDecl.get(funcName) === stmt ? ctx.funcMap.get(funcName) : undefined;
      if (ctx.errors.length === errorsBefore && innerIdx !== undefined) cache.set(stmt, innerIdx);
      else innerIdx = undefined;
    } finally {
      restoreMapEntry(ctx.funcMap, funcName, hadFunc, savedFunc);
      restoreMapEntry(ctx.funcMapOwnerDecl, funcName, hadOwner, savedOwner);
      restoreMapEntry(ctx.nestedFuncCaptures, funcName, hadCaptures, savedCaptures);
      restoreMapEntry(ctx.funcOptionalParams, funcName, hadOptional, savedOptional);
      restoreMapEntry(ctx.funcRestParams, funcName, hadRest, savedRest);
      restoreMapEntry(ctx.closureMap, funcName, hadClosure, savedClosure);
      restoreMapEntry(ctx.functionNameMap, funcName, hadFunctionName, savedFunctionName);
      if (usedArguments) ctx.funcUsesArguments.add(funcName);
      else ctx.funcUsesArguments.delete(funcName);
      if (wasAsync) ctx.asyncFunctions.add(funcName);
      else ctx.asyncFunctions.delete(funcName);
      if (wasGenerator) ctx.generatorFunctions.add(funcName);
      else ctx.generatorFunctions.delete(funcName);
      if (wasPreRegistered) (ctx.preRegisteredBodyless ??= new Set()).add(funcName);
      else ctx.preRegisteredBodyless?.delete(funcName);
    }
  }
  if (innerIdx !== undefined) {
    const closureType = emitAnnexBFunctionClosure(ctx, fctx, stmt, funcName, innerIdx);
    if (closureType) {
      if (closureType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "local.set", index: bindingLocal });
    }
  }
  return true;
}

/**
 * Ordinary function declarations carry the nominal constructible marker in
 * standalone/WASI closure values. Annex-B evaluation sites used to omit this
 * flag while identifier reads supplied it, so both sites shared one cache
 * global but disagreed about its struct type; the first site to initialize the
 * cache then made the other site's ref.cast trap. Keep all declaration-value
 * paths on the same wrapper family.
 */
function isOrdinaryFunctionDeclaration(ctx: CodegenContext, stmt: ts.FunctionDeclaration): boolean {
  return (
    (noJsHost(ctx) || ctx.targetProfile.semanticProviders === "native-first") &&
    stmt.asteriskToken === undefined &&
    !(stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false)
  );
}

/**
 * Annex-B function values may carry TDZ/capture cells when the declaration's
 * body mutates its own binding. The cached singleton helper models the full
 * function signature as user parameters and therefore cannot represent those
 * hidden capture parameters; use the per-activation closure path for such
 * declarations and retain the singleton for capture-free functions.
 */
function emitAnnexBFunctionClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
  funcName: string,
  funcIdx: number,
): ReturnType<typeof emitCachedFuncClosureAccess> {
  const constructible = isOrdinaryFunctionDeclaration(ctx, stmt);
  const captures = ctx.nestedFuncCaptures.get(funcName);
  const closureType =
    captures && captures.length > 0
      ? emitFuncRefAsClosure(ctx, fctx, funcName, funcIdx, constructible)
      : emitCachedFuncClosureAccess(ctx, fctx, funcName, funcIdx, constructible);
  const boxed = fctx.boxedCaptures?.get(funcName);
  if (!closureType || !boxed || boxed.valType.kind !== "externref") return closureType;

  // A function body that assigns to its own Annex-B name captures the mutable
  // outer binding through a ref cell.  The closure must publish itself into
  // that cell after construction; otherwise its first `f` read observes the
  // null value captured while the box was being allocated.
  if (closureType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  const closureLocal = allocLocal(fctx, `__annexb_closure_${funcName}_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.tee", index: closureLocal });
  fctx.body.push({ op: "local.get", index: fctx.localMap.get(funcName)! });
  fctx.body.push({ op: "local.get", index: closureLocal });
  fctx.body.push({ op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.get", index: closureLocal });
  return { kind: "externref" };
}

/**
 * Which eligible declarations share this declaration's Annex B outer binding
 * in the same function/script scope? A name-only test is not
 * enough: a deeper same-named block declaration can be cancelled by Annex B's
 * early-error substitution rule, and a lone declaration may temporarily lose
 * funcMap ownership while its surrounding catch/block is lowered. Neither case
 * should claim a declaration-specific slot.
 */
function eligibleAnnexBOuterBindingDeclarations(stmt: ts.FunctionDeclaration): ts.FunctionDeclaration[] {
  const name = stmt.name?.text;
  if (!name || !isEligibleAnnexBOuterBindingDeclaration(stmt, name)) return [];

  let scope: ts.Node = stmt.parent;
  while (!ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) {
    if (!scope.parent) return [];
    scope = scope.parent;
  }
  const scanRoot = ts.isSourceFile(scope) ? scope : (scope as ts.FunctionLikeDeclarationBase).body;
  if (!scanRoot) return [];

  const declarations: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name &&
      isEligibleAnnexBOuterBindingDeclaration(node, name)
    ) {
      declarations.push(node);
    }
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scanRoot, visit);
  return declarations;
}

function isEligibleAnnexBOuterBindingDeclaration(stmt: ts.FunctionDeclaration, name: string): boolean {
  if (annexBDeclaringRange(stmt) === null || hasInterveningSameNameBlockFunction(stmt, name)) return false;
  const scope = enclosingVarScope(stmt);
  return scope !== null && !hasInterveningLexicalBinder(stmt.parent, name, scope);
}

/**
 * Replacing an inner block function with `var name` is an early error when an
 * enclosing block already lexically declares a same-named function. Such an
 * inner declaration is block-local only, even though the legacy name-keyed
 * hoist analysis conservatively associates it with the outer Annex B name.
 */
function hasInterveningSameNameBlockFunction(stmt: ts.FunctionDeclaration, name: string): boolean {
  let node: ts.Node | undefined = stmt.parent.parent;
  while (node && !ts.isSourceFile(node) && !ts.isFunctionLike(node)) {
    if (
      ts.isBlock(node) &&
      node.statements.some(
        (candidate) => candidate !== stmt && ts.isFunctionDeclaration(candidate) && candidate.name?.text === name,
      )
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Compile a statement, appending instructions to the function body */
export function compileStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  // Track the last known good AST node for error location fallback (#931)
  if (stmt) ctx.lastKnownNode = stmt;

  // Guard: if the AST node is undefined/null, report an error and return
  // instead of crashing with "Cannot read 'kind' of undefined".
  if (!stmt) {
    reportErrorNoNode(ctx, "unexpected undefined AST node in compileStatement");
    return;
  }

  try {
    ctx.irBodyRouteAuditSession?.recordFrame("compileStatement", fctx, stmt);
    // (#4515) §13 `UpdateEmpty(…, undefined)`: `if` / `try` / `switch` / `with`
    // and every loop start their completion value at `undefined` rather than
    // inheriting the previous statement's. No-op outside an inline eval.
    resetCompletionValueForStatement(ctx, fctx, stmt);
    compileStatementInner(ctx, fctx, stmt);
  } catch (e) {
    // Defensive: catch any unhandled crash in statement compilation
    const msg = e instanceof Error ? e.message : String(e);
    reportErrorNoNode(ctx, `Internal error compiling statement: ${msg}`);
  }
}

function compileStatementInner(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  // Skip import declarations — module imports not supported
  if (ts.isImportDeclaration(stmt)) return;

  // Skip export declarations — `export { x }`, `export * from '...'`
  // These are module-level metadata with no runtime effect in our compilation.
  if (ts.isExportDeclaration(stmt)) return;

  // Export assignment — `export default expr` or `export = expr`
  // Evaluate the expression and store it when this linked module owns an exact
  // default-export snapshot cell; otherwise preserve the effects and discard it.
  if (ts.isExportAssignment(stmt)) {
    const resultType = compileExpression(ctx, fctx, stmt.expression);
    const expressionGlobal = ctx.defaultExpressionGlobals?.get(stmt);
    if (resultType !== null && expressionGlobal) {
      if (resultType.kind !== expressionGlobal.type.kind) {
        coerceType(ctx, fctx, resultType, expressionGlobal.type);
      }
      const valueLocalIdx = ctx.mod.globals.indexOf(expressionGlobal.value);
      const initializedLocalIdx = ctx.mod.globals.indexOf(expressionGlobal.initialized);
      if (valueLocalIdx < 0 || initializedLocalIdx < 0) {
        reportErrorNoNode(ctx, "Default-export snapshot cell lost its allocator identity");
        fctx.body.push({ op: "drop" });
        return;
      }
      fctx.body.push({ op: "global.set", index: ctx.numImportGlobals + valueLocalIdx });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "global.set", index: ctx.numImportGlobals + initializedLocalIdx });
    } else if (resultType !== null) {
      fctx.body.push({ op: "drop" });
    }
    return;
  }

  if (ts.isVariableStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileVariableStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isReturnStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileReturnStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isIfStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileIfStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isWhileStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileWhileStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isForStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileForStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isBlock(stmt)) {
    // Save localMap entries for any block-scoped (let/const) names that shadow
    // existing variables.  Wasm locals are flat (no block scope), so we need to
    // restore the outer mapping after the block ends.
    //
    // (#5221) The save/restore pair only ever handled names that ALREADY had a
    // local — a `let`/`const` the block introduces fresh had nothing to save,
    // so its local stayed in `localMap` after the block closed and leaked into
    // the enclosing scope. A later same-named declaration out there then reused
    // the inner slot, INCLUDING ITS WASM TYPE:
    //
    //   if (x === 2) { const n = obj(); … }   // $n : (ref null $Anon)
    //   const n = str();                      // reuses that slot ⇒
    //                                         // ref.test fails ⇒ ref.null ⇒ null
    //
    // which is exactly the Temporal polyfill's `rn()` (`ToTemporalDate`): its
    // `if (isZonedDateTime(e)) { const n = … }` arm poisoned the outer
    // `const n = calendarOf(e)`, so the calendar id read back as `null` and the
    // `%calendarImpl%` lookup that followed dereferenced a null pointer.
    // `discardBlockScopedShadows` drops the block's own new names and then
    // restores any genuine outer shadows — the CaseBlock path has used exactly
    // this for the same reason.
    const blockNames = collectBlockScopedNames(stmt);
    const savedLocals = saveBlockScopedShadowsForNames(fctx, blockNames);
    // (#5271 step 2.3) The block's declarative environment exists before its
    // first statement runs (§13.2.14), so its own `let`/`const` slots must too —
    // otherwise a closure built earlier in the block captures the outer (or
    // same-spelled module-global) binding instead of the block's.
    preallocateBlockScopedSlots(ctx, fctx, stmt.statements);
    for (const s of stmt.statements) {
      compileStatement(ctx, fctx, s);
    }
    discardBlockScopedShadows(fctx, blockNames, savedLocals);
    return;
  }

  if (ts.isExpressionStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileExpressionStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isDoStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileDoWhileStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isSwitchStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileSwitchStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isForOfStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileForOfStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isForInStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileForInStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isLabeledStatement(stmt)) {
    compileLabeledStatement(ctx, fctx, stmt);
    return;
  }

  if (ts.isBreakStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileBreakStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isContinueStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileContinueStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isThrowStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileThrowStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isTryStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileTryStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isWithStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => compileWithStatement(ctx, fctx, stmt));
    return;
  }

  if (ts.isFunctionDeclaration(stmt)) {
    // Skip if already hoisted (pre-compiled in function hoisting pass). A
    // bodyless pre-registration is only a reserved slot; fill it here if the
    // hoist pre-pass did not.
    const funcName = stmt.name?.text;
    // (#2200 Phase 2) Annex B B.3.3 outer-binding init at the textual position.
    // For an *eligible* block-nested `function F`, the hoist pre-pass pre-allocated
    // an outer var-binding (TDZ local + flag). Now that control flow has reached
    // the declaration (inside the block), assign the function value to the outer
    // local and mark the TDZ flag initialised — so a read before/skip of the block
    // sees flag 0 (→ typeof "undefined" / ReferenceError) and a read after sees the
    // value. Emitted BEFORE the funcMap.has early-return (the body was compiled in
    // the hoist pre-pass, so funcMap already has F). Gated on the normally-empty
    // annexBOuterBindings set → non-Annex-B decls untouched.
    if (funcName && fctx.annexBOuterBindings?.has(funcName)) {
      const outerLocal = fctx.localMap.get(funcName);
      const flagLocal = fctx.tdzFlagLocals?.get(funcName);
      const repeatedDeclarations = eligibleAnnexBOuterBindingDeclarations(stmt);
      const repeatedSafe =
        repeatedDeclarations.length > 1 &&
        repeatedDeclarations.every((declaration) => canCompileDistinctAnnexBFunction(ctx, fctx, declaration));
      if (repeatedSafe) {
        if (!fctx.annexBRepeatedOuterBindings) fctx.annexBRepeatedOuterBindings = new Set();
        fctx.annexBRepeatedOuterBindings.add(funcName);
      }
      // (#2552) `funcMap` is keyed by bare name, so the hoist pre-pass keeps
      // only one body for multiple same-named block declarations. Annex B
      // requires EACH declaration to produce its own function object when its
      // statement evaluates: a later block must replace the outer binding with
      // its own body, not store the first block's closure again. Compile this
      // exact declaration when another node currently owns the name. The
      // declaration compiler updates funcMap/owner atomically, and the closure
      // singleton is target-index-aware, so later declarations receive distinct
      // cached wrappers while the single-declaration hot path is unchanged.
      if (ctx.funcMapOwnerDecl.get(funcName) !== stmt && repeatedSafe) {
        compileNestedFunctionDeclaration(ctx, fctx, stmt);
      }
      const fnIdx = ctx.funcMap.get(funcName);
      if (outerLocal !== undefined && flagLocal !== undefined && fnIdx !== undefined) {
        const closureType = emitAnnexBFunctionClosure(ctx, fctx, stmt, funcName, fnIdx);
        if (closureType) {
          // Closure value is on the stack; widen to externref for the outer local.
          if (closureType.kind !== "externref") {
            fctx.body.push({ op: "extern.convert_any" });
          }
          fctx.body.push({ op: "local.set", index: outerLocal });
          emitLocalTdzInit(fctx, funcName);
        }
      }
      // The function body itself was already compiled during the hoist pre-pass;
      // nothing else to emit at this textual position.
      return;
    }
    // (#4182) Module-scope Annex B B.3.3.2: while compiling `__module_init`, a
    // block/`if`/`switch`-nested declaration of a live-bound name compiles as
    // its OWN function and `global.set`s its closure here — the B.3.3.2.c
    // evaluation step. Placed BEFORE the `funcMap.has` early-return, which
    // otherwise silently skips every same-named later declaration. Gated on the
    // normally-empty `annexBModuleBindings` set.
    if (funcName && tryCompileAnnexBModuleBlockFnEvaluation(ctx, fctx, stmt)) {
      return;
    }
    // A direct same-name function declaration already instantiated this
    // binding with its eagerly-hoisted closure. The recursively visited Annex B
    // declaration was deliberately deferred so it could not steal the global
    // name-keyed funcMap slot. Compile the exact safe inner declaration now,
    // store its closure into the initialized live local, then restore every
    // canonical name-keyed record: compile-time branch traversal must not make
    // the inner declaration look like the unconditional owner.
    if (tryCompileAnnexBExistingDirectFunctionUpdate(ctx, fctx, stmt, funcName)) return;
    // (#4131) B.3.3.1 step 3.f on an ALREADY-EXISTING var binding. The branch
    // above covers the case where Annex B CREATES the web-compat binding; when
    // the enclosing var scope already binds the name (`var f = 123` beside a
    // block/`if`/`case`-nested `function f`), no binding is created but the
    // existing one must still be UPDATED with the function object when the
    // declaration is evaluated.
    //
    // Unlike the branch above this must NOT return early: the `if`/`case`
    // declaration positions are not always pre-compiled by the hoist pre-pass, so
    // swallowing the statement here drops the function definition outright (the
    // name then reads as null — measured on the 5 `function-code/if-*` files).
    // The store is therefore emitted AFTER whichever path defines the function.
    const annexBVarUpdate = funcName !== undefined && annexBUpdatesExistingVarBinding(stmt);
    const emitAnnexBVarUpdate = (): void => {
      if (!annexBVarUpdate || funcName === undefined) return;
      const varLocal = fctx.localMap.get(funcName);
      const fnIdx = ctx.funcMap.get(funcName);
      // The externref check is a hard precondition, not an optimisation: the
      // carrier widening in `analysis/mixed-assignment-carrier.ts` is what makes
      // the slot able to hold a closure at all. If it did not happen (a shape
      // that analysis declines), storing here would emit invalid Wasm, so fall
      // through to today's wrong-but-valid behaviour instead.
      if (varLocal === undefined || fnIdx === undefined) return;
      if (getLocalType(fctx, varLocal)?.kind !== "externref") return;
      const closureType = emitAnnexBFunctionClosure(ctx, fctx, stmt, funcName, fnIdx);
      if (!closureType) return;
      if (closureType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "local.set", index: varLocal });
    };
    const hasReservedBodylessEntry = funcName ? (ctx.preRegisteredBodyless?.has(funcName) ?? false) : false;
    if (funcName && ctx.funcMap.has(funcName) && !hasReservedBodylessEntry) {
      emitAnnexBVarUpdate();
      return;
    }
    // Re-attempt compilation even if hoisting failed — the failure may have been
    // due to const/let captures not yet in scope during the hoisting pre-pass.
    // Now that we're in statement order, those locals should be available.
    if (funcName && hasReservedBodylessEntry) {
      const funcIdx = ctx.funcMap.get(funcName);
      const reservedEntry = funcIdx !== undefined ? definedFuncAt(ctx, funcIdx) : undefined;
      compileNestedFunctionDeclaration(ctx, fctx, stmt, reservedEntry ? { reuseReservedEntry: reservedEntry } : {});
      ctx.preRegisteredBodyless?.delete(funcName);
    } else {
      compileNestedFunctionDeclaration(ctx, fctx, stmt);
    }
    emitAnnexBVarUpdate();
    return;
  }

  // ClassDeclaration in statement position (e.g., inside for loops, if blocks,
  // switch cases, labeled statements, try/catch/finally, etc.)
  if (ts.isClassDeclaration(stmt)) {
    // (#4618) A nested class whose name collided with a class in another
    // scope was collected under a per-site synthetic identity (see
    // collectClassesFromStatements). Compile it under that identity and bind
    // the scoped class VALUE to a same-named LOCAL, exactly like
    // `const Foo = class {…}` — locals outrank the name-keyed
    // classObjectGlobals read, so `new Foo()` / `createElement(Foo)` in this
    // scope resolve to THIS declaration, not the first same-named one.
    // (#4646) The collection pass mints that identity only for the scopes it
    // walks — a class in a sibling BLOCK, or in a class/object-literal METHOD
    // body, is never visited, so its name collision survives to here. Mint on
    // demand from the same helper: the check is declaration-node identity, so a
    // class that legitimately owns its name is untouched.
    const scopedSynthetic = ctx.anonClassExprNames.get(stmt) ?? mintScopedClassIdentity(ctx, stmt);
    compileNestedClassDeclaration(ctx, fctx, stmt, scopedSynthetic);
    // Only synthetic nested duplicates need a local singleton binding.  The
    // ordinary class-declaration path intentionally keeps its historical
    // module/class binding: eagerly materialising every class object here
    // changes module-init ordering and can hand the host a half-initialised
    // prototype (the Test262 class-elements cluster exposed this as
    // "Cannot convert undefined or null to object").
    const scopedName = scopedSynthetic;
    if (scopedName !== undefined && stmt.name !== undefined) {
      const bindName = stmt.name.text;
      // Bind the SINGLETON class object (registered with the #4618 host
      // [[Construct]] bridge — parent chain, mirror crossing), not the
      // legacy ctor-value closure, so the scoped class behaves identically
      // to a non-colliding declaration.
      let vt: import("../ir/types.js").ValType | null = null;
      if (emitLazyClassObjectGet(ctx, fctx, scopedName)) {
        vt = { kind: "externref" };
      } else {
        vt = compileClassExpression(ctx, fctx, stmt as unknown as ts.ClassExpression);
      }
      if (vt !== null) {
        if (vt.kind !== "externref") coerceType(ctx, fctx, vt, { kind: "externref" });
        let localIdx = fctx.localMap.get(bindName);
        if (localIdx === undefined) localIdx = allocLocal(fctx, bindName, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    }
    return;
  }

  // Empty statement (`;`) — no-op
  if (stmt.kind === ts.SyntaxKind.EmptyStatement) {
    return;
  }

  // Type-only declarations have no runtime evaluation. They normally disappear
  // in the top-level declaration pass, but can reach this statement compiler
  // from a namespace/module block or another nested statement list.
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
    return;
  }

  // A `const enum` is a type-directed compile-time declaration with no runtime
  // evaluation. Top-level enum declarations are consumed by the declaration
  // collector, but a function-local const enum reaches this dispatcher (the
  // TypeScript compiler's Debug.formatControlFlowGraph declares two). Its
  // member reads are folded through the checker in property-access dispatch;
  // the declaration itself must disappear just as it does in TypeScript emit.
  if (
    ts.isEnumDeclaration(stmt) &&
    stmt.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ConstKeyword) === true
  ) {
    return;
  }

  // `debugger;` — no-op. Per ECMA-262 §13.16, DebuggerStatement evaluation may
  // trigger a breakpoint if an implementation-defined debugging facility is
  // available, and otherwise "has no observable effect". Wasm exposes no such
  // facility, so eliding it is spec-correct rather than a silent drop. The
  // linear backend already treats it this way (src/codegen-linear/index.ts).
  if (stmt.kind === ts.SyntaxKind.DebuggerStatement) {
    return;
  }

  // Class member nodes that can leak into compileStatement when iterating
  // class body or constructor body — treat as no-ops since field initializers
  // are handled separately in compileClassBodies (index.ts).
  if (stmt.kind === ts.SyntaxKind.PropertyDeclaration) {
    // Field declarations (e.g., `x = 5`, `#y: string`) — initializers are
    // compiled in compileClassBodies via struct.set; skip here.
    return;
  }
  if (stmt.kind === ts.SyntaxKind.SemicolonClassElement) {
    // Stray `;` inside class body — no-op.
    return;
  }
  if (stmt.kind === ts.SyntaxKind.ClassStaticBlockDeclaration) {
    // `static { ... }` block — compile the statements inside.
    const staticBlock = stmt as unknown as ts.ClassStaticBlockDeclaration;
    if (staticBlock.body) {
      for (const s of staticBlock.body.statements) {
        compileStatement(ctx, fctx, s);
      }
    }
    return;
  }

  reportError(ctx, stmt, `Unsupported statement: ${ts.SyntaxKind[stmt.kind]}`);
}

// Register compileStatement delegate in shared.ts so index.ts (and any other
// module) can call compileStatement without importing statements.ts directly.
registerCompileStatement(compileStatement);
