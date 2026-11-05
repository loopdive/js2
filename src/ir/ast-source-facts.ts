// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { AstToIrOptions } from "./from-ast.js";
import type { ts } from "../ts-api.js";

type AstSourceFacts = Pick<
  AstToIrOptions,
  "checker" | "oracle" | "numericLocalScalarForDecl" | "hostDynamicClassMethodNames"
>;

/** Forward the same source-oracle identities to free, lifted and module bodies. */
export function projectAstSourceFacts(source: {
  readonly checker: AstToIrOptions["checker"];
  readonly oracle: AstToIrOptions["oracle"];
  readonly usageInference: { scalarForDecl(decl: ts.VariableDeclaration): "number" | undefined };
  readonly hostDynamicClassMethodNames: AstToIrOptions["hostDynamicClassMethodNames"];
}): AstSourceFacts {
  return {
    checker: source.checker,
    oracle: source.oracle,
    // Share direct codegen's grounded numeric-local oracle (#3765).
    numericLocalScalarForDecl: (decl) => source.usageInference.scalarForDecl(decl),
    hostDynamicClassMethodNames: source.hostDynamicClassMethodNames,
  };
}
