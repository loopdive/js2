// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host-vs-GC callback classification for js2wasm closures.
 *
 * Extracted verbatim from `closures.ts` (issue #3270). Answers "should this
 * callable argument go through the host `__make_callback` bridge or the WasmGC
 * closure-struct path?" — a cohesive, pure (returns-booleans) decision
 * subsystem plus its four allowlist constants. Read-only over `CodegenContext`;
 * emits nothing.
 */

import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import type { ValType } from "../../ir/types.js";
import { classMemberFuncKey } from "../class-member-keys.js"; // (#1983) collision-free class-member funcMap keys

/**
 * #1311 — Host method names whose callable arg ALWAYS needs a JS-callable
 * `__make_callback` externref. These methods invoke the callback during the
 * call itself (the JS-side host implementation calls back into the runtime),
 * so the GC-struct closure shape can't satisfy them.
 *
 * Methods NOT in this set get the closure-struct path when their param is
 * callable — the value is stored, not invoked, so the cast at the eventual
 * dispatch site works. Examples: `Map.set`, `WeakMap.set`, `Set.add`,
 * `Array.push`, `Array.unshift`, user-defined methods.
 *
 * Note: array HOFs (`forEach`, `map`, `filter`, `reduce`, etc.) have
 * dedicated inline compilation in `src/codegen/array-methods.ts` and never
 * reach `isHostCallbackArgument` for their callback arg. They're listed
 * here defensively so that if the inline path is bypassed (e.g. on an
 * untyped receiver), the host-callback path is still chosen.
 */
const HOST_CALLBACK_METHODS = new Set<string>([
  // Array HOFs (defensive fallback — usually inlined upstream)
  "forEach",
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "every",
  "some",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "sort",
  // Promise prototype methods — JS microtask scheduler invokes the callback
  "then",
  "catch",
  "finally",
  // Object/JSON callbacks
  "fromEntries",
  // String.replace(pattern, replacer) — replacer is a callback
  "replace",
  "replaceAll",
]);

/**
 * (#2070) True when `recvType` is a JS `Array` (`T[]` / `Array<T>`) — used to
 * give `push`/`unshift` callback args the closure-struct path. Recognises the
 * type via its symbol name and, defensively, via the apparent type so a
 * narrowed/aliased array still matches. Typed arrays (`Uint8Array`, …) are not
 * `Array` and correctly fall through to the host-callback default.
 */
function isArrayLikeReceiverType(recvType: ts.Type, ctx: CodegenContext): boolean {
  const named = (t: ts.Type | undefined): boolean => t?.getSymbol?.()?.getName?.() === "Array";
  if (named(recvType)) return true;
  try {
    const apparent = ctx.checker.getApparentType?.(recvType);
    if (named(apparent)) return true;
    // typeToString covers the structural `T[]` form whose symbol may be absent.
    const asStr = ctx.checker.typeToString(recvType);
    if (/(\[\]|^Array<|^ReadonlyArray<)/.test(asStr) || asStr.endsWith("[]")) return true;
  } catch {
    // ignore checker errors — default to the host-callback path
  }
  return false;
}

/** (#2903 R4) The nine typed-array view constructor names — a receiver of one
 *  of these types is a native packed-carrier typed array in standalone. */
const TYPED_ARRAY_VIEW_NAMES: ReadonlySet<string> = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
]);

/** (#2903 R4) Scalar-returning callback HOFs whose standalone typed-array
 *  dispatch is handled natively via `__call_m_*`/`__hof_*` (calls.ts). Excludes
 *  map/filter (typed-RESULT construction — deferred to R4b). */
const STANDALONE_TYPED_ARRAY_SCALAR_HOFS: ReadonlySet<string> = new Set([
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "some",
  "every",
  "reduce",
  "reduceRight",
]);

/**
 * (#2903 R4) True when `recvType` is one of the nine typed-array view types
 * (`Uint8Array`, `Int8Array`, …). Recognises the type via its symbol name and,
 * defensively, via the apparent type so a narrowed/aliased view still matches.
 */
function isTypedArrayReceiverType(recvType: ts.Type, _ctx: CodegenContext): boolean {
  // A concrete typed-array receiver carries its view name directly on the type
  // symbol; the interception is scoped to that (known-element-kind) shape. A
  // narrowed/aliased view without a direct symbol falls through to the host
  // path (no regression — that path already worked pre-#2903).
  const n = recvType.getSymbol?.()?.getName?.();
  return n !== undefined && TYPED_ARRAY_VIEW_NAMES.has(n);
}

