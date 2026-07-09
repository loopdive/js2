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
import { emitCachedFuncClosureAccess } from "./closures.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { attachSourcePos, getSourcePos } from "./context/source-pos.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression, registerCompileStatement } from "./shared.js";
import { restoreBlockScopedShadows, saveBlockScopedShadows } from "./statements/shared.js";
import { compileWithStatement } from "./with-scope.js";

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
import { compileNestedClassDeclaration, compileNestedFunctionDeclaration } from "./statements/nested-declarations.js";
import { compileVariableStatement } from "./statements/variables.js";
import { definedFuncAt } from "./func-space.js"; // (#1916 S2) positional-read chokepoint

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
export { emitTdzCheck } from "./statements/tdz.js";

// ---------------------------------------------------------------------------
// Dispatcher helpers
// ---------------------------------------------------------------------------

/**
 * Mark the first instruction emitted for a statement with its source position.
 */
function markStatementPos(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement, compile: () => void): void {
  const pos = getSourcePos(ctx, stmt);
  const bodyLenBefore = fctx.body.length;
  compile();
  if (pos && fctx.body.length > bodyLenBefore) {
    attachSourcePos(fctx.body[bodyLenBefore]!, pos);
  }
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
  // Evaluate the expression (for side effects) but discard the result.
  if (ts.isExportAssignment(stmt)) {
    const resultType = compileExpression(ctx, fctx, stmt.expression);
    if (resultType !== null) {
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
    const savedLocals = saveBlockScopedShadows(fctx, stmt);
    for (const s of stmt.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedLocals);
    return;
  }

  if (ts.isExpressionStatement(stmt)) {
    markStatementPos(ctx, fctx, stmt, () => {
      const resultType = compileExpression(ctx, fctx, stmt.expression);
      // Drop the result if the expression left something on the stack
      if (resultType !== null) {
        fctx.body.push({ op: "drop" });
      }
    });
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
    // (#3049) Loop-exit re-sync for persistent callback writebacks. A lazy
    // host iterator (e.g. `Iterator.prototype.map.call(iter, fn)`) invokes
    // its registered callback DURING the for-of stepping, which is emitted
    // by statement codegen — not through compileCallExpression, where the
    // persistent writebacks normally re-emit. Without this, a captured-
    // mutable counter (`++mapperCalls`) written inside the callback stays
    // stale in the outer local after the loop.
    if (fctx.persistentCallbackWritebacks && fctx.persistentCallbackWritebacks.length > 0) {
      fctx.body.push(...fctx.persistentCallbackWritebacks.map((instr) => structuredClone(instr)));
    }
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
      const fnIdx = ctx.funcMap.get(funcName);
      if (outerLocal !== undefined && flagLocal !== undefined && fnIdx !== undefined) {
        const closureType = emitCachedFuncClosureAccess(ctx, fctx, funcName, fnIdx);
        if (closureType) {
          // Closure value is on the stack; widen to externref for the outer local.
          if (closureType.kind !== "externref") {
            fctx.body.push({ op: "extern.convert_any" });
          }
          fctx.body.push({ op: "local.set", index: outerLocal });
          fctx.body.push({ op: "i32.const", value: 1 });
          fctx.body.push({ op: "local.set", index: flagLocal });
        }
      }
      // The function body itself was already compiled during the hoist pre-pass;
      // nothing else to emit at this textual position.
      return;
    }
    const hasReservedBodylessEntry = funcName ? (ctx.preRegisteredBodyless?.has(funcName) ?? false) : false;
    if (funcName && ctx.funcMap.has(funcName) && !hasReservedBodylessEntry) return;
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
    return;
  }

  // ClassDeclaration in statement position (e.g., inside for loops, if blocks,
  // switch cases, labeled statements, try/catch/finally, etc.)
  if (ts.isClassDeclaration(stmt)) {
    compileNestedClassDeclaration(ctx, fctx, stmt);
    return;
  }

  // Empty statement (`;`) — no-op
  if (stmt.kind === ts.SyntaxKind.EmptyStatement) {
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
