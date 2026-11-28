// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { GlobalDef, Instr, ValType } from "../ir/types.js";
import { forEachChild, ts } from "../ts-api.js";
import { hasDeclareModifier } from "./ast-modifiers.js";
import type { CodegenContext } from "./context/types.js";
import { computeElidableTopLevelTdzNames } from "./expressions/identifiers.js";
import {
  addModuleBinding,
  attachModuleBindingDeclaration,
  isCollidingModuleName,
  type ModuleBindingDeclaration,
  moduleBindingOf,
  moduleBindingsNamed,
  scopedModuleBinding,
} from "./module-binding-table.js";
import { absoluteGlobalIdx } from "./global-space.js";
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
 * (#6669) `funcMap` is keyed by bare name across the linked graph, so another
 * module's top-level `function oe` is not this module's binding: a same-named
 * variable here (`const oe = Object.getPrototypeOf`) still needs its own cell.
 */
function functionIsFromAnotherSource(
  ctx: CodegenContext,
  fnIdx: number,
  declaration: ts.VariableDeclaration | ts.BindingElement | undefined,
): boolean {
  if (declaration === undefined) return false;
  const owner = ctx.sourceFunctionDeclarationByHandle.get(fnIdx);
  return owner !== undefined && owner.getSourceFile() !== declaration.getSourceFile();
}

/**
 * (#6651 V10b) Does this top-level SCRIPT `var` redeclare an ambient lib global
 * (`var length = {…}` against lib.dom's `declare var length: number`)? The two
 * merge into one checker symbol whose declared type is the LIB's, which is a
 * host fiction on the host-free lane: the runtime binding holds whatever the
 * script stores. Standalone only, so host-lane bytes are untouched.
 */
export function scriptVarRedeclaresAmbientGlobal(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (ctx.sourceIsModule || decl.initializer === undefined) return false;
  if (decl.getSourceFile().isDeclarationFile || !ts.isIdentifier(decl.name)) return false;
  return ctx.oracle.declarationsOf(decl.name).some((d) => d.getSourceFile().isDeclarationFile);
}

/** (#6651 V10b) An identifier read whose binding is such a redeclared ambient script var. */
function readsAmbientRedeclaringScriptVar(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (ctx.sourceIsModule || !ts.isIdentifier(expr)) return false;
  return ctx.oracle
    .declarationsOf(expr)
    .some((d) => ts.isVariableDeclaration(d) && scriptVarRedeclaresAmbientGlobal(ctx, d));
}

/**
 * (#6651 V10b) A CALL-ARGUMENT object literal reading such a var: the read
 * carries the LIB's checker type (`length: number`), so a closed struct field
 * would ToNumber it at construction (one observable `valueOf`). The caller
 * builds it as an open `$Object` instead. A declaration initializer keeps the
 * shape its binding was typed with.
 */
export function objectLiteralReadsAmbientRedeclaredVar(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): boolean {
  if (ctx.sourceIsModule || ts.isVariableDeclaration(expr.parent)) return false;
  return expr.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) && readsAmbientRedeclaringScriptVar(ctx, p.initializer)) ||
      (ts.isShorthandPropertyAssignment(p) && readsAmbientRedeclaringScriptVar(ctx, p.name)),
  );
}

/**
 * Register one module-level global. With a declaration it is that declaration's binding's global (#7470): reused
 * by every declaration of the binding, and a fresh `__mod_<name>` for a same-named binding of another module, whose
 * bare-name entry stays with the first. Without one (an internal or collision-safe qualified name) the bare name is
 * the key.
 */
