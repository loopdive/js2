// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4010 S3) Own-property **VISIBILITY** over the carrier bags — the four
 * reflective surfaces (`hasOwnProperty`/`Object.hasOwn`, `in`,
 * `getOwnPropertyDescriptor`, `Object.keys`/for-in/`getOwnPropertyNames`) made
 * able to see the own-property side table of a non-`$Object` receiver.
 *
 * ## Why this slice comes LAST, and what had to land first
 * #4010's ordering law:
 *
 * > Own-property VISIBILITY cannot ship before own-property DELETABILITY.
 *
 * That is a receipt, not a preference. #4055 v1 widened `__hasOwnProperty` /
 * `__object_hasOwn` to see the bag; every flip held, the PR was green, and the
 * `merge_group` parked it for **-684** host-free passes — 682 of the 713 losses
 * were `built-ins/**\/{name,length}.js`, 696 failing with *"descriptor should be
 * configurable"*. S2 (`carrier-bag-delete.ts`) made `delete` real on these
 * receivers, which removes the `configurable` wall; this module is the widening
 * that finally pays out against it.
 *
 * ## The -684 mechanism, isolated at last (it never was in #4055)
 * #4055's header records that three candidate mechanisms were measured and none
 * reproduced outside the full harness assembly. Measured here, standalone,
 * host-free, on current main:
 *
 * ```js
 * const f = Array.prototype.push;
 * f.name = "unlikelyValue";   // REFUSED by the read path (#2896 meta arm wins)
 * f.name;                     // => "push"      — looks correct
 * delete f.name;              // #2896 arm clears the meta bit
 * f.name;                     // => "unlikelyValue"   <- THE BAG KEPT IT
 * ```
 *
 * `__extern_set` had no builtin-fn arm, so a write to a **non-writable** builtin
 * `name`/`length` was silently deposited in the #3468 closure bag while the read
 * lane shadowed it. `propertyHelper.js` writes exactly that: `isWritable` does
 * `obj[name] = "unlikelyValue"` BEFORE `isConfigurable` does
 * `delete obj[name]; return !__hasOwnProperty(obj, name)`. Widen
 * `hasOwnProperty` over a bag polluted that way and `isConfigurable` answers
 * **false** for ~700 files whose descriptor is `configurable: true`. That is the
 * -684, exactly.
 *
 * The fix is at the SOURCE, not at the query: {@link buildBuiltinFnSetRefusalArm}
 * makes `__extern_set` refuse a key the #2896 metadata still owns — §10.1.9
 * OrdinarySet over an existing non-writable own data property is a no-op, so the
 * bag never sees the write. After `delete fn.name` the metadata is gone and an
 * assignment lands normally, which is also what the spec says.
 *
 * ## Composition — the helper answers FIRST, the bag only on a miss
 * Every wiring point preserves #4055 v2's pattern: the existing answer is
 * computed first and returned when it is affirmative; the bag is consulted
 * **only** where today's answer is "absent". So this can add a `true`, never
 * override one, and every receiver/key the old code answered for keeps its
 * answer bit-for-bit. The #2896 builtin-fn arms keep running first and
 * returning, so `{name,length}` on a builtin never reaches the bag.
 *
 * ## LOOKUP, never ENSURE
 * `__carrier_bag_of` uses the carrier-specific LOOKUP helper. A
 * *query* must never allocate a bag: merely asking whether a receiver has a
 * property would otherwise hand a later `__integrity_bag` consumer a carrier
 * that previously had none (the `carrier-bag-hasown.ts` rule).
 *
 * ## Tombstones come for free
 * `__obj_find`, `__obj_ordered` and `__obj_ordered_all` all skip
 * `FLAG_TOMBSTONE` entries, so a key deleted by S2 stays invisible to all four
 * surfaces. Nothing here re-implements delete semantics.
 *
 * ## What deliberately does NOT move
 * - **Date / RegExp** have no bag, so
 *   `__carrier_bag_of` answers null and every surface keeps its current answer.
 *   Native Error values now use their existing `$Error_struct.$props` slot;
 *   class-instance expandos use the identity-keyed instance substrate.
 * - **Builtin internals never leak into `keys`.** #4071 measured a -5 for
 *   letting closed-struct fields into `Object.keys` and reverted it. The bag is
 *   not a struct: it only ever holds keys a user assignment put there, so
 *   enumerating it cannot surface an internal field. The screen is structural,
 *   not a name-shape heuristic (#4086: `startsWith("__")` is NOT a safe screen).
 * - **`Object.defineProperty(fn, k, d)` still lands nowhere.** Widening gOPD
 *   does not make it lie: gOPD reads the same bag the define did not write, so
 *   an undefined descriptor stays undefined.
 * - **#4099's direction is the opposite one.** It is about `Object.keys`
 *   failing to EXCLUDE non-enumerables on `$Object` receivers; this includes
 *   bag entries, and honours `FLAG_ENUMERABLE` via `__obj_ordered` while
 *   `getOwnPropertyNames` uses `__obj_ordered_all`. Adjacent, not the same.
 *
 * ## Byte-neutrality
 * Reserved only when a carrier predicate exists (standalone/wasi — in gc/host
 * mode the `env::__extern_*` imports own the dynamic-property path), and every
 * placeholder body is the "nothing to add" answer, so a skipped fill degrades to
 * exactly today's behaviour instead of trapping.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** #3468 closure-own-property side table (`closure-props.ts`). */
const IS_CLOSURE_PROP_CARRIER = "__is_closure_prop_carrier";
const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";
/** #3537 array-expando side table (`vec-props.ts`). */
const IS_VEC_PROP_CARRIER = "__is_vec_prop_carrier";
const VEC_BAG_LOOKUP = "__vec_bag_lookup";
/**
 * (#4194) Instance expando side table (`instance-props.ts`). Instances share the
 * #3468 closure bag — it is keyed by `eqref` IDENTITY, not by closure type — so
 * the arm is `(instance predicate, closure lookup)`. The name is declared here
 * rather than imported to keep this module free of a back-edge to the one that
 * consumes {@link buildBagMarkerTestInstrs}.
 */
const IS_INSTANCE_EXPANDO_CARRIER = "__is_instance_expando_carrier";
/** (#4098) Native `$Error_struct.$props` carrier (`error-props.ts`). */
const IS_ERROR_PROP_CARRIER = "__is_error_prop_carrier";
const ERROR_PROP_BAG_LOOKUP = "__error_prop_bag_lookup";

/** Abbreviated heap type `eq` (`closure-props.ts` uses the same encoding). */
const EQ_HEAP_TYPE = -19;

/** `(externref obj) -> externref` — the receiver's bag as a screened `$Object`, or null. */
export const CARRIER_BAG_OF = "__carrier_bag_of";
/** `(externref obj, externref key) -> i32` — 1 iff the bag holds a live entry. */
export const CARRIER_BAG_HAS = "__carrier_bag_has";
/** `(externref obj, externref key) -> externref` — descriptor, or **null = not handled**. */
export const CARRIER_BAG_GOPD = "__carrier_bag_gopd";
/** `(externref obj, externref vec, i32 includeNonEnum) -> i32` — 1 iff a bag existed. */
export const CARRIER_BAG_PUSH_KEYS = "__carrier_bag_push_keys";

const EXT: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/**
 * Reserve the four visibility natives as placeholder defined funcs so every
 * consumer (`__hasOwnProperty`, `__extern_has`, `__getOwnPropertyDescriptor`,
 * `__object_keys`, `__getOwnPropertyNames`, and the finalize-spliced vec
 * prologues) can bake a `call <idx>` long before the fill knows their bodies.
 * Append-only mint (no funcIdx shifts), idempotent, and a no-op unless a carrier
 * substrate was reserved.
 */
export function reserveCarrierBagVisibility(ctx: CodegenContext): void {
  if (ctx.funcMap.get(CARRIER_BAG_OF) !== undefined) return;
  const hasCarrier =
    ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER) !== undefined ||
    ctx.funcMap.get(IS_VEC_PROP_CARRIER) !== undefined ||
    ctx.funcMap.get(IS_ERROR_PROP_CARRIER) !== undefined;
  if (!hasCarrier) return;

  const reserve = (name: string, params: ValType[], results: ValType[], placeholder: Instr[]): void => {
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    // Locals are assigned at FILL (they need `$Object`/`$PropMap` ref types that
    // are cheapest to resolve there); the placeholders below use none.
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: [], body: placeholder, exported: false });
    ctx.funcMap.set(name, funcIdx);
  };

  reserve(CARRIER_BAG_OF, [EXT], [EXT], [{ op: "ref.null.extern" }]);
  reserve(CARRIER_BAG_HAS, [EXT, EXT], [I32], [{ op: "i32.const", value: 0 }]);
  reserve(CARRIER_BAG_GOPD, [EXT, EXT], [EXT], [{ op: "ref.null.extern" }]);
  reserve(CARRIER_BAG_PUSH_KEYS, [EXT, EXT, I32], [I32], [{ op: "i32.const", value: 0 }]);
}

