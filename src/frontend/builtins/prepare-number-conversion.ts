// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../typescript.js";
import { isCurrentCompilerLibrarySourceFile } from "../../checker/index.js";
import { isPristineIntrinsic } from "../../shared/intrinsic-prototype-writes.js";

/**
 * Source binding evidence for direct calls `Name(…)` of one ambient conversion constructor; the conversion's
 * semantics require their own provider. Admits a call only against the lib declaration. `binding` says what else
 * must hold program-wide: `"pristine"` — the realm keeps its own value under the name (G1's `isPristineIntrinsic`
 * at every occurrence: no source declaration, which the checker would not report for a script's top-level
 * `function String() {}`, no write, delete or define, no enclosing `with`), whatever value reads the program makes;
 * `"unaliased"` — in addition, the binding is never read as a value (an alias could be stored or rebound).
 */
function ambientConversionCalls(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
  name: "Number" | "String",
  binding: "pristine" | "unaliased",
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
    if (ts.isIdentifier(node) && binding === "pristine") {
      if (node.text === name && !isPristineIntrinsic(node)) invalidated = true;
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
  return { preparedNumberCall: ambientConversionCalls(checker, sourceFiles, declaration, "Number", "unaliased") };
}

/**
 * (#7354 Str2) The Prepared program's conversion plans: `Number(v)` and `String(v)`. from-ast asks the `String`
 * question of the callee identifier (`isAmbientStringBinding`), so only the callee of an admitted direct call
 * answers yes; every other read of `String` (`String.fromCharCode`, `new String(v)`, `typeof String`) keeps its
 * own refusal. (#7350) The `String` plan holds while the realm's `String` is pristine, independent of value reads:
 * a read of the value (`map.call(a, String)`, `String: globalThis.String` in the harness prelude) is the global
 * object's business (#7350 G1 / B2b) and cannot rebind the name, while a declaration, write, delete or define of
 * `String` anywhere in the program withdraws the plan.
 */
export function prepareConversionResolvers(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
) {
  const stringCall = ambientConversionCalls(checker, sourceFiles, declaration, "String", "pristine");
  return {
    ...prepareNumberConversionResolver(checker, sourceFiles, declaration),
    isAmbientStringBinding: (node: ts.Identifier): boolean =>
      ts.isCallExpression(node.parent) && node.parent.expression === node && stringCall(node.parent),
  };
}
