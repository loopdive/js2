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
 * (#6691) WHATWG Fetch / URL platform classes. None is an ECMAScript global
 * (host-less engines — d8, QuickJS — lack them too) and a standalone module
 * has no network stack to hand a `Request` to. hono's `mount`,
 * `Context#newResponse` and `HonoRequest` merely CONTAIN them; the sample
 * route registration never evaluates one. Gated on the host-free ENVIRONMENT
 * as well, so the opt-in JS-environment native regime keeps its host's
 * constructors.
 */
const STANDALONE_UNAVAILABLE_FETCH_GLOBALS: ReadonlySet<string> = new Set([
  "Request",
  "Response",
  "Headers",
  "URL",
  "URLSearchParams",
]);

/**
 * (#6841) Browser value globals of lib.dom. `typeof` already answers
 * "undefined" for them in a host-free module (HOST_ONLY_AMBIENT_GLOBALS), but
 * a read silently produced `null` and every member reached through the
 * lib.dom type (`document.head`, `navigator.product`, …) lowered to an
 * `env::` extern-class import. styled-components' sheet bootstrap merely
 * CONTAINS such code. A read now throws `ReferenceError` like an engine
 * without the global. A certified DOM capability module owns `document`
 * (#4576) and keeps its provider.
 */
const STANDALONE_UNAVAILABLE_BROWSER_GLOBALS: ReadonlySet<string> = new Set([
  "document",
  "window",
  "navigator",
  "location",
  "history",
]);

/**
 * (#6841) lib.dom node/document/CSSOM interfaces. A value of one of these types
 * can only come from an unavailable browser global, so in a host-free module
 * their members take the ordinary dynamic-property lowering instead of
 * `env::<Class>_<member>` imports (the receiver read has already thrown).
 */
const STANDALONE_UNPROVIDED_DOM_CLASSES: ReadonlySet<string> = new Set([
  "Window",
  "Navigator",
  "Location",
  "History",
  "Node",
  "Document",
  "DocumentFragment",
  "ShadowRoot",
  "Element",
  "CharacterData",
  "Text",
  "Comment",
  "Attr",
  "NodeList",
  "HTMLCollection",
  "NamedNodeMap",
  "DOMTokenList",
  "StyleSheet",
  "StyleSheetList",
  "CSSStyleSheet",
  "CSSRule",
  "CSSRuleList",
  "CSSStyleDeclaration",
  "MediaQueryList",
]);

/** Host-free and not a certified DOM-capability module (#4576). */
function lacksBrowserDom(ctx: CodegenContext): boolean {
  return ctx.targetProfile.environment === "none" && ctx.requiresStandaloneDomCapability !== true;
}

function isUnprovidedDomClass(ctx: CodegenContext, className: string): boolean {
  if (!lacksBrowserDom(ctx)) return false;
  return (
    STANDALONE_UNPROVIDED_DOM_CLASSES.has(className) ||
    /^(HTML|SVG)\w*Element$/.test(className) ||
    className === "HTMLDocument"
  );
}

function isUnavailableName(ctx: CodegenContext, name: string): boolean {
  if (STANDALONE_UNAVAILABLE_CONSTRUCTOR_GLOBALS.has(name)) return true;
  if (lacksBrowserDom(ctx) && STANDALONE_UNAVAILABLE_BROWSER_GLOBALS.has(name)) return true;
  return ctx.targetProfile.environment === "none" && STANDALONE_UNAVAILABLE_FETCH_GLOBALS.has(name);
}

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
  return (
    ctx.standalone &&
    (STANDALONE_UNPROVIDED_EXTERN_CLASSES.has(className) ||
      isUnavailableName(ctx, className) ||
      isUnprovidedDomClass(ctx, className))
  );
}

/**
 * A host-free standalone module lacks `name`. A linked standalone module reads
 * globals from its owning realm, which may well have the constructor.
 * Name-level only: the caller proves the reference is the ambient binding.
 */
export function isStandaloneUnavailableConstructorGlobal(ctx: CodegenContext, name: string): boolean {
  return ctx.standalone && ctx.standaloneGlobalThisImport === undefined && isUnavailableName(ctx, name);
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
export function isHostResolvedBuiltinReceiver(
  ctx: CodegenContext,
  receiver: ts.Expression,
  methodName: string,
): boolean {
  if (!ts.isIdentifier(receiver) || !BUILTIN_CLASS_NAMES.has(receiver.text)) return false;
  if (!ctx.standalone) return true;
  if (receiver.text === "Buffer") return false;
  return !(methodName === "captureStackTrace" && STANDALONE_ERROR_CONSTRUCTORS.has(receiver.text));
}

/**
 * (#1472) The native error constructors of a host-free realm. V8's
 * non-standard `Error.captureStackTrace` is not among their properties, so
 * `Error.captureStackTrace(this, C)` reads `undefined` and — once reached —
 * throws `TypeError` after its arguments are evaluated (EvaluateCall), exactly
 * as `typeof Error.captureStackTrace` already answers "undefined" here. The
 * receiver is therefore the ordinary native `Error` binding, not
 * `__get_builtin("Error")`. tailwindcss's `CssSyntaxError` guards the call
 * with `Error.captureStackTrace && ...`, which refused its whole graph.
 */
const STANDALONE_ERROR_CONSTRUCTORS: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
]);

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
