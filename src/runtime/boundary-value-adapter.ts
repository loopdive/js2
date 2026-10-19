// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ImportIntent } from "../index.js";

export type BoundaryValueImportIntent = Extract<
  ImportIntent,
  { type: "boundary_object" | "boundary_callback" | "boundary_promise" }
>;

export interface BoundaryValueAdapterFactories {
  readonly object: (operation: Extract<ImportIntent, { type: "boundary_object" }>["operation"]) => Function;
  readonly callback: (arity: number) => Function;
  readonly promise: (operation: "resolve" | "reject") => Function;
}

export function isBoundaryValueImportIntent(intent: ImportIntent): intent is BoundaryValueImportIntent {
  return intent.type === "boundary_object" || intent.type === "boundary_callback" || intent.type === "boundary_promise";
}

/** Resolve a typed boundary intent without consulting its Wasm import spelling. */
export function createBoundaryValueAdapter(
  intent: BoundaryValueImportIntent,
  factories: BoundaryValueAdapterFactories,
): Function {
  switch (intent.type) {
    case "boundary_object":
      return factories.object(intent.operation);
    case "boundary_callback":
      return factories.callback(intent.arity);
    case "boundary_promise":
      return factories.promise(intent.operation);
  }
}

/**
 * (#6980) A JS exception raised inside a boundary operation (a host
 * `[Symbol.iterator]` / `next` / getter / callback that throws) is a FOREIGN
 * exception to the module: its `try_table (catch $__exn)` cannot see it, so
 * `try { const [x] = hostIterable } catch {}` let the error escape. Rethrow it
 * on the module's own exception tag with the thrown value marshalled like any
 * other host value; an uncaught one unwraps back to the same JS value at the
 * export boundary (`normalizeModuleCallbackException`). Module-tag exceptions
 * (a nested Wasm callback's own throw) and modules without an exported tag
 * pass through unchanged.
 */
export function withModuleTagThrow(
  fn: Function,
  callbackState: { getExports: () => Record<string, any> | undefined } | undefined,
  fromHostValue: (value: unknown, exports: Record<string, any>) => any,
): Function {
  return function (this: unknown, ...args: unknown[]) {
    try {
      return fn.apply(this, args);
    } catch (error) {
      const WasmException = typeof WebAssembly === "undefined" ? undefined : (WebAssembly as any).Exception;
      if (typeof WasmException !== "function" || error instanceof WasmException) throw error;
      const exports = callbackState?.getExports();
      const tag = exports?.__exn_tag;
      if (!(tag instanceof (WebAssembly as any).Tag)) throw error;
      throw new WasmException(tag, [fromHostValue(error, exports!)]);
    }
  };
}
