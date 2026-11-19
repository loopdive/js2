// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../typescript.js";
import { isCurrentCompilerLibrarySourceFile } from "../../checker/index.js";
import { evalCalleeCall } from "../../eval-call-shape.js";

/**
 * (#7363) Whether an `eval` identifier denotes the realm's `eval` when it is called: its symbol is the lib's alone (no
 * local binding shadows it) and no source can rebind the global binding. Like the Number plan, the proof is
 * conservative and holds for the whole program or not at all: a top-level declaration named `eval` (the checker
 * reports a script's `var eval` as a duplicate and keeps resolving to the lib), any use of the binding other than as a
 * callee (`evalCalleeCall`), `globalThis`, or an `eval` property name or string anywhere refuses it.
 */
export function prepareRealmEvalResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
): { readonly isRealmEval: (identifier: ts.Identifier) => boolean } {
  const ambient = checker.resolveName("eval", undefined, ts.SymbolFlags.Value, false);
  let intact: boolean | undefined;
  const rebinds = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) {
      if (node.text === "globalThis" && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))
        return true;
      if (node.text === "eval") {
        const parent = node.parent;
        const declared =
          (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) &&
          parent.name === node;
        if (declared && !ts.findAncestor(parent.parent, ts.isFunctionLike)) return true;
        if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return true;
        if (checker.getSymbolAtLocation(node) === ambient && !evalCalleeCall(node)) return true;
      }
    }
    if (ts.isStringLiteralLike(node) && node.text === "eval") return true;
    return ts.forEachChild(node, rebinds) === true;
  };
  return {
    isRealmEval(identifier) {
      if (
        !ambient?.declarations?.length ||
        !ambient.declarations.every((node) => isCurrentCompilerLibrarySourceFile(node.getSourceFile())) ||
        checker.getSymbolAtLocation(identifier) !== ambient
      )
        return false;
      intact ??= !sourceFiles.some(rebinds);
      return intact;
    },
  };
}
