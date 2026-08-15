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

/**
 * (#4221) True when the expression statically denotes a BOUND function — the
 * result of `f.bind(...)`, directly or through a `var b = f.bind(...)` binding.
 *
 * ES5 §15.3.4.5 steps 20-21 install `[[ThrowTypeError]]` as BOTH the getter and
 * the setter of a bound function's `caller` and `arguments` — unconditionally,
 * regardless of the target's strictness. `sourceFunctionForValue` cannot see
 * that: a bound function has no source declaration, so the poison lowering
 * declined and `obj.caller` answered `undefined` / `obj.arguments = 12` silently
 * succeeded (`built-ins/Function/prototype/bind/15.3.4.5-2{0,1}-{2,3}`,
 * `S15.3.4.5_A1`/`_A2`).
 *
 * Recognition is purely syntactic (a `.bind` member call, or a variable whose
 * initializer is one) so it can never fire on a value that merely *looks*
 * function-shaped to the checker.
 */
export function isBoundFunctionValue(ctx: CodegenContext, expression: ts.Expression, depth = 0): boolean {
  if (depth > 4) return false;
  const expr = stripTransparent(expression);
  if (ts.isCallExpression(expr)) {
    const callee = stripTransparent(expr.expression);
    return ts.isPropertyAccessExpression(callee) && callee.name.text === "bind";
  }
  if (!ts.isIdentifier(expr)) return false;
  const initializer = ctx.oracle.variableInitializerOf(expr);
  if (initializer === undefined) return false;
  return isBoundFunctionValue(ctx, initializer, depth + 1);
}

/**
 * (#4464) True when `source` — the BODY argument handed to the `Function`
 * constructor — carries a `"use strict"` Directive Prologue.
 *
 * §14.1.1 restricts the prologue to the leading run of ExpressionStatements
 * that are string literals, so only the FIRST such statement can be
 * `use strict` for our purposes: a directive after any other statement is an
 * ordinary expression and does not switch the code to strict mode. Recognition
 * is therefore deliberately anchored at the start of the source, after leading
 * whitespace and comments; anything else DECLINES, because the caller turns a
 * `true` here into an unconditional TypeError throw and a false positive would
 * poison a sloppy function.
 */
function functionConstructorBodyIsStrict(source: string): boolean {
  let i = 0;
  // Skip leading whitespace and comments (a prologue may be preceded by both).
  for (;;) {
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      if (end < 0) return false;
      i = end + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    break;
  }
  return source.startsWith("'use strict'", i) || source.startsWith('"use strict"', i);
}

/**
 * (#4464) True when the expression statically denotes a STRICT function minted
 * by the `Function` constructor — `Function("'use strict';")` /
 * `new Function("'use strict';")`, directly or through a variable binding
 * (`var foo = Function("'use strict';"); foo.caller`).
 *
 * ES5 §13.2 step 19-20 installs the `[[ThrowTypeError]]` poison accessors on a
 * strict function's `caller`/`arguments` no matter HOW that function was
 * created, but {@link sourceFunctionForValue} can only see functions that have
 * a source declaration in this program. A `Function(…)` result has none — its
 * body is a runtime string — so the poison lowering declined and
 * `foo.caller` answered `undefined` (`language/statements/function/13.2-{5,6,
 * 9,10,13,14,17,18}-s`).
 *
 * The strictness question is nevertheless decidable HERE whenever the body
 * argument is a literal: the directive prologue is a syntactic property of that
 * string. Recognition is purely syntactic (`Function` must resolve to the
 * ambient global — a user `function Function(){}` shadow declines) and the
 * literal requirement is absolute: a computed body means we cannot know, and
 * an unknown strictness must DECLINE rather than throw.
 */
export function isStrictFunctionConstructorValue(ctx: CodegenContext, expression: ts.Expression, depth = 0): boolean {
  if (depth > 4) return false;
  const expr = stripTransparent(expression);
  if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
    const callee = stripTransparent(expr.expression);
    if (!ts.isIdentifier(callee) || callee.text !== "Function") return false;
    // A user-declared `Function` shadows the global — decline.
    const declaration = ctx.oracle.valueDeclarationOf(callee);
    if (declaration !== undefined && !declaration.getSourceFile().isDeclarationFile) return false;
    const args = expr.arguments;
    if (args === undefined || args.length === 0) return false;
    const body = stripTransparent(args[args.length - 1]!);
    if (!ts.isStringLiteral(body) && !ts.isNoSubstitutionTemplateLiteral(body)) return false;
    return functionConstructorBodyIsStrict(body.text);
  }
  if (!ts.isIdentifier(expr)) return false;
  const initializer = ctx.oracle.variableInitializerOf(expr);
  if (initializer === undefined) return false;
  return isStrictFunctionConstructorValue(ctx, initializer, depth + 1);
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
  fctx.activationEntryBody = fctx.body;
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
    const stack: { body: Instr[]; strict: boolean }[] = [{ body, strict }];
    const seen = new Set<Instr[]>();
    while (stack.length > 0) {
      const region = stack.pop()!;
      const instrs = region.body;
      if (seen.has(instrs)) continue;
      seen.add(instrs);
      for (let i = 0; i < instrs.length; i++) {
        const instr = instrs[i]!;
        const directSourceCall =
          (instr.op === "call" || instr.op === "return_call") && sourceFuncIdxs.has(instr.funcIdx);
        const dynamicSourceCall = instr.op === "call_ref" || instr.op === "return_call_ref";
        if (directSourceCall || dynamicSourceCall) {
          const prefix = marker(region.strict);
          instrs.splice(i, 0, ...prefix);
          i += prefix.length;
        }
        walkChildren(instr, (child) =>
          stack.push({
            body: child,
            strict: ctx.sourceFunctionStrictnessByBody.get(child) ?? region.strict,
          }),
        );
      }
    }
  };

  for (const fn of ctx.mod.functions) {
    const strict = sourceFunctions.get(fn);
    if (strict !== undefined) instrument(fn.body, strict);
  }
}
