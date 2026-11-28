// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4133, #3505, #7470) One module's view of the bare-name maps while its code compiles.
 *
 * `ctx.funcMap`, `ctx.nativeGenerators`, `ctx.moduleGlobals` and `ctx.tdzGlobals` are keyed by bare name across a
 * linked graph, so two modules that each declare `function f` or `let g` share one entry. Re-keying their hundreds of
 * readers is out of proportion; instead {@link withSourceBindings} points each colliding name at the compiling
 * module's own binding — its declaration, or the one an import resolves to — and restores the previous view after.
 * A graph without such a name records no view, and a single-source compile never records one.
 *
 * Saved state holds allocator objects (`WasmFunction`, `GlobalDef`), never indices: a late import shifts both index
 * spaces while a body compiles.
 */
import type { GlobalDef, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, NativeGeneratorInfo } from "./context/types.js";
import { definedFuncAt, definedFuncHandleOf } from "./func-space.js";
import { absoluteGlobalIdx, definedGlobalAt } from "./global-space.js";
import {
  isCollidingModuleName,
  type ModuleBinding,
  moduleBindingOf,
  moduleBindingsNamed,
  sourceModuleBindings,
} from "./module-binding-table.js";

/** A defined function's allocator object, or an import's index (imports are appended, so it never shifts). */
type FunctionRef = WasmFunction | number;

interface SourceBindingView {
  /** Its own top-level functions whose name another module also declares. */
  readonly ownFunctions: Map<string, FunctionRef>;
  /** Its function imports, which override another module's same-spelled declaration. */
  readonly importedFunctions: Map<string, FunctionRef>;
  /**
   * Its native-generator registration per colliding `function*` name. `undefined` (its declaration has none) clears
   * the name, so its calls take the legacy path instead of resuming another module's state machine (#3505).
   */
  readonly generators: Map<string, NativeGeneratorInfo | undefined>;
  /** Its own colliding top-level bindings and the bindings its imports resolve to. */
  readonly globals: Map<string, ModuleBinding>;
}

const viewsByContext = new WeakMap<CodegenContext, Map<ts.SourceFile, SourceBindingView>>();

function viewOf(ctx: CodegenContext, sourceFile: ts.SourceFile): SourceBindingView {
  let views = viewsByContext.get(ctx);
  if (views === undefined) viewsByContext.set(ctx, (views = new Map()));
  let view = views.get(sourceFile);
  if (view === undefined) {
    view = { ownFunctions: new Map(), importedFunctions: new Map(), generators: new Map(), globals: new Map() };
    views.set(sourceFile, view);
  }
  return view;
}

function functionRef(ctx: CodegenContext, idx: number): FunctionRef {
  return definedFuncAt(ctx, idx) ?? idx;
}

function functionIdx(ctx: CodegenContext, ref: FunctionRef): number | undefined {
  return typeof ref === "number" ? ref : definedFuncHandleOf(ctx, ref);
}

/**
 * Record `sourceFile`'s own functions and native generators among `collidingNames`, right after its collect pass:
 * the only moment the bare name still holds this module's registration rather than a later module's.
 */
export function snapshotSourceFunctionBindings(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  collidingNames: ReadonlySet<string>,
): void {
  if (collidingNames.size === 0) return;
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
    const name = statement.name.text;
    if (!collidingNames.has(name)) continue;
    const idx = ctx.funcMap.get(name);
    if (idx !== undefined) viewOf(ctx, sourceFile).ownFunctions.set(name, functionRef(ctx, idx));
    if (statement.asteriskToken) {
      const info = ctx.nativeGenerators.get(name);
      viewOf(ctx, sourceFile).generators.set(name, info && info.decl === statement ? info : undefined);
    }
  }
}

/** The current index of `sourceFile`'s own top-level `function name`, when another module also declares the name. */
export function ownSourceFunctionIdx(ctx: CodegenContext, sourceFile: ts.SourceFile, name: string): number | undefined {
  const ref = viewsByContext.get(ctx)?.get(sourceFile)?.ownFunctions.get(name);
  return ref === undefined ? undefined : functionIdx(ctx, ref);
}

/** Record that `localName` in `sourceFile` imports the function at `idx`. */
export function noteImportedSourceFunction(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  localName: string,
  idx: number,
): void {
  viewOf(ctx, sourceFile).importedFunctions.set(localName, functionRef(ctx, idx));
}

/** The local identifiers of `sourceFile`'s default and named import bindings. */
function importBindingNames(sourceFile: ts.SourceFile): ts.Identifier[] {
  const names: ts.Identifier[] = [];
  for (const statement of sourceFile.statements) {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (clause?.name) names.push(clause.name);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) names.push(element.name);
    }
  }
  return names;
}

/**
 * Complete `sourceFile`'s view with the module bindings it must see under a bare name another binding holds: its own
 * colliding top-level bindings, and each import binding whose target the bare name does not show.
 */
export function recordSourceModuleBindingView(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  for (const [name, binding] of sourceModuleBindings(ctx, sourceFile)) {
    if (isCollidingModuleName(ctx, name)) viewOf(ctx, sourceFile).globals.set(name, binding);
  }
  for (const local of importBindingNames(sourceFile)) {
    const target = ctx.oracle.aliasedValueDeclarationOf(local);
    const binding = target && moduleBindingOf(ctx, target);
    if (
      binding &&
      (isCollidingModuleName(ctx, local.text) ||
        isCollidingModuleName(ctx, binding.name) ||
        ctx.moduleGlobals.get(local.text) !== absoluteGlobalIdx(ctx, binding.value))
    ) {
      viewOf(ctx, sourceFile).globals.set(local.text, binding);
    }
  }
}

