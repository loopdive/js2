// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7372 slice 2a) Annex B block functions of a script on the Prepared path (§B.3.2.2, §B.3.3). A sloppy
 * `{ function f() {} }` at script level has two bindings:
 *   - its block binding, a lexical binding of the declaring scope (a Block, a `switch`'s CaseBlock, or an `if` clause)
 *     that BlockDeclarationInstantiation sets to a new function object when the scope is entered;
 *   - where §B.3.2.2 allows it (`writesVar`, `shared/annexb-block-functions.ts`), a script `var` of the same name,
 *     `undefined` from instantiation, set to the block binding's current value when the declaration is evaluated.
 *
 * Both are homes in the dynamic carrier: module-init globals with `var` startup intents, numbered after the script's
 * declarations and F1b's function values. Script-level code runs once, so one global per block binding is exact;
 * a declaring scope inside a loop body is re-entered and refuses. The checker binds a sloppy block function to its
 * file, so one symbol stands for both bindings: {@link BlockFunctionHomes.resolve} splits a reference by position.
 *
 * (#7372 2a-3) Where the script already declares the name (a `var`, or a top-level function), the var binding is that
 * declaration's home: its dynamic script-var home, or F1b's function value home, which the evaluation's write makes
 * mutable (`preparedBindingRewritten` counts it, `annexBWritesScriptBinding`).
 *
 * Refused by name here: a function the dynamic closure route does not take (typed, defaulted or rest parameters), a
 * built-in global's name (the global object already has the property, whose value a read before the block sees), a
 * name whose existing script binding has no dynamic home, two declarations of a name in one scope, a generator or
 * async function, a scope in a loop body, and a read the var binding does not cover.
 */
import { ts } from "../ts-api.js";
import { irModuleGlobalBindingId } from "./abi-bindings.js";
import { annexBBlockFunctions, scopeBindsName, type AnnexBBlockFunction } from "../shared/annexb-block-functions.js";
import type { ModuleBindingGlobal } from "./ast-lowering-plans.js";
import {
  functionValueBindings,
  moduleInitDynamicHome,
  type FunctionValueGlobal,
} from "./function-declaration-values.js";
import { moduleBindingDeclarationOrder } from "./module-init-vars.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import type { IrSourceId, IrUnitId } from "./identity.js";
import { irDynamic } from "./nodes.js";
import { IrUnsupportedError } from "./outcomes.js";
import type { IrModuleInitBindingIntent } from "./program/startup.js";
import { REALM_GLOBAL_NAMES } from "./program/builtin-prototype-keys.js";

/** The Annex B block functions of a single-script program; an ES module or several sources have none on this path. */
export function scriptBlockFunctions(sourceFiles: readonly ts.SourceFile[]): readonly AnnexBBlockFunction[] {
  const source = sourceFiles[0]!;
  return sourceFiles.length === 1 && !ts.isExternalModule(source) ? annexBBlockFunctions(source) : [];
}

/** Refuse by name each block function this slice does not model (module doc). */
function refuseUnmodelled(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  functions: readonly AnnexBBlockFunction[],
  dynamicClosure: (declaration: ts.FunctionDeclaration) => boolean,
): void {
  // The global object's own properties: the realm's built-ins and every global the lib declares.
  const libGlobals = new Set(
    checker
      .getSymbolsInScope(source, ts.SymbolFlags.Value)
      .filter((symbol) => symbol.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile))
      .map((symbol) => symbol.name),
  );
  for (const entry of functions) {
    const { declaration, scope } = entry;
    const name = declaration.name.text;
    if (declaration.asteriskToken || ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Async)
      refuse(name, "is a generator or async function");
    if (ts.findAncestor(declaration.parent, (node) => ts.isIterationStatement(node, false)))
      refuse(name, "is in a loop body");
    if (REALM_GLOBAL_NAMES.has(name) || libGlobals.has(name) || name === "undefined")
      refuse(name, "shadows a built-in global");
    if (functions.some((other) => other !== entry && other.scope === scope && other.declaration.name.text === name))
      refuse(name, "is declared twice in one scope");
    if (!dynamicClosure(declaration)) refuse(name, "is outside the dynamic closure subset");
  }
}

function refuse(name: string, why: string): never {
  throw new IrUnsupportedError("type-resolution-unsupported", "build", `Annex B block function '${name}' ${why}`);
}

/** The first ordinal of the homes: after the script's declarations and F1b's function values. */
export function blockFunctionFirstOrdinal(
  sourceFile: ts.SourceFile,
  functionValues: readonly ts.FunctionDeclaration[],
): number {
  return moduleBindingDeclarationOrder(sourceFile).length + functionValues.length;
}

/** The names whose var binding is new, one per name some declaration writes and nothing else declares. */
function varNames(functions: readonly AnnexBBlockFunction[]): readonly string[] {
  const fresh = functions.filter((entry) => entry.writesVar && !entry.varExists);
  return [...new Set(fresh.map((entry) => entry.declaration.name.text))];
}

/**
 * The startup bindings of the homes, numbered from `firstOrdinal`: each declaration's block binding in source order,
 * then each var binding.
 */
export function blockFunctionBindings(
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
  functions: readonly AnnexBBlockFunction[],
  firstOrdinal: number,
): IrModuleInitBindingIntent[] {
  const id = (ordinal: number) => irModuleGlobalBindingId(sourceId, ordinal);
  const firstOfEach = varNames(functions).map(
    (name) => functions.find((entry) => entry.declaration.name.text === name)!.declaration,
  );
  return [
    ...functionValueBindings(
      sourceFile,
      functions.map((entry) => entry.declaration),
      firstOrdinal,
      id,
    ),
    ...functionValueBindings(sourceFile, firstOfEach, firstOrdinal + functions.length, id),
  ];
}

/** A declaration's two homes, as from-ast stores them. */
export interface BlockFunctionHomeRefs {
  readonly block: ModuleBindingGlobal;
  readonly var: ModuleBindingGlobal | undefined;
}

/** The homes of a script's block functions: their globals, and which one a reference means. */
export interface BlockFunctionHomes {
  readonly globals: readonly FunctionValueGlobal[];
  readonly homesOf: (declaration: ts.FunctionDeclaration) => BlockFunctionHomeRefs | undefined;
  /**
   * The home a reference to a block function's symbol means: the block binding of the innermost declaring scope that
   * contains it, else the var binding. A reference neither covers refuses (no binding exists there).
   */
  readonly resolve: (node: ts.Identifier, symbol: ts.Symbol | undefined) => FunctionValueGlobal | undefined;
}

export function blockFunctionHomes(
  functions: readonly AnnexBBlockFunction[],
  sourceId: IrSourceId,
  moduleInit: IrUnitId,
  firstOrdinal: number,
  existing: (name: string) => FunctionValueGlobal | undefined,
): BlockFunctionHomes {
  const home = (ordinal: number, adapterName: string) =>
    moduleInitDynamicHome(moduleInit, sourceId, irModuleGlobalBindingId(sourceId, ordinal), adapterName, {
      type: irDynamic(),
      mutable: true,
    });
  const blocks = new Map(
    functions.map((entry, index) => [
      entry,
      home(firstOrdinal + index, blockHomeName(entry.declaration.name.text, index)),
    ]),
  );
  const vars = new Map(
    varNames(functions).map((name, index) => [name, home(firstOrdinal + functions.length + index, name)]),
  );
  const varHome = (name: string) => vars.get(name) ?? existing(name);
  const entryOf = (declaration: ts.FunctionDeclaration) => functions.find((entry) => entry.declaration === declaration);
  return {
    globals: [...blocks.values(), ...vars.values()],
    homesOf: (declaration) => {
      const entry = entryOf(declaration);
      if (!entry) return undefined;
      const written = entry.writesVar ? varHome(entry.declaration.name.text) : undefined;
      return { block: blocks.get(entry)!.binding, var: written?.binding };
    },
    resolve: (node, symbol) => {
      // The compiler's checker binds a block function to its block: a reference outside every declaring scope has
      // no symbol, and is a reference to the global of its name.
      const own = functions.filter((entry) =>
        symbol
          ? symbol.declarations?.includes(entry.declaration)
          : entry.declaration.name.text === node.text && !boundInEnclosingFunction(node),
      );
      if (own.length === 0) return undefined;
      const covering = own.filter((entry) => node.pos >= entry.scope.pos && node.end <= entry.scope.end);
      const innermost = covering.sort((a, b) => b.scope.pos - a.scope.pos)[0];
      if (innermost) return blocks.get(innermost);
      return varHome(node.text) ?? refuse(node.text, "is read where no binding of it exists");
    },
  };
}

/**
 * A block home's adapter name, the key its storage is found by. `#` cannot occur in a binding's name (a private name
 * is no binding), so no source identifier collides with it.
 */
function blockHomeName(name: string, index: number): string {
  return `${name}#block${index}`;
}

/**
 * Whether a function enclosing the symbol-less reference `node` binds its name itself (a parameter, a `var`, a
 * declaration, an Annex B block function of its own): then the reference is not to the script's binding.
 */
function boundInEnclosingFunction(node: ts.Identifier): boolean {
  for (let scope = node.parent; !ts.isSourceFile(scope); scope = scope.parent) {
    if (
      ts.isFunctionLike(scope) &&
      (scopeBindsName(scope, node.text) ||
        annexBBlockFunctions(scope).some((entry) => entry.declaration.name.text === node.text))
    )
      return true;
  }
  return false;
}

/**
 * The homes of the program's block functions, when it has any (its only source is a script), after refusing the
 * unmodelled ones. The caller owns the refusals' diagnostics (the script's module-init).
 */
export function scriptBlockFunctionHomes(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  identity: Pick<IrPlanningIdentityContext, "sourceIdBySourceFile" | "moduleInitUnitIdBySourceFile">,
  contracts: {
    readonly blockFunctions: readonly AnnexBBlockFunction[];
    readonly functionDeclarationValues: readonly ts.FunctionDeclaration[];
    readonly resolver: { readonly dynamicClosureSignature?: (expression: ts.FunctionLikeDeclaration) => unknown };
  },
  globals: ReadonlyMap<ts.Declaration, FunctionValueGlobal>,
): BlockFunctionHomes | undefined {
  const { blockFunctions } = contracts;
  // A script binding's home by its name: a script `var`'s, or F1b's for a top-level function.
  const existing = (name: string) =>
    [...globals].find(
      ([declaration]) =>
        (ts.isVariableDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) &&
        declaration.name !== undefined &&
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name,
    )?.[1];
  if (blockFunctions.length === 0) return undefined;
  const source = sourceFiles[0]!;
  refuseUnmodelled(
    checker,
    source,
    blockFunctions,
    (fn) => contracts.resolver.dynamicClosureSignature?.(fn) !== undefined,
  );
  for (const { declaration, writesVar, varExists } of blockFunctions) {
    if (writesVar && varExists && existing(declaration.name.text)?.binding.type.kind !== "dynamic")
      refuse(declaration.name.text, "shares its name with a script binding that has no dynamic home");
  }
  return blockFunctionHomes(
    blockFunctions,
    identity.sourceIdBySourceFile.get(source)!,
    identity.moduleInitUnitIdBySourceFile.get(source)!,
    blockFunctionFirstOrdinal(source, contracts.functionDeclarationValues),
    existing,
  );
}
