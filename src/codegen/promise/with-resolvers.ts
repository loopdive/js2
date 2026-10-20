// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7090) Native `Promise.withResolvers()` provider for the `$Promise` carrier
// (native-first / default gc, standalone, WASI). Registers the shared runtime
// function `__promise_with_resolvers() -> externref` once per module; its body
// lives in `src/runtime/wasmgc/promise/with-resolvers-bodies.ts`. The call
// site only routes `Promise.withResolvers(...)` here — every semantic step is
// in the runtime function, so the direct-AST emitters gain no new behaviour
// (plan/method/ir-only-development-freeze.md).
//
// Scope: `this === %Promise%`. `Promise.withResolvers.call(Sub)` (capability
// construction through a user constructor) is #7089. A statically
// non-constructor `.call` receiver takes the IsConstructor TypeError in
// promise-static-call-typeerror.ts.

import type { Instr } from "../../ir/types.js";
import {
  buildPromiseIntrinsicCapabilityBody,
  buildPromiseIntrinsicCapabilityLocals,
  buildPromiseWithResolversBody,
  buildPromiseWithResolversLocals,
  type PromiseWithResolversResources,
} from "../../runtime/wasmgc/promise/with-resolvers-bodies.js";
import { ts } from "../../ts-api.js";
import {
  DENO_PROMISE_HOOK_INIT,
  buildDenoPromiseHookCall,
  ensurePromiseExecutorClosures,
  isStandalonePromiseActive,
} from "../async-scheduler.js";
import { closureBagInitInstr } from "../closures/closure-header-layout.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { resolvesToNamedAmbientGlobal } from "../expressions/non-constructable.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { addFuncType } from "../registry/types.js";
import { compileExpression } from "../shared.js";
import type { InnerResult } from "../shared.js";

const FUNC_NAME = "__promise_with_resolvers";
const INTRINSIC_CAPABILITY = "__promise_intrinsic_capability";
const KEYS = ["promise", "resolve", "reject"] as const;

/** Register every dependency BEFORE minting (so no index lands mid-build) and collect them. */
function withResolversResources(ctx: CodegenContext): PromiseWithResolversResources | undefined {
  const closures = ensurePromiseExecutorClosures(ctx);
  if (!closures) return undefined;
  ensureObjectRuntime(ctx);
  for (const key of KEYS) addStringConstantGlobal(ctx, key);
  const newPlainObjectFuncIdx = ctx.funcMap.get("__new_plain_object");
  const externSetFuncIdx = ctx.funcMap.get("__extern_set");
  if (newPlainObjectFuncIdx === undefined || externSetFuncIdx === undefined) return undefined;
  return {
    closures,
    promiseTypeIdx: closures.promiseTypeIdx,
    resolveClFuncIdx: closures.resolveClFuncIdx,
    rejectClFuncIdx: closures.rejectClFuncIdx,
    newPlainObjectFuncIdx,
    externSetFuncIdx,
    promiseBagInit: closureBagInitInstr(),
    initHook: (promiseInstrs: Instr[]) => buildDenoPromiseHookCall(ctx, DENO_PROMISE_HOOK_INIT, promiseInstrs),
    keyInstrs: (key: (typeof KEYS)[number]) => stringConstantExternrefInstrs(ctx, key),
  };
}

/**
 * (#7089) Idempotently register `__promise_intrinsic_capability(record) -> externref` —
 * NewPromiseCapability(%Promise%) written into a `$__promise_custom_capability` record.
 */
export function ensurePromiseIntrinsicCapability(ctx: CodegenContext, recordTypeIdx: number): number | undefined {
  const existing = ctx.funcMap.get(INTRINSIC_CAPABILITY);
  if (existing !== undefined) return existing;
  const resources = withResolversResources(ctx);
  if (!resources) return undefined;
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: INTRINSIC_CAPABILITY,
    typeIdx: addFuncType(ctx, [{ kind: "ref", typeIdx: recordTypeIdx }], [{ kind: "externref" }]),
    locals: buildPromiseIntrinsicCapabilityLocals(resources),
    body: buildPromiseIntrinsicCapabilityBody(resources, recordTypeIdx),
    exported: false,
  });
  ctx.funcMap.set(INTRINSIC_CAPABILITY, funcIdx);
  return funcIdx;
}

/** Idempotently register `__promise_with_resolvers`; undefined when the carrier is unavailable. */
export function ensurePromiseWithResolvers(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(FUNC_NAME);
  if (existing !== undefined) return existing;
  const resources = withResolversResources(ctx);
  if (!resources) return undefined;
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: FUNC_NAME,
    typeIdx: addFuncType(ctx, [], [{ kind: "externref" }]),
    locals: buildPromiseWithResolversLocals(resources),
    body: buildPromiseWithResolversBody(resources),
    exported: false,
  });
  ctx.funcMap.set(FUNC_NAME, funcIdx);
  return funcIdx;
}

/**
 * Route `Promise.withResolvers(...)` (the intrinsic `%Promise%` receiver) to the
 * native runtime function. Arguments are evaluated and discarded (the method
 * takes none). Returns undefined — having emitted nothing — when the native
 * carrier is off or the receiver is not the ambient `Promise`.
 */
export function tryEmitNativePromiseWithResolvers(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  if (propAccess.name.text !== "withResolvers" || !isStandalonePromiseActive(ctx)) return undefined;
  let receiver: ts.Expression = propAccess.expression;
  while (ts.isParenthesizedExpression(receiver) || ts.isAsExpression(receiver) || ts.isNonNullExpression(receiver)) {
    receiver = receiver.expression;
  }
  if (!resolvesToNamedAmbientGlobal(ctx, receiver, "Promise")) return undefined;
  if (expr.arguments.some((argument) => ts.isSpreadElement(argument))) return undefined;
  if (ensurePromiseWithResolvers(ctx) === undefined) return undefined;
  for (const argument of expr.arguments) {
    if (compileExpression(ctx, fctx, argument) !== null) fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(FUNC_NAME)! });
  return { kind: "externref" };
}
