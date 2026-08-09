// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { MultiTypedAST, TypedAST } from "../checker/index.js";
import { absoluteFuncIndexCached } from "../emit/resolve-layout.js";
import type { FuncTypeDef, Instr, WasmModule } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { finalizeLinearHeapLayout } from "./runtime.js";

const ARENA_RESET = "__arena_reset";
const ARENA_ENTRY_PREFIX = "__arena_entry_";

/**
 * Values that cross an automatically reclaimed exported-call boundary must be
 * independent of the linear arena. Aggregate/string/object values are raw i32
 * pointers in this backend, so only primitive scalar types are admissible.
 */
function isArenaIndependentType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every(isArenaIndependentType);
  return (
    (type.flags &
      (ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.Void |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Null |
        ts.TypeFlags.Never)) !==
    0
  );
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function functionHasArenaIndependentBoundary(decl: ts.FunctionDeclaration, checker: ts.TypeChecker): boolean {
  try {
    for (const param of decl.parameters) {
      if (!isArenaIndependentType(checker.getTypeAtLocation(param))) return false;
    }
    const signature = checker.getSignatureFromDeclaration(decl);
    return signature !== undefined && isArenaIndependentType(checker.getReturnTypeOfSignature(signature));
  } catch {
    // An unresolved boundary is a pointer boundary until proven otherwise.
    return false;
  }
}

function sourceHasArenaBackedModuleState(sourceFile: ts.SourceFile, checker: ts.TypeChecker): boolean {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt) || stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      continue;
    }
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) return true;
      try {
        if (!isArenaIndependentType(checker.getTypeAtLocation(decl.name))) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

function singleFileExportDeclarations(ast: TypedAST): ts.FunctionDeclaration[] {
  return ast.sourceFile.statements.filter(
    (stmt): stmt is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(stmt) && stmt.name !== undefined && hasExportModifier(stmt),
  );
}

function multiFileExportDeclarations(ast: MultiTypedAST): ts.FunctionDeclaration[] {
  const reExportedNames = new Set<string>();
  for (const stmt of ast.entryFile.statements) {
    if (!ts.isExportDeclaration(stmt) || !stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
    for (const specifier of stmt.exportClause.elements) reExportedNames.add(specifier.name.text);
  }

  const declarations: ts.FunctionDeclaration[] = [];
  for (const sourceFile of ast.sourceFiles) {
    const entry = sourceFile === ast.entryFile;
    for (const stmt of sourceFile.statements) {
      if (!ts.isFunctionDeclaration(stmt) || stmt.name === undefined) continue;
      if ((entry && hasExportModifier(stmt)) || reExportedNames.has(stmt.name.text)) declarations.push(stmt);
    }
  }
  return declarations;
}

/**
 * Return the complete set of user exports that may share one transient call
 * arena, or `null` when any boundary/state can keep an arena pointer alive.
 *
 * Eligibility is deliberately module-wide. Resetting before one scalar export
 * would still invalidate an array returned by a different export, so a single
 * aggregate boundary or heap-backed module global keeps every export on the
 * monotonic arena.
 */
function planArenaResetExports(ast: TypedAST | MultiTypedAST): ReadonlySet<string> | null {
  const sourceFiles = "sourceFile" in ast ? [ast.sourceFile] : ast.sourceFiles;
  if (sourceFiles.some((sourceFile) => sourceHasArenaBackedModuleState(sourceFile, ast.checker))) return null;

  const declarations = "sourceFile" in ast ? singleFileExportDeclarations(ast) : multiFileExportDeclarations(ast);
  if (declarations.length === 0) return new Set();
  if (declarations.some((decl) => !functionHasArenaIndependentBoundary(decl, ast.checker))) return null;
  return new Set(declarations.map((decl) => decl.name!.text));
}

/**
 * Put the reset at the host-to-Wasm edge, not in the user function body.
 * Internal calls continue to target the original function and therefore never
 * reset a live caller's arena. Resetting on entry retains the completed call's
 * memory until the next eligible exported call begins.
 */
function wrapExportsWithArenaReset(mod: WasmModule, exportNames: ReadonlySet<string>): void {
  if (exportNames.size === 0) return;

  const numImportFuncs = mod.imports.filter((item) => item.desc.kind === "func").length;
  const resetLocalIdx = mod.functions.findIndex((func) => func.name === ARENA_RESET);
  if (resetLocalIdx < 0) throw new Error("linear call arena: missing __arena_reset runtime helper");
  const resetFuncIdx = numImportFuncs + resetLocalIdx;

  for (const exp of mod.exports) {
    if (exp.desc.kind !== "func" || !exportNames.has(exp.name)) continue;

    const originalFuncIdx = absoluteFuncIndexCached(mod, numImportFuncs, exp.desc.index);
    const original = mod.functions[originalFuncIdx - numImportFuncs];
    if (original === undefined) throw new Error(`linear call arena: missing exported function '${exp.name}'`);
    const type = mod.types[original.typeIdx];
    if (type === undefined || type.kind !== "func") {
      throw new Error(`linear call arena: export '${exp.name}' has a non-function type`);
    }

    const body: Instr[] = [{ op: "call", funcIdx: resetFuncIdx }];
    for (let index = 0; index < (type as FuncTypeDef).params.length; index++) {
      body.push({ op: "local.get", index });
    }
    body.push({ op: "call", funcIdx: originalFuncIdx });

    const wrapperFuncIdx = numImportFuncs + mod.functions.length;
    mod.functions.push({
      name: `${ARENA_ENTRY_PREFIX}${exp.name}`,
      typeIdx: original.typeIdx,
      locals: [],
      body,
      exported: true,
    });
    exp.desc.index = wrapperFuncIdx;
  }
}

/** Finalize the data/heap boundary, then install the optional call-arena edge. */
export function finalizeLinearArena(
  mod: WasmModule,
  ast: TypedAST | MultiTypedAST,
  enableCallReset: boolean | undefined,
): void {
  finalizeLinearHeapLayout(mod);
  if (!enableCallReset) return;
  const exports = planArenaResetExports(ast);
  if (exports !== null) wrapExportsWithArenaReset(mod, exports);
}
