// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2623 Slice B) Promise-subclass identity unification.
 *
 * A Wasm-compiled `class MyPromise extends Promise` is externref-backed
 * (#1366a/b): its instances are real host Promises (built via `__new_Promise`),
 * and it has **no** `__class_<Name>` class-object singleton global (skipped in
 * `class-bodies.ts` for builtin-parent classes — there is no `$ClassName`
 * WasmGC struct to anchor). Two distinct code paths previously materialized a
 * `class extends Promise` constructor:
 *
 *   1. The combinator capability path (`Promise.all.call(Sub, …)`) — routes the
 *      `thisArg` receiver through the `__promise_subclass_ctor` host import
 *      (`resolvePromiseSubclassThisArg`), which synthesizes and CACHES one real
 *      JS `class extends Promise {}` per class name. V8's NewPromiseCapability
 *      then builds the instance from THAT constructor, so the resulting
 *      promise's `.constructor` / `[[Prototype]]` point at the synthesized ctor.
 *
 *   2. The bare identifier read-as-value (`Sub` on the RHS of `=== Sub`,
 *      `instanceof Sub`, `Promise.try.call(Sub, …)`, etc.) — fell through to the
 *      `ref.null.extern` graceful-default in `identifiers.ts`, yielding `null`.
 *
 * Result: the constructor the user OBSERVES (path 2 → null/opaque) was a
 * DIFFERENT object than the one used to BUILD the subclassed promise (path 1 →
 * synthesized cached ctor), so `instance.constructor === Sub` and
 * `instance instanceof Sub` were always false (test262
 * `Promise/{all,race,allSettled,any}/ctx-ctor.js` assert #1/#2,
 * `Promise/try/{promise,ctx-ctor}.js`).
 *
 * The fix unifies the two paths onto the SAME cached `__promise_subclass_ctor`
 * singleton: the value-read now emits the same host-synthesized ctor the
 * capability path uses, so there is exactly one object per `class extends
 * Promise` name. Both helpers below share one detection + emission core so the
 * value position and the receiver position can never diverge again.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitClassExpressionStaticsBeforeValue } from "../class-expression-static-init.js";
import { emitLazyClassObjectGet } from "./extern.js";
import { markPromiseSubclassValueRead } from "../standalone-class-construct.js"; // (#6651 D4)

/**
 * Returns the resolved class name if `name` (a user-visible identifier or
 * class-expression alias) denotes a `class … extends Promise` (transitively,
 * through a chain of user subclasses), else `undefined`.
 *
 * Walks the parent chain because `classBuiltinParentMap` only records the
 * *immediate* builtin parent: for `class B extends A` / `class A extends
 * Promise`, B maps to "A", not "Promise". `classParentMap` carries the
 * user-class edges, so we climb until we hit a builtin Promise parent.
 *
 * Recognition is target-independent. Whether a target may materialize the
 * legacy host constructor is a separate decision made by the emit helpers
 * below. Keeping those concerns separate is important: native-first dispatch
 * still needs to know that `P.resolve` names an inherited Promise static, even
 * though it must never synthesize `P` through `__promise_subclass_ctor`.
 */
export function resolvePromiseSubclassName(ctx: CodegenContext, name: string): string | undefined {
  const resolved = ctx.classExprNameMap.get(name) ?? name;
  let cursor: string | undefined = resolved;
  const seen = new Set<string>();
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    if (ctx.classBuiltinParentMap.get(cursor) === "Promise") return resolved;
    cursor = ctx.classParentMap.get(cursor);
  }
  return undefined;
}

/**
 * (#5197 r3) The Promise-subclass class a receiver TYPE denotes: through its symbol name,
 * its apparent type's, or — for an ANONYMOUS `class extends Promise` instance
 * (`new class extends Promise {…}(fn)`, whose symbol is the display name `__class`) —
 * the class expression's synthetic name.
 */
export function promiseSubclassNameOfType(
  ctx: CodegenContext,
  type: ts.Type,
  apparent: ts.Type | undefined,
): string | undefined {
  const decl = type.getSymbol()?.valueDeclaration;
  const anon = decl && ts.isClassExpression(decl) ? ctx.anonClassExprNames.get(decl) : undefined;
  for (const name of [type.getSymbol()?.name, apparent?.getSymbol()?.name, anon]) {
    const resolved = name === undefined ? undefined : resolvePromiseSubclassName(ctx, name);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** Whether a variable statement binds a Promise-subclass class expression. */
export function variableStatementContainsPromiseSubclass(
  ctx: CodegenContext,
  statement: ts.VariableStatement,
): boolean {
  return statement.declarationList.declarations.some((declaration) => {
    if (declaration.initializer === undefined || !ts.isClassExpression(declaration.initializer)) return false;
    const syntheticName = ctx.anonClassExprNames.get(declaration.initializer);
    return syntheticName !== undefined && resolvePromiseSubclassName(ctx, syntheticName) !== undefined;
  });
}

/** Compile a class-expression binding, preserving Promise and class-object values. */
export function tryCompileClassExpressionBindingValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  initializer: ts.Expression,
  valueType: ValType,
): ValType | undefined {
  if (!ts.isClassExpression(initializer)) return undefined;
  const syntheticName = ctx.anonClassExprNames.get(initializer);
  if (
    syntheticName === undefined ||
    !ctx.classObjectGlobals?.has(syntheticName) ||
    !emitLazyClassObjectGet(ctx, fctx, syntheticName)
  )
    return undefined;
  return emitClassExpressionStaticsBeforeValue(ctx, fctx, initializer, valueType);
}

/** Resolve a Promise-subclass identifier by its lexical declaration identity. */
export function resolvePromiseSubclassIdentifier(ctx: CodegenContext, id: ts.Identifier): string | undefined {
  const declaration = ctx.oracle.valueDeclarationOf(id);
  if (declaration !== undefined) {
    if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
      const identity =
        ctx.anonClassExprNames.get(declaration) ??
        (declaration.name?.text ? (ctx.classExprNameMap.get(declaration.name.text) ?? declaration.name.text) : id.text);
      return resolvePromiseSubclassName(ctx, identity);
    }
    if (ts.isVariableDeclaration(declaration)) {
      let initializer = declaration.initializer;
      while (initializer !== undefined && ts.isParenthesizedExpression(initializer))
        initializer = initializer.expression;
      if (initializer !== undefined && ts.isClassExpression(initializer)) {
        const identity = ctx.anonClassExprNames.get(initializer) ?? ctx.classExprNameMap.get(id.text) ?? id.text;
        return resolvePromiseSubclassName(ctx, identity);
      }
    }
    return undefined;
  }
  return resolvePromiseSubclassName(ctx, id.text);
}

/**
 * A Promise-subclass identifier read as a VALUE. With a JS host this is the
 * cached host constructor ({@link emitPromiseSubclassCtor}). Without one
 * (#6651 D4) nothing is emitted here — the caller falls through to the class's
 * own class-object singleton — and the module is recorded so the native
 * construct dispatcher admits the class (NewPromiseCapability(C) constructs it).
 */
export function emitPromiseSubclassValueRead(ctx: CodegenContext, fctx: FunctionContext, resolved: string): boolean {
  markPromiseSubclassValueRead(ctx);
  return false;
}
