// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The `env::__extern_new_function` host import — dynamic
 * `new Function(params, body)` / `Function(params, body)` (#2960), extracted
 * from `resolveImport` (#4650).
 *
 * Policy arms (`deny` / `native` / `evaluator`) are the embedder's explicit
 * dynamic-code choices. The default `compat` arm is meta-circular: the body is
 * compiled by js2wasm itself (`createNewFunctionShim`) so the constructed
 * function is a real, JS-callable value the parent module can invoke — with two
 * carve-outs that route to the host `Function` constructor instead, because the
 * meta-circular path cannot represent them:
 *
 *   - `class` in the body (#3058) — the child module's compiled class is an
 *     opaque struct the parent cannot construct, and a class extending a host
 *     builtin loses the builtin's statics and [[Construct]].
 *   - `this` in the body (#4650) — the child module compiles the body as a FREE
 *     function, so its `this` is `undefined` rather than §10.4.3's global
 *     object. `Function("return this;")()` (the canonical global-object idiom,
 *     test262 harness/fnGlobalObject.js) therefore answered `undefined`. This
 *     is the same limitation the codegen compile-away declines on
 *     (`containsThisKeyword`, #2924 park fix).
 */

export type DynamicFunctionPolicy = "deny" | "native" | "evaluator" | "compat" | (string & {});

export interface DynamicFunctionImportOptions {
  policy: DynamicFunctionPolicy;
  /** Embedder-supplied evaluator for the `evaluator` policy. */
  createFunction?: (params: string, body: string) => unknown;
  /**
   * Factory for the meta-circular js2wasm shim. Called at most once, and only
   * under the default `compat` policy — the other policies never build one.
   */
  createWasmNewFunctionShim: () => (params: unknown, body: string) => unknown;
  /**
   * The object the compiled module sees as its global (`__get_globalThis`
   * resolves to `globalSandbox ?? globalThis`). Used to fix up an unbound
   * `this` in a host-constructed function; see below.
   */
  moduleGlobal: unknown;
  /** Constructed on demand so a `deny`/`native` policy never needs one. */
  makeEvalError: (message: string) => Error;
}

export function createDynamicFunctionImport(options: DynamicFunctionImportOptions): Function {
  const { policy, createFunction, createWasmNewFunctionShim, moduleGlobal, makeEvalError } = options;

  if (policy === "deny") {
    return () => {
      throw makeEvalError("dynamic code generation is disabled by the host");
    };
  }
  if (policy === "native") {
    // biome-ignore lint/security/noGlobalEval: explicit opt-in host-eval engine
    return (params: any, body: any) => new Function(String(params ?? ""), String(body ?? ""));
  }
  if (policy === "evaluator") {
    return (params: any, body: any) => {
      if (!createFunction) throw makeEvalError("no dynamic-code evaluator was supplied by the host");
      return createFunction(String(params ?? ""), String(body ?? ""));
    };
  }

  const wasmNewFunctionShim = createWasmNewFunctionShim();
  return (params: any, body: any) => {
    const bodyStr = String(body ?? "");
    const referencesThis = /\bthis\b/.test(bodyStr);
    if (!/\bclass\b/.test(bodyStr) && !referencesThis) {
      try {
        return wasmNewFunctionShim(params, bodyStr);
      } catch {
        /* the js2wasm pipeline could not compile it — use the host ctor */
      }
    }
    // biome-ignore lint/security/noGlobalEval: intentional runtime new Function
    const hostFn = new Function(String(params ?? ""), bodyStr);
    if (!referencesThis || moduleGlobal === (globalThis as unknown)) return hostFn;
    // (#4650) A host function body's unbound `this` is the HOST global, but the
    // module's global object is whatever `__get_globalThis` hands it — the
    // embedder's sandbox when one is supplied (the test262 runner always
    // supplies one). Without this substitution `fnGlobalObject() === this`
    // compares the real `globalThis` against the sandbox and fails. Only a
    // nullish / host-global receiver is redirected, so an explicit
    // `f.call(obj)` keeps its own receiver.
    const thisAwareFn = function (this: any, ...args: any[]): any {
      const receiver = this === undefined || this === null || this === (globalThis as unknown) ? moduleGlobal : this;
      return hostFn.apply(receiver, args);
    };
    Object.defineProperty(thisAwareFn, "length", { value: hostFn.length, configurable: true });
    Object.defineProperty(thisAwareFn, "name", { value: hostFn.name, configurable: true });
    return thisAwareFn;
  };
}
