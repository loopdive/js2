// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export type IrCompileRoute =
  | "compile"
  | "compileSourceSync"
  | "compileMulti"
  | "compileFiles"
  | "compileProject"
  | "incremental.compile"
  | "incremental.compileMulti";

export type IrBodyRouteAuditPipeline = "legacy" | "whole-program";

export type IrCodegenGenerator = "generateModule" | "generateMultiModule" | "generateWholeProgramModule";

export interface IrCompileRouteManifestEntry {
  readonly graph: "single" | "multi";
  readonly generator: IrCodegenGenerator;
}

/** Canonical public-entry graph and legacy-generator routing contract. */
export const IR_COMPILE_ROUTE_MANIFEST: Readonly<Record<IrCompileRoute, IrCompileRouteManifestEntry>> = Object.freeze({
  compile: Object.freeze({ graph: "single", generator: "generateModule" }),
  compileSourceSync: Object.freeze({ graph: "single", generator: "generateModule" }),
  compileMulti: Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
  compileFiles: Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
  compileProject: Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
  "incremental.compile": Object.freeze({ graph: "single", generator: "generateModule" }),
  "incremental.compileMulti": Object.freeze({ graph: "multi", generator: "generateMultiModule" }),
});

/** Select an exact audit contract before a generator enters the session. */
export function irCompileRouteManifestEntry(
  route: IrCompileRoute,
  pipeline: IrBodyRouteAuditPipeline,
): IrCompileRouteManifestEntry {
  const legacy = IR_COMPILE_ROUTE_MANIFEST[route];
  switch (pipeline) {
    case "legacy":
      return legacy;
    case "whole-program":
      return Object.freeze({ graph: legacy.graph, generator: "generateWholeProgramModule" });
    default:
      throw new Error(`Unknown IR body-route audit pipeline: ${String(pipeline)}`);
  }
}