/**
 * The additive tail for a site whose current answer is the literal "absent"
 * constant and whose params are `(0 = obj, 1 = key)`: `return
 * __carrier_bag_has(obj, key)`. Returns `[]` when the native was never reserved,
 * so the caller keeps its constant unchanged.
 */
export function buildBagHasFallback(ctx: CodegenContext): Instr[] {
  const idx = ctx.funcMap.get(CARRIER_BAG_HAS);
  if (idx === undefined) return [];
  return [{ op: "local.get", index: 0 }, { op: "local.get", index: 1 }, { op: "call", funcIdx: idx }, { op: "return" }];
}

/**
 * `[...bag consult, i32.const 0, return]` — the complete replacement for a
 * non-`$Object` arm that used to be the bare constant `0`. Params `(0 = obj,
 * 1 = key)`.
 */
export function bagHasElseAbsent(ctx: CodegenContext): Instr[] {
  return [...buildBagHasFallback(ctx), { op: "i32.const", value: 0 }, { op: "return" }];
}

/**
 * The whole `if (<cond already on the stack>) { <bag consult>; return 0 }`
 * instruction, so a five-line block in a god-file collapses to one call. Used by
 * `__hasOwnProperty` / `__object_hasOwn` / `__extern_has`, whose non-`$Object`
 * branch was `then: [i32.const 0, return]`.
 */
