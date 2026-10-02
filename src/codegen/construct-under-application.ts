// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6738 — under-applied ordinary [[Construct]] in the standalone
 * `__native_construct_<N>` driver (#3981).
 *
 * The driver's ordinary tail calls `__call_fn_method_<N>(self, callee, a0…)`
 * at the CALL-SITE arity N. That dispatcher only admits closures whose declared
 * arity is `<= N`, so constructing a function that declares MORE formals than
 * the site supplies — `function ListCache(entries) { … this.clear(); }` reached
 * as `new (Map || ListCache)()` or `function mk(C) { return new C(); }` — missed
 * every arm: the constructor body never ran and `new` answered the bare
 * `Object.create(C.prototype)` with none of its own fields (`size` undefined).
 *
 * Same rule the accessor drivers already apply (#4392) and the in-Wasm
 * `__apply_closure` bridge applies (#3592): dispatch at
 * `max(N, __closure_arity(callee))`, padding the omitted formals with the
 * canonical `undefined` carrier, and seed `__argc` with the ACTUAL count N so
 * the callee's `arguments.length` / default-parameter checks see what the
 * caller passed. A callee whose declared arity is `<= N` (or that is not a
 * closure, `-1`) keeps the exact-arity call unchanged.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { RUNTIME_EVAL_AOT_CALLABLE_BRAND_A, RUNTIME_EVAL_AOT_CALLABLE_BRAND_B } from "./runtime-eval-boundary.js";
import { ensureArgcGlobal } from "./statements/nested-declarations.js";

/** Highest `__call_fn_method_<N>` arity the ladder considers (the dispatcher family's contiguous range). */
const MAX_LADDER_ARITY = 8;

/**
 * The construct driver's ordinary call `callee.[[Call]](self, a0…a<N-1>)`.
 * Layout is the driver's: param 0 = callee, params 2… = the N supplied
 * arguments; `selfLocal` holds the fresh receiver and `declaredLocal` is an i32
 * scratch the caller reserves when `underApplied` comes back true.
 *
 * Without `__closure_arity` in the module, or with no dispatcher wider than N,
 * this is exactly the pre-#6738 `__call_fn_method_<N>` call, byte-for-byte.
 */
export function buildOrdinaryConstructCall(
  ctx: CodegenContext,
  arity: number,
  methodCallIdx: number,
  selfLocal: number,
  declaredLocal: number,
): { instrs: Instr[]; underApplied: boolean } {
  const calleeLocal = 0;
  const argLocal = (arg: number): number => arg + 2;
  const exactCall: Instr[] = [
    { op: "local.get", index: selfLocal },
    { op: "local.get", index: calleeLocal },
    ...Array.from({ length: arity }, (_, arg): Instr => ({ op: "local.get", index: argLocal(arg) })),
    { op: "call", funcIdx: methodCallIdx },
  ];
  const ladder = underAppliedLadder(ctx, arity, calleeLocal, selfLocal, argLocal, declaredLocal, exactCall);
  return ladder ? { instrs: ladder, underApplied: true } : { instrs: exactCall, underApplied: false };
}

/** Wrap `exactCall` in the declared-arity ladder, or `undefined` when none applies. */
function underAppliedLadder(
  ctx: CodegenContext,
  arity: number,
  calleeLocal: number,
  selfLocal: number,
  argLocal: (arg: number) => number,
  declaredLocal: number,
  exactCall: Instr[],
): Instr[] | undefined {
  const closureArityIdx = ctx.funcMap.get("__closure_arity");
  if (closureArityIdx === undefined) return undefined;
  const wider: { declared: number; funcIdx: number }[] = [];
  for (let declared = arity + 1; declared <= MAX_LADDER_ARITY; declared++) {
    const funcIdx = ctx.funcMap.get(`__call_fn_method_${declared}`);
    if (funcIdx !== undefined) wider.push({ declared, funcIdx });
  }
  if (wider.length === 0) return undefined;
  // Read-only: a standalone module always reserves the `$undefined` singleton;
  // never mint it here (fill time), fall back to null when it is absent.
  // Fresh objects per use: later index-remapping passes rewrite instrs in place.
  const undefinedGlobal = ctx.undefinedGlobalIdx;
  const undefinedArg = (): Instr[] =>
    undefinedGlobal !== undefined
      ? [{ op: "global.get", index: undefinedGlobal }, { op: "extern.convert_any" }]
      : [{ op: "ref.null.extern" }];
  const argcGlobal = ensureArgcGlobal(ctx);

  let dispatch: Instr[] = exactCall;
  for (const { declared, funcIdx } of wider.reverse()) {
    const padded: Instr[] = [
      { op: "i32.const", value: arity },
      { op: "global.set", index: argcGlobal },
      { op: "local.get", index: selfLocal },
      { op: "local.get", index: calleeLocal },
    ];
    for (let arg = 0; arg < declared; arg++) {
      padded.push(...(arg < arity ? [{ op: "local.get", index: argLocal(arg) } as Instr] : undefinedArg()));
    }
    padded.push({ op: "call", funcIdx });
    dispatch = [
      { op: "local.get", index: declaredLocal },
      { op: "i32.const", value: declared },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: padded,
        else: dispatch,
      },
    ];
  }
  return [
    { op: "local.get", index: calleeLocal },
    { op: "call", funcIdx: closureArityIdx },
    { op: "local.set", index: declaredLocal },
    ...dispatch,
  ];
}

/**
 * (#6738) Replace a runtime-eval AOT-callable carrier callee (param
 * `calleeLocal`) by the closure it wraps, before any construct arm looks at it.
 *
 * A module with a runtime-eval site (lodash-es: `Function('return this')()` in
 * `_root.js`) publishes its function-valued module bindings as the #2928
 * `(call, get, target, brandA, brandB)` carrier. No construct arm and no
 * `__reflect_is_constructor` arm knows that carrier, so `new MapCache()` from
 * another module threw `TypeError: value is not a constructor` — and with #6738
 * admitting `new (memoize.Cache || MapCache)`, lodash-es module init did too.
 * The carrier is a call adapter only; the constructor is its `target`.
 * `[]` — identical bytes — when the module minted no carrier.
 */
export function unwrapRuntimeEvalCarrierCallee(ctx: CodegenContext, calleeLocal: number): Instr[] {
  const carrier = ctx.runtimeEvalAotCallableCarrier;
  if (carrier === undefined) return [];
  const cast = (): Instr[] => [
    { op: "local.get", index: calleeLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: carrier.structTypeIdx },
  ];
  const brandEq = (fieldIdx: number, brand: number): Instr[] => [
    ...cast(),
    { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx },
    { op: "i32.const", value: brand },
    { op: "i32.eq" },
  ];
  return [
    { op: "local.get", index: calleeLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: carrier.structTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...brandEq(3, RUNTIME_EVAL_AOT_CALLABLE_BRAND_A),
        ...brandEq(4, RUNTIME_EVAL_AOT_CALLABLE_BRAND_B),
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...cast(),
            { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 2 },
            { op: "local.set", index: calleeLocal },
          ],
        },
      ],
    },
  ];
}
