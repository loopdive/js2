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
// user constructor) is #7089's scope, not this body's.

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

/** Body of `__promise_with_resolvers() -> externref`. */
export function buildPromiseWithResolversBody(r: PromiseWithResolversResources): Instr[] {
  const settleValue = (clFuncIdx: FuncHandle): Instr[] => [
    ...buildPromiseSettleClosureValue(
      r.closures,
      clFuncIdx,
      [{ op: "local.get", index: PROMISE }],
      [{ op: "local.get", index: GUARD }],
    ),
    { op: "extern.convert_any" },
  ];
  const define = (key: "promise" | "resolve" | "reject", value: Instr[]): Instr[] => [
    { op: "local.get", index: RESULT },
    ...r.keyInstrs(key),
    ...value,
    { op: "call", funcIdx: r.externSetFuncIdx },
  ];
  return [
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: r.closures.guardTypeIdx },
    { op: "local.set", index: GUARD },
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    r.promiseBagInit,
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: r.promiseTypeIdx },
    { op: "local.set", index: PROMISE },
    ...r.initHook([{ op: "local.get", index: PROMISE }]),
    { op: "call", funcIdx: r.newPlainObjectFuncIdx },
    { op: "local.set", index: RESULT },
    ...define("promise", [{ op: "local.get", index: PROMISE }, { op: "extern.convert_any" }]),
    ...define("resolve", settleValue(r.resolveClFuncIdx)),
    ...define("reject", settleValue(r.rejectClFuncIdx)),
    { op: "local.get", index: RESULT },
  ];
}
