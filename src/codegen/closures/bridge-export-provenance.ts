// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { WasmExport, WasmFunction } from "../../ir/types.js";
import { STABLE_FUNC_BASE } from "../../emit/resolve-layout.js";
import { CLOSURE_APPLY_BRIDGE } from "../../runtime/contracts/closure-call-abi.js";
import type { CodegenContext } from "../context/types.js";
import { definedFuncAt } from "../func-space.js";

export interface PublishedClosureBridgeExport {
  readonly entry: WasmExport;
  readonly name: string;
  readonly func: WasmFunction;
}

const publications = new WeakMap<CodegenContext, Map<number, readonly PublishedClosureBridgeExport[]>>();
const CTOR_SLOT = 17;
const family = (slot: number): string => (slot === CTOR_SLOT ? "constructor-closure" : "closure-apply");

export function recordClosureBridgeExports(
  ctx: CodegenContext,
  slot: number,
  entries: PublishedClosureBridgeExport[],
): void {
  if (slot !== CTOR_SLOT && slot !== CLOSURE_APPLY_BRIDGE.bit)
    throw new Error(`unknown closure bridge descriptor slot ${slot}`);
  let slots = publications.get(ctx);
  if (!slots) {
    slots = new Map();
    publications.set(ctx, slots);
  }
  if (slots.has(slot)) throw new Error(`${family(slot)} host bridge exports were published more than once`);
  slots.set(slot, Object.freeze(entries));
}

function publicName(slot: number, name: string): boolean {
  const logical = slot === CTOR_SLOT ? "__is_ctor_closure" : CLOSURE_APPLY_BRIDGE.name;
  const alias = slot === CTOR_SLOT ? "$ch" : CLOSURE_APPLY_BRIDGE.alias;
  return name === logical || (name.startsWith(alias) && /^\$*$/.test(name.slice(alias.length)));
}

function owned(ctx: CodegenContext, slot: number, entry: WasmExport): boolean {
  return (
    publications
      .get(ctx)
      ?.get(slot)
      ?.some((p) => p.entry === entry) ?? false
  );
}

function target(ctx: CodegenContext, entry: WasmExport): WasmFunction | undefined {
  if (entry.desc.kind !== "func") return undefined;
  if (entry.desc.index >= STABLE_FUNC_BASE) return definedFuncAt(ctx, entry.desc.index);
  const imports = ctx.mod.imports.filter((i) => i.desc.kind === "func").length;
  const position = entry.desc.index - imports;
  return position < 0 ? undefined : ctx.mod.functions[position];
}

function finalize(ctx: CodegenContext, slot: number): void {
  const entries = publications.get(ctx)?.get(slot);
  if (!entries) return;
  const label = `${family(slot)} host bridge export descriptor`;
  for (const { entry, name, func } of entries) {
    if (ctx.mod.exports.indexOf(entry) < 0) throw new Error(`${label} ${name} disappeared before finalization`);
    if (ctx.mod.exports.indexOf(entry) !== ctx.mod.exports.lastIndexOf(entry))
      throw new Error(`${label} ${name} appears more than once in the module`);
    if (entry.name !== name) throw new Error(`${label} ${name} changed its published name to ${entry.name}`);
    if (entry.desc.kind !== "func") throw new Error(`${label} ${name} changed kind to ${entry.desc.kind}`);
    if (!ctx.mod.functions.includes(func)) throw new Error(`${label} ${name} lost its allocator function`);
    if (target(ctx, entry) !== func) throw new Error(`${label} ${name} resolves to a different allocator function`);
  }
  const recordedEntries = new Set(entries.map((p) => p.entry)),
    funcs = new Set(entries.map((p) => p.func));
  for (const entry of ctx.mod.exports) {
    if (recordedEntries.has(entry) || !publicName(slot, entry.name)) continue;
    const func = target(ctx, entry);
    if (func !== undefined && funcs.has(func))
      throw new Error(`unrecorded ${label} ${entry.name} resolves to a recorded allocator function`);
  }
}

export const isCoreCtorClosureHostBridgePublicName = (name: string): boolean => publicName(CTOR_SLOT, name);
export const isCoreApplyClosureHostBridgePublicName = (name: string): boolean =>
  publicName(CLOSURE_APPLY_BRIDGE.bit, name);
export const isCompilerOwnedCtorClosureHostBridgeExport = (ctx: CodegenContext, entry: WasmExport): boolean =>
  owned(ctx, CTOR_SLOT, entry);
export const isCompilerOwnedApplyClosureHostBridgeExport = (ctx: CodegenContext, entry: WasmExport): boolean =>
  owned(ctx, CLOSURE_APPLY_BRIDGE.bit, entry);
export const finalizeCtorClosureHostBridgeExports = (ctx: CodegenContext): void => finalize(ctx, CTOR_SLOT);
export const finalizeApplyClosureHostBridgeExports = (ctx: CodegenContext): void =>
  finalize(ctx, CLOSURE_APPLY_BRIDGE.bit);
