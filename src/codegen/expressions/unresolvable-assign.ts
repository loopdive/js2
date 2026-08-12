// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * §6.2.5.6 `PutValue` for an identifier whose Reference the compiler could not
 * resolve statically — both the sloppy arm (create/update a property on the
 * realm's global object) and the strict arm (throw `ReferenceError`).
 *
 * Extracted from `assignment.ts` (#3985). The two arms are one decision, not
 * two: they share the unresolvability predicate and the global-environment
 * carrier, and having only the sloppy half implemented is exactly how the
 * strict half went missing for so long — strict code fell off the end of
 * `compileAssignment` into a catch-all that allocated a Wasm local, producing
 * valid Wasm with the wrong semantics and no diagnostic anywhere.
 */
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  emitCaptureRuntimeEvalBindingValueCell,
  emitCaptureGlobalEnvironmentHasBinding,
  emitGlobalEnvironmentKey,
  emitGlobalEnvironmentObject,
  emitRefreshRuntimeEvalBindingValueCellForWrite,
  emitRuntimeEvalBindingCellWrite,
  emitStrictUnresolvableGlobalWrite,
  ensureGlobalEnvironmentOperation,
} from "../global-environment.js";
import { runtimeEvalStateMayShadowBinding } from "../direct-eval-environment.js";
import { popBody, pushBody } from "../context/bodies.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
import { coerceType } from "../type-coercion.js";
import { compileExpression } from "../expressions.js";
import { emitRuntimeEvalAotCallableAdapter } from "../runtime-eval-callable.js";
import { skipTransparentExpressions } from "../shared.js";

/**
 * Returned when the assignment is NOT an unresolvable-identifier assignment, so
 * the caller must keep going through its remaining arms. Distinct from `null`,
 * which means "claimed, and compilation failed".
 */
export const NOT_UNRESOLVABLE = Symbol("not-unresolvable");

/** Conservative proof for values that need the cross-module callable carrier
 * when they are stored in an eval-created activation cell. */
function isStaticallyCallableExpression(ctx: CodegenContext, value: ts.Expression): boolean {
  const expr = skipTransparentExpressions(value);
  if (
    ts.isFunctionExpression(expr) ||
    ts.isArrowFunction(expr) ||
    (ts.isIdentifier(expr) && (ctx.funcMap.has(expr.text) || ctx.topLevelFunctionNames.has(expr.text)))
  ) {
    return true;
  }
  return ctx.oracle.signatureOf(expr) !== undefined;
}

/**
 * True if `id` is an identifier that cannot be resolved to any binding the
 * compiler knows about. Mirrors the check in identifiers.ts:393 for reads
 * but also excludes bindings that only exist in the codegen (locals, captures,
 * globals, func imports).
 */
export function isUnresolvableIdent(ctx: CodegenContext, fctx: FunctionContext, id: ts.Identifier): boolean {
  const name = id.text;
  if (fctx.localMap.has(name)) return false;
  if (fctx.boxedCaptures?.has(name)) return false;
  if (ctx.capturedGlobals.has(name)) return false;
  if (ctx.moduleGlobals.has(name)) return false;
  if (ctx.funcMap.has(name)) return false;
  // For shorthand property assignments `{x}` the checker returns the synthetic
  // property symbol (SymbolFlags.Property = 4) even when `x` has no value
  // binding in scope. The real value lookup is via getShorthandAssignmentValueSymbol.
  if (id.parent && ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
    const valSym = (
      ctx.checker as unknown as {
        getShorthandAssignmentValueSymbol?: (n: ts.Node) => ts.Symbol | undefined;
      }
    ).getShorthandAssignmentValueSymbol?.(id.parent);
    return !valSym;
  }
  const sym = ctx.checker.getSymbolAtLocation(id);
  if (!sym) return true;
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return true;
  for (const d of decls) {
    if (d !== id) return false;
  }
  return true;
}

export function findUnresolvableInObjectPattern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ObjectLiteralExpression,
): boolean {
  for (const prop of target.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (isUnresolvableIdent(ctx, fctx, prop.name)) return true;
    } else if (ts.isPropertyAssignment(prop)) {
      let targetExpr = prop.initializer;
      if (ts.isBinaryExpression(targetExpr) && targetExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        targetExpr = targetExpr.left;
      }
      if (ts.isIdentifier(targetExpr) && isUnresolvableIdent(ctx, fctx, targetExpr)) return true;
      if (ts.isObjectLiteralExpression(targetExpr) && findUnresolvableInObjectPattern(ctx, fctx, targetExpr))
        return true;
      if (ts.isArrayLiteralExpression(targetExpr) && findUnresolvableInArrayPattern(ctx, fctx, targetExpr)) return true;
    } else if (ts.isSpreadAssignment(prop)) {
      if (ts.isIdentifier(prop.expression) && isUnresolvableIdent(ctx, fctx, prop.expression)) return true;
    }
  }
  return false;
}

