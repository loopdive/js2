// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Source-qualified identity for the legacy flat module-binding registries. */
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { hasDeclareModifier } from "../ast-modifiers.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { runtimeEvalStateMayShadowBinding } from "../direct-eval-environment.js";
import {
  emitGlobalEnvironmentKey,
  emitGlobalEnvironmentObject,
  ensureGlobalEnvironmentOperation,
} from "../global-environment.js";
import { localGlobalIdx } from "../registry/imports.js";

const LEXICAL_FLAGS = ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing;

/** Resolve the value-side declarations of an identifier, including `{ value }`. */
function identifierValueDeclarations(ctx: CodegenContext, id: ts.Identifier): readonly ts.Declaration[] {
  if (id.parent && ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
    const symbol = (
      ctx.checker as typeof ctx.checker & {
        getShorthandAssignmentValueSymbol?: (node: ts.ShorthandPropertyAssignment) => ts.Symbol | undefined;
      }
    ).getShorthandAssignmentValueSymbol?.(id.parent);
    if (symbol !== undefined) return symbol.declarations ?? [];
  }
  return ctx.oracle.declarationsOf(id);
}

/** Whether every declaration visible to this identifier is type-only ambient. */
export function identifierHasOnlyAmbientDeclarations(ctx: CodegenContext, id: ts.Identifier): boolean {
  const declarations = identifierValueDeclarations(ctx, id);
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      if (declaration.getSourceFile().isDeclarationFile || hasDeclareModifier(declaration)) return true;
      return ts.isVariableDeclaration(declaration) && hasDeclareModifier(declaration.parent.parent);
    })
  );
}

/**
 * Whether `id` denotes an explicit, typed ambient variable written in a user
 * source file (`declare const/let/var name: T`).
 *
 * Import preprocessing also emits ambient variable stubs, but its value stubs
 * are deliberately `any` (and Node class stubs use `typeof ...`).  Excluding
 * those two synthetic shapes keeps an imported binding from being reinterpreted
 * as a same-named property of globalThis. Declaration-file globals continue to
 * use the established `collectDeclaredGlobals` path.
 */
export function identifierHasExplicitHostAmbientValueDeclaration(ctx: CodegenContext, id: ts.Identifier): boolean {
  if (ctx.standalone || ctx.wasi || ctx.strictNoHostImports) return false;
  const declarations = identifierValueDeclarations(ctx, id);
  if (declarations.length === 0 || !identifierHasOnlyAmbientDeclarations(ctx, id)) return false;
  return declarations.some((declaration) => {
    if (!ts.isVariableDeclaration(declaration) || declaration.getSourceFile().isDeclarationFile) return false;
    const list = declaration.parent;
    if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(list.parent)) return false;
    if (!hasDeclareModifier(list.parent)) return false;
    const type = declaration.type;
    return type !== undefined && type.kind !== ts.SyntaxKind.AnyKeyword && !ts.isTypeQueryNode(type);
  });
}

/**
 * Read a source-level ambient variable from the host global environment.
 * Existing registered declared globals retain their capability thunk (and its
 * dependency injection/cache semantics); otherwise use the live globalThis
 * lookup, which also preserves `undefined` for an absent optional ambient.
 */
export function tryEmitExplicitHostAmbientValueRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
): ValType | undefined {
  if (!identifierHasExplicitHostAmbientValueDeclaration(ctx, id)) return undefined;
  const registered = ctx.declaredGlobals.get(id.text);
  if (registered !== undefined) {
    fctx.body.push({ op: "call", funcIdx: registered.funcIdx });
    return registered.type;
  }
  if (!emitGlobalEnvironmentObject(ctx, fctx)) throw new TypeError(`ambient global '${id.text}' has no environment`);
  const getIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_get");
  if (getIdx === undefined) throw new TypeError(`ambient global '${id.text}' has no environment reader`);
  emitGlobalEnvironmentKey(ctx, fctx, id.text);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? getIdx });
  return { kind: "externref" };
}

/** Read an ambient binding through its runtime environment before flat registries. */
export function tryEmitAmbientRegistryCollisionRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  runtimeEvalFallback = false,
): ValType | undefined {
  if (!identifierHasOnlyAmbientDeclarations(ctx, id)) return undefined;
  const forceGlobalEnvironmentRead = runtimeEvalFallback && runtimeEvalStateMayShadowBinding(ctx, fctx, id.text);
  if (!forceGlobalEnvironmentRead && !ctx.moduleGlobals.has(id.text) && !ctx.capturedGlobals.has(id.text)) {
    return undefined;
  }
  if (!emitGlobalEnvironmentObject(ctx, fctx)) throw new TypeError(`ambient global '${id.text}' has no environment`);
  const getIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_get");
  if (getIdx === undefined) throw new TypeError(`ambient global '${id.text}' has no environment reader`);
  emitGlobalEnvironmentKey(ctx, fctx, id.text);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? getIdx });
  return { kind: "externref" };
}

