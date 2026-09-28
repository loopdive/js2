// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { UnsafeTypeAssumption } from "./semantic-safety-types.js";

/** #5402: reject a known name-based intrinsic dispatch that ignores a parameter. */
export function collectUnsafeBuiltinShadowing(checker: ts.TypeChecker, file: ts.SourceFile): UnsafeTypeAssumption[] {
  const errors: UnsafeTypeAssumption[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Number") {
      const declaration = checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
      if (declaration && ts.isParameter(declaration)) {
        errors.push({
          node,
          id: "JS2WASM_UNSUPPORTED_NUMBER_PARAMETER_CALL",
          message:
            "Calls through a parameter named Number currently dispatch to the global builtin instead of the callback. Rename this parameter before compiling (#5402).",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return errors;
}
