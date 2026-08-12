// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Synchronous JS-realm evaluators that keep the AOT Wasm instance in place. */

import type { DynamicCodeBinding, DynamicCodeEvaluationContext, DynamicCodeEvaluator } from "./runtime.js";

/** Minimal same-origin realm surface exposed by an iframe's `contentWindow`. */
export interface JavaScriptEvalRealm {
  eval(source: string): unknown;
  Function: FunctionConstructor;
}

const SCOPE_PARAM = "__js2wasm_eval_scope__";
const SOURCE_PARAM = "__js2wasm_eval_source__";

function createBindingScope(
  realm: JavaScriptEvalRealm,
  bindings: readonly DynamicCodeBinding[],
): Record<PropertyKey, unknown> {
  const byName = new Map<string, DynamicCodeBinding>();
  for (const binding of bindings) byName.set(binding.name, binding);
  const globalObject = realm as unknown as Record<PropertyKey, unknown>;
  return new Proxy(Object.create(null) as Record<PropertyKey, unknown>, {
    has(_target, key) {
      if (key === "eval" || key === SCOPE_PARAM || key === SOURCE_PARAM) return false;
      return typeof key === "string" && (byName.has(key) || Reflect.has(globalObject, key));
    },
    get(_target, key) {
      if (key === Symbol.unscopables) return undefined;
      const binding = typeof key === "string" ? byName.get(key) : undefined;
      return binding ? binding.get() : Reflect.get(globalObject, key);
    },
    set(_target, key, value) {
      const binding = typeof key === "string" ? byName.get(key) : undefined;
      if (binding) binding.set(value);
      else Reflect.set(globalObject, key, value);
      return true;
    },
    deleteProperty(_target, key) {
      if (typeof key === "string" && byName.has(key)) return false;
      return Reflect.deleteProperty(globalObject, key);
    },
  });
}

/**
 * Use another same-origin JavaScript realm for eval and Function construction.
 *
 * The compiled Wasm module remains in its current host. Values cross the realm
 * boundary as ordinary JavaScript references, so this stays synchronous and
 * supports functions and objects without structured cloning.
 *
 * This is realm/heap separation, not a security boundary: same-origin iframe
 * code can still reach its parent and origin capabilities. An opaque sandboxed
 * iframe requires asynchronous messaging and cannot satisfy a synchronous Wasm
 * import without a suspension transform.
 */
export function createRealmDynamicCodeEvaluator(realm: JavaScriptEvalRealm): DynamicCodeEvaluator {
  const realmEval = realm.eval;
  const RealmFunction = realm.Function;
  if (typeof realmEval !== "function" || typeof RealmFunction !== "function") {
    throw new TypeError("dynamic-code realm must expose eval and Function");
  }
  const scopedEval = Reflect.construct(RealmFunction, [
    SCOPE_PARAM,
    SOURCE_PARAM,
    `with (${SCOPE_PARAM}) { return eval(${SOURCE_PARAM}); }`,
  ]) as (scope: Record<PropertyKey, unknown>, source: string) => unknown;

  return {
    evaluate(source: string, context: DynamicCodeEvaluationContext): unknown {
      if (context.direct && context.bindings !== undefined) {
        const scope = createBindingScope(realm, context.bindings);
        const directSource = context.strict ? `"use strict";\n${source}` : source;
        return Reflect.apply(scopedEval, undefined, [scope, directSource]);
      }
      return Reflect.apply(realmEval, realm, [source]);
    },
    createFunction(parameters: string, body: string): Function {
      return Reflect.construct(RealmFunction, [parameters, body]) as Function;
    },
  };
}
