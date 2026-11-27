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
 */
import type { GlobalDef } from "../ir/types.js";
import type { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

export type ModuleBindingDeclaration = ts.VariableDeclaration | ts.BindingElement;

export interface ModuleBinding {
  readonly name: string;
  readonly source: ts.SourceFile;
  readonly value: GlobalDef;
  tdz?: GlobalDef;
  /** Decided to need no TDZ flag (elided by its module, or not lexical) while a same-named binding may keep one. */
  tdzOmitted?: boolean;
}

interface ModuleBindingTable {
  /** Per scope (a module's SourceFile, or `undefined` for the shared Script realm), its bindings by name. */
  readonly byScope: Map<ts.SourceFile | undefined, Map<string, ModuleBinding>>;
  readonly byDeclaration: Map<ModuleBindingDeclaration, ModuleBinding>;
  /** Every binding of a name, in registration order; the first one holds the bare-name entry. */
  readonly byName: Map<string, ModuleBinding[]>;
}

const tables = new WeakMap<CodegenContext, ModuleBindingTable>();

function tableOf(ctx: CodegenContext): ModuleBindingTable {
  let table = tables.get(ctx);
  if (table === undefined) {
    tables.set(ctx, (table = { byScope: new Map(), byDeclaration: new Map(), byName: new Map() }));
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
