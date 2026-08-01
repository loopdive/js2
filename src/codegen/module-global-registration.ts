// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { GlobalDef, Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { computeElidableTopLevelTdzNames } from "./expressions/identifiers.js";
import { localGlobalIdx, nextModuleGlobalIdx } from "./registry/imports.js";

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
  if (fnIdx !== undefined && fnIdx >= ctx.numImportFuncs) return;
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
export function registerModuleTdzGlobal(ctx: CodegenContext, sourceFile: ts.SourceFile, name: string): void {
  if (!ctx.moduleGlobals.has(name)) return;
  const existingGlobalIdx = ctx.tdzGlobals.get(name);
  if (existingGlobalIdx !== undefined) {
    const existingGlobal = ctx.mod.globals[localGlobalIdx(ctx, existingGlobalIdx)];
    if (!existingGlobal || existingGlobal.name !== `__tdz_${name}`) {
      throw new TypeError(`module TDZ global ${name} has no exact allocator object at index ${existingGlobalIdx}`);
    }
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
      );
      if (declaration) {
        // (#1282) Only pair the TDZ flag with the declaration that owns the
        // VALUE global — see `hasModuleValue`. In a multi-package graph the same
        // bare name can be declared in two modules.
        if (ctx.programAbiGlobals?.hasModuleValue(declaration) !== false) {
          ctx.programAbiGlobals?.observeModuleTdz(declaration, name, existingGlobal);
        }
        return;
      }
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

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
    );
    if (declaration) {
      // (#1282) Same pairing rule as above.
      if (ctx.programAbiGlobals?.hasModuleValue(declaration) !== false) {
        ctx.programAbiGlobals?.observeModuleTdz(declaration, name, flagGlobal);
      }
      return;
    }
  }
}

/**
 * Materialize the top-level TDZ globals that both body emitters reference.
 * Safe to call before IR preparation and again from the direct declaration
 * pass because allocation and structural ABI observation are idempotent.
 */
export function prepareModuleTdzGlobals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const elidableTdzNames = computeElidableTopLevelTdzNames(ctx, sourceFile, ctx.tdzLetConstNames);
  for (const name of elidableTdzNames) {
    ctx.tdzLetConstNames.delete(name);
  }
  for (const name of ctx.tdzLetConstNames) {
    registerModuleTdzGlobal(ctx, sourceFile, name);
  }
}
