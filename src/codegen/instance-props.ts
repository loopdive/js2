// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4194) The **instance expando substrate** — a constructed instance
 * (`new C()`, ES `class` **or** function constructor, and object-literal
 * `__anon_` shapes) made able to (a) RETAIN a dynamic write to one of its
 * declared fields, and (b) carry a genuinely new own property.
 *
 * ## The defect, measured
 * Standalone, one source compiled twice (`.tmp/probe-4194/forin-lanes*.mjs`;
 * bitmask 1 = declared `type`, 10 = expando `name`, 100 = declared `start`):
 *
 * | receiver / surface | standalone (before) | js-host |
 * | --- | ---: | ---: |
 * | class instance, for-in mask | 101 | 111 |
 * | class instance, `("type" in n) + ("name" in n)` | 1 | 11 |
 * | class, computed writes `n[k] = v` (declared str / declared num / expando) | **0** | 111 |
 * | class, `copyNode` emulation `for (p in a) b[p] = a[p]` | 101 | 111 |
 * | fn-expr ctor, same `copyNode` emulation | 101 | 111 |
 *
 * The zero in the third row is the whole issue: **`__extern_set` drops every
 * write to a closed-struct receiver** — computed OR literal key, declared field
 * OR expando. There is no side table for such a receiver and no field arm, so
 * the value lands nowhere and the read-back is `undefined`. (`member-set-
 * dispatch.ts:173`'s comment says exactly this about the cold-tail case: "an
 * unwired write would fall to `__extern_set`, which in the standalone lane has
 * no side table for a closed-struct receiver and would drop it.")
 *
 * ## Why it is not a niche reflection bug — compiled acorn is the victim
 * The standalone `eval` / `new Function` provider IS compiled acorn, and
 * acorn's `copyNode` is
 *
 * ```js
 * pp$2.copyNode = function (node) {
 *   var newNode = new Node(this, node.start, this.startLoc);
 *   for (var prop in node) { newNode[prop] = node[prop]; }
 *   return newNode
 * };
 * ```
 *
 * `node` is untyped ⇒ the receiver is `any` ⇒ the write takes `__extern_set`
 * and is **discarded**, so the copy keeps only its constructor defaults
 * (`this.type = ""`). `copyNode` is called on exactly one hot path —
 * object-property **shorthand** — and for an object *pattern*
 * `checkLValPattern(prop.value)` reads `expr.type`, finds `""`, falls through
 * to `checkLValSimple`'s `default:` arm and raises **"Binding rvalue"**. Hence
 * no standalone runtime-lane `eval` could parse `var { a } = {}`,
 * `function g({ f }) {}` or `catch ({ f })` — the 24
 * `annexB/language/eval-code/…-skip-early-err-try` files, all failing on parse.
 *
 * ## Shape of the fix, and the ONE invariant that keeps it safe
 * Three composable pieces, all gated `ctx.standalone || ctx.wasi`, all
 * reserve-then-fill (funcIdx discipline of `closure-props.ts`):
 *
 * - **S1 — declared-field write-through** ({@link fillClosedStructExternSetArms}).
 *   A prologue on `__extern_set`: for a NON-`$Object` receiver with a string
 *   key, a per-name ladder of per-struct `ref.test` arms stores into the
 *   physical slot (hot field, `#3927` cold tail, or presence-tracked
 *   conditional field alike).
 * - **S2 — expando bag** ({@link buildInstanceOrVecOrClosurePropSetMissArm},
 *   {@link buildInstancePropGetArm}). No new side table: the #3468 bag is keyed
 *   by **eqref identity**, so `__closure_bag_lookup`/`_ensure` work on any
 *   struct instance unchanged — the same receipt `instance-tombstones.ts` cashed
 *   for #4098's tombstones.
 * - **S3/S4 — visibility.** `__carrier_bag_of` grows an instance arm
 *   (`carrier-bag-visibility.ts`), which lights up `in` / `hasOwnProperty` /
 *   gOPD for free, and `buildClosedStructEnumerationArms` appends the bag keys
 *   after the declared names for `Object.keys` / for-in / gOPN.
 *
 * ### The invariant: a declared name NEVER reaches the bag
 * This is what structurally excludes the **-684** shape that parked #4055 v1
 * (a write refused by the read lane but deposited invisibly in a bag, which a
 * later visibility widening then surfaced). Here, once S1's ladder matches a
 * name **on a receiver whose struct type it matched**, the arm **always
 * `return`s** — whether or not the value could actually be stored:
 *
 * - immutable field (`struct.set` would not even validate) ⇒ refuse. §10.1.9
 *   OrdinarySet over a non-writable own data property is a no-op anyway.
 * - unrepresentable field kind (i64 / f32 / v128 / packed) ⇒ refuse.
 * - **brand-mismatched value** into a typed-ref slot (the `ref.test` guard
 *   `fillMemberSetDispatch` also emits) ⇒ refuse. NOT a bag deposit: a bag
 *   entry under a declared name would be shadowed by the read lane's field arm,
 *   which is the -684 mechanism exactly. (That dispatcher's guard-miss falls
 *   back to `__extern_set`; from inside `__extern_set`'s own prologue that
 *   would recurse, so refusing is forced here as well as correct.)
 *
 * The refusal set is therefore a SUPERSET of the read lane's answer set for any
 * receiver that can own a bag, so the bag can never shadow a struct field and
 * `Object.keys` can never list a name twice. Every refusal is byte-equal to
 * today's behaviour (the write is dropped today too) — they only remove the
 * option of the bag catching them.
 *
 * Scalar slots are NOT guarded: the value goes through the single coercion
 * engine, so `n[k] = "abc"` into an `f64` field stores what `n.count = "abc"`
 * already stores through `__set_member_count`. Matching the literal-key
 * spelling was chosen over a narrower no-op precisely because a literal-vs-
 * computed divergence is the failure class this area keeps re-growing.
 *
 * ## Carrier set — ONE authority
 * {@link IS_INSTANCE_EXPANDO_CARRIER} is a `ref.test` chain over every
 * `ctx.structFields` entry admitted by `isUserDeclaredStruct`
 * (`user-declared-structs.ts`: class ∪ `__fnctor_` ∪ `__anon_`; builtin carriers
 * and tuples excluded by construction). That is deliberately the SAME screen
 * `collectClosedStructEnumerationEntries` uses, so write / enumerate / `in`
 * cannot drift apart — #3920's one-authority principle. It is also why the
 * #4071 `Object.keys(new Date(0))` bucket is unreachable from here: `__Date`
 * fails the whitelist, so a Date receiver gets no bag and no arm.
 *
 * `instance-tombstones.ts`'s own predicate stays **class-only** and untouched;
 * its tombstone semantics remain #4098-owned. This module widens the carrier set
 * for the expando substrate only.
 *
 * ## A query must never allocate
 * The get side is LOOKUP-only (`__closure_bag_lookup`), never `ensure` — the
 * `carrier-bag-hasown.ts` rule. `for (p in freshInstance)` allocates nothing.
 *
 * ## Bounded divergences, stated
 * - A bag entry whose value is literally `null` is indistinguishable from "no
 *   entry" through the `null = not handled` return contract this module shares
 *   with `__carrier_bag_gopd`, so `x[k] = null; x[k]` reads `undefined`. Today
 *   the write is dropped entirely, so this is strictly narrower, not new.
 * - Enumeration order is declared names first, bag keys after. That matches
 *   OrdinaryOwnPropertyKeys for the dominant ctor-fields-then-expandos
 *   lifecycle; interleaved insertion order is not reproduced.
 * - The enumeration arm returns OWN keys only and does not walk to prototype
 *   objects (faithful for acorn nodes; documented otherwise).
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { buildBagMarkerTestInstrs } from "./carrier-bag-visibility.js";
import type { CodegenContext } from "./context/types.js";
import { isSyntheticStructName } from "./emit-helpers.js";
import {
  coldFieldWriteArm,
  coldFieldNameAt,
  coldOwnFieldsFor,
  coldTailAllocatorName,
  type ColdFieldLocation,
} from "./fnctor-cold-tail.js";
import { exposedClosedStructFieldName } from "./fnctor-identity-fields.js";
import { presenceSetInstrs, presenceSlotOf, type PresenceSlot } from "./fnctor-presence-bits.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import { coercionInstrs } from "./type-coercion.js";
import { isUserDeclaredStruct } from "./user-declared-structs.js";
import { buildVecOrClosurePropSetMissArm } from "./vec-props.js";

/** `(externref v) -> i32` — 1 iff `v` is an instance of a user-declared shape. */
export const IS_INSTANCE_EXPANDO_CARRIER = "__is_instance_expando_carrier";
/** `(externref obj, externref key) -> externref` — bag value, or **null = not handled**. */
const INSTANCE_PROP_GET = "__instance_prop_get";
/** `(externref obj, externref key, externref value)` — deposit into the instance's bag. */
const INSTANCE_PROP_SET = "__instance_prop_set";
/** `(externref obj, externref key)` — drop a #4098 tombstone marker so a write can land. */
const INSTANCE_FIELD_RESURRECT = "__instance_field_resurrect";

const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";
const CLOSURE_BAG_ENSURE = "__closure_bag_ensure";

/** Abbreviated heap types (`closure-props.ts` / `object-runtime.ts` encoding). */
const I31_HEAP_TYPE = -20;

const EXT: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const ANY: ValType = { kind: "anyref" };

/**
 * Reserve the four natives as placeholder defined funcs so `__extern_get` /
 * `__extern_set`'s arms can bake a `call <idx>` long before the fill knows their
 * bodies. Append-only mint (no funcIdx shifts), idempotent, and a no-op outside
 * standalone/wasi — where the `env::__extern_*` host imports own the dynamic
 * property path and none of this is emitted.
 *
 * Every placeholder is the "nothing to add" answer, so a skipped fill degrades
 * to exactly today's behaviour instead of trapping.
 */
export function reserveInstanceProps(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  if (ctx.funcMap.get(IS_INSTANCE_EXPANDO_CARRIER) !== undefined) return;

  const reserve = (name: string, params: ValType[], results: ValType[], placeholder: Instr[]): void => {
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    const fn: WasmFunction = { name, typeIdx, locals: [], body: placeholder, exported: false };
    pushDefinedFunc(ctx, funcIdx, fn);
    ctx.funcMap.set(name, funcIdx);
  };

  reserve(IS_INSTANCE_EXPANDO_CARRIER, [EXT], [I32], [{ op: "i32.const", value: 0 }]);
  reserve(INSTANCE_PROP_GET, [EXT, EXT], [EXT], [{ op: "ref.null.extern" }]);
  reserve(INSTANCE_PROP_SET, [EXT, EXT, EXT], [], []);
  reserve(INSTANCE_FIELD_RESURRECT, [EXT, EXT], [], []);
}

/**
 * The ONE carrier authority: struct type indices of every `ctx.structFields`
 * entry `isUserDeclaredStruct` admits. Same screen as
 * `collectClosedStructEnumerationEntries`, so the write ladder, the bag, and the
 * three enumeration surfaces cannot drift apart.
 *
 * A `ref.test` over a class's struct root also matches every subclass instance
 * (subclass structs are declared as WasmGC subtypes), so the chain does not have
 * to be closed under inheritance to be complete.
 */
function instanceCarrierTypeIdxs(ctx: CodegenContext): number[] {
  const idxs: number[] = [];
  const seen = new Set<number>();
  for (const [structName] of ctx.structFields) {
    if (isSyntheticStructName(structName)) continue;
    if (!isUserDeclaredStruct(ctx, structName)) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined || seen.has(typeIdx)) continue;
    seen.add(typeIdx);
    idxs.push(typeIdx);
  }
  return idxs;
}

