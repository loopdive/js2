// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Runtime values for same-compilation ESM namespace imports. */

import type { GlobalDef, ValType, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { emitCachedFuncClosureAccess, ensureFuncClosureSingleton } from "./closures.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isNodeBuiltin, normalizeNodeBuiltin } from "../import-resolver.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { withRuntimeModuleCallableBindings } from "./runtime-module-callable-metadata.js";
import { coerceType } from "./shared.js";

interface NamespaceFunctionExport {
  readonly kind: "function";
  readonly key: string;
  readonly functionName: string;
  readonly declaration: ts.FunctionDeclaration;
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

/**
 * A binding the exporting module re-exports straight from a Node builtin
 * (`export { equal } from "node:assert"`). There is no compiled declaration to
 * point at — the value lives on the host module object — so the slot is filled
 * with the same `__extern_get(__node_<mod>(), member)` carrier that
 * `registerNodeBuiltinImports` gives a direct named import. Without this arm one
 * such re-export declined the WHOLE namespace object and `ns` read back null.
 */
interface NamespaceHostMemberExport {
  readonly kind: "host-member";
  readonly key: string;
  readonly moduleName: string;
  readonly propertyName: string;
}

type NamespaceExport = NamespaceFunctionExport | NamespaceGlobalExport | NamespaceHostMemberExport;

/** `{ moduleName, propertyName }` when `specifier` names a Node builtin. */
function hostMemberOf(
  specifier: ts.Expression | undefined,
  binding: ts.ImportSpecifier | ts.ExportSpecifier,
): { moduleName: string; propertyName: string } | undefined {
  if (specifier === undefined || !ts.isStringLiteral(specifier) || !isNodeBuiltin(specifier.text)) return undefined;
  return {
    moduleName: normalizeNodeBuiltin(specifier.text),
    propertyName: (binding.propertyName ?? binding.name).text,
  };
}

/** The `import { x } from "…"` specifier a bare `export { x }` republishes. */
function localImportSpecifier(sourceFile: ts.SourceFile, localName: string): ts.ImportSpecifier | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text === localName) return element;
    }
  }
  return undefined;
}

/**
 * Follow an export's alias chain to the Node-builtin binding it names, if any.
 *
 * Read off the syntax rather than the checker deliberately: with no
 * `@types/node` in the program the alias resolves to the `unknown` symbol, so
 * there is nothing to ask the checker about. Both spellings are covered —
 * `export { x } from "node:assert"`, and the two-step `import { x } from
 * "node:assert"; export { x }` (whose local target is resolved by name within
 * the same file, since an export specifier can only rebind a local binding).
 */
function nodeBuiltinReexport(symbol: ts.Symbol): { moduleName: string; propertyName: string } | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isImportSpecifier(declaration)) {
      const found = hostMemberOf(declaration.parent.parent.parent.moduleSpecifier, declaration);
      if (found !== undefined) return found;
      continue;
    }
    if (!ts.isExportSpecifier(declaration)) continue;
    const reexported = declaration.parent.parent.moduleSpecifier;
    if (reexported !== undefined) {
      const found = hostMemberOf(reexported, declaration);
      if (found !== undefined) return found;
      continue;
    }
    const local = localImportSpecifier(
      declaration.getSourceFile(),
      (declaration.propertyName ?? declaration.name).text,
    );
    if (local === undefined) continue;
    const found = hostMemberOf(local.parent.parent.parent.moduleSpecifier, local);
    if (found !== undefined) return found;
  }
  return undefined;
}

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

const namespaceObjectCaches = new WeakMap<CodegenContext, WeakMap<object, NamespaceObjectCache>>();