/** Emit a read from the live post-provider index and return its allocator type. */
export function emitLiveIdentifierGlobalRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  globals: ReadonlyMap<string, number>,
  name: string,
): ValType {
  const globalIdx = globals.get(name);
  if (globalIdx === undefined) throw new TypeError(`identifier global '${name}' disappeared during provider setup`);
  const global = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
  if (!global) throw new TypeError(`identifier global '${name}' has no allocator object at index ${globalIdx}`);
  fctx.body.push({ op: "global.get", index: globalIdx });
  return global.type;
}

/** Resolve a destructured binding element to its owning variable declaration. */
function enclosingVariableDeclaration(declaration: ts.Declaration): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = declaration;
  while (current !== undefined && !ts.isVariableDeclaration(current)) {
    if (!ts.isBindingElement(current) && !ts.isObjectBindingPattern(current) && !ts.isArrayBindingPattern(current)) {
      return undefined;
    }
    current = current.parent;
  }
  return current;
}

function isCurrentSourceRuntimeVariable(declaration: ts.Declaration, sourceFile: ts.SourceFile): boolean {
  const variable = enclosingVariableDeclaration(declaration);
  if (variable === undefined) return false;
  const list = variable.parent;
  if (!ts.isVariableDeclarationList(list) || declaration.getSourceFile() !== sourceFile) return false;
  const statement = list.parent;
  if ((list.flags & LEXICAL_FLAGS) !== 0) {
    return ts.isVariableStatement(statement) && statement.parent === sourceFile && !hasDeclareModifier(statement);
  }
  for (let node: ts.Node | undefined = statement; node && node !== sourceFile; node = node.parent) {
    if (ts.isFunctionLike(node) || ts.isModuleBlock(node) || ts.isModuleDeclaration(node)) return false;
    if (ts.isVariableStatement(node) && hasDeclareModifier(node)) return false;
  }
  return !sourceFile.isDeclarationFile;
}

function directUnresolvedTopLevelVariable(ctx: CodegenContext, id: ts.Identifier): ts.VariableDeclaration | undefined {
  const sourceFile = id.getSourceFile() as ts.SourceFile | undefined;
  if (sourceFile === undefined || sourceFile.isDeclarationFile || ctx.oracle.declarationsOf(id).length !== 0) {
    return undefined;
  }
  const matches = sourceFile.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) && !hasDeclareModifier(statement)
      ? statement.declarationList.declarations.filter(
          (declaration): declaration is ts.VariableDeclaration =>
            ts.isIdentifier(declaration.name) && declaration.name.text === id.text,
        )
      : [],
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function resolvedDeclaration(
  ctx: CodegenContext,
  id: ts.Identifier,
  allowUnresolvedTopLevelVariable: boolean,
): ts.Declaration | undefined {
  return (
    ctx.oracle.valueDeclarationOf(id) ??
    (allowUnresolvedTopLevelVariable ? directUnresolvedTopLevelVariable(ctx, id) : undefined)
  );
}

function isTopLevelLexicalOwner(ctx: CodegenContext, id: ts.Identifier, declaration: ts.Declaration): boolean {
  const variable = enclosingVariableDeclaration(declaration);
  const sourceFile = declaration.getSourceFile();
  return (
    (!ctx.sourceIsModule || sourceFile === id.getSourceFile()) &&
    variable !== undefined &&
    isCurrentSourceRuntimeVariable(declaration, sourceFile) &&
    ts.isVariableDeclarationList(variable.parent) &&
    (variable.parent.flags & LEXICAL_FLAGS) !== 0
  );
}

function rejectsModuleTdzOwnership(ctx: CodegenContext, id: ts.Identifier, declaration: ts.Declaration): boolean {
  return (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportEqualsDeclaration(declaration) ||
    declaration.getSourceFile().isDeclarationFile ||
    (ctx.sourceIsModule && declaration.getSourceFile() !== id.getSourceFile())
  );
}

