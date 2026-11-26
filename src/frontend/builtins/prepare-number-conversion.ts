// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../typescript.js";
import { isCurrentCompilerLibrarySourceFile } from "../../checker/index.js";
import { isUndeclaredInFile } from "../../shared/ambient-intrinsics.js";

/**
 * Source binding evidence for direct calls `Name(…)` of one ambient conversion function; the conversion's
 * semantics require their own provider. Admits a call only against the lib declaration, and only while no source
 * file declares the name (the checker reports a script's top-level `function String() {}` as the lib declarations
 * alone) and, unless `escapesRefuse`, the binding is never read as a value anywhere in the program (an alias could
 * be stored or rebound). `escapesRefuse` is the Prepared program's guarantee that every such read already refuses
 * by name.
 */
function ambientConversionCalls(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
  name: "Number" | "String" | "isNaN",
  escapesRefuse: boolean,
): (call: ts.CallExpression) => boolean {
  const calls = new WeakSet<ts.CallExpression>();
  const ambient = checker.resolveName(name, undefined, ts.SymbolFlags.Value, false);
  const canonical = (): boolean =>
    !!ambient?.declarations?.length &&
    ambient.declarations.every((node) => isCurrentCompilerLibrarySourceFile(node.getSourceFile()));
  const shape = (call: ts.CallExpression): boolean =>
    ts.isIdentifier(call.expression) &&
    call.expression.text === name &&
    checker.getSymbolAtLocation(call.expression) === ambient &&
    !call.questionDotToken &&
    !call.typeArguments?.length &&
    !call.arguments.some(ts.isSpreadElement);
  const roots: readonly ts.Node[] = "kind" in declaration ? [declaration] : declaration;
  let invalidated = roots.some((root) => !sourceFiles.includes(root.getSourceFile())) || !canonical();
  const inspect = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && escapesRefuse) {
      if (node.text === name && !isUndeclaredInFile(node)) invalidated = true;
    } else if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      // A bare constructor alias can subsequently be stored/rebound by arbitrary
      // consumers. Admit only direct calls, never infer identity through aliases.
      // (#7106 module-init lever B) The receiver of a member access
      // (`Number.MAX_VALUE`, `Number.prototype.x`) and the callee of
      // `new Number(…)` leave the binding itself untouched — neither reads
      // `Number` as a value that could be stored or rebound. test262 bodies
      // read the constants beside their `Number(v)` calls, so those spellings
      // keep the plan.
      if (
        symbol === ambient &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node && shape(node.parent)) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) &&
        !(ts.isNewExpression(node.parent) && node.parent.expression === node)
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
  return (call) => {
    if (invalidated || !canonical() || !calls.has(call) || !shape(call)) return false;
    const signature = checker.getResolvedSignature(call);
    return !!signature?.declaration && isCurrentCompilerLibrarySourceFile(signature.declaration.getSourceFile());
  };
}

/** Source binding evidence only; native Number semantics require their own provider. */
export function prepareNumberConversionResolver(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
): { readonly preparedNumberCall: (call: ts.CallExpression) => boolean } {
  return { preparedNumberCall: ambientConversionCalls(checker, sourceFiles, declaration, "Number", false) };
}

/**
 * (#7354 Str2) The Prepared program's conversion plans: `Number(v)` and `String(v)`. from-ast asks the `String`
 * question of the callee identifier (`isAmbientStringBinding`), so only the callee of an admitted direct call
 * answers yes; every other read of `String` (`String.fromCharCode`, `new String(v)`, `typeof String`) keeps its
 * own refusal. The `String` plan is not invalidated by an escape: the Prepared program is closed, and every way to
 * rebind the ambient `String` (a value read of `String` or `globalThis`, an assignment) refuses by name
 * (tests/issue-7354-str2-to-string.test.ts pins each), while a program's own `String` declaration is not the lib
 * symbol. The harness prelude escapes both (`String: globalThis.String`, `map.call(a, String)`), so the
 * invalidation would deny its every `String(v)`. (#7354 T) `isNaN(v)` is `Number(v)`'s ToNumber and a NaN test
 * (§19.2.3), admitted by the same proof as `String(v)`.
 */
export function prepareConversionResolvers(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
) {
  const stringCall = ambientConversionCalls(checker, sourceFiles, declaration, "String", true);
  return {
    ...prepareNumberConversionResolver(checker, sourceFiles, declaration),
    isAmbientStringBinding: (node: ts.Identifier): boolean =>
      ts.isCallExpression(node.parent) && node.parent.expression === node && stringCall(node.parent),
    preparedIsNaNCall: ambientConversionCalls(checker, sourceFiles, declaration, "isNaN", true),
  };
}