/**
 * (#2640) True when `wt` is a (nullable) ref to a typed WasmGC vec/array
 * struct (`__vec_*`/`__arr_*`/`$__vec_base`). Used to widen array-like
 * generic-method callback params to externref (see
 * `ctx.forceExternrefCallbackParams`). Mirrors the `__vec_`/`__arr_`
 * receiver-bail detection in `compileArrayLikePrototypeCall`.
 */
export function isVecOrArrayRefType(ctx: CodegenContext, wt: ValType): boolean {
  if (wt.kind !== "ref" && wt.kind !== "ref_null") return false;
  const typeIdx = (wt as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];
  const name = typeDef && "name" in typeDef ? (typeDef as { name?: string }).name : undefined;
  if (!name) return false;
  return name.startsWith("__vec_") || name.startsWith("__arr_") || name === "__vec_base";
}

/** Check if an arrow/function expression is used as a callback argument to a call
 *  that targets a HOST import (not a user-defined function). User-defined functions
 *  should receive closures via the GC struct path, not the __make_callback host path. */
export function isHostCallbackArgument(node: ts.Node, ctx: CodegenContext): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent)) {
    if (!parent.arguments.some((arg) => arg === node)) return false;
    // #3747 — an argument to an immediately-invoked function expression is
    // consumed by compiled Wasm code, not by the JS host. Classifying it as a
    // host callback wrapped the function in `__make_callback`; the inlined
    // IIFE parameter later tried to cast that host function back to a WasmGC
    // closure struct and null-dereferenced. This is the UMD factory shape used
    // by Moment: `(function (factory) { factory(); }(function () { ... }))`.
    let directCallee: ts.Expression = parent.expression;
    while (ts.isParenthesizedExpression(directCallee)) directCallee = directCallee.expression;
    if (ts.isFunctionExpression(directCallee) || ts.isArrowFunction(directCallee)) return false;
    // Check if the callee is a user-defined function — if so, NOT a host callback
    if (ts.isIdentifier(parent.expression)) {
      const calleeName = parent.expression.text;
      const funcIdx = ctx.funcMap.get(calleeName);
      if (funcIdx !== undefined && funcIdx >= ctx.numImportFuncs) {
        // User-defined function — use closure path, not host callback
        return false;
      }
      // (#1300) The callee is an identifier but not in funcMap — typically a
      // function-typed parameter or local. The receiving function expects
      // the GC-struct closure shape (`__fn_wrap_N_struct`) and will
      // `ref.cast` the externref it gets. Routing through the host
      // `__make_callback` path here produces a JS-wrapped externref that
      // fails the cast and null-derefs at the receiver's `struct.get`.
      // Detect via TypeScript's call-signature lookup on the identifier's
      // type and use the closure path if the callee is callable.
      try {
        const calleeType = ctx.checker.getTypeAtLocation(parent.expression);
        const callSigs = calleeType?.getCallSignatures?.();
        if (callSigs && callSigs.length > 0) {
          return false;
        }
      } catch {
        // Fall through to host-callback path on any checker error
      }
    }
    // For method calls (property access), check if the method is on a
    // user-defined class. User-defined methods receive the closure as the
    // GC-struct shape (`__fn_wrap_N_struct`) and may store it for later
    // dispatch (e.g. `app.routes.set(path, handler)`). Routing through
    // `__make_callback` here produces a JS-wrapped externref that fails the
    // dispatch-site `ref.cast` and null-derefs at `struct.get`. (#1311)
    if (ts.isPropertyAccessExpression(parent.expression)) {
      const propAccess = parent.expression;
      const methodName = propAccess.name.text;
      // (#3016) `Function.prototype.call`/`apply` NEVER invoke their arguments
      // as callbacks — they invoke the *receiver* with those args as `thisArg`
      // + forwarded params. So a function-expression/arrow passed to `.call`/
      // `.apply` (e.g. `get.call(() => {})` using a function object as an
      // invalid `this`, or `Array.prototype.find.call(undefined, fn)`) is a
      // plain function-object VALUE, not a synchronously-invoked host callback.
      // Routing it through `__make_callback` leaks an `env::` import in
      // standalone mode for no reason; the GC closure-struct path produces a
      // valid function-object value host-free (and any HOF that the *receiver*
      // then invokes — `Array.prototype.forEach.call(arr, cb)` — dispatches the
      // struct via `__call_fn_N`, verified host-free). Standalone-gated so the
      // js-host lane stays byte-identical.
      if (ctx.standalone && (methodName === "call" || methodName === "apply")) {
        return false;
      }
      try {
        const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
        // Search the receiver type's symbol chain for a class name that
        // matches a user-defined method `${ClassName}_${methodName}`. We
        // check both the receiver's own symbol (instance methods) and the
        // type itself (handles `(typeof Foo).method` for statics).
        const candidates = new Set<string>();
        const recSym = receiverType.getSymbol?.();
        const recName = recSym?.getName?.();
        if (recName) candidates.add(recName);
        // (#3231) In standalone/nativeStrings mode a callback passed to a native
        // DisposableStack `defer`/`adopt` is STORED as a first-class WasmGC closure
        // (the native runtime later invokes it via `__call_fn_N`), NOT wrapped by
        // the host `__make_callback`. Route it to the closure-struct path so the
        // dispatcher can find it host-free. `use` isn't native yet (Phase 1b) — its
        // callback keeps the host path. Standalone-gated; js-host lane unchanged.
        if (ctx.nativeStrings && recName === "DisposableStack" && (methodName === "defer" || methodName === "adopt")) {
          return false;
        }
        // Walk base types so inherited user-defined methods are detected
        const baseTypes = receiverType.getBaseTypes?.();
        if (baseTypes) {
          for (const bt of baseTypes) {
            const bs = bt.getSymbol?.()?.getName?.();
            if (bs) candidates.add(bs);
          }
        }
        for (const className of candidates) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && funcIdx >= ctx.numImportFuncs) {
            // User-defined method on a user-defined class — closure path
            return false;
          }
        }
        // (#2070) Not a user-defined class method. A closure pushed onto an
        // array via `Array.prototype.push`/`unshift` is *stored*, not invoked,
        // and the eventual element-read call site (`fns[0]()`) dispatches it as
        // a WasmGC closure struct. Routing such a closure through the host
        // `__make_callback` path produces a JS-wrapped externref that fails the
        // read-site `ref.test`/`ref.cast` and null-derefs at `struct.get`. Give
        // array storage methods the closure-struct path instead.
        //
        // This is deliberately narrow: `Map.set`/`Set.add` and the deferred
        // DisposableStack methods keep the host-callback path because their
        // in-class dispatch wrappers (#1311) and writeback machinery (#1695)
        // depend on the JS-callable externref. The broader
        // HOST_CALLBACK_METHODS allowlist still governs the invoke-during-call
        // host methods (array HOFs, Promise.then, String.replace, …).
        if ((methodName === "push" || methodName === "unshift") && isArrayLikeReceiverType(receiverType, ctx)) {
          return false;
        }
        // (#2903 R4) Standalone typed-array SCALAR-returning callback HOFs
        // (find/findIndex/…/forEach/some/every/reduce) are dispatched natively
        // through the `__call_m_<name>`/`__hof_<name>` substrate (see the
        // interception in `expressions/calls.ts`), which drives the predicate
        // via `__apply_closure` on a WasmGC closure STRUCT — NOT the host
        // `__make_callback` externref. Routing the callback through the host
        // bridge here would leak `env.__make_callback` (breaking host-free
        // instantiation) AND hand the substrate an externref it can't `ref.cast`
        // to the closure struct. So give these the closure-struct path.
        // Standalone-gated (js-host/gc keep the pre-existing host path,
        // byte-identical). map/filter (typed-RESULT construction) are NOT here —
        // deferred to R4b. The dyn-view (`$__ta_dyn_view`) receiver shape stays
        // on its own #3058/#3162 path in array-methods.ts.
        if (
          ctx.standalone &&
          STANDALONE_TYPED_ARRAY_SCALAR_HOFS.has(methodName) &&
          isTypedArrayReceiverType(receiverType, ctx)
        ) {
          return false;
        }
      } catch {
        // Fall through to host-callback path on any checker error
      }
    }
    return true;
  }
  // NewExpression: `new Promise(executor)`, `new Map(comparator)`, etc.
  // Function args to constructors of extern classes need to be JS-callable.
  if (ts.isNewExpression(parent)) {
    if (!parent.arguments?.some((arg) => arg === node)) return false;
    // Check if the constructor is a user-defined class — if so, NOT a host callback
    if (ts.isIdentifier(parent.expression)) {
      const ctorName = parent.expression.text;
      const newFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${ctorName}_new`)); // (#1983)
      if (newFuncIdx !== undefined && newFuncIdx >= ctx.numImportFuncs) {
        return false;
      }
      // (#28) `new Promise(executor)` — the executor must be invoked by the host
      // `Promise_new` import (which does `new Promise(_maybeWrapCallable(executor,
      // 2, …))`). The `__make_callback` host-callback path does NOT round-trip
      // here: an INLINE executor (`new Promise((res, rej) => …)`) routed through
      // it produced no callable wrapper, so the executor was silently never
      // invoked (resolve/reject `undefined`). Compiling the executor as a
      // first-class CLOSURE instead emits the `__call_fn_2` dispatcher that
      // `_maybeWrapCallable` uses to make the wasm closure JS-callable — the same
      // path the working `const exec = …; new Promise(exec)` form already takes.
      // So treat the Promise executor as a closure value, not a host callback.
      if (ctorName === "Promise") {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Methods that STORE the callback for later invocation rather than calling it
 * synchronously during the call. Closures passed to these methods need
 * persistent ref-cell writebacks (re-emitted after every subsequent call) so
 * that mutations made when the callback eventually runs are reflected in the
 * outer scope. (#1695)
 *
 * Receiver-type-aware allowlist (className → method names): we only promote
 * to persistent writebacks when the receiver type matches — e.g. a user-defined
 * `class Foo { defer(cb) {} }` calling `foo.defer(...)` must NOT be promoted.
 */
/**
 * (#1795) Listener-method names treated as deferred when the RECEIVER is
 * `any`/`unknown` (no type symbol to key the per-class allowlist on) — the
 * EventEmitter surface every Node stream/response exposes.
 */
const ANY_RECEIVER_DEFERRED_METHOD_NAMES: ReadonlySet<string> = new Set([
  "on",
  "once",
  "off",
  "addListener",
  "removeListener",
  "prependListener",
  "prependOnceListener",
  // Observable/store APIs (Redux, useSyncExternalStore-compatible stores,
  // Rx-style sources) retain the subscriber until unsubscribe/teardown.
  "subscribe",
]);

const DEFERRED_CALLBACK_METHODS_BY_CLASS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["DisposableStack", new Set(["defer", "use", "adopt"])],
  ["AsyncDisposableStack", new Set(["defer", "use", "adopt"])],
  // (#1794) node:events EventEmitter — every listener-registering method stores
  // the callback; it fires later from `.emit(...)` (a DIFFERENT host call), so a
  // one-shot pending writeback would resync the outer local before the listener
  // ever ran (captured-mutable writes were lost: `got` stayed 0 in the Tier 0
  // acceptance shape).
  [
    "EventEmitter",
    new Set(["on", "once", "off", "addListener", "removeListener", "prependListener", "prependOnceListener"]),
  ],
]);

/**
 * Returns true if the arrow's parent CallExpression is a stored-callback host
 * method (DisposableStack.defer/use/adopt etc.). The callback is not invoked
 * synchronously by the call that registers it, so its captured-mutable
 * writebacks must be persistent. (#1695)
 */
export function isDeferredCallbackArgument(node: ts.Node, ctx: CodegenContext): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (!parent.arguments.some((arg) => arg === node)) return false;
  if (!ts.isPropertyAccessExpression(parent.expression)) return false;
  const methodName = parent.expression.name.text;
  try {
    const recType = ctx.checker.getTypeAtLocation(parent.expression.expression);
    const symName = recType.getSymbol?.()?.getName?.();
    if (symName) {
      const methods = DEFERRED_CALLBACK_METHODS_BY_CLASS.get(symName);
      if (methods?.has(methodName)) return true;
    }
    // (#1795) UNTYPED receiver (`res: any` — e.g. the http.get response, or
    // any duck-typed EventEmitter): no symbol to key the allowlist on, so
    // fall back to the universal listener-method NAMES. Promoting a
    // synchronous same-named user method is semantics-preserving (persistent
    // writebacks are just extra resyncs; the #3329 cell rebind aliases reads
    // and writes through one cell either way).
    if (!symName && (recType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      if (ANY_RECEIVER_DEFERRED_METHOD_NAMES.has(methodName)) return true;
    }
    const baseTypes = recType.getBaseTypes?.();
    if (baseTypes) {
      for (const bt of baseTypes) {
        const bn = bt.getSymbol?.()?.getName?.();
        if (!bn) continue;
        const m = DEFERRED_CALLBACK_METHODS_BY_CLASS.get(bn);
        if (m?.has(methodName)) return true;
      }
    }
  } catch {
    // checker failure → conservative false (no behavioural change)
  }
  return false;
}

/**
 * (#3046) True when `node` is the **reviver** argument (2nd arg) of a
 * `JSON.parse(text, reviver)` call. Per ECMA-262 §25.5.1.1
 * `InternalizeJSONProperty`, the reviver is invoked as
 * `Call(reviver, holder, «name, val»)` — `this` MUST be the holder. The host
 * `JSON_parse` / `_invokeJsonCallable` bridge applies the holder as the JS
 * receiver, so the reviver callback must route through the `this`-forwarding
 * `__make_getter_callback` maker (needsThis) rather than the bare
 * `__make_callback`, which drops the receiver and leaves `this` non-object
 * (a `this.`-op such as `Object.defineProperty(this, …)` then throws
 * "called on non-object").
 */
export function isJsonReviverArgument(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (parent.arguments[1] !== node) return false; // must be the 2nd arg
  const callee = parent.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "JSON" &&
    callee.name.text === "parse"
  );
}
