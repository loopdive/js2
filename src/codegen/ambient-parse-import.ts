// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { addImport } from "./registry/imports.js";

/** Register an ambient parse import and preserve its compiler-owned identity. */
export function registerAmbientParseImport(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  name: string,
  typeIdx: number,
): void {
  const imported = addImport(ctx, ctx.externImportModule ?? "env", name, { kind: "func", typeIdx });
  // Prepared IR parse calls must reuse this exact default-library slot.
  // Without the sidecar, collectParseImports mistakes it for a source shadow
  // and emits a duplicate adapter binding (#4585). Both the syntactic and
  // checker lib scanners retain SourceFile's no-default-lib provenance.
  if (
    !imported ||
    !sourceFile.isDeclarationFile ||
    !sourceFile.hasNoDefaultLib ||
    (name !== "parseInt" && name !== "parseFloat")
  ) {
    return;
  }
  const builtinIdx = ctx.funcMap.get(name);
  if (builtinIdx !== undefined) ctx.ambientBuiltinFuncMap.set(name, builtinIdx);
}
