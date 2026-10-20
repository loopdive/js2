// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6708) Platform-API (`extern_class`: DOM, ...) arguments marshalled for the
 * JS host.
 *
 * Under the native regime — the default policy since S6 — a platform API can
 * receive Wasm-owned carriers: native strings, boxed numbers, closures. The
 * host API needs JS values, so each argument goes through the runtime's
 * primitive converter and its callable bridge. Both are INJECTED, so this
 * module never imports runtime.ts. A module that does not export the
 * native-string bridge (`__str_is_native`) — every host-assisted module — is
 * passed through untouched, as is any value the converters do not own.
 *
 * (#7095) A user `declare function f(...)` bound to an embedder dependency
 * crosses the same boundary and gets the same argument marshal, plus the
 * reverse direction for its result: when the Wasm import returns a reference
 * (`imp.refResult`, recorded from the import's function type), the compiled
 * caller reads a native carrier, so a JS primitive the host returns is adapted
 * into one. Numeric results (`f64`/`i32`) are left to the JS-API's own
 * ToNumber/ToInt32 — a carrier there would be a TypeError.
 *
 * (#7098) A closure argument becomes a callable the host may invoke, and the
 * host reads what it returns. The bridge hands back the raw `__call_fn_*`
 * externref, so a void closure answered the module's `$undefined` singleton (an
 * empty null-prototype object to JS), a Boolean its native box, a string its
 * carrier. The callable is therefore adapted once (cached, identity-stable,
 * aliased to the same closure so it unwraps on the way back) to convert its
 * result by value: primitive carriers → JS primitives, closures → callables,
 * everything else unchanged. Scoped to closures crossing THIS boundary — the
 * generic bridge keeps raw returns (#3123/#2835).
 */

type ExportsSource = { getExports(): Record<string, Function> | undefined };
type PrimitiveToHost = (value: any, exports: Record<string, Function>) => unknown;
type CallableToHost = (value: any, exportsSource: ExportsSource) => unknown;
/**
 * (#7098) The runtime's closure-bridge registries, injected once so this module
 * never imports runtime.ts: `arity === -1` marks a dynamic bridge, and the
 * target map is how a callable handed back to Wasm unwraps to its closure.
 */
let bridgeSources: WeakMap<Function, { arity: number }> | undefined;
let bridgeTargets: WeakMap<Function, object> | undefined;
export const closureBridges = {
  configure(sources: WeakMap<Function, { arity: number }>, targets: WeakMap<Function, object>): void {
    bridgeSources = sources;
    bridgeTargets = targets;
  },
};

interface ResultMarshal {
  readonly exportsSource: ExportsSource;
  readonly primitiveToHost: PrimitiveToHost;
  readonly miss: unknown;
  readonly callableToHost: CallableToHost;
}

const hostResultCallables = new WeakMap<Function, Function>();

/** (#7098) Convert a closure result the host is about to read; see the module comment. */
function closureResultToHost(result: unknown, m: ResultMarshal): unknown {
  if (typeof result !== "object" || result === null) return result;
  const exports = m.exportsSource.getExports();
  if (!isNativeRegime(exports)) return result;
  const primitive = m.primitiveToHost(result, exports);
  if (primitive !== m.miss) return primitive;
  const callable = m.callableToHost(result, m.exportsSource);
  return typeof callable === "function" ? withHostResult(callable, m) : callable;
}

/** (#7098) The host-facing twin of a dynamic closure bridge; anything else is returned as is. */
function withHostResult(fn: Function, m: ResultMarshal): Function {
  const target = bridgeSources?.get(fn)?.arity === -1 ? bridgeTargets?.get(fn) : undefined;
  if (target === undefined) return fn;
  const cached = hostResultCallables.get(fn);
  if (cached !== undefined) return cached;
  const adapter = function marshalledClosureResult(this: unknown, ...args: unknown[]) {
    return closureResultToHost(Reflect.apply(fn, this, args), m);
  };
  for (const key of ["name", "length"] as const)
    Object.defineProperty(adapter, key, { value: fn[key], configurable: true });
  hostResultCallables.set(fn, adapter);
  bridgeTargets!.set(adapter, target);
  return adapter;
}

function marshalArgsInPlace(args: unknown[], exports: Record<string, Function>, m: ResultMarshal): void {
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] !== "object" || args[i] === null) continue;
    const primitive = m.primitiveToHost(args[i], exports);
    if (primitive !== m.miss) {
      args[i] = primitive;
      continue;
    }
    const callable = m.callableToHost(args[i], m.exportsSource);
    args[i] = typeof callable === "function" ? withHostResult(callable, m) : callable;
  }
}

function isNativeRegime(exports: Record<string, Function> | undefined): exports is Record<string, Function> {
  return exports !== undefined && typeof exports.__str_is_native === "function";
}

type PrimitiveFromHost = (value: any, exports: Record<string, Function>) => unknown;

/** (#7095) User `declare function` bindings → the runtime's dynamic-slot adapter for their results. */
const declaredHostFunctions = new WeakMap<Function, PrimitiveFromHost>();

/** (#7095) Mark `fn` as the embedder binding of a user `declare function`, so it is marshalled. */
export function declaredHostFunction(fn: Function, primitiveFromHost: PrimitiveFromHost): Function {
  declaredHostFunctions.set(fn, primitiveFromHost);
  return fn;
}

export function marshalPlatformArgs(
  imp: { intent: { type: string }; refResult?: boolean },
  fn: Function,
  exportsSource: ExportsSource,
  primitiveToHost: PrimitiveToHost,
  miss: unknown,
  callableToHost: CallableToHost,
): Function {
  const m: ResultMarshal = { exportsSource, primitiveToHost, miss, callableToHost };
  const primitiveFromHost = declaredHostFunctions.get(fn);
  if (primitiveFromHost !== undefined) return marshalDeclaredHostFunction(imp, fn, m, primitiveFromHost);
  if (imp.intent.type !== "extern_class") return fn;
  return function marshalledPlatformImport(this: unknown, ...args: unknown[]) {
    const exports = exportsSource.getExports();
    if (isNativeRegime(exports)) marshalArgsInPlace(args, exports, m);
    return fn.apply(this, args);
  };
}

/**
 * (#7095) Marshal a user-declared ambient host function: carriers → JS values
 * on the way in; on the way out, a JS primitive result → its native carrier
 * when the import returns a reference. `primitiveFromHost` is the runtime's
 * dynamic-slot adapter (`_nativeDynamicFromHost`); objects and functions the
 * host returns pass through unchanged, exactly as before.
 */
function marshalDeclaredHostFunction(
  imp: { refResult?: boolean },
  fn: Function,
  m: ResultMarshal,
  primitiveFromHost: PrimitiveFromHost,
): Function {
  const refResult = imp.refResult === true;
  return function marshalledDeclaredImport(this: unknown, ...args: unknown[]) {
    const exports = m.exportsSource.getExports();
    if (!isNativeRegime(exports)) return fn.apply(this, args);
    marshalArgsInPlace(args, exports, m);
    const result = fn.apply(this, args);
    if (!refResult || (typeof result === "object" && result !== null) || typeof result === "function") return result;
    return primitiveFromHost(result, exports);
  };
}
