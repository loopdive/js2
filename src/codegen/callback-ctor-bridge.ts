// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4394) Pick the host callback-maker import for a callable crossing to the
// JS host, honouring whether the source callable has [[Construct]].
//
// `__make_callback`'s runtime bridge is an ARROW, and an arrow has no
// [[Construct]] — so every compiled callable handed to a host API was rejected
// by `Reflect.construct` / `new`, whatever it was written as. That silently
// inverted the test262 harness's `isConstructor` (its probe's own TARGET is an
// inline function expression, so it threw before ever inspecting the argument)
// for all 644 files that include `isConstructor.js`.
//
// Only an ordinary function definition has [[Construct]] (§15.2.4). Arrows,
// generators, async functions, methods and accessor callbacks do not, and must
// keep the arrow bridge — otherwise the repair widens into "every compiled
// callable is a constructor", which is just as wrong in the other direction.

import ts from "typescript";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

/**
 * True when `node` is a callable form the spec gives [[Construct]]: an ordinary
 * function expression that is neither a generator nor `async`.
 *
 * Arrow functions are excluded by the node kind. Methods, getters and setters
 * never reach here — they take the `__make_getter_callback` path, which the
 * caller checks before consulting this.
 */
export function callableHasConstructBehavior(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
  if (!ts.isFunctionExpression(node)) return false;
  if (node.asteriskToken !== undefined) return false;
  return !(node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/**
 * (#5375) Result type of a callback the host will INVOKE as an accessor or
 * method (`needsThis`, i.e. the `__make_getter_callback` bridge).
 *
 * The host consumes the return value, and a JS caller can only ever receive an
 * externref: a `(ref $T)` result is handed over as the same opaque WasmGC
 * object, and the getter bridge (`_invokeGetterCallbackBridge`) then re-wraps
 * it for the host anyway. Declaring the struct type therefore buys nothing —
 * and costs a lot when the value the body returns is NOT already that struct:
 * the `externref → ref` coercion rebuilds a host object property by property
 * (`buildRecordFromExternref`), which invokes the host object's getters. A
 * getter that returns its own object (prettier's `ROOT_INDENT`, whose
 * `get root() { return ROOT_INDENT; }` is typed `RootIndent` through JSDoc)
 * then rebuilds the object it is a property of, reads `root` again, and
 * recurses through the host until the stack is exhausted.
 *
 * So a host-facing callback returns its reference result as an externref: a
 * struct crosses as `extern.convert_any` (identity preserved, the bridge sees
 * the same object), a host object crosses untouched. Numbers, booleans and
 * `null` (void) keep their representation.
 */
export function hostFacingCallbackReturnType(returnType: ValType | null, needsThis: boolean): ValType | null {
  if (!needsThis || returnType === null) return returnType;
  if (returnType.kind === "ref" || returnType.kind === "ref_null") return { kind: "externref" };
  return returnType;
}

/**
 * Resolve the callback-maker import name for one callback creation site.
 *
 * Returns `__make_getter_callback` for `this`-bound accessor callbacks (caller's
 * existing contract), `__make_callback_ctor` when the callable is constructible
 * and the constructible bridge could be registered, `__make_callback`
 * otherwise. Standalone/WASI never registers a host bridge at all, so they stay
 * on the plain name and degrade to the native closure struct upstream.
 */
export function resolveCallbackMakerName(
  ctx: CodegenContext,
  fctx: FunctionContext,
  node: ts.ArrowFunction | ts.FunctionExpression,
  needsThis: boolean,
): string {
  if (needsThis) return "__make_getter_callback";
  if (ctx.standalone || ctx.wasi) return "__make_callback";
  if (!callableHasConstructBehavior(node)) return "__make_callback";
  const idx = ensureLateImport(
    ctx,
    "__make_callback_ctor",
    [{ kind: "i32" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (idx === undefined) return "__make_callback";
  flushLateImportShifts(ctx, fctx);
  return "__make_callback_ctor";
}
