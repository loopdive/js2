// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Runtime values for same-compilation ESM namespace imports. */

import type { GlobalDef, ValType, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { emitCachedFuncClosureAccess, ensureFuncClosureSingleton } from "./closures.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { coerceType } from "./shared.js";

interface NamespaceFunctionExport {
  readonly kind: "function";
  readonly key: string;
  readonly functionName: string;
  readonly funcIdx: number;
  readonly constructible: boolean;
}

/**
 * A top-level `export const` of the imported module. `const` is the one binding
 * form whose value is fixed once module initialization has run, so the snapshot
 * this object publishes stays correct — which is exactly the carve-out the
 * "mutable values require live-binding getters" rule below leaves open. `let`,
 * `var` and reassigned function declarations still decline the whole object.
 */
interface NamespaceGlobalExport {
  readonly kind: "global";
  readonly key: string;
  readonly globalName: string;
}

type NamespaceExport = NamespaceFunctionExport | NamespaceGlobalExport;

/** `export const x = …` at the top level of the exporting module. */
function immutableTopLevelConstName(ctx: CodegenContext, node: ts.Declaration): string | undefined {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return undefined;
  const list = node.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return undefined;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement) || statement.parent !== statement.getSourceFile()) return undefined;
  return ctx.moduleGlobals.has(node.name.text) ? node.name.text : undefined;
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
): readonly NamespaceExport[] | undefined {
  let moduleSymbol = ctx.checker.getSymbolAtLocation(declaration.name);
  if (!moduleSymbol) return undefined;
  if ((moduleSymbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      moduleSymbol = ctx.checker.getAliasedSymbol(moduleSymbol);
    } catch {
      return undefined;
    }
  }

  const exports: NamespaceExport[] = [];
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
    if (declarationNode !== undefined) {
      // `export const` is immutable after module init, so a snapshot of the
      // exporting module's global is a correct namespace property. Without this
      // arm a single `export const` in the module declined the WHOLE namespace
      // object, and `ns.CONSTANT` trapped even though `ns.fn()` worked.
      const constName = immutableTopLevelConstName(ctx, declarationNode);
      if (constName !== undefined) {
        exports.push({
          kind: "global",
          key: exportedSymbol.getName(),
          globalName: constName,
        });
        continue;
      }
    }
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
    exports.push({
      kind: "function",
      key: exportedSymbol.getName(),
      functionName,
      funcIdx,
      constructible,
    });
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
  // `global.get` indices baked here can still move: reserving a function-value
  // cache or a string constant adds import globals and shifts the module-global
  // range. `ctx.moduleGlobals` is shifted with them, so remember each emitted
  // read and re-resolve its index once the loop is done — the same treatment
  // the cache global gets below.
  const globalReads: {
    instr: { op: "global.get"; index: number };
    name: string;
  }[] = [];
  for (const entry of exports) {
    let valueType: ValType | null;
    if (entry.kind === "global") {
      const globalIdx = ctx.moduleGlobals.get(entry.globalName);
      const global = globalIdx === undefined ? undefined : ctx.mod.globals[globalIdx - ctx.numImportGlobals];
      if (global === undefined) {
        popBody(getterFctx, savedBody);
        return undefined;
      }
      const instr = { op: "global.get" as const, index: globalIdx! };
      getterFctx.body.push(instr);
      globalReads.push({ instr, name: entry.globalName });
      valueType = global.type;
    } else {
      valueType = emitCachedFuncClosureAccess(ctx, getterFctx, entry.functionName, entry.funcIdx, entry.constructible);
    }
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
  for (const read of globalReads) {
    const current = ctx.moduleGlobals.get(read.name);
    if (current === undefined) {
      popBody(getterFctx, savedBody);
      return undefined;
    }
    read.instr.index = current;
  }
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
  getterFctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: initBody,
    else: [],
  });
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