/**
 * `__extern_set`'s non-`$Object` arm, with the instance branch composed AROUND
 * the UNCHANGED #3537/#3468 builders (ownership boundary: this edits a call
 * site, not those modules).
 *
 * **Order.** The instance branch runs before the builtin-fn refusal that heads
 * `buildVecOrClosurePropSetMissArm`, and that is sound by CONSTRUCTION rather
 * than by coincidence: a builtin function value is a closure / builtin carrier
 * struct, and `isUserDeclaredStruct` is a WHITELIST (class ∪ `__fnctor_` ∪
 * `__anon_`) that rejects it, so `__is_instance_expando_carrier` answers 0 for
 * every receiver the §10.1.9 refusal is about. Re-emitting the refusal ahead of
 * the instance branch would state the precedence more loudly, at the cost of a
 * second `__builtinfn_get_meta` walk on every non-`$Object` write — a real cost
 * on the test262 harness's hot `obj.x = …` path, for a case the whitelist
 * already makes unreachable.
 *
 * The closure arm is TERMINAL (`call __closure_prop_set; return` for ANY
 * receiver — the helper itself screens), so the instance branch could not go
 * after it.
 */
export function buildInstanceOrVecOrClosurePropSetMissArm(ctx: CodegenContext): Instr[] {
  return [...buildInstancePropSetArm(ctx), ...buildVecOrClosurePropSetMissArm(ctx)];
}

