// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * ES5 §15.3.5.4 `caller` poison support.
 *
 * A non-strict function may expose its active caller, but the legacy `caller`
 * getter must throw when that caller is strict.  The compiler therefore
 * threads one source-strictness bit across JavaScript-function calls:
 *
 *   caller:  i32.const <own strictness>; global.set $__caller_strict; call …
 *   callee:  global.get $__caller_strict; local.set $__caller_strict_at_entry
 *
 * The callee snapshots the bit in an activation-local before executing user
 * code.  Nested calls can overwrite the module global without corrupting an
 * outer activation, and exceptions need no restore path.  Native/runtime
 * helper calls are not instrumented; only source-function direct calls and
 * `call_ref`/`return_call_ref` emitted from source-function bodies carry the
 * marker.
 *
 * This module deliberately supplies only the call-context substrate.  Property
 * access decides whether the receiver is the current source function and
 * applies the poison there; strict function objects are poisoned independently
 * of call context.
 */

import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";
import { isStrictFunction } from "./helpers/is-strict-function.js";
import { ts } from "../ts-api.js";
import { walkChildren } from "./walk-instructions.js";
import { definedFuncHandleOf } from "./func-space.js";

function stripTransparent(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Resolve the source function denoted by a statically-known function value. */
export function sourceFunctionForValue(
  ctx: CodegenContext,
  expression: ts.Expression,
): ts.FunctionLikeDeclaration | undefined {
  const expr = stripTransparent(expression);
  if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) return expr;
  if (!ts.isIdentifier(expr)) return undefined;
  const declaration = ctx.oracle.valueDeclarationOf(expr);
  if (!declaration) return undefined;
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isSetAccessorDeclaration(declaration)
  ) {
    return declaration;
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const initializer = stripTransparent(declaration.initializer);
    if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) return initializer;
  }
  return undefined;
}

/** True when a function-valued expression denotes the currently executing source function. */
export function isCurrentSourceFunctionValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: ts.Expression,
): boolean {
  const source = sourceFunctionForValue(ctx, expression);
  return source !== undefined && source === fctx.sourceFunction;
}

/** Lazily create the source-call strictness hand-off global. */
export function ensureCallerStrictGlobal(ctx: CodegenContext): number {
  if (ctx.callerStrictGlobalIdx >= 0) return ctx.callerStrictGlobalIdx;
  const globalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__caller_strict",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.callerStrictGlobalIdx = globalIdx;
  return globalIdx;
}

/** Register the source function represented by a FunctionContext. */
export function initializeFunctionPoisonPillContext(
  ctx: CodegenContext,
  fctx: FunctionContext,
  sourceFunction: ts.FunctionLikeDeclaration,
): void {
  const strict = isStrictFunction(sourceFunction, ctx.inferModuleStrictArguments);
  fctx.sourceFunction = sourceFunction;
  fctx.sourceFunctionStrict = strict;
  fctx.callerStrictEntryBody = fctx.body;
  ctx.sourceFunctionStrictness.set(fctx.name, strict);
  ctx.sourceFunctionStrictnessByBody.set(fctx.body, strict);
}

/**
 * Lazily add the immediate-caller snapshot to a function that actually reads
 * its own legacy `caller` property.  Keeping this lazy avoids changing every
 * generated source function (and every call site) in programs that never
 * observe Function caller state.
 */
export function ensureCallerStrictSnapshot(ctx: CodegenContext, fctx: FunctionContext): number {
  if (fctx.callerStrictLocalIdx !== undefined) return fctx.callerStrictLocalIdx;
  const globalIdx = ensureCallerStrictGlobal(ctx);
  const localIdx = allocLocal(fctx, "__caller_strict_at_entry", { kind: "i32" });
  fctx.callerStrictLocalIdx = localIdx;
  (fctx.callerStrictEntryBody ?? fctx.body).unshift(
    { op: "global.get", index: globalIdx },
    { op: "local.set", index: localIdx },
  );
  return localIdx;
}

/**
 * Insert the caller strictness hand-off immediately before source-function
 * calls.  This runs after function-index finalization and before stack balance.
 */
export function finalizeFunctionPoisonPillCalls(ctx: CodegenContext): void {
  if (ctx.functionPoisonPillCallsFinalized) return;
  ctx.functionPoisonPillCallsFinalized = true;
  if (ctx.callerStrictGlobalIdx < 0 || ctx.sourceFunctionStrictness.size === 0) return;

  const sourceFunctions = new Map<(typeof ctx.mod.functions)[number], boolean>();
  const sourceFuncIdxs = new Set<number>();
  for (const fn of ctx.mod.functions) {
    const strict = ctx.sourceFunctionStrictnessByBody.get(fn.body) ?? ctx.sourceFunctionStrictness.get(fn.name);
    if (strict === undefined) continue;
    sourceFunctions.set(fn, strict);
    const handle = definedFuncHandleOf(ctx, fn);
    if (handle !== undefined) sourceFuncIdxs.add(handle);
    const registeredHandle = ctx.funcMap.get(fn.name);
    if (registeredHandle !== undefined) sourceFuncIdxs.add(registeredHandle);
  }

  const marker = (strict: boolean): Instr[] => [
    { op: "i32.const", value: strict ? 1 : 0 },
    { op: "global.set", index: ctx.callerStrictGlobalIdx },
  ];

  const instrument = (body: Instr[], strict: boolean): void => {
    const stack: Instr[][] = [body];
    const seen = new Set<Instr[]>();
    while (stack.length > 0) {
      const instrs = stack.pop()!;
      if (seen.has(instrs)) continue;
      seen.add(instrs);
      for (let i = 0; i < instrs.length; i++) {
        const instr = instrs[i]!;
        const directSourceCall =
          (instr.op === "call" || instr.op === "return_call") && sourceFuncIdxs.has(instr.funcIdx);
        const dynamicSourceCall = instr.op === "call_ref" || instr.op === "return_call_ref";
        if (directSourceCall || dynamicSourceCall) {
          const prefix = marker(strict);
          instrs.splice(i, 0, ...prefix);
          i += prefix.length;
        }
        walkChildren(instr, (child) => stack.push(child));
      }
    }
  };

  for (const fn of ctx.mod.functions) {
    const strict = sourceFunctions.get(fn);
    if (strict !== undefined) instrument(fn.body, strict);
  }
}
