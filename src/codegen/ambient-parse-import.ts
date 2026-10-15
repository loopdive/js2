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
  const linked = ctx.linkedPackageBindings.get(name);
  const imported = addImport(ctx, linked?.module ?? ctx.externImportModule ?? "env", linked?.field ?? name, {
    kind: "func",
    typeIdx,
  });
  if (imported && imported.module === "env" && !isEcmaScriptLibFile(sourceFile)) {
    (ctx.mod.declaredFunctionImports ??= new Set()).add(imported.name);
  }
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

/**
 * (#6979) An ECMAScript standard-library declaration file (`lib.es5.d.ts`,
 * `lib.es2015.*.d.ts`, ...). A global function declared there is language
 * semantics, never an embedder capability, so it does not get the
 * `declared_function` intent.
 */
function isEcmaScriptLibFile(sourceFile: ts.SourceFile): boolean {
  return sourceFile.isDeclarationFile && /(?:^|[\\/])lib\.es[^\\/]*\.d\.ts$/.test(sourceFile.fileName);
}
