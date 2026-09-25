// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { runtimeEvalStateMayShadowBinding } from "./direct-eval-environment.js";
import { resolvesToAmbientGlobal } from "./expressions/non-constructable.js";
import { emitThrowReferenceError } from "./js-errors.js";
import { BUILTIN_CLASS_NAMES } from "./expressions/builtin-class-names.js";

/**
 * (#6664) Browser (lib.dom) globals that a host-free `--target standalone`
 * module does not have.
 *
 * The TypeScript lib declares them ambiently, so without this gate the
 * extern-class machinery lowered every mention to an `env::` host import
 * (`MessageChannel_new`, `MessagePort_postMessage`, `ErrorEvent_new`, …) and a
 * module that merely CONTAINED such code — react's `enqueueTask` fallback,
 * never run — could not be instantiated without a JS host.
 *
 * A standalone program has no event loop, so there is no message port to
 * provide. The honest lowering is the one an engine without the global gives:
 * `typeof MessageChannel` is `"undefined"`, and evaluating the reference
 * (a read, or `new MessageChannel()` before any argument) throws
 * `ReferenceError: MessageChannel is not defined`.
 */
const STANDALONE_UNAVAILABLE_CONSTRUCTOR_GLOBALS: ReadonlySet<string> = new Set([
  "MessageChannel",
  "MessagePort",
  "ErrorEvent",
  // (#1472) Node's global — declared ambiently only under `--emulate node`.
  "Buffer",
]);

/**
 * lib.dom interfaces that must never be registered as extern classes in a
 * standalone module: every member of an extern class lowers to an `env::`
 * import. `Performance` is here although the `performance` global is not
 * unavailable — its one supported member, `performance.now()`, is lowered
 * natively by {@link tryEmitStandalonePerformanceNow}.
 */
const STANDALONE_UNPROVIDED_EXTERN_CLASSES: ReadonlySet<string> = new Set([
  ...STANDALONE_UNAVAILABLE_CONSTRUCTOR_GLOBALS,
  "Performance",
]);

/** Skip registering `className` as an `env::`-backed extern class. */
export function isStandaloneUnprovidedExternClass(ctx: CodegenContext, className: string): boolean {
  return ctx.standalone && STANDALONE_UNPROVIDED_EXTERN_CLASSES.has(className);
}

/**
 * A host-free standalone module lacks `name`. A linked standalone module reads
 * globals from its owning realm, which may well have the constructor.
 * Name-level only: the caller proves the reference is the ambient binding.
 */
export function isStandaloneUnavailableConstructorGlobal(ctx: CodegenContext, name: string): boolean {
  return (
    ctx.standalone &&
    ctx.standaloneGlobalThisImport === undefined &&
    STANDALONE_UNAVAILABLE_CONSTRUCTOR_GLOBALS.has(name)
  );
}

/**
 * (#1472) Whether the generic static-method arm resolves the `X` of `X.m(...)`
 * through the `__get_builtin("X")` host import rather than as an ordinary
 * identifier. Node's `Buffer` is in `BUILTIN_CLASS_NAMES` for the JS-host lane
 * (#1793), but a `--target standalone` module has no `Buffer` — and refuses
 * that import at compile time. There the receiver is an ordinary reference:
 * the unresolvable name throws `ReferenceError: Buffer is not defined` before
 * any argument is evaluated, and a context-linked module reads its owning
 * realm's global. combined-stream's `!Buffer.isBuffer(stream)` (axios's
 * form-data) refused the whole axios graph.
 */
export function isHostResolvedBuiltinReceiver(ctx: CodegenContext, receiver: ts.Expression): boolean {
  if (!ts.isIdentifier(receiver) || !BUILTIN_CLASS_NAMES.has(receiver.text)) return false;
  return !(ctx.standalone && receiver.text === "Buffer");
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

/**
 * The unavailable global `expr` names, or `undefined`. Only the AMBIENT
 * binding qualifies: a user declaration (`class MessageChannel {}`) or a name
 * a direct `eval` may have introduced keeps its ordinary lowering.
 */
export function standaloneUnavailableGlobalReference(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): string | undefined {
  const target = unwrapParens(expr);
  if (!ts.isIdentifier(target) || !isStandaloneUnavailableConstructorGlobal(ctx, target.text)) return undefined;
  if (fctx.localMap.has(target.text) || runtimeEvalStateMayShadowBinding(ctx, fctx, target.text)) return undefined;
  return resolvesToAmbientGlobal(ctx, target) ? target.text : undefined;
}

/** Throw `ReferenceError: <name> is not defined`; the externref slot is unreachable. */
export function emitStandaloneUnavailableGlobalThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
): ValType {
  emitThrowReferenceError(ctx, fctx, `${name} is not defined`);
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * `performance.now()` in a standalone module.
 *
 * There is no clock to read — the same position `Date.now()` is in, which
 * standalone lowers to the Unix epoch `0` (#2164). `performance.now()` returns
 * the matching constant: the time origin, which never advances. That keeps the
 * value monotonic non-decreasing (the only ordering guarantee a
 * `DOMHighResTimeStamp` makes) and deterministic, and — unlike a throw — lets
 * code that only records timings (react's lazy `_ioInfo.start/end`) run.
 */
export function tryEmitStandalonePerformanceNow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  argumentCount: number,
): ValType | undefined {
  if (!ctx.standalone || argumentCount !== 0 || propAccess.name.text !== "now") return undefined;
  const receiver = propAccess.expression;
  if (!ts.isIdentifier(receiver) || receiver.text !== "performance") return undefined;
  if (fctx.localMap.has("performance") || runtimeEvalStateMayShadowBinding(ctx, fctx, "performance")) return undefined;
  if (!resolvesToAmbientGlobal(ctx, receiver)) return undefined;
  fctx.body.push({ op: "f64.const", value: 0 });
  return { kind: "f64" };
}
