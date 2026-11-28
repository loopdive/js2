// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7470) The storage of every top-level binding, keyed by declaration.
 *
 * A module scope holds one binding per name, and every Script shares one global environment record (§9.1.1.4), so
 * a binding is identified by its scope and name: `var g; var g;` is one binding with two declarations, while `let g`
 * in two modules of one graph is two bindings. Each binding owns its `__mod_<name>` global and, once the TDZ pass
 * decides it needs one, its `__tdz_<name>` flag.
 *
 * `ctx.moduleGlobals` / `ctx.tdzGlobals` stay keyed by bare name: the first binding of a name holds that entry, and
 * `source-binding-projection.ts` points a name at another binding while that binding's module compiles. The Program
 * ABI registry resolves declarations through this table. A leaf module, so the registry can read it without a cycle.
 *
 * A function declaration has a binding only once it is live (#7530): its name is reassigned, or eval code may rebind
 * it, so reads go through its `__mod_<name>` global instead of the function's static index.
 */
import type { GlobalDef } from "../../ir/types.js";
import type { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { absoluteGlobalIdx } from "./global-space.js";

export type ModuleBindingDeclaration = ts.VariableDeclaration | ts.BindingElement | ts.FunctionDeclaration;

/** Why a function binding is live: an assignment to it, or only a dynamic source that may rebind it (#6880). */
export type LiveFunctionKind = "assigned" | "eval";

export interface ModuleBinding {
  readonly name: string;
  readonly source: ts.SourceFile;
  readonly value: GlobalDef;
  tdz?: GlobalDef;
  /** Decided to need no TDZ flag (elided by its module, or not lexical) while a same-named binding may keep one. */
  tdzOmitted?: boolean;
  liveFunction?: LiveFunctionKind;
}

interface ModuleBindingTable {
  /** Per scope (a module's SourceFile, or `undefined` for the shared Script realm), its bindings by name. */
  readonly byScope: Map<ts.SourceFile | undefined, Map<string, ModuleBinding>>;
  readonly byDeclaration: Map<ModuleBindingDeclaration, ModuleBinding>;
  /** Every binding of a name, in registration order; the first one holds the bare-name entry. */
  readonly byName: Map<string, ModuleBinding[]>;
  /** The binding that owns each value global; no two bindings share one. */
  readonly byValue: Map<GlobalDef, ModuleBinding>;
  /** The live function bindings, in the order they became live. */
  readonly liveFunctions: ModuleBinding[];
}

const tables = new WeakMap<CodegenContext, ModuleBindingTable>();

function tableOf(ctx: CodegenContext): ModuleBindingTable {
  let table = tables.get(ctx);
  if (table === undefined) {
    table = { byScope: new Map(), byDeclaration: new Map(), byName: new Map(), byValue: new Map(), liveFunctions: [] };
    tables.set(ctx, table);
  }
  return table;
}

function scopeOf(ctx: CodegenContext, declaration: ModuleBindingDeclaration): ts.SourceFile | undefined {
  return ctx.sourceIsModule ? declaration.getSourceFile() : undefined;
}

/** The binding `name` declared by `declaration` names, if one was registered for its scope. */
export function scopedModuleBinding(
  ctx: CodegenContext,
  name: string,
  declaration: ModuleBindingDeclaration,
): ModuleBinding | undefined {
  return tables.get(ctx)?.byScope.get(scopeOf(ctx, declaration))?.get(name);
}

/** Record a new binding for `declaration`'s scope, then attach the declaration. */
export function addModuleBinding(
  ctx: CodegenContext,
  name: string,
  declaration: ModuleBindingDeclaration,
  value: GlobalDef,
): ModuleBinding {
  const table = tableOf(ctx);
  const binding: ModuleBinding = { name, source: declaration.getSourceFile(), value };
  const scope = scopeOf(ctx, declaration);
  let named = table.byScope.get(scope);
  if (named === undefined) table.byScope.set(scope, (named = new Map()));
  named.set(name, binding);
  const all = table.byName.get(name);
  if (all === undefined) table.byName.set(name, [binding]);
  else all.push(binding);
  table.byValue.set(value, binding);
  return binding;
}

export function attachModuleBindingDeclaration(
  ctx: CodegenContext,
  declaration: ModuleBindingDeclaration,
  binding: ModuleBinding,
): void {
  tableOf(ctx).byDeclaration.set(declaration, binding);
}

export function moduleBindingOf(ctx: CodegenContext, declaration: ts.Declaration): ModuleBinding | undefined {
  return tables.get(ctx)?.byDeclaration.get(declaration as ModuleBindingDeclaration);
}

/** The binding whose value global is `global`, if a binding owns it. */
export function moduleBindingOfGlobal(ctx: CodegenContext, global: GlobalDef): ModuleBinding | undefined {
  return tables.get(ctx)?.byValue.get(global);
}

/**
 * Make `binding` a live function binding. An assignment outranks eval-only liveness, never the reverse. The bare
 * name joins `ctx.liveFuncBindingGlobals` when it shows this binding; another source sees the liveness through its
 * view (`source-binding-projection.ts`).
 */
export function markLiveFunctionBinding(ctx: CodegenContext, binding: ModuleBinding, kind: LiveFunctionKind): void {
  if (binding.liveFunction === undefined) tableOf(ctx).liveFunctions.push(binding);
  if (binding.liveFunction !== "assigned") binding.liveFunction = kind;
  if (ctx.moduleGlobals.get(binding.name) === absoluteGlobalIdx(ctx, binding.value)) {
    (ctx.liveFuncBindingGlobals ??= new Set<string>()).add(binding.name);
  }
}

/** Every live function binding, in the order it became live. */
export function liveFunctionBindings(ctx: CodegenContext): readonly ModuleBinding[] {
  return tables.get(ctx)?.liveFunctions ?? [];
}

/** Every binding of `name`, in registration order. */
export function moduleBindingsNamed(ctx: CodegenContext, name: string): readonly ModuleBinding[] {
  return tables.get(ctx)?.byName.get(name) ?? [];
}

/** More than one binding has this name, so the bare-name entry cannot serve them all. */
export function isCollidingModuleName(ctx: CodegenContext, name: string): boolean {
  return moduleBindingsNamed(ctx, name).length > 1;
}

/** The bindings declared at top level of `source`, by name. */
export function sourceModuleBindings(ctx: CodegenContext, source: ts.SourceFile): ReadonlyMap<string, ModuleBinding> {
  return tables.get(ctx)?.byScope.get(ctx.sourceIsModule ? source : undefined) ?? new Map();
}
