// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, TypeHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";

export type PromiseHookResources =
  | undefined
  | {
      readonly dispatchFuncIdx: FuncHandle;
      readonly parentExternInstrs: readonly Instr[];
    };

export interface PromiseSettleResources {
  readonly promiseTypeIdx: TypeHandle;
  readonly callbackTypeIdx: TypeHandle;
  readonly enqueueFuncIdx: FuncHandle;
  readonly resolveHook: PromiseHookResources;
  readonly unhandledHeadGlobalIdx: number;
  readonly unhandledNodeTypeIdx: number;
}

export interface IdentityReactionResources {
  readonly capsTypeIdx: TypeHandle;
  readonly settleFuncIdx: FuncHandle;
  readonly beforeHook: PromiseHookResources;
  readonly afterHook: PromiseHookResources;
}

/**
 * #1326 — Sentinel state values for `$Promise.state`. Match the JS spec
 * tri-state: pending → fulfilled (final), or pending → rejected (final).
 * State transitions other than from pending are illegal per spec and
 * silently ignored by Phase 1B's resolve/reject emit code.
 */
export const PROMISE_STATE_PENDING = 0;

export const PROMISE_STATE_FULFILLED = 1;

export const PROMISE_STATE_REJECTED = 2;

/** v8::PromiseHookType values used by the private Deno graph dispatcher. */
export const DENO_PROMISE_HOOK_INIT = 0;

export const DENO_PROMISE_HOOK_BEFORE = 1;

export const DENO_PROMISE_HOOK_AFTER = 2;

export const DENO_PROMISE_HOOK_RESOLVE = 3;

/**
 * Build a direct, same-module Promise-hook dispatch for an app-owned
 * `$Promise`.  Ordinary JS2 programs do not define the private dispatcher, so
 * this is byte-inert outside the opted-in Deno graph.
 *
 * `promiseInstrs` and `parentInstrs` push concrete WasmGC refs.  They are
 * lifted to externref because the runtime-seed dispatcher accepts JS values.
 */
export function buildDenoPromiseHookCall(
  resources: PromiseHookResources,
  kind:
    | typeof DENO_PROMISE_HOOK_INIT
    | typeof DENO_PROMISE_HOOK_BEFORE
    | typeof DENO_PROMISE_HOOK_AFTER
    | typeof DENO_PROMISE_HOOK_RESOLVE,
  promiseInstrs: Instr[],
): Instr[] {
  if (resources === undefined) return [];
  return [
    { op: "f64.const", value: kind },
    ...promiseInstrs,
    { op: "extern.convert_any" },
    ...resources.parentExternInstrs,
    { op: "call", funcIdx: resources.dispatchFuncIdx },
  ];
}

export function buildPromiseSettleLocals(callbackTypeIdx: TypeHandle): LocalDef[] {
  // Params 0/1: (promise, value). Locals start at 2.
  return [
    { name: "$callbacks", type: { kind: "externref" } },
    { name: "$callback", type: { kind: "ref", typeIdx: callbackTypeIdx } },
  ];
}

