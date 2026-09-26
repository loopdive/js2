// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6685) The console platform capability, marshalled for the JS host.
 *
 * Under the native regime a dynamic `console.log(x)` argument (the test262
 * harness `print(x)` is untyped) can be a Wasm-owned primitive carrier — a
 * native string or a boxed number — which the host console cannot stringify.
 * The resolved capability is therefore wrapped so those carriers arrive as JS
 * values. The conversion service is INJECTED (the runtime's primitive
 * converter plus its "not mine" sentinel), so this module never imports
 * runtime.ts; values the converter does not own pass through unchanged, and
 * the boolean variants (an i32 argument) are left alone.
 *
 * `resolvePlatformCapabilityImport` is re-exported so the runtime reaches the
 * platform capabilities through this one seam.
 */
export { resolvePlatformCapabilityImport } from "./platform-capability-adapter.js";

type ExportsSource = { getExports(): Record<string, Function> | undefined } | undefined;

export function wrapConsoleForHost(
  capability: Function,
  intent: { type: string; variant?: string },
  exportsSource: ExportsSource,
  primitiveToHost: (value: any, exports: Record<string, Function> | undefined) => unknown,
  miss: unknown,
): Function {
  if (intent.type !== "console_log" || intent.variant === undefined || intent.variant.endsWith("bool")) {
    return capability;
  }
  return function consoleWithHostPrimitives(value: unknown) {
    const primitive = primitiveToHost(value, exportsSource?.getExports());
    return capability(primitive === miss ? value : primitive);
  };
}
