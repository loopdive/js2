// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/**
 * Reserve a collision-free compiler identity for a function declaration while
 * retaining its source name for JavaScript-visible `.name` and exports.
 */
export function reserveFunctionDeclarationKey(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  sourceName: string,
): string {
  const existing = ctx.functionDeclKeys.get(declaration);
  if (existing) return existing;

  let key = sourceName;
  const existingIndex = ctx.funcMap.get(key);
  if (existingIndex !== undefined && existingIndex >= ctx.numImportFuncs) {
    const stem = sourceName.replace(/[^A-Za-z0-9_$]/g, "_");
    let ordinal = ctx.functionDeclKeys.size;
    do {
      key = `__module_fn_${ordinal++}_${stem}`;
    } while (ctx.funcMap.has(key));
  }
  ctx.functionDeclKeys.set(declaration, key);
  return key;
}

export function functionDeclarationKey(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  fallback: string,
): string {
  return ctx.functionDeclKeys.get(declaration) ?? fallback;
}

/**
 * Resolve a direct identifier call through the TypeScript declaration rather
 * than the process-wide bare-name map. This is what keeps `validate()` in one
 * CommonJS module distinct from an unrelated `validate()` in another module.
 */
export function functionKeyAtIdentifier(ctx: CodegenContext, identifier: ts.Identifier): string {
  return functionDeclarationKeyAtIdentifier(ctx, identifier) ?? identifier.text;
}

/**
 * Return the compiler identity only when an identifier is actually bound to a
 * registered FunctionDeclaration. This lets capture analysis distinguish a
 * sibling function binding from a same-named outer local.
 */
export function functionDeclarationKeyAtIdentifier(ctx: CodegenContext, identifier: ts.Identifier): string | undefined {
  let symbol = ctx.checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = ctx.checker.getAliasedSymbol(symbol);
    } catch {
      // Keep the original symbol when TypeScript cannot resolve a synthetic alias.
    }
  }
  const declarations = [symbol?.valueDeclaration, ...(symbol?.declarations ?? [])];
  for (const declaration of declarations) {
    if (declaration && ts.isFunctionDeclaration(declaration)) {
      const key = ctx.functionDeclKeys.get(declaration);
      if (key) return key;
    }
  }

  // JavaScript files without an explicit import/export are checker "scripts",
  // so TypeScript merges their top-level bindings into one program-wide
  // symbol table. In a package graph this can make a reference inside an ESM
  // bundle resolve to a same-named CommonJS-script variable from another file:
  // ESLint's `ms` dependency declares numeric `m`, while esquery has a lexical
  // `function m` inside its factory. The AST still contains the unambiguous
  // lexical declaration. Recover it only when the checker supplied no
  // declaration from this source file; a genuine same-file variable/parameter
  // shadow must continue to win.
  const sourceFile = identifier.getSourceFile();
  const declarationScopeContainsIdentifier = (declaration: ts.Declaration): boolean => {
    let scope: ts.Node | undefined = declaration.parent;
    while (
      scope &&
      !ts.isSourceFile(scope) &&
      !ts.isBlock(scope) &&
      !ts.isFunctionDeclaration(scope) &&
      !ts.isFunctionExpression(scope) &&
      !ts.isArrowFunction(scope) &&
      !ts.isMethodDeclaration(scope) &&
      !ts.isConstructorDeclaration(scope)
    ) {
      scope = scope.parent;
    }
    return scope !== undefined && scope.pos <= identifier.pos && scope.end >= identifier.end;
  };
  if (
    declarations.some(
      (declaration) =>
        declaration !== undefined &&
        declaration.getSourceFile() === sourceFile &&
        !ts.isFunctionDeclaration(declaration) &&
        declarationScopeContainsIdentifier(declaration),
    )
  ) {
    return undefined;
  }

  let lexicalMatch: { key: string; span: number } | undefined;
  for (const [declaration, key] of ctx.functionDeclKeys) {
    if (declaration.getSourceFile() !== sourceFile || declaration.name?.text !== identifier.text) continue;
    const scope = declaration.parent;
    if (scope.pos > identifier.pos || scope.end < identifier.end) continue;
    const span = scope.end - scope.pos;
    if (!lexicalMatch || span < lexicalMatch.span) lexicalMatch = { key, span };
  }
  if (lexicalMatch) return lexicalMatch.key;

  // Some multi-source JavaScript paths compile a transformed AST node while
  // the checker and declaration prepass retain equivalent nodes from the
  // Program SourceFile. Object identity then misses functionDeclKeys even
  // though the lexical declaration was registered. Recover the narrowest
  // visible FunctionDeclaration from source structure and corroborate it
  // against funcSourceText before selecting a compiler key. Source text is
  // captured when declarations are registered, so this never guesses from a
  // realm-wide short name alone.
  let visibleDeclaration: { declaration: ts.FunctionDeclaration; span: number } | undefined;
  const findVisibleDeclaration = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === identifier.text &&
      node.parent.pos <= identifier.pos &&
      node.parent.end >= identifier.end
    ) {
      const span = node.parent.end - node.parent.pos;
      if (!visibleDeclaration || span < visibleDeclaration.span) {
        visibleDeclaration = { declaration: node, span };
      }
    }
    ts.forEachChild(node, findVisibleDeclaration);
  };
  findVisibleDeclaration(sourceFile);
  if (visibleDeclaration) {
    const declarationText = visibleDeclaration.declaration.getText(sourceFile);
    const matchingKeys: string[] = [];
    for (const [key, sourceText] of ctx.funcSourceText) {
      if (
        sourceText === declarationText &&
        ctx.funcMap.has(key) &&
        (ctx.functionNameMap.get(key) ?? key) === identifier.text
      ) {
        matchingKeys.push(key);
      }
    }
    if (matchingKeys.length === 1) return matchingKeys[0];
  }

  return undefined;
}

