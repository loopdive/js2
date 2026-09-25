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
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { withRuntimeModuleCallableBindings } from "./runtime-module-callable-metadata.js";
import { coerceType } from "./shared.js";

/** §10.4.6.2 module namespace own `Symbol.toStringTag` metadata. */
const MODULE_NAMESPACE_TO_STRING_TAG = "Module";
const MODULE_NAMESPACE_TO_STRING_TAG_SYMBOL_ID = 4;
// `__defineProperty_value` host ABI: data value present (bit 7), and all three
// false attributes explicitly present (bits 3/4/5).
const MODULE_NAMESPACE_TO_STRING_TAG_FLAGS = 0xb8;

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

/**
 * (#6651 N1) A top-level `export var` / `export let` of the imported module.
 *
 * Unlike {@link NamespaceGlobalExport} this binding is MUTABLE, so a snapshot
 * would be wrong the moment the exporting module reassigns it — §16.2.1.6.4
 * requires the namespace property to read the binding LIVE. The slot is filled
 * with a synthesized zero-argument getter over the module global and installed
 * through `__defineProperty_accessor` as `{enumerable: true, configurable:
 * false}` with no setter, which is also what makes the namespace's `[[Set]]` /
 * `[[Delete]]` refusals fall out for free.
 *
 * Before this arm a single `export var` declined the WHOLE namespace object and
 * `ns` read back null/undefined — the reason every
 * `language/module-code/namespace/internals/*` row failed on `ns` rather than
 * on the §10.4.6 behaviour it was written to test.
 */
interface NamespaceLiveExport {
  readonly kind: "live";
  readonly key: string;
  readonly globalName: string;
}

/**
 * (#6651 N1) `export default <expression>` — the snapshot cell
 * `ctx.defaultExpressionGlobals` already mints for a cross-module import of
 * that default. The binding is immutable once module initialization has run
 * (there is no name to reassign), so the namespace slot may hold its value
 * rather than a getter.
 *
 * Without this arm `export default null` alone declined the whole namespace,
 * which is what kept `own-property-keys-sort.js` / `own-property-keys-binding-
 * types.js` reading `ns` as null even after live bindings landed.
 */
interface NamespaceDefaultExport {
  readonly kind: "default";
  readonly key: string;
  readonly global: GlobalDef;
}

type NamespaceExport =
  | NamespaceFunctionExport
  | NamespaceGlobalExport
  | NamespaceHostMemberExport
  | NamespaceLiveExport
  | NamespaceDefaultExport;

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

/**
 * (#6651 N1) `export var x` / `export let x` at the top level of the exporting
 * module, when the binding lives in a module global this compilation can read.
 *
 * Deliberately the same shape as {@link immutableTopLevelConstName} minus the
 * `const` requirement: the difference between the two is not whether the
 * namespace can carry the binding, but whether the slot may hold a SNAPSHOT
 * (const) or must hold a live getter (var/let).
 */
function mutableTopLevelBindingName(ctx: CodegenContext, node: ts.Declaration): string | undefined {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return undefined;
  const list = node.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) !== 0) return undefined;
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

/**
 * (#5330) The module specifier a namespace import names, or `undefined` when it
 * is not a plain string literal.
 */
function namespaceImportSpecifier(declaration: ts.NamespaceImport): string | undefined {
  const importDeclaration = declaration.parent.parent;
  if (!ts.isImportDeclaration(importDeclaration)) return undefined;
  const specifier = importDeclaration.moduleSpecifier;
  return ts.isStringLiteral(specifier) ? specifier.text : undefined;
}