export function registerModuleGlobal(
  ctx: CodegenContext,
  name: string,
  wasmType: ValType,
  declaration?: ModuleBindingDeclaration,
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
  if (
    fnIdx !== undefined &&
    fnIdx >= ctx.numImportFuncs &&
    !shadowsConversionHook &&
    !functionIsFromAnotherSource(ctx, fnIdx, declaration)
  ) {
    return;
  }
  const existingGlobalIdx = ctx.moduleGlobals.get(name);
  const existingGlobal =
    existingGlobalIdx === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, existingGlobalIdx)];
  if (existingGlobalIdx !== undefined && !existingGlobal) {
    throw new TypeError(`module global ${name} has no allocator object at index ${existingGlobalIdx}`);
  }
  if (declaration === undefined) {
    if (existingGlobal === undefined && !ctx.classSet.has(name)) mintBareModuleGlobal(ctx, name, wasmType);
    return;
  }
  let binding = scopedModuleBinding(ctx, name, declaration);
  if (binding === undefined) {
    if (existingGlobal === undefined && isClassOfScope(ctx, name, declaration)) return;
    // A bare entry no binding holds (an internal global of that name) is reused, as it always was; one another
    // module's binding holds stays that binding's.
    const heldElsewhere = moduleBindingsNamed(ctx, name).some((other) => other.value === existingGlobal);
    const value =
      existingGlobal === undefined
        ? mintBareModuleGlobal(ctx, name, wasmType)
        : heldElsewhere
          ? allocateModuleGlobal(ctx, name, wasmType)
          : existingGlobal;
    binding = addModuleBinding(ctx, name, declaration, value);
  }
  ctx.programAbiGlobals?.assertModuleBindingsOpen(name);
  attachModuleBindingDeclaration(ctx, declaration, binding);
}

/**
 * `name` is a class of `declaration`'s scope, whose class singleton is that binding's storage. The class map is
 * keyed by bare name too, so a same-named class of another module is another binding and needs no say (#7470).
 */
function isClassOfScope(ctx: CodegenContext, name: string, declaration: ModuleBindingDeclaration): boolean {
  const classDeclaration = ctx.classSet.has(name) ? ctx.classDeclarationMap.get(name) : undefined;
  return (
    classDeclaration !== undefined &&
    (!ctx.sourceIsModule || classDeclaration.getSourceFile() === declaration.getSourceFile())
  );
}

/** Allocate `name`'s global and give it the bare-name entry. */
function mintBareModuleGlobal(ctx: CodegenContext, name: string, wasmType: ValType): GlobalDef {
  ctx.moduleGlobals.set(name, nextModuleGlobalIdx(ctx));
  return allocateModuleGlobal(ctx, name, wasmType);
}

/** Append the zero-initialised mutable `__mod_<name>` global for `wasmType`. */
function allocateModuleGlobal(ctx: CodegenContext, name: string, wasmType: ValType): GlobalDef {
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
  const global: GlobalDef = {
    name: `__mod_${name}`,
    type: globalType,
    mutable: true,
    init,
  };
  ctx.mod.globals.push(global);
  return global;
}

/** Append one zero-initialised `__tdz_<name>` flag. */
function allocateModuleTdzGlobal(ctx: CodegenContext, name: string): GlobalDef {
  const flagGlobal: GlobalDef = {
    name: `__tdz_${name}`,
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  };
  ctx.mod.globals.push(flagGlobal);
  return flagGlobal;
}

/**
 * (#7470) `name` shows a binding other than the one that declares it: a source compiling under a view that points
 * its renamed import (`export { x as name }`) at `x`. The bare entries then hold `x`'s global and flag, which this
 * source reads, so it must neither check them as `name`'s flag nor allocate one under the view; a source that shows
 * `name`'s own binding allocates that flag.
 */
function showsAnotherBinding(ctx: CodegenContext, name: string): boolean {
  const owner = moduleBindingsNamed(ctx, name)[0];
  return owner !== undefined && ctx.moduleGlobals.get(name) !== absoluteGlobalIdx(ctx, owner.value);
}

/**
 * Allocate one retained top-level TDZ flag and attach it to the binding `sourceFile` declares. A name with one
 * binding keeps one bare-name flag; a name several modules declare gets a flag per binding (#7470), each decided
 * by {@link prepareCollidingModuleTdz}.
 */
