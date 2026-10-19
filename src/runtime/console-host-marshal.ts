// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Marshals explicit capabilities at the JS boundary. Dynamic console values
 * use an injected primitive converter; declared globals retain their exact
 * identity. Re-exporting the resolver keeps runtime.ts behind this seam.
 */
export { resolvePlatformCapabilityImport } from "./platform-capability-adapter.js";

interface ExportsSource {
  getExports(): Record<string, Function> | undefined;
  deferToExports?(operation: () => void): void;
}

export function wrapConsoleForHost(
  capability: Function,
  intent: { type: string; variant?: string; name?: string },
  exportsSource: ExportsSource | undefined,
  primitiveToHost: (value: any, exports: Record<string, Function> | undefined) => unknown,
  miss: unknown,
  fromHost?: (value: unknown, exports: Record<string, Function>) => unknown,
): Function {
  // Admit the exact object/function. During START, defer only admission until
  // setInstance publishes the owner; the value itself crosses unchanged.
  if (intent.type === "declared_global" && fromHost) {
    return () => {
      const value = capability();
      const exports = exportsSource?.getExports();
      if (!exports) {
        exportsSource?.deferToExports?.(() => {
          const installed = exportsSource.getExports();
          if (installed) fromHost(value, installed);
        });
      }
      return exports ? fromHost(value, exports) : value;
    };
  }
  if (intent.type !== "console_log" || intent.variant === undefined || intent.variant.endsWith("bool")) {
    return capability;
  }
  return function consoleWithHostPrimitives(value: unknown) {
    const primitive = primitiveToHost(value, exportsSource?.getExports());
    return capability(primitive === miss ? value : primitive);
  };
}
