// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "../typescript.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import { prepareConversionResolvers } from "./prepare-number-conversion.js";
import { prepareObjectCreateResolver } from "./prepare-object-create.js";
import { prepareObjectStaticsResolver } from "./prepare-object-statics.js";
import { prepareOrdinaryObjectAccessResolver } from "./prepare-ordinary-object-access.js";

/** The source facts every builtin plan of a Prepared program is proved over. */
export interface SourceBuiltinInput {
  readonly checker: ts.TypeChecker;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly policy: Pick<RuntimeManifestPolicy, "backend" | "target">;
}

/**
 * The source-owned call and read plans of the units lowered from `roots`, combined; no physical provider is selected
 * here. The plans that bind the native realm's objects exist only on standalone WasmGC.
 */
export function prepareSourceBuiltinResolvers(
  { checker, sourceFiles, policy }: SourceBuiltinInput,
  roots: ts.FunctionDeclaration | readonly ts.Statement[],
  isDynamicModuleBinding: (identifier: ts.Identifier) => boolean,
) {
  return {
    ...prepareConversionResolvers(checker, sourceFiles, roots),
    ...prepareOrdinaryObjectAccessResolver(checker, sourceFiles, roots),
    ...(policy.target === "standalone" && policy.backend === "wasmgc"
      ? {
          ...prepareObjectCreateResolver(checker, sourceFiles, roots),
          ...prepareObjectStaticsResolver(checker, sourceFiles, isDynamicModuleBinding),
        }
      : {}),
  };
}