/** `if (carrier(obj)) { __instance_prop_set(obj, key, value); return }` */
function buildInstancePropSetArm(ctx: CodegenContext): Instr[] {
  const isIdx = ctx.funcMap.get(IS_INSTANCE_EXPANDO_CARRIER);
  const setIdx = ctx.funcMap.get(INSTANCE_PROP_SET);
  if (isIdx === undefined || setIdx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: isIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: setIdx },
        { op: "return" },
      ],
    },
  ];
}

/**
 * `__extern_get`'s instance consult: `if (carrier(obj)) { v =
 * __instance_prop_get(obj, key); if (v != null) return v }`, then FALL THROUGH.
 *
 * Falling through is the whole point: the #4176 receiver-aware proto-companion
 * consult and the undefined-miss must still run, so an inherited name keeps
 * answering. Params `(0 = obj, 1 = key)`; the arm is stack-neutral and uses no
 * local, so it can be spliced into any prefix position of that body.
 *
 * ## Placement — why the head of the non-`$Object` branch, not the miss arm
 * The obvious wiring point is `buildVecOrClosurePropGetMissArm`'s two call
 * sites. That would cover class instances and MISS every fnctor instance with a
 * prototype: `__fnctor_proto_start` answers non-null for those, so control takes
 * the proto-walk and a chain-exhausted miss lands on the body's tail, never on
 * the miss arm. Acorn's `Node` is exactly such a fnctor — and since the
 * enumeration side (S3) WILL list that instance's bag keys, wiring only the miss
 * arm would enumerate a key whose read answers `undefined`. Consulting at the
 * head of the branch covers both receiver families and is additionally MORE
 * correct: an own property shadows the prototype chain (§7.3.2), and the bag
 * holds own properties.
 */
