// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId } from "../ir/identity.js";
import { NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { addUnionImportsViaRegistry } from "./shared.js";

function publishNativePromiseNumberBoundary(ctx: CodegenContext): void {
  for (const name of NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS) {
    const index = ctx.funcMap.get(name);
    if (index === undefined) continue;
    const helper = definedFuncAt(ctx, index);
    if (!helper) continue;
    helper.exported = true;
    if (!ctx.mod.exports.some((entry) => entry.name === name)) {
      ctx.mod.exports.push({ name, desc: { kind: "func", index } });
    }
  }
}

/** Pre-register the numeric Promise value bridge before Program ABI sealing. */
export function prepareNativePromiseNumberBoundary(ctx: CodegenContext): void {
  addUnionImportsViaRegistry(ctx);
  publishNativePromiseNumberBoundary(ctx);
  const aliasTargets = new Set<IrBindingId>();
  for (const name of NATIVE_PROMISE_NUMBER_BOUNDARY_HELPERS) {
    const index = ctx.funcMap.get(name);
    const helper = index === undefined ? undefined : definedFuncAt(ctx, index);
    const bindingId = helper ? ctx.programAbiSession?.locatorBindingId(helper) : undefined;
    if (bindingId) aliasTargets.add(bindingId);
  }
  ctx.programAbiExports?.planAliasesForTargets(aliasTargets);
}

/** Publish the boundary only for the standalone native semantic-provider lane. */
export function prepareStandaloneNativePromiseNumberBoundary(ctx: CodegenContext): void {
  if (
    ctx.standalone &&
    ctx.nativeStrings &&
    ctx.targetProfile.semanticProviders === "native-first" &&
    ctx.targetProfile.environment === "none"
  ) {
    prepareNativePromiseNumberBoundary(ctx);
  }
}