export function bagHasIfAbsent(ctx: CodegenContext): Instr {
  return { op: "if", blockType: { kind: "empty" }, then: bagHasElseAbsent(ctx) };
}

/**
 * `[<push bag keys into vecLocal>, local.get vecLocal, return]` — the complete
 * replacement for an arm that used to return the key vector as-is.
 */
export function bagKeysTail(
  ctx: CodegenContext,
  args: { vecLocal: number; includeNonEnum: boolean; objLocal?: number },
): Instr[] {
  return [...buildBagPushKeys(ctx, args), { op: "local.get", index: args.vecLocal }, { op: "return" }];
}

/** {@link bagKeysTail} wrapped in its enclosing `if` — see {@link bagHasIfAbsent}. */
export function bagKeysIf(
  ctx: CodegenContext,
  args: { vecLocal: number; includeNonEnum: boolean; objLocal?: number },
): Instr {
  return { op: "if", blockType: { kind: "empty" }, then: bagKeysTail(ctx, args) };
}

/**
 * `[...before, <bag gOPD consult>, ...after]` — one call for a descriptor site
 * that must keep an existing arm in front of the bag and its own miss behind it.
 */
export function bagGopdBetween(ctx: CodegenContext, tmp: number, before: Instr[], after: Instr[]): Instr[] {
  return [...before, ...buildBagGopdFallback(ctx, tmp), ...after];
}

/**
 * The additive tail for a gOPD site whose params are `(0 = obj, 1 = key)`:
 * consult the bag and return its descriptor only when the bag definitely holds
 * the key; otherwise fall through to the caller's own miss. `tmp` must be an
 * externref local of the enclosing native.
 */
export function buildBagGopdFallback(ctx: CodegenContext, tmp: number, keyLocal = 1): Instr[] {
  const idx = ctx.funcMap.get(CARRIER_BAG_GOPD);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: idx },
    { op: "local.tee", index: tmp },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: tmp }, { op: "return" }],
    },
  ];
}

