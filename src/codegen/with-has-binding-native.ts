// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5271 step 3, D1) `__with_has_binding` for `--target standalone`.
 *
 * ECMA-262 §9.1.1.2.1 — Object Environment Record HasBinding(N):
 *
 *   1. Let foundBinding be ? HasProperty(bindingObject, N).
 *   2. If foundBinding is false, return false.
 *   3. If withEnvironment is false, return true.
 *   4. Let unscopables be ? Get(bindingObject, @@unscopables).
 *   5. If unscopables is an Object:
 *        a. Let blocked be ToBoolean(? Get(unscopables, N)).
 *        b. If blocked is true, return false.
 *   6. Return true.
 *
 * HOST mode has had this since #2663 Slice 4, as the `env::__with_has_binding`
 * import. Standalone had only `__extern_has` — HasProperty alone — so the
 * @@unscopables filter never ran (`with (env) x` read the blocked property,
 * `*-in-get-unscopables` counted zero getter calls, and a throwing
 * `@@unscopables` getter never propagated).
 *
 * This is a DEFINED function, never an import: a standalone module that
 * imported `__with_has_binding` would fail the runner's host-import leak check
 * (#5272) — and would also slip past the `__extern_*` refusal in #1472, which
 * is name-prefixed.
 *
 * Both `Get`s go through `__extern_get`, which carries the Proxy front-guard,
 * so a Proxy `with`-target logs `has:x` then `get:Symbol(Symbol.unscopables)`
 * in spec order and a throwing getter propagates (there is no catch here).
 * Nothing is cached: the rows that count getter calls mutate the environment
 * from inside the getter, so @@unscopables is re-read on EVERY lookup.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureSymbolCarrier } from "./symbol-native.js";
import { getWellKnownSymbolId } from "./literals.js";

/** Registry name of the standalone HasBinding native. */
export const WITH_HAS_BINDING_NATIVE = "__with_has_binding_native";

/**
 * Register (once) the standalone §9.1.1.2.1 HasBinding predicate and return its
 * STABLE function handle, or `undefined` when the substrate it needs is not
 * present — the caller then keeps the plain `__extern_has` gate, which is the
 * pre-#5271 behaviour.
 *
 * Call it during body compilation: `__extern_get` / `__extern_has` /
 * `__is_truthy` are all registered by then, and the handle is stable, so a
 * later late-import batch cannot move it.
 */
export function ensureWithHasBindingNative(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get(WITH_HAS_BINDING_NATIVE);
  if (existing !== undefined) return existing;

  const hasIdx = ctx.funcMap.get("__extern_has");
  const getIdx = ctx.funcMap.get("__extern_get");
  const truthyIdx = ctx.funcMap.get("__is_truthy");
  const isUndefIdx = ctx.funcMap.get("__extern_is_undefined");
  if (hasIdx === undefined || getIdx === undefined || truthyIdx === undefined || isUndefIdx === undefined) {
    return undefined;
  }

  // The @@unscopables key is the interned well-known `$Symbol` carrier —
  // `__box_symbol(11)` — the same identity `Symbol.unscopables` reads as a
  // value, so a user's `obj[Symbol.unscopables] = …` write is found by this
  // lookup.
  const unscopablesId = getWellKnownSymbolId("unscopables");
  if (unscopablesId === undefined) return undefined;
  ensureSymbolCarrier(ctx);
  const boxSymbolIdx = ctx.funcMap.get("__box_symbol");
  if (boxSymbolIdx === undefined) return undefined;

  // params: 0 = env (externref), 1 = key (externref)
  const L_UNSC = 2;
  const locals: { name: string; type: ValType }[] = [{ name: "unsc", type: { kind: "externref" } }];

  const body: Instr[] = [
    // step 1-2: HasProperty(env, key) === false ⇒ false.
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: hasIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    // step 4: unscopables = Get(env, @@unscopables). A throwing getter
    // propagates — no catch, per §9.1.1.2.1 step 4's `?`.
    { op: "local.get", index: 0 },
    { op: "i32.const", value: unscopablesId },
    { op: "call", funcIdx: boxSymbolIdx },
    { op: "call", funcIdx: getIdx },
    { op: "local.tee", index: L_UNSC },
    // step 5: only an OBJECT blocks, so a nullish answer leaves the binding
    // visible. `null` and the `undefined` carrier are the two spellings the
    // absent case takes here — a genuinely primitive @@unscopables value falls
    // through to the blocklist read below, which answers `undefined` (falsy) for
    // it and so does not block either.
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },
    { op: "local.get", index: L_UNSC },
    { op: "call", funcIdx: isUndefIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },
    // step 5.a-b: blocked = ToBoolean(Get(unscopables, key)); blocked ⇒ false.
    { op: "local.get", index: L_UNSC },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: getIdx },
    { op: "call", funcIdx: truthyIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    // step 6.
    { op: "i32.const", value: 1 },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(WITH_HAS_BINDING_NATIVE, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: WITH_HAS_BINDING_NATIVE,
    typeIdx,
    locals,
    body,
    exported: false,
  });
  return funcIdx;
}
