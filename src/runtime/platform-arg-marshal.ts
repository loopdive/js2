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
 */

type ExportsSource = { getExports(): Record<string, Function> | undefined };
type PrimitiveToHost = (value: any, exports: Record<string, Function>) => unknown;
type CallableToHost = (value: any, exportsSource: ExportsSource) => unknown;

function marshalArgsInPlace(
  args: unknown[],
  exports: Record<string, Function>,
  exportsSource: ExportsSource,
  primitiveToHost: PrimitiveToHost,
  miss: unknown,
  callableToHost: CallableToHost,
): void {
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] !== "object" || args[i] === null) continue;
    const primitive = primitiveToHost(args[i], exports);
    args[i] = primitive !== miss ? primitive : callableToHost(args[i], exportsSource);
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
  const primitiveFromHost = declaredHostFunctions.get(fn);
  if (primitiveFromHost !== undefined) {
    return marshalDeclaredHostFunction(
      imp,
      fn,
      exportsSource,
      primitiveToHost,
      miss,
      callableToHost,
      primitiveFromHost,
    );
  }
  if (imp.intent.type !== "extern_class") return fn;
  return function marshalledPlatformImport(this: unknown, ...args: unknown[]) {
    const exports = exportsSource.getExports();
    if (isNativeRegime(exports))
      marshalArgsInPlace(args, exports, exportsSource, primitiveToHost, miss, callableToHost);
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
  exportsSource: ExportsSource,
  primitiveToHost: PrimitiveToHost,
  miss: unknown,
  callableToHost: CallableToHost,
  primitiveFromHost: PrimitiveFromHost,
): Function {
  const refResult = imp.refResult === true;
  return function marshalledDeclaredImport(this: unknown, ...args: unknown[]) {
    const exports = exportsSource.getExports();
    if (!isNativeRegime(exports)) return fn.apply(this, args);
    marshalArgsInPlace(args, exports, exportsSource, primitiveToHost, miss, callableToHost);
    const result = fn.apply(this, args);
    if (!refResult || (typeof result === "object" && result !== null) || typeof result === "function") return result;
    return primitiveFromHost(result, exports);
  };
}