export function buildInstancePropGetArm(ctx: CodegenContext, scratchLocal: number): Instr[] {
  const isIdx = ctx.funcMap.get(IS_INSTANCE_EXPANDO_CARRIER);
  const getIdx = ctx.funcMap.get(INSTANCE_PROP_GET);
  if (isIdx === undefined || getIdx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: isIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: getIdx },
        // null = "not handled" (the `__carrier_bag_gopd` contract); any other
        // value is a live bag entry, INCLUDING the undefined singleton, which
        // must shadow the prototype chain like any own property (§7.3.2).
        { op: "local.tee", index: scratchLocal },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: scratchLocal }, { op: "return" }],
        },
      ],
    },
  ];
}

/**
 * Fill the four natives at FINALIZE, once every struct type is registered and
 * `__closure_bag_lookup` / `_ensure` / `__extern_get` / `__extern_set` /
 * `__obj_find` / `__delete_property` are in `funcMap`. funcMap-READ-ONLY, so no
 * funcIdx churn. Leaves the "nothing to add" placeholders in place when a
 * dependency is missing or the module declares no user shapes.
 */
export function fillInstanceProps(ctx: CodegenContext): void {
  const carrierIdx = ctx.funcMap.get(IS_INSTANCE_EXPANDO_CARRIER);
  if (carrierIdx === undefined) return;
  const types = ctx.objectRuntimeTypes;
  if (!types) return;
  const { objectTypeIdx, propEntryTypeIdx } = types;
  const lookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);
  const ensureIdx = ctx.funcMap.get(CLOSURE_BAG_ENSURE);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const deletePropIdx = ctx.funcMap.get("__delete_property");
  if (
    lookupIdx === undefined ||
    ensureIdx === undefined ||
    externGetIdx === undefined ||
    externSetIdx === undefined ||
    objFindIdx === undefined
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

  // ── __is_instance_expando_carrier(v) -> i32 ──────────────────────────────
  {
    const typeIdxs = instanceCarrierTypeIdxs(ctx);
    if (typeIdxs.length === 0) return; // no user shapes ⇒ leave every placeholder inert
    const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
    for (const typeIdx of typeIdxs) {
      body.push(
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
      );
    }
    body.push({ op: "i32.const", value: 0 });
    setFn(IS_INSTANCE_EXPANDO_CARRIER, [{ name: "__any", type: ANY }], body);
  }

  /** `if (!__is_instance_expando_carrier(obj)) <bail>;` */
  const requireCarrier = (bail: Instr[]): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: carrierIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: bail },
  ];

  // ── __instance_prop_set(obj, key, value) ─────────────────────────────────
  // ENSURE is legal here: this IS a write, and it is reached only after S1's
  // declared-field ladder missed, so a declared name can never be deposited.
  setFn(
    INSTANCE_PROP_SET,
    [{ name: "__bag", type: EXT }],
    [
      ...requireCarrier([{ op: "return" }]),
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: ensureIdx },
      { op: "local.tee", index: 3 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: externSetIdx },
    ],
  );

  /** `bag = __closure_bag_lookup(obj)` into `bagLocal`, screened to `$Object`. */
  const loadBagOrBail = (bagLocal: number, bail: Instr[]): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: lookupIdx },
    { op: "local.tee", index: bagLocal },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: bail },
    { op: "local.get", index: bagLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: bail },
  ];
  /** `e = __obj_find(cast<$Object>(bag), key)` into `entryLocal`. */
  const findInBag = (bagLocal: number, entryLocal: number, bail: Instr[]): Instr[] => [
    { op: "local.get", index: bagLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: objFindIdx },
    { op: "local.tee", index: entryLocal },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: bail },
  ];

  // ── __instance_prop_get(obj, key) -> externref (null = NOT HANDLED) ──────
  // LOOKUP, never ensure (`carrier-bag-hasown.ts`: a query must not allocate).
  //
  // The #4098 tombstone marker (`bag[k] === bag`) is filtered here rather than
  // screened with a separate `__instance_field_deleted` call: the two tests are
  // the same test, and folding it in saves a second walk of the bag list on the
  // read path. It ALSO widens the screen correctly — `__instance_field_deleted`
  // is class-only by design, while an `__fnctor_` instance can carry a marker.
  {
    const bail: Instr[] = [{ op: "ref.null.extern" }, { op: "return" }];
    setFn(
      INSTANCE_PROP_GET,
      [
        { name: "__bag", type: EXT },
        { name: "__e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
        { name: "__v", type: ANY },
      ],
      [
        ...requireCarrier(bail),
        ...loadBagOrBail(2, bail),
        ...findInBag(2, 3, bail),
        ...buildBagMarkerTestInstrs(ctx, { entryLocal: 3, bagLocal: 2, tmpAnyLocal: 4 }),
        { op: "if", blockType: { kind: "empty" }, then: bail },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: externGetIdx },
      ],
    );
  }

  // ── __instance_field_resurrect(obj, key) ─────────────────────────────────
  // `delete o.f; o.f = v` must round-trip (#4098 III2/II7). The marker is a
  // real live bag entry, so the write-through in S1 would store into the struct
  // while every reflective surface kept answering "deleted". Dropping the
  // marker first restores the round trip.
  if (deletePropIdx !== undefined) {
    const bail: Instr[] = [{ op: "return" }];
    setFn(
      INSTANCE_FIELD_RESURRECT,
      [
        { name: "__bag", type: EXT },
        { name: "__e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
        { name: "__v", type: ANY },
      ],
      [
        ...loadBagOrBail(2, bail),
        ...findInBag(2, 3, bail),
        ...buildBagMarkerTestInstrs(ctx, { entryLocal: 3, bagLocal: 2, tmpAnyLocal: 4 }),
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: bail },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: deletePropIdx },
        { op: "drop" },
      ],
    );
  }
}

