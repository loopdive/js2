// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 V) The IR's own home for a SCRIPT `var`, for a pipeline with no legacy
 * slot to share (the Prepared whole-program path). Codegen's `scriptVarHome`
 * names the carrier of the `__mod_<name>` slot legacy allocated; here the IR
 * allocates the global itself, so the home follows from the checker type and
 * the binding's uses alone, in the same `IrScriptVarHome` vocabulary the
 * resolver already reads.
 *
 * The `typed` home is a `number` or `boolean` binding whose reads all follow
 * its initializer (`scriptVarReadsFollowInitializer`), since an `f64` or `i32`
 * global cannot hold the hoisted `undefined`, and whose stored values are all
 * typed. (#7354 H) Where the lane has the dynamic carrier, every other
 * top-level script `var` gets the `dynamic` home: the carrier holds `undefined`
 * before the initializer runs, so it needs no reads proof, and a value the
 * carrier cannot hold yet is refused at its store, not here. A string home
 * needs the presentation's string policies (#7354 Str).
 *
 * Not shared with codegen's classifier: that one reads back the slot legacy's
 * allocation chose (including legacy's own zero for an unwritten typed slot),
 * so a common core would either change legacy's answer or inherit its zero.
 */
import { GLOBAL_CONSTANTS } from "../shared/ambient-intrinsics.js";
import { isJsPropertyDeclarationTarget } from "../shared/binding-writes.js";
import { ts } from "../ts-api.js";
import { type NamedVariableDeclaration, scriptVarReadsFollowInitializer } from "./module-binding-script-var.js";
import { type IrModuleBindingDeclaration, type IrScriptVarHome, moduleBindingDeclarations } from "./module-bindings.js";
import { IrUnsupportedError } from "./outcomes.js";
import { moduleDeclares } from "./select-planned-closure-operands.js";

/**
 * The `scriptVarHome` resolver option of a pipeline whose IR owns every script `var`'s storage, over the
 * program's `sourceFiles`. Every script of a program shares one global scope, and the reads proof walks only the
 * declaration's file, so a typed home needs that file to be the program's only source: a read in a script that
 * runs first would otherwise go unseen. The dynamic home needs it too: each script's module-init stores the
 * hoisted `undefined` into its own globals, so a script that runs first would read the carrier's null.
 * `storesDynamic` (the lane's dynamic provenance, absent without a carrier) says whether a store may be the
 * dynamic value.
 */
export function irOwnedScriptVarHome(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  storesDynamic?: (declaration: ts.VariableDeclaration) => boolean,
): (declaration: IrModuleBindingDeclaration) => IrScriptVarHome | undefined {
  const soleSource = sourceFiles.length === 1 ? sourceFiles[0] : undefined;
  return (declaration) => {
    if (!isNamedVariableDeclaration(declaration)) return undefined;
    // A script `var` only: the resolver asks for nothing else, but the dynamic provenance asks for every
    // top-level variable, and a lexical or ES-module global is typed by the resolver.
    if ((declaration.parent.flags & ts.NodeFlags.BlockScoped) !== 0 || ts.isExternalModule(declaration.getSourceFile()))
      return undefined;
    // (#7354 Fa, N1) The var's home would not hold the hoisted function, and a direct call of the name binds the
    // declaration: a script var sharing its name with a function declaration has no sound home.
    if (moduleDeclares(declaration.getSourceFile(), declaration.name.text, true))
      throw new IrUnsupportedError(
        "type-resolution-unsupported",
        "build",
        `script var ${declaration.name.text} shares its binding with a function declaration`,
      );
    // A script `var` of a non-writable global value property never stores.
    if (declaration.getSourceFile() !== soleSource || GLOBAL_CONSTANTS.has(declaration.name.text)) return undefined;
    // (#7372 1b) A repeated `var` is one binding: the home is its first declarator's (the resolver's canonical one),
    // each later one a write. A JS property declaration on the binding (`o.p = v`, `Object.defineProperty(o, …)`)
    // declares no binding; the call itself is refused by name where from-ast meets it (#7364).
    const declarators = moduleBindingDeclarations(declaration.name, checker);
    const declarations = checker.getSymbolAtLocation(declaration.name)?.declarations ?? [];
    const own = (other: ts.Declaration) =>
      !other.getSourceFile().isDeclarationFile && !isJsPropertyDeclarationTarget(other);
    if (declarators[0] !== declaration || declarations.filter(own).length !== declarators.length) return undefined;
    const type = checker.getTypeAtLocation(declaration.name);
    // A TypeScript annotation other than `any` is the binding's contract: the binding gets the typed home or none,
    // never the dynamic one. A store of a value the checker types `any` into it is then refused by the resolver's
    // retype rule ("unsupported"), which names the binding.
    const annotated = declaration.type !== undefined && type !== checker.getAnyType();
    if (
      (type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) !== 0 &&
      scriptVarReadsFollowInitializer(checker, declaration) &&
      (annotated || !storesDynamic?.(declaration))
    )
      return "typed";
    // (#7372) A `var` nested in top-level code has the same global; its reads never follow a proven initializer.
    return storesDynamic && !annotated ? "dynamic" : undefined;
  };
}

function isNamedVariableDeclaration(declaration: IrModuleBindingDeclaration): declaration is NamedVariableDeclaration {
  return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name);
}
