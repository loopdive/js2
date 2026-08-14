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
