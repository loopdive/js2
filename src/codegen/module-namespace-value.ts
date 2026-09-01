// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Runtime values for same-compilation ESM namespace imports. */

import { ts } from "../ts-api.js";
import type { GlobalDef, ValType, WasmFunction } from "../ir/types.js";
import { emitCachedFuncClosureAccess, ensureFuncClosureSingleton } from "./closures.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { popBody, pushBody } from "./context/bodies.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { coerceType } from "./shared.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

interface NamespaceFunctionExport {
  readonly key: string;
  readonly functionName: string;
  readonly funcIdx: number;
  readonly constructible: boolean;
}

interface NamespaceObjectCache {
  readonly global: GlobalDef;
  readonly getterName: string;
}

const namespaceObjectCaches = new WeakMap<CodegenContext, WeakMap<ts.NamespaceImport, NamespaceObjectCache>>();

function cacheMap(ctx: CodegenContext): WeakMap<ts.NamespaceImport, NamespaceObjectCache> {
  let caches = namespaceObjectCaches.get(ctx);
  if (!caches) {
    caches = new WeakMap();
    namespaceObjectCaches.set(ctx, caches);
  }
  return caches;
}

function namespaceFunctionExports(
  ctx: CodegenContext,
  declaration: ts.NamespaceImport,
): readonly NamespaceFunctionExport[] | undefined {
  let moduleSymbol = ctx.checker.getSymbolAtLocation(declaration.name);
  if (!moduleSymbol) return undefined;
  if ((moduleSymbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      moduleSymbol = ctx.checker.getAliasedSymbol(moduleSymbol);
    } catch {
      return undefined;
    }
  }

  const exports: NamespaceFunctionExport[] = [];
  for (const exportedSymbol of ctx.checker.getExportsOfModule(moduleSymbol)) {
    let target = exportedSymbol;
    if ((target.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        target = ctx.checker.getAliasedSymbol(target);
      } catch {
        return undefined;
      }
    }
    const declarationNode =
      target.valueDeclaration ?? target.declarations?.find((node) => !node.getSourceFile().isDeclarationFile);
    // Type-only exports do not exist on the runtime namespace object.
    if (declarationNode === undefined && (target.flags & ts.SymbolFlags.Value) === 0) continue;
    if (
      declarationNode === undefined ||
      !ts.isFunctionDeclaration(declarationNode) ||
      declarationNode.body === undefined ||
      declarationNode.parent !== declarationNode.getSourceFile() ||
      ctx.reassignedFunctionDeclarations?.has(declarationNode)
    ) {
      // Mutable values require live-binding getters. Decline the entire object
      // rather than publishing a semantically-wrong snapshot.
      return undefined;
    }

    const registry = ctx.programAbiSourceCallables;
    const identity = registry?.identityContext;
    const unitId = identity?.unitIdByDeclaration.get(declarationNode);
    if (
      unitId === undefined ||
      identity?.declarationByUnitId.get(unitId) !== declarationNode ||
      registry?.functionForUnit(unitId) === undefined
    ) {
      return undefined;
    }
    const funcIdx = registry.handleForUnit(unitId);
    const func = funcIdx === undefined ? undefined : definedFuncAt(ctx, funcIdx);
    if (funcIdx === undefined || func === undefined || func !== registry.functionForUnit(unitId)) return undefined;

    const functionName = declarationNode.name?.text ?? func.name;
    const constructible =
      declarationNode.asteriskToken === undefined &&
      !(declarationNode.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
    if (ensureFuncClosureSingleton(ctx, functionName, funcIdx, constructible) === null) return undefined;
    exports.push({ key: exportedSymbol.getName(), functionName, funcIdx, constructible });
  }

  // An empty module still has a real namespace object. In particular, a
  // module may self-import its namespace while exporting no runtime values
  // (`import * as ns from "./self.js"`). Declining this vacuous immutable
  // namespace sends the binding through the identifier fallback and produces
  // null instead of the empty object required by the module namespace API.
  // Keep the object path for type-only modules as well: those exports have no
  // runtime properties, but the namespace itself remains observable.
  exports.sort((left, right) => left.key.localeCompare(right.key));
  return exports;
}

function absoluteGlobalIndex(ctx: CodegenContext, global: GlobalDef): number | undefined {
  const localIndex = ctx.mod.globals.indexOf(global);
  return localIndex < 0 ? undefined : ctx.numImportGlobals + localIndex;
}

/**
 * Materialize a stable enumerable namespace object when every runtime export is
 * an immutable function compiled into this module. Mixed/mutable namespaces
 * decline until live-binding getter cells are available.
 */
export function tryEmitCompiledModuleNamespaceObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  identifier: ts.Identifier,
): ValType | undefined {
  const declaration = ctx.oracle.valueDeclarationOf(identifier);
  if (declaration === undefined || !ts.isNamespaceImport(declaration)) return undefined;
  const existing = cacheMap(ctx).get(declaration);
  if (existing) {
    const getterIdx = ctx.funcMap.get(existing.getterName);
    if (getterIdx === undefined) return undefined;
    fctx.body.push({ op: "call", funcIdx: getterIdx });
    return { kind: "externref" };
  }
  const exports = namespaceFunctionExports(ctx, declaration);
  if (!exports) return undefined;

  const newObjectIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  for (const entry of exports) addStringConstantGlobal(ctx, entry.key);
  flushLateImportShifts(ctx, fctx);
  const finalNewObjectIdx = ctx.funcMap.get("__new_plain_object") ?? newObjectIdx;
  const finalSetIdx = ctx.funcMap.get("__extern_set") ?? setIdx;
  if (finalNewObjectIdx === undefined || finalSetIdx === undefined) return undefined;

  const cacheGlobal: GlobalDef = {
    name: `__module_namespace_${ctx.mod.globals.length}`,
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  };
  ctx.mod.globals.push(cacheGlobal);
  const cacheGlobalIdx = absoluteGlobalIndex(ctx, cacheGlobal);
  if (cacheGlobalIdx === undefined) return undefined;

  const getterName = `__get_module_namespace_${ctx.mod.functions.length}`;
  const getterFctx: FunctionContext = {
    name: getterName,
    params: [],
    locals: [],
    localMap: new Map(),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  const savedBody = pushBody(getterFctx);
  getterFctx.body.push({ op: "call", funcIdx: finalNewObjectIdx });
  const objectLocal = allocLocal(getterFctx, `__module_namespace_obj_${getterFctx.locals.length}`, {
    kind: "externref",
  });
  getterFctx.body.push({ op: "local.set", index: objectLocal });
  for (const entry of exports) {
    const valueType = emitCachedFuncClosureAccess(
      ctx,
      getterFctx,
      entry.functionName,
      entry.funcIdx,
      entry.constructible,
    );
    if (valueType === null) {
      getterFctx.body.push({ op: "ref.null.extern" });
    } else if (valueType.kind !== "externref") {
      coerceType(ctx, getterFctx, valueType, { kind: "externref" });
    }
    const valueLocal = allocLocal(getterFctx, `__module_namespace_value_${getterFctx.locals.length}`, {
      kind: "externref",
    });
    getterFctx.body.push({ op: "local.set", index: valueLocal });
    getterFctx.body.push({ op: "local.get", index: objectLocal });
    getterFctx.body.push(...stringConstantExternrefInstrs(ctx, entry.key));
    getterFctx.body.push({ op: "local.get", index: valueLocal });
    getterFctx.body.push({ op: "call", funcIdx: finalSetIdx });
  }
  // Global indices may have moved while function-value caches were reserved.
  const finalCacheGlobalIdx = absoluteGlobalIndex(ctx, cacheGlobal);
  if (finalCacheGlobalIdx === undefined) {
    popBody(getterFctx, savedBody);
    return undefined;
  }
  getterFctx.body.push({ op: "local.get", index: objectLocal });
  getterFctx.body.push({ op: "global.set", index: finalCacheGlobalIdx });
  const initBody = getterFctx.body;
  popBody(getterFctx, savedBody);

  getterFctx.body.push({ op: "global.get", index: finalCacheGlobalIdx });
  getterFctx.body.push({ op: "ref.is_null" });
  getterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  getterFctx.body.push({ op: "global.get", index: finalCacheGlobalIdx });
  const getterTypeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
  const getterFuncIdx = mintDefinedFunc(ctx);
  const getter: WasmFunction = {
    name: getterName,
    typeIdx: getterTypeIdx,
    locals: getterFctx.locals,
    body: getterFctx.body,
    exported: false,
  };
  pushDefinedFunc(ctx, getterFuncIdx, getter);
  ctx.funcMap.set(getterName, getterFuncIdx);
  cacheMap(ctx).set(declaration, { global: cacheGlobal, getterName });
  fctx.body.push({ op: "call", funcIdx: getterFuncIdx });
  return { kind: "externref" };
}
