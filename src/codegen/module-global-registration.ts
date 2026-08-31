// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { GlobalDef, Instr, ValType } from "../ir/types.js";
import { forEachChild, ts } from "../ts-api.js";
import { hasDeclareModifier } from "./ast-modifiers.js";
import type { CodegenContext } from "./context/types.js";
import { computeElidableTopLevelTdzNames } from "./expressions/identifiers.js";
import { localGlobalIdx, nextModuleGlobalIdx } from "./registry/imports.js";

const TOP_LEVEL_LEXICAL_FLAGS = ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing;

function isFunctionOrClassBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

function unwrapParenthesizedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/**
 * Retain TDZ state for a checker-unresolved write inside a dynamic `with`.
 *
 * TypeScript deliberately leaves the bare target of `with (scope) { x = v }`
 * symbol-less: the Object Environment Record decides at runtime whether the
 * write reaches `scope.x` or the outer binding. The ordinary elision walk
 * therefore cannot join that occurrence back to a declaration. Admit only the
 * bounded miss route used by the dynamic-with writer: the occurrence has no
 * oracle declaration at all and its spelling names one direct, non-ambient
 * top-level lexical in this exact SourceFile. A resolved local, capture,
 * import, ambient declaration, or foreign declaration cannot enter this path.
 */
function unresolvedDynamicWithTopLevelLexicalWrites(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  candidates: ReadonlySet<string>,
): ReadonlySet<string> {
  const declarationCounts = new Map<string, number>();
  if (!sourceFile.isDeclarationFile) {
    for (const statement of sourceFile.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        hasDeclareModifier(statement) ||
        (statement.declarationList.flags & TOP_LEVEL_LEXICAL_FLAGS) === 0
      ) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && candidates.has(declaration.name.text)) {
          declarationCounts.set(declaration.name.text, (declarationCounts.get(declaration.name.text) ?? 0) + 1);
        }
      }
    }
  }
  const topLevelLexicals = new Set([...declarationCounts].filter(([, count]) => count === 1).map(([name]) => name));
  if (topLevelLexicals.size === 0) return new Set();

  const retained = new Set<string>();
  const recordUnresolvedWrite = (target: ts.Expression): void => {
    const identifier = unwrapParenthesizedExpression(target);
    if (!ts.isIdentifier(identifier) || !topLevelLexicals.has(identifier.text)) return;
    if (ctx.oracle.valueDeclarationOf(identifier) !== undefined || ctx.oracle.declarationsOf(identifier).length > 0) {
      return;
    }
    retained.add(identifier.text);
  };
  const visitWithBody = (body: ts.Statement): void => {
    const visit = (node: ts.Node): void => {
      if (node !== body && isFunctionOrClassBoundary(node)) return;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        recordUnresolvedWrite(node.left);
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        recordUnresolvedWrite(node.operand);
      }
      forEachChild(node, visit);
    };
    visit(body);
  };
  const visitSource = (node: ts.Node): void => {
    if (retained.size === topLevelLexicals.size) return;
    if (ts.isWithStatement(node)) visitWithBody(node.statement);
    forEachChild(node, visitSource);
  };
  visitSource(sourceFile);
  return retained;
}

/**
 * Find the runtime-owning top-level declaration of `name` in `sourceFile`.
 *
 * AMBIENT DECLARATIONS ARE SKIPPED, and that is the whole point (#4018). This
 * lookup is by NAME, but `ctx.tdzLetConstNames` is graph-global, so on a
 * multi-source graph it is asked for names owned by other files — and a package
 * that ships both an implementation and its `.d.ts` has the SAME name declared
 * in both. `export declare const minimatch` in `minimatch/dist/esm/index.d.ts`
 * is not a runtime binding: `collectDeclarations` skips ambient statements, so
 * it never receives a value global. Attaching a TDZ global to it therefore
 * tripped the sidecar's "TDZ observed before its value global" invariant and
 * aborted the whole compile.
 *
 * The predicate deliberately mirrors the ambient test used by
 * `collectDeclarations` / `statementListHasEagerClass` — a declaration that
 * cannot receive a value observation must not receive a TDZ one. Same defect
 * class as #1282's ambient-function skip, on the variable side.
 */
function findRuntimeTopLevelDeclaration(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
  if (sourceFile.isDeclarationFile) return undefined;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || hasDeclareModifier(statement)) continue;
    const declaration = statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
    );
    if (declaration) return declaration;
  }
  return undefined;
}

/**
 * Register one module-level global and expose its exact allocator object to
 * the structural ABI sidecar when the source declaration is authoritative.
 */
