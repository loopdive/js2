// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Native callable entry point for the ES5 `%Function.prototype%` object. */

import { ts } from "../ts-api.js";
import type { Instr, WasmFunction } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { emitThrowTypeError } from "./expressions/helpers.js";

/**
 * `%Function.prototype%.[[Call]]` ignores every argument and returns
 * `undefined` (ES5 §15.3.4). Calls use a zero-parameter helper because both
 * front-ends evaluate and discard source arguments before invoking it.
 */
export const FUNCTION_PROTOTYPE_CALL_HELPER = "__function_prototype_call";

export function ensureFunctionPrototypeCallHelper(ctx: CodegenContext): number | undefined {
  if (!(ctx.standalone || ctx.wasi)) return undefined;
  const existing = ctx.funcMap.get(FUNCTION_PROTOTYPE_CALL_HELPER);
  if (existing !== undefined) return existing;

  const body: Instr[] = undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }], `$${FUNCTION_PROTOTYPE_CALL_HELPER}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: FUNCTION_PROTOTYPE_CALL_HELPER,
    typeIdx,
    locals: [],
    body,
    exported: false,
  } satisfies WasmFunction);
  ctx.funcMap.set(FUNCTION_PROTOTYPE_CALL_HELPER, funcIdx);
  return funcIdx;
}

/**
 * §20.2.3 spec arities of the `%Function.prototype%` members, for the
 * `<fn>.<member>.length` static fold.
 *
 * The fold otherwise counts the LIB DECLARATION's formals, and `lib.es5.d.ts`
 * disagrees with the spec for `apply`: it writes the second argument as
 * `argArray?: any` (optional), so §15.1.5's prefix walk stops at it and answers
 * 1 where §20.2.3.1 pins 2. That is the same "TS's param count can disagree
 * with the runtime Function.length" divergence the fold's own comment already
 * records for `Array.prototype.toSorted`. Stating the four spec numbers here
 * removes the guesswork for this family.
 */
const FUNCTION_PROTOTYPE_MEMBER_LENGTH: Readonly<Record<string, number>> = Object.assign(
  Object.create(null) as Record<string, number>,
  { apply: 2, call: 1, bind: 1, toString: 0 },
);

/**
 * §20.2.3 `<fn>.<member>.length` where `<fn>` is a callable and `<member>` is a
 * `%Function.prototype%` method — the spec arity, or `undefined` to leave the
 * read to the generic fold.
 *
 * `memberAccess` is the INNER access (`f.call` of `f.call.length`). The
 * receiver must be provably callable, so a plain object that merely owns a
 * property named `call` keeps the ordinary path. Pure — emits nothing.
 */
export function functionPrototypeMemberSpecLength(
  ctx: CodegenContext,
  memberAccess: ts.Expression,
): number | undefined {
  if (!ts.isPropertyAccessExpression(memberAccess)) return undefined;
  const specLength = FUNCTION_PROTOTYPE_MEMBER_LENGTH[memberAccess.name.text];
  if (specLength === undefined) return undefined;
  if (ctx.oracle.signatureOf(memberAccess.expression) === undefined) return undefined;
  return specLength;
}

/**
 * The builtin NAMESPACE globals — ordinary, non-callable objects that inherit
 * directly from `%Object.prototype%` (§21.3 Math, §25.5 JSON, §28.1 Reflect,
 * §25.4 Atomics). Deliberately excludes every builtin CONSTRUCTOR (`Error`,
 * `Array`, …): those ARE callable and DO inherit `%Function.prototype%`'s
 * `bind`/`call`/`apply`.
 */
const NON_CALLABLE_BUILTIN_NAMESPACES: ReadonlySet<string> = new Set(["Math", "JSON", "Reflect", "Atomics"]);

/** The `%Function.prototype%` methods that invoke their this-value (§20.2.3.1-.3). */
const FUNCTION_PROTOTYPE_INVOKERS: ReadonlySet<string> = new Set(["bind", "call", "apply"]);

/**
 * (§20.2.3.1-.3) `JSON.bind()` / `Math.call()` / `Reflect.apply()`-as-a-method:
 * degrade to the catchable TypeError the spec calls for instead of leaking the
 * dynamic `env::__get_builtin` host import.
 *
 * A builtin namespace object is not callable and does not own
 * `bind`/`call`/`apply` — those live on `%Function.prototype%`, which is NOT on
 * a namespace's prototype chain (`Math`, `JSON`, `Reflect` and `Atomics` all
 * inherit straight from `%Object.prototype%`). So the call is a TypeError twice
 * over: the member resolves to `undefined`, and even reached as
 * `Function.prototype.bind` its step-2 `IsCallable(Target)` check rejects the
 * namespace. Without this the generic `Namespace.member()` path asks
 * `__get_builtin` for a dynamic property and HARD-REFUSES under standalone
 * (#1472 Phase B), turning a catchable runtime TypeError into a whole-file
 * compile error — test262 `built-ins/Function/prototype/bind/15.3.4.5-2-7.js`.
 * Same reshape as `ensureFunctionPrototypeCallHelper`'s caller above and the
 * Atomics arm in `compileBuiltinStaticCall`.
 *
 * Deliberately narrow on BOTH axes. Only the three `%Function.prototype%`
 * invokers — a blanket "unknown member on a namespace throws" would preempt the
 * `Math.<unknown>` fallthrough that lets `Array.prototype.every.call(Math, …)`
 * be rewritten as `Math.every(…)`. And only the AMBIENT namespace binding
 * (the caller checks `isGlobalBuiltinIdentifier`): a local object named `JSON`
 * keeps ordinary member-call semantics.
 *
 * Returns `true` having emitted the throw (stack-polymorphic, so the caller's
 * nominal externref result is satisfied), or `false` having pushed NOTHING.
 */
export function tryEmitNonCallableNamespaceInvokerThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
): boolean {
  if (!ts.isIdentifier(propAccess.expression)) return false;
  const namespaceName = propAccess.expression.text;
  const member = propAccess.name.text;
  if (!NON_CALLABLE_BUILTIN_NAMESPACES.has(namespaceName)) return false;
  if (!FUNCTION_PROTOTYPE_INVOKERS.has(member)) return false;
  emitThrowTypeError(ctx, fctx, `${namespaceName}.${member} is not a function (${namespaceName} is not callable)`);
  return true;
}
