// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  ALL_ASYNC_HOST_ADAPTERS,
  type AsyncHostAdapter,
  type AsyncHostAdapterValueType,
  type AsyncHostCapabilityId,
} from "../ir/async-runtime-providers.js";
import { sameIrCallableBinding, irImportFuncRef } from "../ir/callable-bindings.js";
import type { IrFunction } from "../ir/nodes.js";
import type { FuncTypeDef, Import, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { addImport } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { ensureAsyncDriveRuntime } from "./async-scheduler.js";
import { prepareNativePromiseNumberBoundary } from "./native-promise-number-boundary.js";

function lowerAdapterType(type: AsyncHostAdapterValueType): ValType {
  return type === "i32" ? { kind: "i32" } : { kind: "externref" };
}

function sameValType(left: ValType, right: ValType): boolean {
  return left.kind === right.kind;
}

function expectedSignature(adapter: AsyncHostAdapter): FuncTypeDef {
  return {
    kind: "func",
    params: adapter.params.map(lowerAdapterType),
    results: adapter.results.map(lowerAdapterType),
  };
}

function assertImportSignature(ctx: CodegenContext, imported: Import, adapter: AsyncHostAdapter): void {
  if (imported.desc.kind !== "func") {
    throw new Error(`IR async adapter ${adapter.capability} resolved to a non-function import`);
  }
  const actual = ctx.mod.types[imported.desc.typeIdx];
  const expected = expectedSignature(adapter);
  if (
    !actual ||
    actual.kind !== "func" ||
    actual.params.length !== expected.params.length ||
    actual.results.length !== expected.results.length ||
    actual.params.some((type, index) => !sameValType(type, expected.params[index]!)) ||
    actual.results.some((type, index) => !sameValType(type, expected.results[index]!))
  ) {
    throw new Error(
      `IR async adapter ${adapter.capability} import ${adapter.module}.${adapter.field} has a signature outside the frozen catalogue`,
    );
  }
}

function findExactImport(ctx: CodegenContext, adapter: AsyncHostAdapter): Import | undefined {
  for (let index = ctx.mod.imports.length - 1; index >= 0; index--) {
    const imported = ctx.mod.imports[index]!;
    if (imported.module === adapter.module && imported.name === adapter.field) return imported;
  }
  return undefined;
}

/**
 * Materialize the concrete host adapter projection selected after semantic
 * runtime-manifest freeze. This runs before prepared component / Program ABI
 * sealing. Existing imports from the transitional AST collector are validated
 * and reused; no body-lowering path may lazily invent another adapter.
 */
export function materializePreparedAsyncHostAdapters(ctx: CodegenContext, functions: readonly IrFunction[]): void {
  const requested = new Map<AsyncHostCapabilityId, AsyncHostAdapter>();
  const catalogue = new Map(ALL_ASYNC_HOST_ADAPTERS.map((adapter) => [adapter.capability, adapter] as const));
  let nativeRuntimeRequested = false;
  let nativeUndefinedRequested = false;

  for (const fn of functions) {
    if (!fn.asyncRuntime) continue;
    if (!fn.asyncPlan || fn.funcKind !== "async") {
      throw new Error(`IR async runtime attachment for ${fn.name} has no valid async plan owner`);
    }
    if (fn.asyncRuntime.kind === "standalone-native-wasmgc") {
      if (
        !ctx.standalone ||
        ctx.wasi ||
        !ctx.nativeStrings ||
        ctx.targetProfile.environment !== "none" ||
        ctx.targetProfile.semanticProviders !== "native-first"
      ) {
        throw new Error(`IR async function ${fn.name} selected a native standalone runtime on the wrong target`);
      }
      nativeRuntimeRequested = true;
      nativeUndefinedRequested ||= fn.asyncPlan.runtimeIntents.includes("value.undefined");
      continue;
    }
    for (const attached of fn.asyncRuntime.adapters) {
      const adapter = catalogue.get(attached.capability);
      if (!adapter) throw new Error(`IR async runtime attachment uses unknown capability ${attached.capability}`);
      const expectedTarget = irImportFuncRef(adapter.module, adapter.field, adapter.field);
      if (!sameIrCallableBinding(attached.target.binding, expectedTarget.binding)) {
        throw new Error(`IR async adapter ${attached.capability} does not match its frozen import projection`);
      }
      requested.set(attached.capability, adapter);
    }
  }

  if (nativeRuntimeRequested) {
    ensureAsyncDriveRuntime(ctx);
    prepareNativePromiseNumberBoundary(ctx);
    if (nativeUndefinedRequested) {
      // Promise<void> must settle with the canonical native `undefined`
      // singleton, not the null externref sentinel. Reserve it before Program
      // ABI sealing so async-frame lowering remains allocation-free.
      canonicalUndefinedExternInstrs(ctx);
    }
  }

  for (const adapter of ALL_ASYNC_HOST_ADAPTERS) {
    if (!requested.has(adapter.capability)) continue;
    let imported = findExactImport(ctx, adapter);
    if (!imported) {
      const signature = expectedSignature(adapter);
      const typeIdx = addFuncType(ctx, signature.params, signature.results);
      imported = addImport(ctx, adapter.module, adapter.field, { kind: "func", typeIdx });
    }
    if (!imported) {
      throw new Error(`IR async adapter ${adapter.capability} could not be registered before Program ABI freeze`);
    }
    assertImportSignature(ctx, imported, adapter);
  }
}