/**
 * The additive tail for a key-enumeration site: push the receiver's bag keys
 * into `vecLocal`. `objLocal` defaults to param 0. `includeNonEnum` selects
 * `__obj_ordered_all` (getOwnPropertyNames) over `__obj_ordered`
 * (Object.keys / for-in).
 */
export function buildBagPushKeys(
  ctx: CodegenContext,
  args: { vecLocal: number; includeNonEnum: boolean; objLocal?: number },
): Instr[] {
  const idx = ctx.funcMap.get(CARRIER_BAG_PUSH_KEYS);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: args.objLocal ?? 0 },
    { op: "local.get", index: args.vecLocal },
    { op: "i32.const", value: args.includeNonEnum ? 1 : 0 },
    { op: "call", funcIdx: idx },
    { op: "drop" },
  ];
}

/**
 * (#4194) `i32` on the stack: 1 iff the `$PropEntry` in `entryLocal` is the
 * #4098 **tombstone marker** — the self-referential entry `bag[k] === bag`.
 *
 * `instance-tombstones.ts:69-77` predicted this leak by name: *"Stage 3/4 must
 * filter `bag[k] === bag` when they wire the instance arm in, or the marker
 * leaks into `Object.keys` as a real entry."* This is that filter, in one place,
 * used by all three bag query natives below AND by `__instance_prop_get`.
 *
 * Applying it to closure and vec carriers too is safe *because* the marker is
 * unforgeable: a bag is unreachable from user source, so no program can store a
 * value `ref.eq` to it, and the filter can never hide a real entry.
 *
 * `entryLocal` must hold a NON-NULL `$PropEntry`; `bagLocal` its owning bag as
 * `externref`; `tmpAnyLocal` is a scratch `anyref` the caller owns. The
 * `ref.test eq` before the cast is not decoration: a stored value need not be an
 * `eq` type (a host externref is not), and `ref.cast eq` on one would TRAP
 * inside a helper that must never throw.
 */