/**
 * Resolve an identifier to its module global while preserving the lexical
 * identity of ESM imports in multi-file graphs.
 *
 * `moduleGlobals` predates module graphs and is keyed only by source spelling.
 * A package such as ESLint legitimately has an imported `estraverse` binding
 * in several files as well as unrelated same-named declarations. The checker
 * symbol is the stable identity for an import alias; fall back to the legacy
 * name map for ordinary top-level variables.
 */
export function moduleGlobalAtIdentifier(ctx: CodegenContext, identifier: ts.Identifier): number | undefined {
  try {
    const symbol = valueSymbolAtIdentifier(ctx, identifier);
    const imported = symbol ? ctx.importBindingGlobals.get(symbol) : undefined;
    if (imported !== undefined) return imported;
    const declared = moduleGlobalForSymbol(ctx, symbol);
    if (declared !== undefined) return declared;
    if (symbol) {
      // A real checker symbol with no declaration-owned module global is a
      // lexical binding, not permission to consult the process-wide bare-name
      // fallback. Large package graphs legitimately contain an unrelated
      // top-level `h`/`y` in one module and nested function declarations with
      // those names in another; falling back here made the nested calls read
      // numeric globals instead of their own helpers. Reassigned-function
      // value reads have their own live-binding path in identifiers.ts, while
      // imported live bindings are recorded in importBindingGlobals above.
      // Applying the realm-wide live-name exception here let an unrelated
      // reassigned `m` route esquery's lexically resolved helper `m()` through
      // the numeric `ms` package global, producing invalid Wasm.
      return undefined;
    }
  } catch {
    // Synthetic nodes may not be attached to the checker program.
  }
  return ctx.moduleGlobals.get(identifier.text);
}

/**
 * Resolve the value binding denoted by an identifier.
 *
 * TypeScript gives the name in an object shorthand (`{ value }`) the
 * shorthand-property symbol rather than the symbol of `value`'s lexical
 * binding. Codegen reads the latter, and TDZ/declaration identity must do the
 * same or a later shorthand is mistaken for a declaration at its own source
 * position.
 */
export function valueSymbolAtIdentifier(ctx: CodegenContext, identifier: ts.Identifier): ts.Symbol | undefined {
  if (
    identifier.parent &&
    ts.isShorthandPropertyAssignment(identifier.parent) &&
    identifier.parent.name === identifier
  ) {
    const shorthandSymbol = (
      ctx.checker as unknown as {
        getShorthandAssignmentValueSymbol?: (node: ts.ShorthandPropertyAssignment) => ts.Symbol | undefined;
      }
    ).getShorthandAssignmentValueSymbol?.(identifier.parent);
    if (shorthandSymbol) return shorthandSymbol;
  }
  return ctx.checker.getSymbolAtLocation(identifier);
}

/** Resolve a checker symbol (including an import alias) to its exact global. */
export function moduleGlobalForSymbol(ctx: CodegenContext, symbol: ts.Symbol | undefined): number | undefined {
  if (!symbol) return undefined;
  let target = symbol;
  if (target.flags & ts.SymbolFlags.Alias) {
    try {
      target = ctx.checker.getAliasedSymbol(target);
    } catch {
      // Retain the local symbol and inspect its declarations.
    }
  }
  for (const declaration of [target.valueDeclaration, ...(target.declarations ?? [])]) {
    if (!declaration) continue;
    const globalIdx = ctx.moduleGlobalDeclarations.get(declaration);
    if (globalIdx !== undefined) return globalIdx;
  }
  return undefined;
}

/** Resolve a declaration-owned global, retaining the legacy name fallback. */
export function moduleGlobalForDeclaration(
  ctx: CodegenContext,
  declaration: ts.Declaration,
  fallbackName: string,
): number | undefined {
  return ctx.moduleGlobalDeclarations.get(declaration) ?? ctx.moduleGlobals.get(fallbackName);
}