export function registerModuleGlobal(
  ctx: CodegenContext,
  name: string,
  wasmType: ValType,
  declaration?: ts.VariableDeclaration,
): void {
  // Only a genuine user-defined function (a defined function whose index is
  // past the import prefix) shadows a module-level var. Imported host globals,
  // including wasm:js-string builtins, remain shadowable by user variables.
  // This distinction preserves #2669's concat/length/etc. collisions and
  // #3428's Test262 `var print = ...` harness binding. Treating any funcMap
  // entry as a user function leaves those variables as module-init locals,
  // making them invisible to nested/exported functions.
  const fnIdx = ctx.funcMap.get(name);
  // Native standalone exposes the inherited Object.prototype conversion
  // hooks as defined functions, so their funcMap entries are not proof that a
  // same-named script `var` is a function binding. A script declaration of
  // either hook must still receive a mutable global cell: OrdinaryToPrimitive
  // observes it through the realm object, and the module initializer mirrors
  // the value into that carrier. Other defined functions retain the original
  // collision guard.
  const shadowsConversionHook = declaration !== undefined && (name === "toString" || name === "valueOf");
  if (fnIdx !== undefined && fnIdx >= ctx.numImportFuncs && !shadowsConversionHook) return;
  const existingGlobalIdx = ctx.moduleGlobals.get(name);
  if (existingGlobalIdx !== undefined) {
    if (declaration) {
      const existingGlobal = ctx.mod.globals[localGlobalIdx(ctx, existingGlobalIdx)];
      if (!existingGlobal) {
        throw new TypeError(`module global ${name} has no allocator object at index ${existingGlobalIdx}`);
      }
      ctx.programAbiGlobals?.observeModuleValue(declaration, name, existingGlobal);
    }
    return;
  }
  if (ctx.classSet.has(name)) return;

  const init: Instr[] =
    wasmType.kind === "f64"
      ? [{ op: "f64.const", value: 0 }]
      : wasmType.kind === "i32"
        ? [{ op: "i32.const", value: 0 }]
        : wasmType.kind === "i64"
          ? [{ op: "i64.const", value: 0n }]
          : wasmType.kind === "ref_null" || wasmType.kind === "ref"
            ? [{ op: "ref.null", typeIdx: wasmType.typeIdx }]
            : [{ op: "ref.null.extern" }];
  const globalType: ValType =
    wasmType.kind === "ref"
      ? {
          kind: "ref_null",
          typeIdx: wasmType.typeIdx,
        }
      : wasmType;
  const globalIdx = nextModuleGlobalIdx(ctx);
  const global: GlobalDef = {
    name: `__mod_${name}`,
    type: globalType,
    mutable: true,
    init,
  };
  ctx.mod.globals.push(global);
  ctx.moduleGlobals.set(name, globalIdx);
  if (declaration) {
    ctx.programAbiGlobals?.observeModuleValue(declaration, name, global);
  }
}

/** Allocate and structurally observe one retained top-level TDZ flag. */
export function registerModuleTdzGlobal(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  name: string,
  exactDeclaration?: ts.VariableDeclaration,
): void {
  if (!ctx.moduleGlobals.has(name)) return;
  const existingGlobalIdx = ctx.tdzGlobals.get(name);
  if (existingGlobalIdx !== undefined) {
    const existingGlobal = ctx.mod.globals[localGlobalIdx(ctx, existingGlobalIdx)];
    if (!existingGlobal || existingGlobal.name !== `__tdz_${name}`) {
      throw new TypeError(`module TDZ global ${name} has no exact allocator object at index ${existingGlobalIdx}`);
    }
    const declaration = exactDeclaration ?? findRuntimeTopLevelDeclaration(sourceFile, name);
    if (declaration && ctx.programAbiGlobals?.hasModuleValue(declaration)) {
      ctx.programAbiGlobals?.observeModuleTdz(declaration, name, existingGlobal);
    }
    return;
  }
  const flagGlobalIdx = nextModuleGlobalIdx(ctx);
  const flagGlobal: GlobalDef = {
    name: `__tdz_${name}`,
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  };
  ctx.mod.globals.push(flagGlobal);
  ctx.tdzGlobals.set(name, flagGlobalIdx);

  const declaration = exactDeclaration ?? findRuntimeTopLevelDeclaration(sourceFile, name);
  if (declaration && ctx.programAbiGlobals?.hasModuleValue(declaration)) {
    ctx.programAbiGlobals?.observeModuleTdz(declaration, name, flagGlobal);
  }
}

/** Allocate an exact TDZ sidecar for one top-level destructuring leaf. */
export function registerModulePatternTdzGlobal(ctx: CodegenContext, binding: ts.BindingElement): void {
  if (!ctx.modulePatternTdzGlobals.has(binding)) {
    let suffix = ctx.modulePatternTdzGlobals.size;
    let name = `__tdz_pattern_${suffix}`;
    while (ctx.mod.globals.some((global) => global.name === name)) name = `__tdz_pattern_${++suffix}`;
    const flagGlobalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name,
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    ctx.modulePatternTdzGlobals.set(binding, flagGlobalIdx);
  }
  if (!ts.isIdentifier(binding.name)) return;
  const sourceFile = binding.getSourceFile();
  let bindings = ctx.modulePatternTdzBindings.get(sourceFile);
  if (!bindings) {
    bindings = new Map();
    ctx.modulePatternTdzBindings.set(sourceFile, bindings);
  }
  const previous = bindings.get(binding.name.text);
  bindings.set(binding.name.text, previous === undefined || previous === binding ? binding : null);
}

/**
 * Materialize the top-level TDZ globals that both body emitters reference.
 * Safe to call before IR preparation and again from the direct declaration
 * pass because allocation and structural ABI observation are idempotent.
 */
export function prepareModuleTdzGlobals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const elidableTdzNames = computeElidableTopLevelTdzNames(ctx, sourceFile, ctx.tdzLetConstNames);
  for (const name of unresolvedDynamicWithTopLevelLexicalWrites(ctx, sourceFile, elidableTdzNames)) {
    elidableTdzNames.delete(name);
  }
  for (const name of elidableTdzNames) {
    ctx.tdzLetConstNames.delete(name);
  }
  for (const name of ctx.tdzLetConstNames) {
    registerModuleTdzGlobal(ctx, sourceFile, name);
  }
}
