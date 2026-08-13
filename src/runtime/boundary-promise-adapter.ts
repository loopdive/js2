// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export interface BoundaryPromiseObserver {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export interface BoundaryPromiseAdapterContext {
  readonly getExports: () => Record<string, Function> | undefined;
  readonly takeObserver: (id: number, exports: Record<string, Function>) => BoundaryPromiseObserver | undefined;
  readonly toHostValue: (value: unknown, exports: Record<string, Function>) => unknown;
}

/** Bind one settlement notification for a Wasm-owned Promise boundary view. */
export function createBoundaryPromiseAdapter(
  operation: "resolve" | "reject",
  context: BoundaryPromiseAdapterContext,
): Function {
  return (id: number, value: unknown): void => {
    const exports = context.getExports();
    if (!exports) throw new TypeError("native Promise boundary is not wired to a module instance");
    const observer = context.takeObserver(id, exports);
    if (!observer) return;
    const hostValue = context.toHostValue(value, exports);
    if (operation === "resolve") observer.resolve(hostValue);
    else observer.reject(hostValue);
  };
}
