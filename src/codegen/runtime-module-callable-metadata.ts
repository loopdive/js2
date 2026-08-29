// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

interface OpaqueMapEntry {
  readonly map: Map<string, unknown>;
  readonly had: boolean;
  readonly value: unknown;
}

interface SetEntry {
  readonly set: Set<string>;
  readonly had: boolean;
}

interface CallableNameState {
  readonly maps: readonly OpaqueMapEntry[];
  readonly sets: readonly SetEntry[];
}

export interface RuntimeModuleCallableBinding {
  readonly declaration: ts.FunctionDeclaration;
  readonly handle: FuncHandle;
}

const metadataByContext = new WeakMap<CodegenContext, WeakMap<ts.FunctionDeclaration, CallableNameState>>();

function nameMaps(ctx: CodegenContext): readonly Map<string, unknown>[] {
  return [
    ctx.funcMap,
    ctx.funcMapOwnerDecl,
    ctx.nestedFuncCaptures,
    ctx.funcOptionalParams,
    ctx.funcRestParams,
    ctx.closureMap,
    ctx.functionNameMap,
    ctx.funcSourceText,
    ctx.genericResolved,
    ctx.generatorYieldType,
    ctx.nativeGenerators,
    ctx.inlinableFunctions,
  ] as readonly Map<string, unknown>[];
}

function nameSets(ctx: CodegenContext): readonly Set<string>[] {
  return [ctx.funcUsesArguments, ctx.asyncFunctions, ctx.generatorFunctions];
}

function captureNameState(ctx: CodegenContext, name: string): CallableNameState {
  return {
    maps: nameMaps(ctx).map((map) => ({ map, had: map.has(name), value: map.get(name) })),
    sets: nameSets(ctx).map((set) => ({ set, had: set.has(name) })),
  };
}

function clearNameState(ctx: CodegenContext, name: string): void {
  for (const map of nameMaps(ctx)) map.delete(name);
  for (const set of nameSets(ctx)) set.delete(name);
}

function applyNameState(state: CallableNameState, name: string): void {
  for (const entry of state.maps) {
    if (entry.had) entry.map.set(name, entry.value);
    else entry.map.delete(name);
  }
  for (const entry of state.sets) {
    if (entry.had) entry.set.add(name);
    else entry.set.delete(name);
  }
}

function declarationMetadata(ctx: CodegenContext, declaration: ts.FunctionDeclaration): CallableNameState | undefined {
  return metadataByContext.get(ctx)?.get(declaration);
}

/**
 * Register one runtime-namespace callable without publishing any permanent
 * bare-name compatibility metadata. The exact declaration keeps the produced
 * metadata for bounded projections at its body and call sites.
 */
export function isolateRuntimeModuleCallableRegistration<T>(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  register: () => T,
): T {
  const name = declaration.name!.text;
  const prior = captureNameState(ctx, name);
  const wasPreRegistered = ctx.preRegisteredBodyless?.has(name) ?? false;
  clearNameState(ctx, name);
  ctx.preRegisteredBodyless?.delete(name);
  try {
    const result = register();
    let byDeclaration = metadataByContext.get(ctx);
    if (!byDeclaration) {
      byDeclaration = new WeakMap();
      metadataByContext.set(ctx, byDeclaration);
    }
    byDeclaration.set(declaration, captureNameState(ctx, name));
    return result;
  } finally {
    applyNameState(prior, name);
    if (wasPreRegistered) (ctx.preRegisteredBodyless ??= new Set()).add(name);
    else ctx.preRegisteredBodyless?.delete(name);
  }
}

/** Project exact callable state only while compiling its lexical use site. */
export function withRuntimeModuleCallableBindings<T>(
  ctx: CodegenContext,
  bindings: readonly RuntimeModuleCallableBinding[],
  action: () => T,
): T {
  const prior = new Map<string, CallableNameState>();
  for (const binding of bindings) {
    const name = binding.declaration.name!.text;
    prior.set(name, captureNameState(ctx, name));
    clearNameState(ctx, name);
    const metadata = declarationMetadata(ctx, binding.declaration);
    if (metadata) applyNameState(metadata, name);
    ctx.funcMap.set(name, binding.handle);
    ctx.funcMapOwnerDecl.delete(name);
    // A direct namespace declaration is never a lifted closure. Deleting a
    // stale same-named capture prefix is ABI-critical for exact member calls.
    ctx.nestedFuncCaptures.delete(name);
  }
  try {
    return action();
  } finally {
    for (const [name, state] of prior) applyNameState(state, name);
  }
}
