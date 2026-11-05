// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId } from "../ir/identity.js";
import type { WasmFunction } from "../wasm/model/module-records.js";
import { NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { nativeNumberBoundaryFunction } from "./registry/imports.js";
import { addUnionImportsViaRegistry } from "./shared.js";

const publishedNativeNumberBoundaries = new WeakMap<CodegenContext, Map<string, WasmFunction>>();

function requireNativeNumberBoundary(ctx: CodegenContext, name: string): { index: number; helper: WasmFunction } {
  const helper = nativeNumberBoundaryFunction(ctx, name);
  const index = ctx.funcMap.get(name);
  const signature = helper === undefined ? undefined : ctx.mod.types[helper.typeIdx];
  const paramKind = name === "__box_number" ? "f64" : "externref";
  const resultKind = name === "__typeof_number" ? "i32" : name === "__box_number" ? "externref" : "f64";
  if (
    !helper ||
    index === undefined ||
    definedFuncAt(ctx, index) !== helper ||
    signature?.kind !== "func" ||
    signature.params.length !== 1 ||
    signature.params[0]?.kind !== paramKind ||
    signature.results.length !== 1 ||
    signature.results[0]?.kind !== resultKind
  )
    throw new Error(`native numeric boundary lacks canonical allocator ownership: ${name}`);
  return { index, helper };
}

function requireExactPublicTarget(ctx: CodegenContext, name: string, helper: WasmFunction): boolean {
  const entries = ctx.mod.exports.filter((entry) => entry.name === name);
  if (entries.length === 0) return false;
  if (
    entries.length !== 1 ||
    entries[0]!.desc.kind !== "func" ||
    definedFuncAt(ctx, entries[0]!.desc.index) !== helper
  ) {
    throw new Error(`native numeric boundary export collision: ${name}`);
  }
  return true;
}

function publishNativeNumberBoundary(ctx: CodegenContext, names: readonly string[]): void {
  // Validate the complete requested set before publishing any descriptor.
  const targets = names.map((name) => ({ name, ...requireNativeNumberBoundary(ctx, name) }));
  for (const { name, helper } of targets) requireExactPublicTarget(ctx, name, helper);
  let published = publishedNativeNumberBoundaries.get(ctx);
  if (!published) publishedNativeNumberBoundaries.set(ctx, (published = new Map()));
  const aliasTargets = new Set<IrBindingId>();
  for (const { name, index, helper } of targets) {
    helper.exported = true;
    if (!requireExactPublicTarget(ctx, name, helper)) ctx.mod.exports.push({ name, desc: { kind: "func", index } });
    published.set(name, helper);
    const bindingId = ctx.programAbiSession?.locatorBindingId(helper);
    if (bindingId) aliasTargets.add(bindingId);
  }
  ctx.programAbiExports?.planAliasesForTargets(aliasTargets);
}

/** A source alias must not be silently suppressed by an earlier numeric ABI descriptor. */
export function rejectNativeNumberBoundarySourceExport(ctx: CodegenContext, name: string): void {
  if (publishedNativeNumberBoundaries.get(ctx)?.has(name)) {
    throw new Error(`native numeric boundary export collision with source export intent: ${name}`);
  }
}

/** Publish the actual dynamic-value boundary's three canonical numeric functions. */
export function prepareNativeNumberValueBoundary(ctx: CodegenContext): void {
  addUnionImportsViaRegistry(ctx);
  publishNativeNumberBoundary(ctx, [...NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS, "__box_number"]);
}

/** Recheck after source exports/aliases settle, before DCE and Program ABI publication. */
export function validateNativeNumberBoundaryExports(ctx: CodegenContext): void {
  for (const [name, helper] of publishedNativeNumberBoundaries.get(ctx) ?? []) {
    if (requireNativeNumberBoundary(ctx, name).helper !== helper || !requireExactPublicTarget(ctx, name, helper)) {
      throw new Error(`native numeric boundary export was replaced: ${name}`);
    }
  }
}

/** Pre-register the numeric Promise value bridge before Program ABI sealing. */
export function prepareNativePromiseNumberBoundary(ctx: CodegenContext): void {
  addUnionImportsViaRegistry(ctx);
  publishNativeNumberBoundary(ctx, NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS);
}

/** Publish the boundary only for the standalone native semantic-provider lane. */
export function prepareStandaloneNativePromiseNumberBoundary(ctx: CodegenContext): void {
  if (ctx.standalone && ctx.nativeStrings && ctx.targetProfile.environment === "none") {
    prepareNativePromiseNumberBoundary(ctx);
  }
}

/** Publish both numeric readers and the boxer required by the actual JS timer value ABI. */
export function prepareNativeTimerNumberBoundary(ctx: CodegenContext): void {
  if (!ctx.nativeStrings || !ctx.emitHostBridge) return;
  prepareNativeNumberValueBoundary(ctx);
}