function cacheMap(ctx: CodegenContext): WeakMap<object, NamespaceObjectCache> {
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
    // Checked before the declaration arms: a Node builtin's binding is served by
    // the host module object whether or not `@types/node` happens to give the
    // alias a (body-less, declaration-file) node to point at.
    const hostMember = ctx.wasi ? undefined : nodeBuiltinReexport(exportedSymbol);
    if (hostMember !== undefined) {
      exports.push({
        kind: "host-member",
        key: exportedSymbol.getName(),
        moduleName: hostMember.moduleName,
        propertyName: hostMember.propertyName,
      });
      continue;
    }
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
      declaration: declarationNode,
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

interface RuntimeNamespaceFunctionSurface {
  readonly symbol: ts.Symbol;
  readonly keys: ReadonlySet<string>;
  readonly exports: readonly NamespaceFunctionExport[];
}

const runtimeNamespaceFunctionSurfaces = new WeakMap<
  CodegenContext,
  WeakMap<ts.Symbol, RuntimeNamespaceFunctionSurface | null>
>();

function runtimeSurfaceCache(ctx: CodegenContext): WeakMap<ts.Symbol, RuntimeNamespaceFunctionSurface | null> {
  let cache = runtimeNamespaceFunctionSurfaces.get(ctx);
  if (!cache) {
    cache = new WeakMap();
    runtimeNamespaceFunctionSurfaces.set(ctx, cache);
  }
  return cache;
}

function canonicalRuntimeNamespaceSymbol(ctx: CodegenContext, identifier: ts.Identifier): ts.Symbol | undefined {
  let symbol = ctx.checker.getSymbolAtLocation(identifier);
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = ctx.checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  return symbol.declarations?.some(
    (declaration) =>
      ts.isModuleDeclaration(declaration) &&
      declaration.body !== undefined &&
      ts.isModuleBlock(declaration.body) &&
      !declaration.getSourceFile().isDeclarationFile,
  )
    ? symbol
    : undefined;
}

function skipNamespaceReceiverWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function finiteStringKeys(ctx: CodegenContext, expression: ts.Expression): ReadonlySet<string> | undefined {
  let type = ctx.checker.getTypeAtLocation(expression);
  try {
    type = ctx.checker.getBaseConstraintOfType(type) ?? type;
  } catch {
    return undefined;
  }
  const members = type.isUnion() ? type.types : [type];
  const keys = new Set<string>();
  for (const member of members) {
    if ((member.flags & ts.TypeFlags.StringLiteral) === 0) return undefined;
    keys.add((member as ts.StringLiteralType).value);
  }
  return keys.size > 0 ? keys : undefined;
}

function runtimeNamespaceMemberImplementation(target: ts.Symbol): ts.FunctionDeclaration | undefined {
  const seen = new Set<ts.Declaration>();
  const implementations: ts.FunctionDeclaration[] = [];
  for (const declaration of [target.valueDeclaration, ...(target.declarations ?? [])]) {
    if (declaration === undefined || seen.has(declaration)) continue;
    seen.add(declaration);
    if (ts.isFunctionDeclaration(declaration) && declaration.name !== undefined && declaration.body !== undefined) {
      implementations.push(declaration);
    }
  }
  return implementations.length === 1 ? implementations[0] : undefined;
}

function runtimeNamespaceFunctionExport(
  ctx: CodegenContext,
  moduleBlocks: ReadonlySet<ts.ModuleBlock>,
  exportedSymbol: ts.Symbol,
): NamespaceFunctionExport | undefined {
  let target = exportedSymbol;
  if ((target.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      target = ctx.checker.getAliasedSymbol(target);
    } catch {
      return undefined;
    }
  }
  const declaration = runtimeNamespaceMemberImplementation(target);
  if (
    declaration === undefined ||
    declaration.name === undefined ||
    !ts.isModuleBlock(declaration.parent) ||
    !moduleBlocks.has(declaration.parent)
  ) {
    return undefined;
  }
  const registry = ctx.programAbiSourceCallables;
  const identity = registry?.identityContext;
  const unitId = identity?.unitIdByDeclaration.get(declaration);
  if (
    unitId === undefined ||
    identity?.declarationByUnitId.get(unitId) !== declaration ||
    registry?.functionForUnit(unitId) === undefined
  ) {
    return undefined;
  }
  const funcIdx = registry.handleForUnit(unitId);
  const func = funcIdx === undefined ? undefined : definedFuncAt(ctx, funcIdx);
  if (funcIdx === undefined || func === undefined || func !== registry.functionForUnit(unitId)) return undefined;
  const functionName = declaration.name.text;
  const constructible =
    declaration.asteriskToken === undefined &&
    !(declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
  if (ensureFuncClosureSingleton(ctx, functionName, funcIdx, constructible) === null) return undefined;
  return { kind: "function", key: exportedSymbol.getName(), functionName, declaration, funcIdx, constructible };
}

function runtimeNamespaceFunctionSurface(
  ctx: CodegenContext,
  identifier: ts.Identifier,
): RuntimeNamespaceFunctionSurface | undefined {
  const symbol = canonicalRuntimeNamespaceSymbol(ctx, identifier);
  if (!symbol) return undefined;
  const cache = runtimeSurfaceCache(ctx);
  const cached = cache.get(symbol);
  if (cached !== undefined) return cached ?? undefined;

  const moduleBlocks = new Set<ts.ModuleBlock>();
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isModuleDeclaration(declaration) &&
      declaration.body !== undefined &&
      ts.isModuleBlock(declaration.body) &&
      !declaration.getSourceFile().isDeclarationFile
    ) {
      moduleBlocks.add(declaration.body);
    }
  }

  const mutableKeys = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isElementAccessExpression(node) &&
      ts.isBinaryExpression(node.parent) &&
      node.parent.left === node &&
      node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const receiver = skipNamespaceReceiverWrappers(node.expression);
      if (ts.isIdentifier(receiver) && canonicalRuntimeNamespaceSymbol(ctx, receiver) === symbol) {
        const keys = finiteStringKeys(ctx, node.argumentExpression);
        if (keys) for (const key of keys) mutableKeys.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const block of moduleBlocks) visit(block);
  if (mutableKeys.size === 0) {
    cache.set(symbol, null);
    return undefined;
  }

  const exportedByName = new Map(ctx.checker.getExportsOfModule(symbol).map((entry) => [entry.getName(), entry]));
  const exports: NamespaceFunctionExport[] = [];
  for (const key of mutableKeys) {
    const exportedSymbol = exportedByName.get(key);
    const entry = exportedSymbol && runtimeNamespaceFunctionExport(ctx, moduleBlocks, exportedSymbol);
    if (!entry) {
      cache.set(symbol, null);
      return undefined;
    }
    exports.push(entry);
  }
  exports.sort((left, right) => left.key.localeCompare(right.key));
  const surface = { symbol, keys: mutableKeys, exports } satisfies RuntimeNamespaceFunctionSurface;
  cache.set(symbol, surface);
  return surface;
}