/** What a bare module name shows: a value global and its TDZ flag, either possibly absent. */
export interface ModuleNameState {
  readonly value?: GlobalDef;
  readonly tdz?: GlobalDef;
}

/**
 * Capture what `name` shows now. A colliding name answers with its binding object itself, so a TDZ flag the binding
 * receives while another view is applied is still restored.
 */
export function moduleNameState(ctx: CodegenContext, name: string): ModuleNameState {
  const valueIdx = ctx.moduleGlobals.get(name);
  const tdzIdx = ctx.tdzGlobals.get(name);
  const value = valueIdx === undefined ? undefined : definedGlobalAt(ctx, valueIdx);
  const binding = isCollidingModuleName(ctx, name)
    ? moduleBindingsNamed(ctx, name).find((candidate) => candidate.value === value)
    : undefined;
  return binding ?? { value, tdz: tdzIdx === undefined ? undefined : definedGlobalAt(ctx, tdzIdx) };
}

/**
 * `binding`'s value global and TDZ flag, independent of the view applied now. A name with one binding keeps its flag
 * under the bare name only, so that flag is taken from there while the name shows this binding.
 */
export function moduleBindingState(ctx: CodegenContext, binding: ModuleBinding): ModuleNameState {
  if (binding.tdz || ctx.moduleGlobals.get(binding.name) !== absoluteGlobalIdx(ctx, binding.value)) return binding;
  const tdzIdx = ctx.tdzGlobals.get(binding.name);
  return { value: binding.value, tdz: tdzIdx === undefined ? undefined : definedGlobalAt(ctx, tdzIdx) };
}

/** Make `name` show `state`: each part set at its current index, or removed when absent. */
export function setModuleNameState(ctx: CodegenContext, name: string, state: ModuleNameState): void {
  const valueIdx = state.value && absoluteGlobalIdx(ctx, state.value);
  if (valueIdx === undefined) ctx.moduleGlobals.delete(name);
  else ctx.moduleGlobals.set(name, valueIdx);
  const tdzIdx = state.tdz && absoluteGlobalIdx(ctx, state.tdz);
  if (tdzIdx === undefined) ctx.tdzGlobals.delete(name);
  else ctx.tdzGlobals.set(name, tdzIdx);
}

function projectFunction(ctx: CodegenContext, name: string, ref: FunctionRef | undefined): void {
  const idx = ref === undefined ? undefined : functionIdx(ctx, ref);
  if (idx === undefined) ctx.funcMap.delete(name);
  else ctx.funcMap.set(name, idx);
}

function projectGenerator(ctx: CodegenContext, name: string, info: NativeGeneratorInfo | undefined): void {
  if (info) ctx.nativeGenerators.set(name, info);
  else ctx.nativeGenerators.delete(name);
}

/** What a view replaced, to put back when it is lifted. */
interface SavedNames {
  readonly functions: Map<string, FunctionRef | undefined>;
  readonly generators: Map<string, NativeGeneratorInfo | undefined>;
  readonly globals: Map<string, ModuleNameState>;
}

function applyView(ctx: CodegenContext, view: SourceBindingView): SavedNames {
  const saved: SavedNames = { functions: new Map(), generators: new Map(), globals: new Map() };
  for (const [name, ref] of [...view.ownFunctions, ...view.importedFunctions]) {
    const idx = ctx.funcMap.get(name);
    saved.functions.set(name, idx === undefined ? undefined : functionRef(ctx, idx));
    projectFunction(ctx, name, ref);
    // The inliner is keyed by bare name and does not record which function an entry is, so it may hold another
    // module's tiny function of this name. This module's own body re-registers its version if it qualifies; an
    // imported function is called rather than inlined.
    ctx.inlinableFunctions.delete(name);
  }
  for (const [name, info] of view.generators) {
    saved.generators.set(name, ctx.nativeGenerators.get(name));
    projectGenerator(ctx, name, info);
  }
  for (const [name, binding] of view.globals) {
    saved.globals.set(name, moduleNameState(ctx, name));
    setModuleNameState(ctx, name, binding);
  }
  return saved;
}

function liftView(ctx: CodegenContext, saved: SavedNames): void {
  for (const [name, state] of saved.globals) setModuleNameState(ctx, name, state);
  for (const [name, info] of saved.generators) projectGenerator(ctx, name, info);
  for (const [name, ref] of saved.functions) projectFunction(ctx, name, ref);
}

/** The view applied now, and what it replaced. */
interface AppliedView {
  readonly sourceFile: ts.SourceFile;
  readonly view: SourceBindingView;
  saved: SavedNames;
}

const appliedByContext = new WeakMap<CodegenContext, AppliedView>();

/**
 * Run `action` with `sourceFile`'s view applied, then restore every name it changed. A view is relative to the
 * collect-time names, so one requested while another module's view is applied (a statement of `__module_init`,
 * which compiles once under the last module's view) first lifts that view and re-applies it after.
 */
export function withSourceBindings<T>(ctx: CodegenContext, sourceFile: ts.SourceFile, action: () => T): T {
  const outer = appliedByContext.get(ctx);
  if (outer?.sourceFile === sourceFile) return action();
  const view = viewsByContext.get(ctx)?.get(sourceFile);
  if (view === undefined && outer === undefined) return action();
  if (outer) liftView(ctx, outer.saved);
  const inner = view && { sourceFile, view, saved: applyView(ctx, view) };
  if (inner) appliedByContext.set(ctx, inner);
  else appliedByContext.delete(ctx);
  try {
    return action();
  } finally {
    if (inner) liftView(ctx, inner.saved);
    if (outer) {
      outer.saved = applyView(ctx, outer.view);
      appliedByContext.set(ctx, outer);
    } else {
      appliedByContext.delete(ctx);
    }
  }
}
