// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../typescript.js";
import { isCurrentCompilerLibrarySourceFile } from "../../checker/index.js";

/** Source binding evidence only; native Number semantics require their own provider. */
export function prepareNumberConversionResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
): { readonly preparedNumberCall: (call: ts.CallExpression) => boolean } {
  const calls = new WeakSet<ts.CallExpression>();
  const ambient = checker.resolveName("Number", undefined, ts.SymbolFlags.Value, false);
  const canonical = (): boolean =>
    !!ambient?.declarations?.length &&
    ambient.declarations.every((node) => isCurrentCompilerLibrarySourceFile(node.getSourceFile()));
  const shape = (call: ts.CallExpression): boolean =>
    ts.isIdentifier(call.expression) &&
    call.expression.text === "Number" &&
    checker.getSymbolAtLocation(call.expression) === ambient &&
    !call.questionDotToken &&
    !call.typeArguments?.length &&
    !call.arguments.some(ts.isSpreadElement);
  const roots: readonly ts.Node[] = "kind" in declaration ? [declaration] : declaration;
  let invalidated = roots.some((root) => !sourceFiles.includes(root.getSourceFile())) || !canonical();
  const inspect = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      // A bare constructor alias can subsequently be stored/rebound by arbitrary
      // consumers. Admit only direct calls, never infer identity through aliases.
      if (
        symbol === ambient &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node && shape(node.parent))
      )
        invalidated = true;
      // Conservatively reject global-object escape, computed writes, reflective
      // mutation and destructuring targets alike. A shadowed spelling also refuses
      // this optimization; the spelling never grants builtin authority.
      if (node.text === "globalThis" && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node))
        invalidated = true;
    }
    ts.forEachChild(node, inspect);
  };
  sourceFiles.forEach(inspect);
  const collect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && shape(node)) {
      const signature = checker.getResolvedSignature(node);
      if (signature?.declaration && isCurrentCompilerLibrarySourceFile(signature.declaration.getSourceFile()))
        calls.add(node);
    }
    ts.forEachChild(node, collect);
  };
  if (!invalidated) roots.forEach(collect);
  return {
    preparedNumberCall(call) {
      if (invalidated || !canonical() || !calls.has(call) || !shape(call)) return false;
      const signature = checker.getResolvedSignature(call);
      return !!signature?.declaration && isCurrentCompilerLibrarySourceFile(signature.declaration.getSourceFile());
    },
  };
}