function namespaceFunctionExports(
  ctx: CodegenContext,
  declaration: ts.NamespaceImport,
): readonly NamespaceExport[] | undefined {
  // (#5330) `import * as path from 'path'` — a namespace import OF a Node
  // builtin is served by the host module thunk (`__node_<mod>`), never by a
  // synthesized object. This optimizer asks the CHECKER for the module's
  // exports, and with no `@types/node` in the program a BARE builtin specifier
  // resolves to nothing at all: `getExportsOfModule` answers `[]`, which is an
  // empty-but-truthy list, so the namespace was materialized as
  // `__new_plain_object()` with no properties. `path.join` was then genuinely
  // undefined ("join is not a function"), `path.sep` undefined, and
  // `String(path)` `[object Object]` — while the module still imported
  // `__node_path` for nothing. The `node:`-prefixed spelling escaped only by
  // accident: the injected ambient `declare module "node:path"` gives it ONE
  // export whose sole declaration lives in a `.d.ts`, which trips the
  // mutable-value decline below and falls through to the host binding.
  // Decline for the whole family, up front, for the actual reason.
  //
  // This does NOT affect a user module that RE-EXPORTS builtin members
  // (`export { join } from 'node:path'`): that namespace belongs to the user
  // module, and its entries keep the `host-member` lowering below.
  const specifier = namespaceImportSpecifier(declaration);
  if (specifier !== undefined && isNodeBuiltin(specifier)) return undefined;
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
      // (#6651 N1) `export default <expression>` reads its own snapshot cell.
      if (ts.isExportAssignment(declarationNode) && declarationNode.isExportEquals !== true) {
        const defaultGlobal = ctx.defaultExpressionGlobals?.get(declarationNode);
        if (defaultGlobal === undefined) return undefined;
        exports.push({ kind: "default", key: exportedSymbol.getName(), global: defaultGlobal.value });
        continue;
      }
      // (#6651 N1) …and a mutable top-level `var`/`let` gets a LIVE getter
      // rather than declining the whole object.
      const liveName = mutableTopLevelBindingName(ctx, declarationNode);
      if (liveName !== undefined) {
        exports.push({
          kind: "live",
          key: exportedSymbol.getName(),
          globalName: liveName,
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
  //
  // §10.4.6.7 sorts the export names "according to lexicographic code unit
  // order", which is `<` on the raw UTF-16 strings — NOT `localeCompare`, whose
  // collation interleaves case and reorders `$`/`_`. `own-property-keys-sort.js`
  // pins the difference: it expects `$ $$ A Z _ __ a aa az default z za zz λ μ π`,
  // while `localeCompare` answers `_ __ $ $$ a A aa az default z za zz λ μ π`
  // (#6651 N1).
  exports.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
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

/**
 * (#6651 N1) `__defineProperty_accessor` flag word for a module-namespace
 * property: `{enumerable: true, configurable: false}` in the
 * `computeRuntimeFlags` encoding — bits 4/5 mark enumerable/configurable as
 * SPECIFIED, bits 1/2 carry their values, so enumerable-true is bit 1 set and
 * configurable-false is bit 2 clear. Bits 8/9 stay clear, which the runtime
 * reads as "both halves specified": the namespace slot genuinely has no
 * `[[Set]]`, and that absent half is what refuses a write.
 */
const MODULE_NAMESPACE_LIVE_ACCESSOR_FLAGS = (1 << 4) | (1 << 5) | (1 << 1);

/**
 * Mint a zero-argument getter over the exporting module's global for one live
 * binding, and return its defined-function index.
 *
 * The emitted `global.get` index is recorded in `globalReads` exactly like the
 * snapshot arm's: reserving a function-value cache or a string constant adds
 * import globals and shifts the module-global range, so every baked index is
 * re-resolved after the export loop finishes.
 */
function mintLiveBindingGetter(
  ctx: CodegenContext,
  entry: NamespaceLiveExport,
  globalReads: { instr: { op: "global.get"; index: number }; name: string }[],
): number | undefined {
  const globalIdx = ctx.moduleGlobals.get(entry.globalName);
  const global = globalIdx === undefined ? undefined : ctx.mod.globals[globalIdx - ctx.numImportGlobals];
  if (globalIdx === undefined || global === undefined) return undefined;

  const name = `__module_namespace_live_${ctx.mod.functions.length}`;
  const fctx: FunctionContext = {
    name,
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
  const instr = { op: "global.get" as const, index: globalIdx };
  fctx.body.push(instr);
  globalReads.push({ instr, name: entry.globalName });
  if (global.type.kind !== "externref") coerceType(ctx, fctx, global.type, { kind: "externref" });

  const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

function emitNamespaceObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  cacheKey: object,
  exports: readonly NamespaceExport[],
  moduleNamespaceTag: boolean,
): ValType | undefined {
  const existing = cacheMap(ctx).get(cacheKey);
  if (existing) {
    const getterIdx = ctx.funcMap.get(existing.getterName);
    if (getterIdx === undefined) return undefined;
    fctx.body.push({ op: "call", funcIdx: getterIdx });
    return { kind: "externref" };
  }

  // The namespace is an ordinary `$Object` carrier with a deliberately narrow
  // own-property surface. Only an actual ESM namespace import owns the Module
  // tag; this emitter also serves TypeScript runtime namespace projections.
  // Establish the native descriptor helper only for the native provider. Host
  // GC uses the shared descriptor late import below; eagerly minting the native
  // runtime there would incorrectly require native-string helpers.
  if (moduleNamespaceTag && ctx.targetProfile.semanticProviders === "native-first") ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
  if (moduleNamespaceTag) {
    // (#6651 N1) §10.4.6.1 `[[GetPrototypeOf]]` is always null and
    // §10.4.6.4 `[[IsExtensible]]` is always false. Both are observable and
    // both are load-bearing for OTHER methods: with `Object.prototype` in the
    // chain `ns.__proto__` answers an object where the spec says `undefined`
    // and `'__proto__' in ns` is true; while the object stays extensible,
    // `Reflect.set(ns, <non-export>)` answers true where the spec says false.
    ensureLateImport(ctx, "__object_create", [{ kind: "externref" }], [{ kind: "externref" }]);
    ensureLateImport(ctx, "__object_preventExtensions", [{ kind: "externref" }], [{ kind: "externref" }]);
    ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [{ kind: "externref" }]);
    ensureLateImport(
      ctx,
      "__defineProperty_value",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
    );
    // Reserve the tag literal before the one flush below, alongside every
    // helper used by the cached initializer. The final helper indices are read
    // from the live map only after that flush.
    addStringConstantGlobal(ctx, MODULE_NAMESPACE_TO_STRING_TAG);
  }
  // (#6651 N1) The live-binding arm installs accessors, not `__extern_set`
  // values. Reserve its helper in the SAME batch as everything else — one
  // `flushLateImportShifts` runs below and every index is read after it.
  if (exports.some((entry) => entry.kind === "live")) {
    ensureLateImport(
      ctx,
      "__defineProperty_accessor",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
    );
  }
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
  const finalObjectCreateIdx = moduleNamespaceTag ? ctx.funcMap.get("__object_create") : undefined;
  const finalPreventExtensionsIdx = moduleNamespaceTag ? ctx.funcMap.get("__object_preventExtensions") : undefined;
  if (moduleNamespaceTag && (finalObjectCreateIdx === undefined || finalPreventExtensionsIdx === undefined)) {
    return undefined;
  }
  const finalNewObjectIdx = ctx.funcMap.get("__new_plain_object");
  const finalSetIdx = ctx.funcMap.get("__extern_set");
  if (finalNewObjectIdx === undefined || finalSetIdx === undefined) {
    return undefined;
  }
  const hasLiveExport = exports.some((entry) => entry.kind === "live");
  const finalDefineAccessorIdx = hasLiveExport ? ctx.funcMap.get("__defineProperty_accessor") : undefined;
  if (hasLiveExport && finalDefineAccessorIdx === undefined) return undefined;
  const finalBoxSymbolIdx = moduleNamespaceTag ? ctx.funcMap.get("__box_symbol") : undefined;
  const finalDefinePropertyValueIdx = moduleNamespaceTag ? ctx.funcMap.get("__defineProperty_value") : undefined;
  if (moduleNamespaceTag && (finalBoxSymbolIdx === undefined || finalDefinePropertyValueIdx === undefined))
    return undefined;

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
  if (finalObjectCreateIdx !== undefined) {
    // §10.4.6.1 — `Object.create(null)`: a module namespace has NO prototype.
    getterFctx.body.push({ op: "ref.null.extern" });
    getterFctx.body.push({ op: "call", funcIdx: finalObjectCreateIdx });
  } else {
    getterFctx.body.push({ op: "call", funcIdx: finalNewObjectIdx });
  }
  const objectLocal = allocLocal(getterFctx, `__module_namespace_obj_${getterFctx.locals.length}`, {
    kind: "externref",
  });
  getterFctx.body.push({ op: "local.set", index: objectLocal });
  if (moduleNamespaceTag) {
    // §10.4.6.2: every module namespace owns `Symbol.toStringTag` = "Module"
    // with all three descriptor attributes false. This is a genuine well-known
    // symbol key, not the unrelated string property "toStringTag".
    if (finalBoxSymbolIdx === undefined || finalDefinePropertyValueIdx === undefined) {
      popBody(getterFctx, savedBody);
      return undefined;
    }
    getterFctx.body.push(
      { op: "local.get", index: objectLocal },
      { op: "i32.const", value: MODULE_NAMESPACE_TO_STRING_TAG_SYMBOL_ID },
      { op: "call", funcIdx: finalBoxSymbolIdx },
      ...stringConstantExternrefInstrs(ctx, MODULE_NAMESPACE_TO_STRING_TAG),
      { op: "f64.const", value: MODULE_NAMESPACE_TO_STRING_TAG_FLAGS },
      { op: "call", funcIdx: finalDefinePropertyValueIdx },
      { op: "drop" },
    );
  }
  // `global.get` indices baked here can still move: reserving a function-value
  // cache or a string constant adds import globals and shifts the module-global
  // range. `ctx.moduleGlobals` is shifted with them, so remember each emitted
  // read and re-resolve its index once the loop is done — the same treatment
  // the cache global gets below.
  const globalReads: {
    instr: { op: "global.get"; index: number };
    name: string;
  }[] = [];
  const defaultReads: {
    instr: { op: "global.get"; index: number };
    global: GlobalDef;
  }[] = [];
  for (const entry of exports) {
    let valueType: ValType | null;
    if (entry.kind === "live") {
      // Stack: [obj, key, getter, null, flags] — no setter, so the namespace's
      // §10.4.6.9 `[[Set]]` refusal and §10.4.6.10 `[[Delete]]` refusal fall out
      // of the descriptor itself.
      const getterFuncIdx =
        finalDefineAccessorIdx === undefined ? undefined : mintLiveBindingGetter(ctx, entry, globalReads);
      if (getterFuncIdx === undefined || finalDefineAccessorIdx === undefined) {
        popBody(getterFctx, savedBody);
        return undefined;
      }
      getterFctx.body.push({ op: "local.get", index: objectLocal });
      getterFctx.body.push(...stringConstantExternrefInstrs(ctx, entry.key));
      if (
        emitCachedFuncClosureAccess(ctx, getterFctx, `__module_namespace_live_getter_${entry.key}`, getterFuncIdx) ===
        null
      ) {
        popBody(getterFctx, savedBody);
        return undefined;
      }
      getterFctx.body.push({ op: "ref.null.extern" });
      getterFctx.body.push({ op: "f64.const", value: MODULE_NAMESPACE_LIVE_ACCESSOR_FLAGS });
      getterFctx.body.push({ op: "call", funcIdx: finalDefineAccessorIdx });
      getterFctx.body.push({ op: "drop" });
      continue;
    }
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
    } else if (entry.kind === "default") {
      // The default cell is a `GlobalDef` identity, not a named module global,
      // so its absolute index is recomputed from `ctx.mod.globals` here and
      // again in the post-loop fixup (`defaultReads`) after any late import
      // has shifted the global range.
      const index = absoluteGlobalIndex(ctx, entry.global);
      if (index === undefined) {
        popBody(getterFctx, savedBody);
        return undefined;
      }
      const instr = { op: "global.get" as const, index };
      getterFctx.body.push(instr);
      defaultReads.push({ instr, global: entry.global });
      valueType = entry.global.type;
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
  for (const read of defaultReads) {
    const current = absoluteGlobalIndex(ctx, read.global);
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
  if (finalPreventExtensionsIdx !== undefined) {
    // §10.4.6.4 — sealed AFTER every export slot is installed, so the installs
    // themselves are unaffected and only later writes see the refusal.
    getterFctx.body.push({ op: "local.get", index: objectLocal });
    getterFctx.body.push({ op: "call", funcIdx: finalPreventExtensionsIdx });
    getterFctx.body.push({ op: "drop" });
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
  return exports ? emitNamespaceObject(ctx, fctx, declaration, exports, true) : undefined;
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
  return emitNamespaceObject(ctx, fctx, surface.symbol, surface.exports, false);
}