/** Resolve the exact pattern sidecar or a proven same-source direct lexical. */
export function moduleTdzGlobalIndexForIdentifier(ctx: CodegenContext, id: ts.Identifier): number | undefined {
  const declaration = ctx.oracle.valueDeclarationOf(id);
  if (declaration !== undefined) {
    if (rejectsModuleTdzOwnership(ctx, id, declaration)) return undefined;
    if (ts.isBindingElement(declaration)) {
      // A pattern binding never consults graph-name state: another module may
      // own an unrelated same-spelled lexical flag.
      return isTopLevelLexicalOwner(ctx, id, declaration) ? ctx.modulePatternTdzGlobals.get(declaration) : undefined;
    }
    return ts.isVariableDeclaration(declaration) && isTopLevelLexicalOwner(ctx, id, declaration)
      ? ctx.tdzGlobals.get(id.text)
      : undefined;
  }

  // A checker query can be unresolved before a pattern declaration. Registration
  // records a unique source-local leaf so this still reaches its exact flag.
  const pattern = ctx.modulePatternTdzBindings.get(id.getSourceFile())?.get(id.text);
  if (pattern !== undefined) return pattern === null ? undefined : ctx.modulePatternTdzGlobals.get(pattern);

  // Preserve the established direct-lexical path only after proving ownership
  // from the current source AST; never fall through to a graph-wide bare name.
  const direct = directUnresolvedTopLevelVariable(ctx, id);
  return direct !== undefined && isTopLevelLexicalOwner(ctx, id, direct) ? ctx.tdzGlobals.get(id.text) : undefined;
}

/** Resolve the flat compatibility map only for this source's runtime binding. */
export function currentSourceModuleGlobalIndex(
  ctx: CodegenContext,
  id: ts.Identifier,
  allowUnresolvedTopLevelVariable = false,
): number | undefined {
  // Script files share one GlobalEnvironmentRecord. A declaration resolved
  // through another script (notably the assembled Test262 harness) therefore
  // names the same runtime binding; source qualification is only meaningful
  // for module environment records.
  if (!ctx.sourceIsModule) return ctx.moduleGlobals.get(id.text);
  const sourceFile = id.getSourceFile();
  if (sourceFile.isDeclarationFile) return undefined;
  const declaration = resolvedDeclaration(ctx, id, allowUnresolvedTopLevelVariable);
  if (!declaration) {
    // Pattern leaves can be checker-unresolved before their declaration is
    // emitted. The TDZ registration already records an exact source-local
    // leaf for lexical patterns; use that identity to keep an assignment
    // target in its module global instead of inventing a helper-local slot.
    const pattern = ctx.modulePatternTdzBindings.get(sourceFile)?.get(id.text);
    return pattern && pattern !== null && isCurrentSourceRuntimeVariable(pattern, sourceFile)
      ? ctx.moduleGlobals.get(id.text)
      : undefined;
  }
  if (declaration.getSourceFile() !== sourceFile) return undefined;
  if (ts.isBindingElement(declaration) && isCurrentSourceRuntimeVariable(declaration, sourceFile)) {
    return ctx.moduleGlobals.get(id.text);
  }
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.name.text === id.text) {
    const projectedIdx = ctx.moduleGlobals.get(id.text);
    if (projectedIdx === undefined) return undefined;

    // Runtime namespace variables are intentionally registered under a
    // collision-safe qualified name, then projected under their bare source
    // name only while the owning namespace body is compiled. The top-level
    // source predicate below rejects ModuleBlock declarations, so simple
    // writes used to fall through to assignment.ts's auto-local even though
    // reads correctly used the projected global. Match the projected allocator
    // object against this exact declaration's Program ABI observation before
    // accepting it. This preserves the cross-module/sibling-namespace collision
    // guard while allowing the active namespace binding to be written.
    const exactBinding = ctx.programAbiGlobals?.moduleBinding(declaration);
    if (exactBinding !== undefined) {
      const projectedGlobal = ctx.mod.globals[localGlobalIdx(ctx, projectedIdx)];
      if (projectedGlobal === exactBinding.value) return projectedIdx;
    }

    if (isCurrentSourceRuntimeVariable(declaration, sourceFile)) return projectedIdx;
  }
  if (
    ts.isFunctionDeclaration(declaration) &&
    declaration.name?.text === id.text &&
    declaration.parent === sourceFile &&
    declaration.body !== undefined &&
    !hasDeclareModifier(declaration) &&
    ctx.liveFuncBindingGlobals?.has(id.text)
  ) {
    return ctx.moduleGlobals.get(id.text);
  }
  return undefined;
}

/** Exact same-source runtime top-level lexical identity. */
