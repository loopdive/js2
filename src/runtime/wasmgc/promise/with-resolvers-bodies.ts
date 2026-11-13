// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7090) §27.2.4.8 `Promise.withResolvers()` on the native `$Promise` carrier.
//
//   1. Let C be the this value.
//   2. Let promiseCapability be ? NewPromiseCapability(C).
//   3. Let obj be OrdinaryObjectCreate(%Object.prototype%).
//   4. CreateDataPropertyOrThrow(obj, "promise", promiseCapability.[[Promise]]).
//   5. CreateDataPropertyOrThrow(obj, "resolve", promiseCapability.[[Resolve]]).
//   6. CreateDataPropertyOrThrow(obj, "reject", promiseCapability.[[Reject]]).
//   7. Return obj.
//
// For C = %Promise% the capability is exactly what `new Promise(executor)`
// builds before it runs the executor: a pending `$Promise`, one shared
// resolving-pair latch and the two `$__promise_settle_cap` settle closures. No
// executor runs. The result is an ordinary object whose three data properties
// are inserted in spec order. A subclass `C` (NewPromiseCapability through a
// user constructor) is built at the call site by
// src/codegen/promise/receiver-capability.ts (#7089).

import type { FuncHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import type { PromiseSettleClosureResources } from "./resolution-bodies.js";
import { buildPromiseSettleClosureValue } from "./resolution-bodies.js";
import { PROMISE_STATE_PENDING } from "./settlement-bodies.js";

export interface PromiseWithResolversResources {
  readonly closures: PromiseSettleClosureResources & {
    readonly guardTypeIdx: TypeHandle;
  };
  readonly promiseTypeIdx: TypeHandle;
  readonly resolveClFuncIdx: FuncHandle;
  readonly rejectClFuncIdx: FuncHandle;
  /** `__new_plain_object() -> externref` (an ordinary object with %Object.prototype%). */
  readonly newPlainObjectFuncIdx: FuncHandle;
  /** `__extern_set(obj, key, value)` — a fresh ordinary object makes it CreateDataProperty. */
  readonly externSetFuncIdx: FuncHandle;
  /** The `$bag` slot initialiser of a fresh `$Promise`. */
  readonly promiseBagInit: Instr;
  /** Deno promise-hook INIT dispatch for the new promise (empty outside that graph). */
  readonly initHook: (promiseInstrs: Instr[]) => Instr[];
  /** Pushes the externref property key. */
  readonly keyInstrs: (key: "promise" | "resolve" | "reject") => Instr[];
}

const PROMISE = 0;
const GUARD = 1;
const RESULT = 2;

export function buildPromiseWithResolversLocals(r: PromiseWithResolversResources): LocalDef[] {
  return [
    { name: "$promise", type: { kind: "ref", typeIdx: r.promiseTypeIdx } },
    { name: "$guard", type: { kind: "ref", typeIdx: r.closures.guardTypeIdx } },
    { name: "$result", type: { kind: "externref" } },
  ];
}

/** A fresh pending `$Promise` into `promise` and its shared resolving-pair latch into `guard`. */
function pendingPromiseInstrs(r: PromiseWithResolversResources, promise: number, guard: number): Instr[] {
  return [
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: r.closures.guardTypeIdx },
    { op: "local.set", index: guard },
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    r.promiseBagInit,
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: r.promiseTypeIdx },
    { op: "local.set", index: promise },
    ...r.initHook([{ op: "local.get", index: promise }]),
  ];
}

/** One `$__promise_settle_cap` function object over `promise`/`guard`, as an externref. */
function settleValueInstrs(
  r: PromiseWithResolversResources,
  clFuncIdx: FuncHandle,
  promise: number,
  guard: number,
): Instr[] {
  return [
    ...buildPromiseSettleClosureValue(
      r.closures,
      clFuncIdx,
      [{ op: "local.get", index: promise }],
      [{ op: "local.get", index: guard }],
    ),
    { op: "extern.convert_any" },
  ];
}

/** Body of `__promise_with_resolvers() -> externref`. */
export function buildPromiseWithResolversBody(r: PromiseWithResolversResources): Instr[] {
  const define = (key: "promise" | "resolve" | "reject", value: Instr[]): Instr[] => [
    { op: "local.get", index: RESULT },
    ...r.keyInstrs(key),
    ...value,
    { op: "call", funcIdx: r.externSetFuncIdx },
  ];
  return [
    ...pendingPromiseInstrs(r, PROMISE, GUARD),
    { op: "call", funcIdx: r.newPlainObjectFuncIdx },
    { op: "local.set", index: RESULT },
    ...define("promise", [{ op: "local.get", index: PROMISE }, { op: "extern.convert_any" }]),
    ...define("resolve", settleValueInstrs(r, r.resolveClFuncIdx, PROMISE, GUARD)),
    ...define("reject", settleValueInstrs(r, r.rejectClFuncIdx, PROMISE, GUARD)),
    { op: "local.get", index: RESULT },
  ];
}

// (#7089) NewPromiseCapability(%Promise%) into a caller-owned capability record — the
// `$__promise_custom_capability` struct the custom-`C` executor fills — so one call-site
// protocol serves both receivers. params: 0 = record; locals: 1 promise, 2 guard.
const CAP_RECORD = 0;
const CAP_PROMISE = 1;
const CAP_GUARD = 2;

export function buildPromiseIntrinsicCapabilityLocals(r: PromiseWithResolversResources): LocalDef[] {
  return [
    { name: "$promise", type: { kind: "ref", typeIdx: r.promiseTypeIdx } },
    { name: "$guard", type: { kind: "ref", typeIdx: r.closures.guardTypeIdx } },
  ];
}

/**
 * Body of `__promise_intrinsic_capability(record) -> externref`: the pending promise and settle
 * closures `__promise_with_resolvers` builds, stored into the record's `$resolve` / `$reject`
 * slots; returns the promise.
 */
export function buildPromiseIntrinsicCapabilityBody(
  r: PromiseWithResolversResources,
  recordTypeIdx: TypeHandle,
): Instr[] {
  const store = (fieldIdx: number, clFuncIdx: FuncHandle): Instr[] => [
    { op: "local.get", index: CAP_RECORD },
    ...settleValueInstrs(r, clFuncIdx, CAP_PROMISE, CAP_GUARD),
    { op: "struct.set", typeIdx: recordTypeIdx, fieldIdx },
  ];
  return [
    ...pendingPromiseInstrs(r, CAP_PROMISE, CAP_GUARD),
    ...store(0, r.resolveClFuncIdx),
    ...store(1, r.rejectClFuncIdx),
    { op: "local.get", index: CAP_PROMISE },
    { op: "extern.convert_any" },
  ];
}