function absoluteGlobalIndex(ctx: CodegenContext, global: GlobalDef): number | undefined {
  const localIndex = ctx.mod.globals.indexOf(global);
  return localIndex < 0 ? undefined : ctx.numImportGlobals + localIndex;
}

function currentNamespaceFunctionHandle(ctx: CodegenContext, entry: NamespaceFunctionExport): number | undefined {
  const registry = ctx.programAbiSourceCallables;
  const identity = registry?.identityContext;
  const unitId = identity?.unitIdByDeclaration.get(entry.declaration);
  if (
    unitId === undefined ||
    identity?.declarationByUnitId.get(unitId) !== entry.declaration ||
    registry?.functionForUnit(unitId) === undefined
  ) {
    return undefined;
  }
  const handle = registry.handleForUnit(unitId);
  return handle !== undefined && definedFuncAt(ctx, handle) === registry.functionForUnit(unitId) ? handle : undefined;
}

function emitNamespaceObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  cacheKey: object,
  exports: readonly NamespaceExport[],
): ValType | undefined {
  const existing = cacheMap(ctx).get(cacheKey);
  if (existing) {
    const getterIdx = ctx.funcMap.get(existing.getterName);
    if (getterIdx === undefined) return undefined;
    fctx.body.push({ op: "call", funcIdx: getterIdx });
    return { kind: "externref" };
  }
  const newObjectIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  for (const entry of exports) addStringConstantGlobal(ctx, entry.key);
  // Reserve the host-member carrier imports in the SAME batch as the object
  // helpers: every `ensureLateImport` shifts the defined-function index space,
  // and only one `flushLateImportShifts` runs before the getter body is built.
  for (const entry of exports) {
    if (entry.kind !== "host-member") continue;
    ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    ensureLateImport(ctx, `__node_${entry.moduleName}`, [], [{ kind: "externref" }]);
    ctx.mod.nodeBuiltinModules.add(entry.moduleName);
    addStringConstantGlobal(ctx, entry.propertyName);
  }
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
    } else if (entry.kind === "host-member") {
      // `__extern_get(__node_<mod>(), "<member>")` — the host module object's
      // own property, so the slot holds the real callable rather than a copy.
      const moduleIdx = ctx.funcMap.get(`__node_${entry.moduleName}`);
      const externGetIdx = ctx.funcMap.get("__extern_get");
      if (moduleIdx === undefined || externGetIdx === undefined) {
        popBody(getterFctx, savedBody);
        return undefined;
      }
      getterFctx.body.push({ op: "call", funcIdx: moduleIdx });
      getterFctx.body.push(...stringConstantExternrefInstrs(ctx, entry.propertyName));
      getterFctx.body.push({ op: "call", funcIdx: externGetIdx });
      valueType = { kind: "externref" };
    } else {
      const currentHandle = currentNamespaceFunctionHandle(ctx, entry);
      valueType =
        currentHandle === undefined
          ? null
          : withRuntimeModuleCallableBindings(ctx, [{ declaration: entry.declaration, handle: currentHandle }], () =>
              emitCachedFuncClosureAccess(ctx, getterFctx, entry.functionName, currentHandle, entry.constructible),
            );
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
    getterFctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_set") ?? finalSetIdx });
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
  cacheMap(ctx).set(cacheKey, { global: cacheGlobal, getterName });
  fctx.body.push({ op: "call", funcIdx: getterFuncIdx });
  return { kind: "externref" };
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
  const exports = namespaceFunctionExports(ctx, declaration);
  return exports ? emitNamespaceObject(ctx, fctx, declaration, exports) : undefined;
}