/** One (struct, field) write target of the S1 ladder. */
type SetArm = {
  typeIdx: number;
  fieldIdx: number;
  fieldType: ValType;
  mutable: boolean;
  jsBoolean: boolean;
  presenceSlot?: PresenceSlot;
  shapeFieldIdx?: number;
  shapeId?: number;
  /** (#3927) Write through the hot/cold-split tail rather than a main slot. */
  cold?: ColdFieldLocation;
};

/**
 * (#4194 S1) **Declared-field WRITE-THROUGH** — the half that has to come first,
 * because there is no point enumerating a key the assignment threw away.
 *
 * Splices a prologue onto `__extern_set`:
 *
 * ```
 * if (!ref.test $Object(recv) && ref.test $AnyString(key)) {
 *   flatten key once
 *   per NAME:  __str_equals ladder
 *     per STRUCT carrying that name:  ref.test  [+ $shape guard, #2009]
 *       resurrect any #4098 tombstone, then store-or-REFUSE, then RETURN
 * }
 * ```
 *
 * A plain `$Object` write pays exactly ONE `ref.test` before the whole block is
 * skipped — the same cost shape the read side already pays (#3673 round 19,
 * `object-runtime.ts:6627`). Misses fall through to the untouched original body,
 * so this only ever converts a silently-dropped write into a real one (the #4055
 * composition rule: the existing answer runs first; new code only where today's
 * answer is "nothing happened").
 *
 * The ladder is linear over names. The #3926 hash `br_table` the read side uses
 * is the upgrade path if provider build timings regress; a write to a closed
 * struct through `any` is far rarer than the read.
 */