export function findUnresolvableInArrayPattern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
): boolean {
  for (const element of target.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element) && isUnresolvableIdent(ctx, fctx, element)) return true;
    if (
      ts.isSpreadElement(element) &&
      ts.isIdentifier(element.expression) &&
      isUnresolvableIdent(ctx, fctx, element.expression)
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(element) &&
      element.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(element.left) &&
      isUnresolvableIdent(ctx, fctx, element.left)
    ) {
      return true;
    }
    if (ts.isArrayLiteralExpression(element) && findUnresolvableInArrayPattern(ctx, fctx, element)) return true;
    if (ts.isObjectLiteralExpression(element) && findUnresolvableInObjectPattern(ctx, fctx, element)) return true;
  }
  return false;
}

/**
 * Compile `<ident> = <rhs>` when `<ident>` is an unresolvable Reference, per
 * §6.2.5.6 PutValue step 6.
 *
 * Returns {@link NOT_UNRESOLVABLE} when this is not that shape, so the caller
 * falls through to its remaining arms.
 */
export function tryCompileUnresolvableIdentifierAssign(
  ctx: CodegenContext,
  fctx: FunctionContext,
  left: ts.Identifier,
  right: ts.Expression,
): ValType | null | typeof NOT_UNRESOLVABLE {
  if (!isUnresolvableIdent(ctx, fctx, left)) return NOT_UNRESOLVABLE;
  const name = left.text;
  const strict = isStrictContext(left, ctx.inferModuleStrictArguments);

  // Resolve the provider-created activation binding BEFORE the RHS. The
  // captured value cell is a stable Reference: an RHS that performs another
  // eval cannot retroactively change whether this assignment targeted the
  // existing eval var or the realm global. The miss arm preserves the exact
  // sloppy/strict global behavior below.
  if (runtimeEvalStateMayShadowBinding(ctx, fctx, name)) {
    const runtimeBinding = emitCaptureRuntimeEvalBindingValueCell(ctx, fctx, name);
    if (runtimeBinding) {
      let globalObjectLocal: number | undefined;
      let globalHasBinding: { objLocalIdx: number; hasLocalIdx: number } | undefined;
      let globalSetIdx: number | undefined;
      if (strict) {
        globalHasBinding = emitCaptureGlobalEnvironmentHasBinding(ctx, fctx, name);
        if (!globalHasBinding) return NOT_UNRESOLVABLE;
      } else {
        if (!emitGlobalEnvironmentObject(ctx, fctx)) return null;
        globalObjectLocal = allocLocal(fctx, `__runtime_eval_global_obj_${fctx.locals.length}`, {
          kind: "externref",
        });
        fctx.body.push({ op: "local.set", index: globalObjectLocal });
        globalSetIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_set");
        if (globalSetIdx === undefined) return null;
        (ctx.sloppyImplicitGlobals ??= new Set()).add(name);
      }

      const resultType = compileExpression(ctx, fctx, right);
      if (!resultType) return null;
      const resultLocal = allocLocal(fctx, `__runtime_eval_assign_result_${fctx.locals.length}`, resultType);
      fctx.body.push({ op: "local.set", index: resultLocal }, { op: "local.get", index: resultLocal });
      if (resultType.kind !== "externref") coerceType(ctx, fctx, resultType, { kind: "externref" });
      const valueLocal = allocLocal(fctx, `__runtime_eval_assign_value_${fctx.locals.length}`, {
        kind: "externref",
      });
      fctx.body.push({ op: "local.set", index: valueLocal });

      const savedPresent = pushBody(fctx);
      let cellValueLocal = valueLocal;
      if (isStaticallyCallableExpression(ctx, right)) {
        fctx.body.push({ op: "local.get", index: valueLocal });
        emitRuntimeEvalAotCallableAdapter(ctx, fctx);
        cellValueLocal = allocLocal(fctx, `__runtime_eval_assign_cell_value_${fctx.locals.length}`, {
          kind: "externref",
        });
        fctx.body.push({ op: "local.set", index: cellValueLocal });
      }
      const refreshedBinding = emitRefreshRuntimeEvalBindingValueCellForWrite(ctx, fctx, name, runtimeBinding);
      emitRuntimeEvalBindingCellWrite(fctx, refreshedBinding ?? runtimeBinding, cellValueLocal);
      const presentBody = fctx.body;
      popBody(fctx, savedPresent);

      const savedMiss = pushBody(fctx);
      if (strict) {
        emitStrictUnresolvableGlobalWrite(
          ctx,
          fctx,
          name,
          globalHasBinding!.objLocalIdx,
          globalHasBinding!.hasLocalIdx,
          valueLocal,
        );
      } else {
        fctx.body.push({ op: "local.get", index: globalObjectLocal! });
        emitGlobalEnvironmentKey(ctx, fctx, name);
        fctx.body.push(
          { op: "local.get", index: valueLocal },
          { op: "call", funcIdx: ctx.funcMap.get("__extern_set") ?? globalSetIdx! },
        );
      }
      const missBody = fctx.body;
      popBody(fctx, savedMiss);

      fctx.body.push(
        { op: "local.get", index: runtimeBinding.valueCellLocal },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: presentBody, else: missBody },
        { op: "local.get", index: resultLocal },
      );
      return resultType;
    }
  }

  // ── Sloppy arm: create/update a configurable property on the realm's global
  // object. Host and host-free targets share the same carrier (#2726).
  if (!strict) {
    (ctx.sloppyImplicitGlobals ??= new Set()).add(name);
    const resultType = compileExpression(ctx, fctx, right);
    if (!resultType) return null;
    const resultTmp = allocLocal(fctx, `__implicit_global_rhs_${fctx.locals.length}`, resultType);
    fctx.body.push({ op: "local.set", index: resultTmp });

    if (!emitGlobalEnvironmentObject(ctx, fctx)) return null;
    emitGlobalEnvironmentKey(ctx, fctx, name);
    fctx.body.push({ op: "local.get", index: resultTmp });
    if (resultType.kind !== "externref") {
      coerceType(ctx, fctx, resultType, { kind: "externref" });
    }
    const setIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_set");
    if (setIdx === undefined) return null;
    fctx.body.push({ op: "call", funcIdx: setIdx });
    fctx.body.push({ op: "local.get", index: resultTmp });
    return resultType;
  }

  // ── Strict arm (#3985): the same Reference is unresolvable, but strict code
  // must throw ReferenceError instead of creating a global-object property.
  //
  // The throw is RUNTIME-CONDITIONAL, not static. `isUnresolvableIdent` is a
  // compiler-knowledge predicate, not the spec one: a name absent from the
  // TypeScript program can still be a property of the global object at run time
  // (another concatenated script's `var`, a host-installed global), in which
  // case §9.1.1.4.1 HasBinding is true, the Reference resolves, and the
  // assignment must SUCCEED. So we gate on the runtime HasBinding.
  //
  // §13.15.2 step 1.a: resolve the LHS Reference BEFORE evaluating the RHS.
  const captured = emitCaptureGlobalEnvironmentHasBinding(ctx, fctx, name);
  // Global environment unavailable — let the caller's fallback take it.
  if (!captured) return NOT_UNRESOLVABLE;

  // §13.15.2 step 1.e: the RHS is evaluated (side effects observable) before
  // PutValue throws in step 1.f.
  const resultType = compileExpression(ctx, fctx, right);
  if (!resultType) return null;
  if (resultType.kind !== "externref") {
    coerceType(ctx, fctx, resultType, { kind: "externref" });
  }
  const valueTmp = allocLocal(fctx, `__strict_unresolvable_rhs_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valueTmp });
  // When the set operation could not be registered the RHS is already consumed
  // into `valueTmp`; completing the expression with it keeps the stack balanced
  // and degrades to the pre-#3985 shape rather than desyncing.
  emitStrictUnresolvableGlobalWrite(ctx, fctx, name, captured.objLocalIdx, captured.hasLocalIdx, valueTmp);
  // Assignment expression result: the assigned value (§13.15.2 step 1.g).
  fctx.body.push({ op: "local.get", index: valueTmp });
  return { kind: "externref" };
}
