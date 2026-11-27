// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../typescript.js";
import { isCurrentCompilerLibrarySourceFile } from "../../checker/index.js";

/** (#7350) The realm keeps its own value under the callee's name (`pristineBuiltinGlobal`, `src/ir`). */
type Pristine = (identifier: ts.Identifier) => boolean;

/**
 * Source binding evidence for direct calls `Name(…)` of one ambient conversion function; the conversion's
 * semantics require their own provider. Admits a call only against the lib declaration. `binding` says what else
 * must hold program-wide: a {@link Pristine} predicate — the callee is the pristine global (no source declares or
 * writes it, which the checker would not report for a script's top-level `function String() {}`), whatever value
 * reads the program makes; `"unaliased"` — the binding is never read as a value anywhere in the program (an alias
 * could be stored or rebound).
 */
function ambientConversionCalls(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
  name: "Number" | "String" | "Boolean" | "isNaN",
  binding: Pristine | "unaliased",
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
  const pristine = binding === "unaliased" ? () => true : binding;
  const inspect = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
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
  if (binding === "unaliased") sourceFiles.forEach(inspect);
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
    if (invalidated || !canonical() || !calls.has(call) || !shape(call) || !pristine(call.expression as ts.Identifier))
      return false;
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
 * (#7354 Str2) The Prepared program's conversion plans: `Number(v)`, `String(v)`, (#7350 B3a) `Boolean(v)` and
 * (#7354 T) `isNaN(v)`, `Number(v)`'s ToNumber and a NaN test (§19.2.3). from-ast asks the `String` question of the
 * callee identifier (`isAmbientStringBinding`), so only the callee of an admitted direct call answers yes. (#7350) Each
 * plan holds while the realm's global is pristine, independent of value reads: a read of the value
 * (`map.call(a, String)` in the harness prelude, `var N = Number`) is the realm's own value (`identifier-read.ts`) and
 * cannot rebind the name, while a declaration or write of it anywhere in the program withdraws the plan.
 */
export function prepareConversionResolvers(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.FunctionDeclaration | readonly ts.Statement[],
  pristine: Pristine,
) {
  const plan = (name: "Number" | "String" | "Boolean" | "isNaN") =>
    ambientConversionCalls(checker, sourceFiles, declaration, name, pristine);
  const stringCall = plan("String");
  return {
    preparedNumberCall: plan("Number"),
    preparedBooleanCall: plan("Boolean"),
    isAmbientStringBinding: (node: ts.Identifier): boolean =>
      ts.isCallExpression(node.parent) && node.parent.expression === node && stringCall(node.parent),
    preparedIsNaNCall: plan("isNaN"),
  };
}
