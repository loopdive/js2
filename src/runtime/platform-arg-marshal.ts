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
 */

type ExportsSource = { getExports(): Record<string, Function> | undefined };

export function marshalPlatformArgs(
  imp: { intent: { type: string } },
  fn: Function,
  exportsSource: ExportsSource,
  primitiveToHost: (value: any, exports: Record<string, Function>) => unknown,
  miss: unknown,
  callableToHost: (value: any, exportsSource: ExportsSource) => unknown,
): Function {
  if (imp.intent.type !== "extern_class") return fn;
  return function marshalledPlatformImport(this: unknown, ...args: unknown[]) {
    const exports = exportsSource.getExports();
    if (exports && typeof exports.__str_is_native === "function") {
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] !== "object" || args[i] === null) continue;
        const primitive = primitiveToHost(args[i], exports);
        args[i] = primitive !== miss ? primitive : callableToHost(args[i], exportsSource);
      }
    }
    return fn.apply(this, args);
  };
}