function namespaceMemberAccessForIdentifier(
  identifier: ts.Identifier,
): ts.PropertyAccessExpression | ts.ElementAccessExpression | undefined {
  let current: ts.Expression = identifier;
  let parent = current.parent;
  while (
    parent !== undefined &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)) &&
    parent.expression === current
  ) {
    current = parent;
    parent = current.parent;
  }
  return parent !== undefined &&
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === current
    ? parent
    : undefined;
}

/**
 * Materialize the checker-proven function projection of a runtime namespace
 * whose computed writes are bounded to a finite set of callable exports.
 */
export function tryEmitCompiledRuntimeNamespaceFunctionObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  identifier: ts.Identifier,
): ValType | undefined {
  const access = namespaceMemberAccessForIdentifier(identifier);
  if (!access) return undefined;
  const surface = runtimeNamespaceFunctionSurface(ctx, identifier);
  if (!surface) return undefined;
  if (ts.isPropertyAccessExpression(access)) {
    if (ts.isPrivateIdentifier(access.name) || !surface.keys.has(access.name.text)) return undefined;
  } else {
    const keys = finiteStringKeys(ctx, access.argumentExpression);
    if (!keys || [...keys].some((key) => !surface.keys.has(key))) return undefined;
  }
  return emitNamespaceObject(ctx, fctx, surface.symbol, surface.exports);
}
