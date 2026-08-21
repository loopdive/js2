// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export type IrCompileRoute =
  | "compile"
  | "compileSourceSync"
  | "compileMulti"
  | "compileFiles"
  | "compileProject"
  | "incremental.compile"
  | "incremental.compileMulti";

export interface IrCompileRouteManifestEntry {
  readonly graph: "single" | "multi";
  readonly generator: "generateModule" | "generateMultiModule";
}

/** Canonical public-entry to WasmGC-generator routing contract. */
export const IR_COMPILE_ROUTE_MANIFEST: Readonly<Record<IrCompileRoute, IrCompileRouteManifestEntry>> = Object.freeze({
  compile: Object.freeze({ graph: "single", generator: "generateModule" }),
  compileSourceSync: Object.freeze({ graph: "single", generator: "generateModule" }),
  compileMulti: Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
  compileFiles: Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
  compileProject: Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
  "incremental.compile": Object.freeze({ graph: "single", generator: "generateModule" }),
  "incremental.compileMulti": Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
});
