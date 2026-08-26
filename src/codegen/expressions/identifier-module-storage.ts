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

/** Whether every declaration visible to this identifier is type-only ambient. */
export function identifierHasOnlyAmbientDeclarations(ctx: CodegenContext, id: ts.Identifier): boolean {
  const declarations = ctx.oracle.declarationsOf(id);
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      if (declaration.getSourceFile().isDeclarationFile || hasDeclareModifier(declaration)) return true;
      return ts.isVariableDeclaration(declaration) && hasDeclareModifier(declaration.parent.parent);
    })
  );
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

function isCurrentSourceRuntimeVariable(declaration: ts.Declaration, sourceFile: ts.SourceFile): boolean {
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const list = declaration.parent;
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
  const sourceFile = id.getSourceFile();
  if (sourceFile.isDeclarationFile || ctx.oracle.declarationsOf(id).length !== 0) return undefined;
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
  if (!declaration || declaration.getSourceFile() !== sourceFile) return undefined;
  if (
    ts.isVariableDeclaration(declaration) &&
    isCurrentSourceRuntimeVariable(declaration, sourceFile) &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === id.text
  ) {
    return ctx.moduleGlobals.get(id.text);
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
export function identifierResolvesToCurrentTopLevelLexical(
  ctx: CodegenContext,
  id: ts.Identifier,
  allowUnresolvedTopLevelVariable = false,
): boolean {
  const declaration = resolvedDeclaration(ctx, id, allowUnresolvedTopLevelVariable);
  return (
    declaration !== undefined &&
    isCurrentSourceRuntimeVariable(declaration, id.getSourceFile()) &&
    (declaration.parent.flags & LEXICAL_FLAGS) !== 0
  );
}
