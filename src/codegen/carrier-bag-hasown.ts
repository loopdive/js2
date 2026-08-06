// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4055) `__desc_has_own(obj, key)` — the HasProperty step of
 * ToPropertyDescriptor (§6.2.5.6), widened to see the #3468 closure
 * own-property side table.
 *
 * ## The gap
 * #3468 gave the terminal dynamic-property helpers `__extern_get` /
 * `__extern_set` / `__extern_method_call` a fallback for a receiver that is not
 * a `$Object`: an identity-keyed side table mapping the carrier to a `$Object`
 * "bag" holding its own properties. The descriptor reader never got it, and
 * `__obj_define_from_desc`'s ToPropertyDescriptor gates **every** field on
 * HasProperty before reading it. So a **function used as a descriptor** — the
 * dominant test262 spelling —
 *
 * ```js
 * var descObj = function () {};
 * descObj.enumerable = true;
 * descObj.value = 42;
 * Object.defineProperty(obj, "p", descObj);
 * ```
 *
 * produced an EMPTY descriptor, and CompletePropertyDescriptor filled in
 * `undefined` plus all-false attributes. Silently: no refusal, wrong content —
 * even though `descObj.enumerable` *reads* `true` through `__extern_get`.
 *
 * ## Why this is a SEPARATE native, not a change to `__hasOwnProperty` (#4017)
 * The first version of this fix widened `__hasOwnProperty` / `__object_hasOwn`
 * themselves. It kept every flip and it was auto-parked out of the merge queue
 * for costing **684 host-free passes**: `Object.prototype.hasOwnProperty` is
 * reached by `propertyHelper.js` on every `built-ins/**\/{name,length}.js` test —
 * ~700 files, of which 696 failed with "descriptor should be configurable".
 *
 * The lesson is NOT "that arm was subtly wrong". Its answers were the ones asked
 * for. It was wired at the most GENERAL point that could express the fix, and
 * generality there IS blast radius. ToPropertyDescriptor is the only caller that
 * needs this, so the widening now lives in a native only it calls;
 * `Object.prototype.hasOwnProperty`, `Object.hasOwn` and `propertyIsEnumerable`
 * are byte-identical to before.
 *
 * Worth recording because the harness-only trigger was never isolated: three
 * candidate mechanisms were measured and all three failed to reproduce outside
 * the full harness assembly (gOPD reads `configurable: true` on BOTH arms;
 * `isConfigurable`'s delete-then-hasOwn already answers wrong on BOTH arms;
 * the `verifyProperty` vacuity gate is `true` on BOTH arms). When a mechanism
 * resists isolation, narrowing the change until the mechanism is out of scope
 * beats chasing it.
 *
 * ## Why a fixed-key presence query over the bag is sound
 * #4047 measured a carrier-bag arm at +6 and reverted it: resolving a
 * `Properties` MAP through the bag needs a COMPLETE own-key source, and the bag
 * is not one — `props.p = v` lands in the bag while
 * `Object.defineProperty(props,"p",…)` lands in the separate #3251 overlay
 * (Array) or nowhere (Function). Enumerating it defines nothing and returns
 * normally: a silent no-op on the more idiomatic spelling.
 *
 * HasProperty over a FIXED key needs no key source at all, and the bag is
 * exactly where `__extern_set` put the write, so presence and read agree by
 * construction. `Object.defineProperty(fun,"p",…)` still lands nowhere and this
 * still answers `false` for it — the same answer as before.
 *
 * ## LOOKUP, never ENSURE
 * The bag is read with `__closure_bag_lookup`, never `__closure_bag_ensure`: a
 * presence *query* must not allocate a bag, or merely asking whether a
 * descriptor has a `value` field would mutate the side table and hand a later
 * `__integrity_bag` consumer a carrier that previously had none.
 *
 * ## The ARRAY half is deliberately absent — measured, not assumed
 * A vec arm was written and measured **unreachable**: `fillVecHasOwnHelpers`
 * (`vec-overlay.ts`) unshifts a prologue into `__hasOwnProperty` that answers
 * from `__vec_gopd` and returns for EVERY vec receiver. Probe: `a=[1,2,3];
 * a.q=5` gives `a.q === 5` and `a.hasOwnProperty("0") === true` but
 * `a.hasOwnProperty("q") === false`. That is the #3251-overlay-vs-#3537-bag
 * split filed as **#4010**. Removed rather than shipped as decoration.
 *
 * ## Ownership / byte-neutrality
 * Composition only — `closure-props.ts` (#3468) and `vec-props.ts` (#3537) are
 * not edited; this reaches their helpers by name through `funcMap`. When the
 * substrate is absent (host/gc, where the `env::__extern_*` imports own the
 * dynamic-property path) the native degrades to a plain `__hasOwnProperty`
 * forward, so non-standalone output is unchanged.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** #3468 closure-own-property side table. */
const IS_CLOSURE_PROP_CARRIER = "__is_closure_prop_carrier";
const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";

/** The descriptor-scoped HasProperty native minted here. */
export const DESC_HAS_OWN = "__desc_has_own";

/** Minter signature shared with `ensureObjectRuntime`'s `registerNative`. */
type RegisterNative = (
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
) => number;

/** Params are 0/1; the single local `bag` is 2. */
const BAG = 2;

/**
 * Register `__desc_has_own(externref obj, externref key) -> i32`:
 *
 * ```
 * if (__hasOwnProperty(obj, key)) return 1;          // never overridden
 * if (__is_closure_prop_carrier(obj)) {
 *   bag = __closure_bag_lookup(obj);                 // LOOKUP, never ensure
 *   if (bag != null && bag is $Object) {
 *     if (__obj_find(bag, key) != null) return 1;    // (#4163) fall through on miss
 *   }
 * }
 * return __extern_has(obj, key);                     // (#4163) §7.3.12 chain walk
 * ```
 *
 * The `__hasOwnProperty` call comes FIRST so every answer the existing helper
 * gives is preserved exactly — the bag is a strict fallback for the cases it
 * answers `false` on, never an override. That ordering is what keeps this
 * additive rather than a redirection.
 *
 * (#4163) The FINAL arm is the full ES §7.3.12 HasProperty — delegate to
 * `__extern_has`, which walks the `$Object.$proto` chain (and the #4160
 * prototype-index companions). ToPropertyDescriptor's field-presence step IS
 * HasProperty, not HasOwnProperty: an INHERITED `enumerable`/`value`/… on a
 * descriptor-argument object must be honored (the `Con.prototype = proto; new
 * Con()` descriptor family). Prototype pollution was checked and is a
 * non-issue: none of the six descriptor field names is reachable via `in` on
 * any standalone plain object/array/function/RegExp/Date/Error/Arguments/
 * wrapper receiver by default. This arm measured +0 while the #2660 chain was
 * dead and is re-landed WITH the chain-liveness fix, where it is load-bearing
 * (see plan/issues/4008-*.md "do not re-derive" note).
 *
 * Returns the funcIdx, or `undefined` when a dependency is missing, in which
 * case callers keep using `__hasOwnProperty` directly.
 */
export function registerDescriptorHasOwn(
  ctx: CodegenContext,
  registerNative: RegisterNative,
  args: { hasOwnIdx: number; objFindIdx: number; objectTypeIdx: number; externHasIdx?: number | undefined },
): number | undefined {
  const existing = ctx.funcMap.get(DESC_HAS_OWN);
  if (existing !== undefined) return existing;

  const isCarrierIdx = ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER);
  const bagLookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: args.hasOwnIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },
  ];

  if (isCarrierIdx !== undefined && bagLookupIdx !== undefined) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isCarrierIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: bagLookupIdx },
          { op: "local.tee", index: BAG },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // The `ref.test` is not decoration: a bag is a
              // `__new_plain_object` product today, but a bare `ref.cast` would
              // turn any future substrate change into a trap inside a helper
              // that must never throw (#3468 S1 discipline).
              { op: "local.get", index: BAG },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: args.objectTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: BAG },
                  { op: "any.convert_extern" },
                  { op: "ref.cast", typeIdx: args.objectTypeIdx },
                  { op: "local.get", index: 1 },
                  { op: "call", funcIdx: args.objFindIdx },
                  { op: "ref.is_null" },
                  { op: "i32.eqz" },
                  // (#4163) HIT → 1; a bag MISS now falls through to the
                  // §7.3.12 chain arm below instead of answering 0.
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "i32.const", value: 1 }, { op: "return" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    );
  }

  // (#4163) FINAL arm — full §7.3.12 HasProperty via `__extern_has` (own +
  // carrier bag + `$proto` chain + #4160 companions). Registered after
  // `__extern_has` precisely so this funcIdx is available; when it is not
  // (dependency missing), keep the previous own-only 0 answer.
  if (args.externHasIdx !== undefined) {
    body.push({ op: "local.get", index: 0 }, { op: "local.get", index: 1 }, { op: "call", funcIdx: args.externHasIdx });
  } else {
    body.push({ op: "i32.const", value: 0 });
  }

  return registerNative(
    DESC_HAS_OWN,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
    [{ name: "bag", type: { kind: "externref" } }],
    body,
  );
}