export function fillClosedStructExternSetArms(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.anyStrTypeIdx < 0) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_set");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const objTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (!fn || flattenIdx === undefined || equalsIdx === undefined || objTypeIdx === undefined) return;

  const resurrectIdx = ctx.funcMap.get(INSTANCE_FIELD_RESURRECT);

  // ── Collect (name → arms), screened by the ONE carrier authority ─────────
  // Stricter than the get side's screen on purpose: a dynamic write must never
  // reach a BUILTIN internal slot — `(new Date(0) as any).timestamp = 5` is an
  // expando in JS, not a mutation of the Date's `[[DateValue]]`.
  const byName = new Map<string, SetArm[]>();
  const push = (name: string, arm: SetArm): void => {
    let arms = byName.get(name);
    if (!arms) {
      arms = [];
      byName.set(name, arms);
    }
    arms.push(arm);
  };
  for (const [structName, fields] of ctx.structFields) {
    if (isSyntheticStructName(structName)) continue;
    if (!isUserDeclaredStruct(ctx, structName)) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    const shapeFieldIdx = fields.findIndex((field) => field?.name === "$shape");
    const shapeId = ctx.shapeIdByStructName.get(structName);
    const shape = shapeFieldIdx >= 0 && shapeId !== undefined ? { shapeFieldIdx, shapeId } : {};
    for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
      const field = fields[fieldIdx];
      const name = exposedClosedStructFieldName(field?.name);
      if (!field || !name) continue;
      const presenceSlot = presenceSlotOf(fields, field.name);
      push(name, {
        typeIdx,
        fieldIdx,
        fieldType: field.type,
        mutable: field.mutable === true,
        jsBoolean: field.jsBoolean === true || (field.type.kind === "i32" && field.type.boolean === true),
        ...(presenceSlot ? { presenceSlot } : {}),
        ...shape,
      });
    }
    // (#3927) Split-out fields are still own properties of the MAIN shape; a
    // write must reach the tail or the split would silently drop it — the same
    // soundness argument `fillMemberSetDispatch`'s cold arms rest on.
    for (const cold of coldOwnFieldsFor(ctx, structName)) {
      const name = coldFieldNameAt(ctx, cold);
      if (name === undefined) continue;
      push(name, {
        typeIdx,
        fieldIdx: cold.coldFieldIdx,
        fieldType: cold.fieldType,
        mutable: cold.mutable,
        jsBoolean: false,
        cold,
        ...shape,
      });
    }
  }
  if (byName.size === 0) return;

  // ── Locals (APPENDED — never renumbered, so baked indices stay valid) ────
  const anyLocal = 3 + fn.locals.length;
  const fkeyLocal = anyLocal + 1;
  const coldLocal = fkeyLocal + 1;
  fn.locals.push(
    { name: "__isp_any", type: ANY },
    { name: "__isp_fkey", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
    { name: "__isp_cold", type: ANY },
  );

  /**
   * `{ guard, coerce }` for a field kind, or `undefined` when this module
   * cannot represent the store — in which case the arm REFUSES (see the module
   * header's invariant: refusing is byte-equal to today, and it is what keeps
   * the bag from shadowing a declared field).
   *
   * The value conversion goes through the SINGLE coercion engine
   * (`coercionInstrs`, #1917/#2108), NOT a hand-rolled box/unbox matrix — the
   * same call `fillMemberSetDispatch` makes for the LITERAL-key spelling of
   * this exact write. That is deliberate beyond the gate: `n.count = v` and
   * `n[k] = v` reaching the same slot by different value recipes is precisely
   * the literal-vs-computed divergence this area keeps producing. Calling it
   * here is as safe as it is there — same finalize phase, and the union helpers
   * it needs were registered at reserve time, so its idempotent
   * `addUnionImports` is a no-op and no funcIdx churns.
   *
   * The `ref.test` guard on typed-ref fields mirrors
   * `fillMemberSetDispatch`'s `fieldNeedsRuntimeBrand` guard, with ONE forced
   * difference: that dispatcher's guard-miss falls back to `__extern_set`,
   * which from inside `__extern_set`'s own prologue would recurse. A miss here
   * therefore RETURNS — refusing, never depositing.
   */
  const storeRecipe = (arm: SetArm): { guard: Instr[]; coerce: Instr[] } | undefined => {
    const ft = arm.fieldType;
    if (ft.kind === "i64" || ft.kind === "f32" || ft.kind === "v128" || ft.kind === "i8" || ft.kind === "i16") {
      return undefined;
    }
    const coerce = coercionInstrs(ctx, EXT, ft);
    const brandTypeIdx = ft.kind === "ref" || ft.kind === "ref_null" ? ft.typeIdx : -1;
    if (brandTypeIdx < 0) return { guard: [], coerce };
    return {
      guard: [
        { op: "local.get", index: 2 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: brandTypeIdx },
        ...(ft.kind === "ref_null"
          ? ([{ op: "local.get", index: 2 }, { op: "ref.is_null" }, { op: "i32.or" }] satisfies Instr[])
          : []),
      ],
      coerce,
    };
  };

  /**
   * The matched arm's body. It ALWAYS ends in `return`: see the module header's
   * invariant — a declared name must never fall through to the expando bag,
   * whether the store happened, was refused for immutability, or was refused
   * because the value's type does not fit the slot.
   */
  const buildStore = (arm: SetArm): Instr[] => {
    const recipe = arm.mutable ? storeRecipe(arm) : undefined;
    if (!recipe) return [{ op: "return" }];

    let store: Instr[];
    if (arm.cold !== undefined) {
      const mainStructName = ctx.typeIdxToStructName.get(arm.cold.mainStructTypeIdx);
      const ensureIdx =
        mainStructName === undefined ? undefined : ctx.funcMap.get(coldTailAllocatorName(mainStructName));
      if (ensureIdx === undefined) return [{ op: "return" }];
      store = coldFieldWriteArm(arm.cold, anyLocal, 2, coldLocal, ensureIdx, recipe.coerce);
    } else {
      store = [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: arm.typeIdx },
        { op: "local.get", index: 2 },
        ...recipe.coerce,
        { op: "struct.set", typeIdx: arm.typeIdx, fieldIdx: arm.fieldIdx },
      ];
      // A write makes a conditionally-assigned field LIVE — symmetric with the
      // read side's presence test, and with `fillMemberSetDispatch`'s own
      // `presenceSetInstrs` call. Without it the value is stored but every
      // reflective surface keeps answering "absent".
      if (arm.presenceSlot !== undefined) {
        store.push(
          ...presenceSetInstrs(arm.typeIdx, arm.presenceSlot, [
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: arm.typeIdx },
          ]),
        );
      }
    }

    const guarded: Instr[] =
      recipe.guard.length === 0 ? store : [...recipe.guard, { op: "if", blockType: { kind: "empty" }, then: store }];
    return [...guarded, { op: "return" }];
  };

  // ── Per-name ladder over per-struct receiver arms ────────────────────────
  const keyArms: Instr[] = [];
  for (const [name, arms] of byName) {
    const receiverArms: Instr[] = [];
    for (const arm of arms) {
      const store = buildStore(arm);
      const exactThen: Instr[] =
        arm.shapeFieldIdx === undefined || arm.shapeId === undefined
          ? store
          : [
              // (#2009) `ref.test` matched, but same-shape canonicalization means
              // this could be a DIFFERENT struct lacking the field. A mismatch
              // falls through to the next arm rather than corrupting a same-slot
              // field of the wrong struct.
              { op: "local.get", index: anyLocal },
              { op: "ref.cast", typeIdx: arm.typeIdx },
              { op: "struct.get", typeIdx: arm.typeIdx, fieldIdx: arm.shapeFieldIdx },
              { op: "i32.const", value: arm.shapeId },
              { op: "i32.eq" },
              { op: "if", blockType: { kind: "empty" }, then: store },
            ];
      receiverArms.push(
        { op: "local.get", index: anyLocal },
        { op: "ref.test", typeIdx: arm.typeIdx },
        { op: "if", blockType: { kind: "empty" }, then: exactThen },
      );
    }
    keyArms.push(
      { op: "local.get", index: fkeyLocal },
      { op: "ref.as_non_null" },
      ...nativeStringLiteralInstrs(ctx, name),
      { op: "call", funcIdx: equalsIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // Resurrect a #4098 tombstone for THIS key before any arm stores. It
          // is emitted per NAME rather than per receiver arm: the helper is a
          // no-op unless a marker exists for this exact (obj, key), and hoisting
          // it also covers the shape-mismatch fall-through into the bag.
          ...(resurrectIdx === undefined
            ? []
            : ([
                { op: "local.get", index: 0 },
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: resurrectIdx },
              ] satisfies Instr[])),
          ...receiverArms,
        ],
      },
    );
  }

  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyLocal },
    { op: "ref.test", typeIdx: objTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
            { op: "call", funcIdx: flattenIdx },
            { op: "local.set", index: fkeyLocal },
            ...keyArms,
          ],
        },
      ],
    },
  );
}