export function registerModuleTdzGlobal(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  name: string,
  exactDeclaration?: ModuleBindingDeclaration,
): void {
  if (!ctx.moduleGlobals.has(name)) return;
  const declaration = exactDeclaration ?? findRuntimeTopLevelDeclaration(sourceFile, name);
  const binding = declaration && moduleBindingOf(ctx, declaration);
  if (binding === undefined && showsAnotherBinding(ctx, name)) return;
  const existingGlobalIdx = ctx.tdzGlobals.get(name);
  let flag: GlobalDef | undefined;
  if (existingGlobalIdx !== undefined) {
    flag = ctx.mod.globals[localGlobalIdx(ctx, existingGlobalIdx)];
    if (!flag || flag.name !== `__tdz_${name}`) {
      throw new TypeError(`module TDZ global ${name} has no exact allocator object at index ${existingGlobalIdx}`);
    }
  } else {
    ctx.tdzGlobals.set(name, nextModuleGlobalIdx(ctx));
    flag = allocateModuleTdzGlobal(ctx, name);
  }
  if (binding && !binding.tdz) {
    ctx.programAbiGlobals?.assertModuleBindingsOpen(name);
    binding.tdz = flag;
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

/** (#6651 V6) `import * as ns from '<this module>'` anywhere at top level. */
function importsOwnNamespace(ctx: CodegenContext, sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamespaceImport(bindings)) continue;
    if (ctx.oracle.aliasedValueDeclarationOf(bindings.name) === sourceFile) return true;
  }
  return false;
}

/**
 * (#6651 V6) A self-importing module's namespace getter bakes each binding's
 * TDZ flag, and a class body compiled before the top-level pass can build that
 * namespace first — so allocate the flags before classes compile. The module
 * keeps every flag (no elision), so the early call answers the same set.
 */
export function prepareSelfImportingModuleTdzGlobals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  if (importsOwnNamespace(ctx, sourceFile)) prepareModuleTdzGlobals(ctx, sourceFile);
}

/** The top-level lexicals of `sourceFile` among `candidates` whose every read provably follows initialisation. */
function elidableTopLevelTdzNames(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  candidates: Set<string>,
): Set<string> {
  // (#6651 V6) A module that imports its OWN namespace can observe every
  // binding through `ns.x` before initialization (§10.4.6.8 step 12 →
  // ReferenceError), and that read is invisible to the identifier walk below.
  // Keep every top-level lexical flag for such a module.
  const elidable = importsOwnNamespace(ctx, sourceFile)
    ? new Set<string>()
    : computeElidableTopLevelTdzNames(ctx, sourceFile, candidates);
  for (const name of unresolvedDynamicWithTopLevelLexicalWrites(ctx, sourceFile, elidable)) elidable.delete(name);
  return elidable;
}

/**
 * Materialize the top-level TDZ globals that both body emitters reference.
 * Safe to call before IR preparation and again from the direct declaration
 * pass because allocation and structural ABI observation are idempotent.
 */
export function prepareModuleTdzGlobals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  for (const name of elidableTopLevelTdzNames(ctx, sourceFile, ctx.tdzLetConstNames)) {
    if (!isCollidingModuleName(ctx, name)) ctx.tdzLetConstNames.delete(name);
  }
  for (const name of ctx.tdzLetConstNames) {
    if (isCollidingModuleName(ctx, name)) prepareCollidingModuleTdz(ctx, name);
    else registerModuleTdzGlobal(ctx, sourceFile, name);
  }
}

/**
 * (#7470) Decide the TDZ flag of each binding of a name several modules declare from that binding's own module.
 * Every binding is decided at the first call, as the shared bare-name flag was, so a module compiled before the one
 * it imports from still finds the flag. The bare `tdzGlobals` entry follows whichever binding the name shows now.
 */
function prepareCollidingModuleTdz(ctx: CodegenContext, name: string): void {
  for (const binding of moduleBindingsNamed(ctx, name)) {
    if (binding.tdz || binding.tdzOmitted) continue;
    const declaration = findRuntimeTopLevelDeclaration(binding.source, name);
    if (
      declaration === undefined ||
      (declaration.parent.flags & TOP_LEVEL_LEXICAL_FLAGS) === 0 ||
      elidableTopLevelTdzNames(ctx, binding.source, new Set([name])).has(name)
    ) {
      binding.tdzOmitted = true;
      continue;
    }
    ctx.programAbiGlobals?.assertModuleBindingsOpen(name);
    const flagIdx = nextModuleGlobalIdx(ctx);
    binding.tdz = allocateModuleTdzGlobal(ctx, name);
    if (ctx.moduleGlobals.get(name) === absoluteGlobalIdx(ctx, binding.value)) ctx.tdzGlobals.set(name, flagIdx);
  }
}