export function buildBagMarkerTestInstrs(
  ctx: CodegenContext,
  args: { entryLocal: number; bagLocal: number; tmpAnyLocal: number },
): Instr[] {
  const propEntryTypeIdx = ctx.objectRuntimeTypes?.propEntryTypeIdx;
  if (propEntryTypeIdx === undefined) return [{ op: "i32.const", value: 0 }];
  return [
    { op: "local.get", index: args.entryLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value (anyref)
    { op: "local.tee", index: args.tmpAnyLocal },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        { op: "local.get", index: args.tmpAnyLocal },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "local.get", index: args.bagLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/**
 * (#4010 S3) `__extern_set`'s builtin-fn refusal — the fix for the -684
 * mechanism, at its SOURCE.
 *
 * `name` / `length` on a builtin function value are `writable: false`
 * (§10.2.x), so §10.1.9 OrdinarySet over them is a no-op. Before this, the write
 * fell through to the #3468 closure bag and sat there invisibly, which is what
 * turned a visibility widening into 696 *"descriptor should be configurable"*
 * failures. `__builtinfn_get_meta` returns non-null exactly while the metadata
 * property is live, so after `delete fn.name` the refusal correctly stops
 * applying and an assignment creates a fresh own property.
 *
 * Emitted at the head of `__extern_set`'s non-`$Object` arm, params
 * `(0 = obj, 1 = key, 2 = value)`. `[]` when the #2896 substrate is absent
 * (non-standalone), so host output is unchanged.
 */
export function buildBuiltinFnSetRefusalArm(ctx: CodegenContext): Instr[] {
  const bfnGetMetaIdx = ctx.standalone ? ctx.funcMap.get("__builtinfn_get_meta") : undefined;
  if (bfnGetMetaIdx === undefined) return [];
  const refuse: Instr[] =
    ctx.externSetResultGlobalIdx === undefined
      ? [{ op: "return" }]
      : [
          { op: "i32.const", value: 2 }, // #4504 SET_RESULT_REFUSED
          { op: "global.set", index: ctx.externSetResultGlobalIdx },
          { op: "return" },
        ];
  return [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: bfnGetMetaIdx },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: refuse },
  ];
}

/**
 * Fill the four visibility natives at FINALIZE, once `__obj_find` /
 * `__obj_ordered` / `__obj_ordered_all` / `__getOwnPropertyDescriptor` /
 * `__objvec_push` and both carrier substrates are in `funcMap`. Leaves the
 * placeholders (the "nothing to add" answers) in place when a dependency is
 * missing.
 */
export function fillCarrierBagVisibility(ctx: CodegenContext): void {
  const bagOfIdx = ctx.funcMap.get(CARRIER_BAG_OF);
  if (bagOfIdx === undefined) return;
  const types = ctx.objectRuntimeTypes;
  if (!types) return;
  const { objectTypeIdx, propMapTypeIdx, propEntryTypeIdx } = types;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const objOrderedIdx = ctx.funcMap.get("__obj_ordered");
  const objOrderedAllIdx = ctx.funcMap.get("__obj_ordered_all");
  const gopdIdx = ctx.funcMap.get("__getOwnPropertyDescriptor");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  if (
    objFindIdx === undefined ||
    objOrderedIdx === undefined ||
    objOrderedAllIdx === undefined ||
    gopdIdx === undefined ||
    objVecPushIdx === undefined
  ) {
    return;
  }

  const setFn = (name: string, locals: { name: string; type: ValType }[], body: Instr[]): void => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    fn.locals = locals;
    fn.body = body;
  };

  // ── __carrier_bag_of(obj) -> externref ──────────────────────────────────
  // `if (<predicate>) { bag = <lookup>(obj); return bag is $Object ? bag : null }`
  // per substrate, then null. The `ref.test $Object` is not decoration: a bag is
  // a `__new_plain_object` product today, but a bare `ref.cast` in the consumers
  // would turn any future substrate change into a trap inside helpers that must
  // never throw (#3468 S1 discipline). Screening once here keeps all three
  // consumers cast-safe.
  {
    const arm = (isName: string, lookupName: string): Instr[] => {
      const isIdx = ctx.funcMap.get(isName);
      const lookupIdx = ctx.funcMap.get(lookupName);
      if (isIdx === undefined || lookupIdx === undefined) return [];
      return [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: isIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: lookupIdx },
            { op: "local.tee", index: 1 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "any.convert_extern" },
                { op: "ref.test", typeIdx: objectTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "local.get", index: 1 }, { op: "return" }],
                },
              ],
            },
            { op: "ref.null.extern" },
            { op: "return" },
          ],
        },
      ];
    };
    const closureArm = arm(IS_CLOSURE_PROP_CARRIER, CLOSURE_BAG_LOOKUP);
    const vecArm = arm(IS_VEC_PROP_CARRIER, VEC_BAG_LOOKUP);
    // (#4194) Instances read the SAME (identity-keyed) closure bag. #4098's
    // header warns this arm is "inert alone" — it ships in the same change as
    // the write path (`instance-props.ts` S1/S2), never on its own.
    const instanceArm = arm(IS_INSTANCE_EXPANDO_CARRIER, CLOSURE_BAG_LOOKUP);
    // (#4098) Error's bag is the existing `$props` slot, not the identity-keyed
    // closure side table. Only user-created entries live there, so widening
    // visibility cannot fabricate `$Error_struct` internals.
    const errorArm = arm(IS_ERROR_PROP_CARRIER, ERROR_PROP_BAG_LOOKUP);
    if (closureArm.length === 0 && vecArm.length === 0 && instanceArm.length === 0 && errorArm.length === 0) return;
    setFn(
      CARRIER_BAG_OF,
      [{ name: "bag", type: EXT }],
      [...closureArm, ...vecArm, ...instanceArm, ...errorArm, { op: "ref.null.extern" }],
    );
  }

  /** `bag = __carrier_bag_of(obj); if (bag == null) <miss>;` */
  const loadBag = (bagLocal: number, miss: Instr[]): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: bagOfIdx },
    { op: "local.tee", index: bagLocal },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: miss },
  ];
  /** `__obj_find(cast<$Object>(bag), key)` — bag already screened by `__carrier_bag_of`. */
  const findInBag = (bagLocal: number, keyLocal: number): Instr[] => [
    { op: "local.get", index: bagLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: objFindIdx },
  ];

  // ── __carrier_bag_has(obj, key) -> i32 ──────────────────────────────────
  // (#4194) The #4098 tombstone marker is a LIVE entry, so it must be filtered
  // explicitly or `delete o.f` would leave `"f" in o` answering true.
  setFn(
    CARRIER_BAG_HAS,
    [
      { name: "bag", type: EXT },
      { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
      { name: "v", type: { kind: "anyref" } },
    ],
    [
      ...loadBag(2, [{ op: "i32.const", value: 0 }, { op: "return" }]),
      ...findInBag(2, 1),
      { op: "local.tee", index: 3 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      ...buildBagMarkerTestInstrs(ctx, { entryLocal: 3, bagLocal: 2, tmpAnyLocal: 4 }),
      { op: "i32.eqz" },
    ],
  );

  // ── __carrier_bag_gopd(obj, key) -> externref (null = NOT HANDLED) ──────
  // Presence is checked BEFORE delegating so "not handled" stays distinguishable
  // from "handled, and the property is absent" — the same reason
  // `__carrier_bag_delete` is tri-state. Collapsing the two would let this
  // shadow the #2896 / #3251-overlay descriptors that legitimately answer for a
  // key the bag does not hold.
  setFn(
    CARRIER_BAG_GOPD,
    [
      { name: "bag", type: EXT },
      { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
      { name: "v", type: { kind: "anyref" } },
    ],
    [
      ...loadBag(2, [{ op: "ref.null.extern" }, { op: "return" }]),
      ...findInBag(2, 1),
      { op: "local.tee", index: 3 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
      // (#4194) A tombstone marker is "not handled", not "present with a
      // self-referential value" — otherwise gOPD would describe the marker.
      ...buildBagMarkerTestInstrs(ctx, { entryLocal: 3, bagLocal: 2, tmpAnyLocal: 4 }),
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: gopdIdx },
    ],
  );

  // ── __carrier_bag_push_keys(obj, vec, includeNonEnum) -> i32 ────────────
  // `__obj_ordered` (enumerable-only) and `__obj_ordered_all` both return a
  // COMPACTED `$PropMap` in OrdinaryOwnPropertyKeys order, with tombstones
  // already dropped and trailing nulls — so this is the same loop
  // `__object_keys` runs: break at the first null, push `entry.key`.
  {
    const BAG = 3;
    const ARR = 4;
    const CAP = 5;
    const I = 6;
    const E = 7;
    const V = 8; // (#4194) marker-test scratch
    const orderedCall = (idx: number): Instr[] => [
      { op: "local.get", index: BAG },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "call", funcIdx: idx },
      { op: "local.set", index: ARR },
    ];
    setFn(
      CARRIER_BAG_PUSH_KEYS,
      [
        { name: "bag", type: EXT },
        { name: "arr", type: { kind: "ref_null", typeIdx: propMapTypeIdx } },
        { name: "cap", type: I32 },
        { name: "i", type: I32 },
        { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
        { name: "v", type: { kind: "anyref" } },
      ],
      [
        ...loadBag(BAG, [{ op: "i32.const", value: 0 }, { op: "return" }]),
        { op: "local.get", index: 2 },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: orderedCall(objOrderedAllIdx),
          else: orderedCall(objOrderedIdx),
        },
        { op: "local.get", index: ARR },
        { op: "ref.as_non_null" },
        { op: "array.len" },
        { op: "local.set", index: CAP },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: I },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: I },
                { op: "local.get", index: CAP },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: ARR },
                { op: "ref.as_non_null" },
                { op: "local.get", index: I },
                { op: "array.get", typeIdx: propMapTypeIdx },
                { op: "local.tee", index: E },
                { op: "ref.is_null" },
                { op: "br_if", depth: 1 },
                // (#4194) skip the #4098 tombstone marker — a deleted declared
                // field must not reappear as an own key of the bag.
                ...buildBagMarkerTestInstrs(ctx, { entryLocal: E, bagLocal: BAG, tmpAnyLocal: V }),
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: 1 }, // vec
                    { op: "local.get", index: E },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                    { op: "extern.convert_any" },
                    { op: "call", funcIdx: objVecPushIdx },
                  ],
                },
                { op: "local.get", index: I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "i32.const", value: 1 },
      ],
    );
  }
}
