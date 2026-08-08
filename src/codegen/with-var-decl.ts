// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4231 RC-A) `var` declarations inside a `with` body.
 *
 * ECMA-262 §14.11.2 puts an Object Environment Record in front of the running
 * execution context's scope chain, and §10.2.11 hoists a `var` declared inside
 * that body to the enclosing FUNCTION environment. The two facts compose into a
 * rule that is easy to get backwards:
 *
 *   with (o) { var value = 'v'; }
 *
 * is `var value;` (hoisted, function-scoped, initialised `undefined`) followed by
 * the ordinary assignment `value = 'v'`, and that assignment resolves through the
 * scope chain — where the object environment is consulted FIRST. So when `o` owns
 * `value`, the store lands on **`o.value`** and the hoisted binding stays
 * `undefined`. Only a LEXICAL declaration (`let`/`const`/class/catch) genuinely
 * shadows the object.
 *
 * `compileVariableStatement` has no idea a `with` scope is open, so it emitted
 * the initializer straight into the hoisted local and the object was never
 * touched. This module is the hook it consults first: when the declared name
 * resolves to an open `with` scope, the initializer is compiled as a
 * with-scoped store (Tier-1 struct field or the Tier-2 HasBinding-gated cascade)
 * and the local store is skipped entirely.
 *
 * Lives in its own module rather than inside `with-scope.ts` because it needs
 * the Tier-2 write emitter from `expressions/assignment.ts`, which itself
 * imports `with-scope.ts` — routing through here keeps that edge acyclic.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { reportError } from "./context/errors.js";
import { compileExpression, coerceType } from "./shared.js";
import { captureDynamicWithHasBindings, compileWithBindingAssignment, resolveWithBinding } from "./with-scope.js";
import { emitDynamicWithIdentifierWrite } from "./expressions/assignment.js";

/**
 * If `decl` is a `var` whose name resolves to an open `with` scope, emit its
 * initializer as a with-scoped store and return `true` (the caller must skip its
 * own local store). Returns `false` for every other declaration — lexical
 * declarations, names no `with` scope binds, and bodies with no `with` open —
 * so the ordinary path is byte-identical outside a `with`.
 *
 * A `var` with NO initializer is a pure hoist: it stores nothing anywhere, so it
 * also returns `true` (nothing to emit) and must not fall through to a local
 * store that would clobber the hoisted `undefined`.
 */
export function tryCompileWithScopedVarDeclaration(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.VariableStatement,
  decl: ts.VariableDeclaration,
): boolean {
  if (!fctx.withScopes || fctx.withScopes.length === 0) return false;
  if (!ts.isIdentifier(decl.name)) return false;
  // Lexical declarations DO shadow the object environment record — leave them to
  // the ordinary local path (and to `blockedNames`, which already excludes them
  // from `with` resolution).
  const lexicalFlags = ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing;
  if ((stmt.declarationList.flags & lexicalFlags) !== 0) return false;

  const name = decl.name.text;
  const res = resolveWithBinding(fctx, name);
  if (!res) return false;

  if (!decl.initializer) return true; // pure hoist — nothing is stored

  if (res.kind === "static") {
    const stored = compileWithBindingAssignment(ctx, fctx, res.binding, decl.initializer);
    // The assignment form leaves its value on the stack; a declaration is a
    // statement, so drop it.
    if (stored) fctx.body.push({ op: "drop" });
    return true;
  }

  // Tier-2: §13.15.2 ordering — resolve the LHS Reference (capture HasBinding for
  // every candidate scope) BEFORE evaluating the RHS, then cascade-write once.
  const captures = captureDynamicWithHasBindings(ctx, fctx, name);
  const rhsType = compileExpression(ctx, fctx, decl.initializer, { kind: "externref" });
  if (!rhsType) {
    reportError(ctx, decl, "Failed to compile with-scoped var initializer");
    return true;
  }
  if (rhsType.kind !== "externref") coerceType(ctx, fctx, rhsType, { kind: "externref" });
  const rhsTmp = allocLocal(fctx, `__with_var_rhs_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: rhsTmp });
  emitDynamicWithIdentifierWrite(ctx, fctx, decl.name, rhsTmp, captures);
  return true;
}