export function buildPromiseSettleBody(
  state: PromiseSettleResources,
  settledState: typeof PROMISE_STATE_FULFILLED | typeof PROMISE_STATE_REJECTED,
): Instr[] {
  const { promiseTypeIdx, callbackTypeIdx } = state;
  const promiseLocal = 0;
  const valueLocal = 1;
  const callbacksLocal = 2;
  const callbackLocal = 3;
  const fnFieldIdx = settledState === PROMISE_STATE_FULFILLED ? 0 : 2;
  const capsFieldIdx = settledState === PROMISE_STATE_FULFILLED ? 1 : 3;

  return [
    // V8 reports the resolving-function invocation even when the promise has
    // already settled.  Keep this before the one-shot guard for the same
    // duplicate-resolution behavior.
    ...buildDenoPromiseHookCall(state.resolveHook, DENO_PROMISE_HOOK_RESOLVE, [
      { op: "local.get", index: promiseLocal },
    ]),
    // Promise settlement is one-shot. If a user callback tries to resolve the
    // same chained promise again, return the attempted value and leave the
    // original state/value intact.
    { op: "local.get", index: promiseLocal },
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: valueLocal }, { op: "return" }],
    },

    // promise.state = fulfilled/rejected; promise.value = value
    { op: "local.get", index: promiseLocal },
    { op: "i32.const", value: settledState },
    { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: promiseLocal },
    { op: "local.get", index: valueLocal },
    { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 1 },

    // Detach callbacks before enqueueing so re-entrant `.then` calls append to
    // the settled promise's normal immediate-enqueue path.
    { op: "local.get", index: promiseLocal },
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: callbacksLocal },
    { op: "local.get", index: promiseLocal },
    { op: "ref.null.extern" },
    { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 2 },

    // (#2958) A REJECTED settle with NO detached callbacks means no reaction was
    // attached before the promise rejected — record it as (so-far) unhandled so
    // the exit-time reporter can surface it. A later `.then/.catch` marks it
    // handled. Skipped for FULFILLED and when tracking is inactive (non-wasi).
    // The drain loop below is a no-op when callbacks is null, so ordering is safe.
    ...(settledState === PROMISE_STATE_REJECTED && state.unhandledHeadGlobalIdx >= 0
      ? ([
          { op: "local.get", index: callbacksLocal },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: buildNoteUnhandledRejection(state, [{ op: "local.get", index: promiseLocal }]),
          },
        ] satisfies Instr[])
      : []),

    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: callbacksLocal },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },

            { op: "local.get", index: callbacksLocal },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: callbackTypeIdx },
            { op: "local.set", index: callbackLocal },

            { op: "local.get", index: callbackLocal },
            { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: fnFieldIdx },
            { op: "local.get", index: callbackLocal },
            { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: capsFieldIdx },
            { op: "local.get", index: valueLocal },
            { op: "call", funcIdx: state.enqueueFuncIdx },

            { op: "local.get", index: callbackLocal },
            { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 4 },
            { op: "local.set", index: callbacksLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    { op: "local.get", index: valueLocal },
  ];
}

export function buildIdentityWrapperLocals(capsTypeIdx: TypeHandle): LocalDef[] {
  // Params 0/1: (caps, value). Locals 2/3 are decoded caps + settle result.
  return [
    { name: "$caps", type: { kind: "ref", typeIdx: capsTypeIdx } },
    { name: "$result", type: { kind: "externref" } },
  ];
}

export function buildIdentityWrapperBody(resources: IdentityReactionResources): Instr[] {
  const { capsTypeIdx, settleFuncIdx } = resources;
  const rawCapsLocal = 0;
  const valueLocal = 1;
  const capsLocal = 2;
  const resultLocal = 3;
  const chainedPromise = (): Instr[] => [
    { op: "local.get", index: capsLocal },
    { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
  ];
  return [
    { op: "local.get", index: rawCapsLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: capsTypeIdx },
    { op: "local.set", index: capsLocal },
    ...buildDenoPromiseHookCall(resources.beforeHook, DENO_PROMISE_HOOK_BEFORE, chainedPromise()),
    { op: "local.get", index: capsLocal },
    { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: valueLocal },
    { op: "call", funcIdx: settleFuncIdx },
    { op: "local.set", index: resultLocal },
    ...buildDenoPromiseHookCall(resources.afterHook, DENO_PROMISE_HOOK_AFTER, chainedPromise()),
    { op: "local.get", index: resultLocal },
  ];
}

/**
 * (#2958) Emit `__note_unhandled_rejection`-equivalent inline instructions that
 * prepend `promiseInstrs`' value (which MUST leave a `(ref $Promise)` /
 * eqref-compatible value on the stack) onto `__unhandled_head`. Returns [] when
 * tracking is inactive (non-wasi). The value is consumed (not left on stack).
 */
export function buildNoteUnhandledRejection(
  state: { readonly unhandledHeadGlobalIdx: number; readonly unhandledNodeTypeIdx: number },
  promiseOnStack: Instr[],
): Instr[] {
  if (state.unhandledHeadGlobalIdx < 0 || state.unhandledNodeTypeIdx < 0) return [];
  return [
    // node = $__unhandled_node{ promise: <p>, next: __unhandled_head, handled: 0 }
    ...promiseOnStack,
    { op: "global.get", index: state.unhandledHeadGlobalIdx },
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: state.unhandledNodeTypeIdx },
    { op: "extern.convert_any" },
    { op: "global.set", index: state.unhandledHeadGlobalIdx },
  ];
}
