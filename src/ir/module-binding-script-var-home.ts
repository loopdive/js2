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
import { isMemberWriteDeclaration } from "../shared/binding-writes.js";
import { ts } from "../ts-api.js";
import { type NamedVariableDeclaration, scriptVarReadsFollowInitializer } from "./module-binding-script-var.js";
import type { IrModuleBindingDeclaration, IrScriptVarHome } from "./module-bindings.js";

/** The global object's non-writable value properties: a script `var` of one of these names never stores. */
const NON_WRITABLE_GLOBALS: ReadonlySet<string> = new Set(["undefined", "NaN", "Infinity"]);

/**
 * The `scriptVarHome` resolver option of a pipeline whose IR owns every script `var`'s storage, over the
 * program's `startupSources`: every source but its called eval sources (#7363 A3). Every script of a program
 * shares one global scope, and the reads proof walks only the declaration's file, so a typed home needs that file
 * to be the program's only startup source: a read in a script that runs first would otherwise go unseen. The
 * dynamic home needs it too: each script's module-init stores the hoisted `undefined` into its own globals, so a
 * script that runs first would read the carrier's null. A called eval source breaks neither rule. It declares
 * nothing, so it stores no hoisted `undefined` and owns no binding asked about here. It runs only from its site in
 * the startup source, after that source's prologue. And the site is a direct eval, so its caller has no typed
 * home (`sourceRunsDynamicCode`) and no write list (`hasDynamicScope`): no proof the eval text's uses could break.
 * `storesDynamic` (the lane's dynamic provenance, absent without a carrier) says whether a store may be the
 * dynamic value.
 */
export function irOwnedScriptVarHome(
  checker: ts.TypeChecker,
  startupSources: readonly ts.SourceFile[],
  storesDynamic?: (declaration: ts.VariableDeclaration) => boolean,
): (declaration: IrModuleBindingDeclaration) => IrScriptVarHome | undefined {
  const soleSource = startupSources.length === 1 ? startupSources[0] : undefined;
  return (declaration) => {
    if (!isNamedVariableDeclaration(declaration)) return undefined;
    // A script `var` only: the resolver asks for nothing else, but the dynamic provenance asks for every
    // top-level variable, and a lexical or ES-module global is typed by the resolver.
    if ((declaration.parent.flags & ts.NodeFlags.BlockScoped) !== 0 || ts.isExternalModule(declaration.getSourceFile()))
      return undefined;
    if (declaration.getSourceFile() !== soleSource || NON_WRITABLE_GLOBALS.has(declaration.name.text)) return undefined;
    // The startup plan gives every declarator its own binding, so a repeated `var` has no single global yet. A JS
    // member write on the binding (`o.p = v`) declares no second binding. `Object.defineProperty(o, …)` still counts
    // as one: the Prepared path admits no `Object` static yet (slice O), and from-ast takes an unadmitted one for
    // selector drift, so the binding must stay without a home and refuse by name.
    const declarations = checker.getSymbolAtLocation(declaration.name)?.declarations ?? [];
    const own = (other: ts.Declaration) => !other.getSourceFile().isDeclarationFile && !isMemberWriteDeclaration(other);
    if (declarations.filter(own).length !== 1) return undefined;
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
    // A nested `var` answered here stays a module-init local: the producer gives globals to top-level statements only.
    return storesDynamic && !annotated ? "dynamic" : undefined;
  };
}

function isNamedVariableDeclaration(declaration: IrModuleBindingDeclaration): declaration is NamedVariableDeclaration {
  return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name);
}
