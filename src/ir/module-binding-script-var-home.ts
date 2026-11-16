// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 V) The IR's own home for a SCRIPT `var`, for a pipeline with no legacy
 * slot to share (the Prepared whole-program path). Codegen's `scriptVarHome`
 * names the carrier of the `__mod_<name>` slot legacy allocated; here the IR
 * allocates the global itself, so the home follows from the checker type and
 * the binding's uses alone, in the same `IrScriptVarHome` vocabulary the
 * resolver already reads.
 *
 * Only the `typed` home is answered: a `number` or `boolean` binding whose reads
 * all follow its initializer (`scriptVarReadsFollowInitializer`), since an `f64`
 * or `i32` global cannot hold the hoisted `undefined`. A string home needs the
 * presentation's string policies (#7354 S) and a dynamic one the Prepared
 * dynamic carrier (#7354 D1); until then those bindings have no home.
 *
 * Not shared with codegen's classifier: that one reads back the slot legacy's
 * allocation chose (including legacy's own zero for an unwritten typed slot),
 * so a common core would either change legacy's answer or inherit its zero.
 */
import { ts } from "../ts-api.js";
import { type NamedVariableDeclaration, scriptVarReadsFollowInitializer } from "./module-binding-script-var.js";
import type { IrModuleBindingDeclaration, IrScriptVarHome } from "./module-bindings.js";

/** The global object's non-writable value properties: a script `var` of one of these names never stores. */
const NON_WRITABLE_GLOBALS: ReadonlySet<string> = new Set(["undefined", "NaN", "Infinity"]);

/**
 * The `scriptVarHome` resolver option of a pipeline whose IR owns every script `var`'s storage, over the
 * program's `sourceFiles`. Every script of a program shares one global scope, and the reads proof walks only the
 * declaration's file, so a typed home needs that file to be the program's only source: a read in a script that
 * runs first would otherwise go unseen.
 */
export function irOwnedScriptVarHome(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
): (declaration: IrModuleBindingDeclaration) => IrScriptVarHome | undefined {
  const soleSource = sourceFiles.length === 1 ? sourceFiles[0] : undefined;
  return (declaration) => {
    if (!isNamedVariableDeclaration(declaration)) return undefined;
    if (declaration.getSourceFile() !== soleSource || NON_WRITABLE_GLOBALS.has(declaration.name.text)) return undefined;
    // The startup plan gives every declarator its own binding, so a repeated `var` has no single global yet.
    const declarations = checker.getSymbolAtLocation(declaration.name)?.declarations ?? [];
    if (declarations.filter((other) => !other.getSourceFile().isDeclarationFile).length !== 1) return undefined;
    const type = checker.getTypeAtLocation(declaration.name);
    if ((type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) === 0) return undefined;
    return scriptVarReadsFollowInitializer(checker, declaration) ? "typed" : undefined;
  };
}

function isNamedVariableDeclaration(declaration: IrModuleBindingDeclaration): declaration is NamedVariableDeclaration {
  return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name);
}
