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
import { exposedClosedStructFieldName } from "./fnctor-identity-fields.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import { isUserDeclaredStruct } from "./user-declared-structs.js";
import { buildVecOrClosurePropSetMissArm } from "./vec-props.js";

/** `(externref v) -> i32` — 1 iff `v` is an instance of a user-declared shape. */
export const IS_INSTANCE_EXPANDO_CARRIER = "__is_instance_expando_carrier";
/** `(externref obj, externref key) -> externref` — bag value, or **null = not handled**. */
const INSTANCE_PROP_GET = "__instance_prop_get";
/** `(externref obj, externref key, externref value)` — deposit into the instance's bag. */
const INSTANCE_PROP_SET = "__instance_prop_set";
/** `(externref obj, externref key)` — drop a #4098 tombstone marker so a write can land. */
export const INSTANCE_FIELD_RESURRECT = "__instance_field_resurrect";

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
  // This helper predates #4504 and is part of the established standalone/WASI
  // function space even when the inherited-set resolver is inactive.
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
  const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
  const createDescriptorIdx = ctx.funcMap.get("__create_descriptor");
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const deletePropIdx = ctx.funcMap.get("__delete_property");
  const setDecideIdx = ctx.funcMap.get("__extern_set_decide");
  const setOwnIdx = ctx.funcMap.get("__extern_set_own");
  const setResultGlobalIdx = ctx.externSetResultGlobalIdx;
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

  // A Proxy trap receives its target through the dynamic externref ABI. When
  // that target is a compiler-owned closed struct, the ordinary call-site
  // fast path for Object.getOwnPropertyDescriptor no longer knows its nominal
  // shape; the generic descriptor helper used to treat it like a primitive and
  // return undefined. Reuse the completed closed-struct hasOwn/get ladders to
  // synthesize the ordinary default data descriptor without copying or opening
  // the target. The functions are filled later in finalization, but their
  // reserved indices are already stable here.
  //
  // Closed physical fields on this substrate are ordinary W/E/C data
  // properties. Reflagged descriptors are widened to the open-object runtime,
  // so they do not reach this arm. The hasOwn predicate also screens presence
  // bits and deletion tombstones before the value read.
  if (hasOwnIdx !== undefined && createDescriptorIdx !== undefined && externGetIdx !== undefined) {
    const gopdIdx = ctx.funcMap.get("__getOwnPropertyDescriptor");
    const gopdFn = gopdIdx === undefined ? undefined : definedFuncAt(ctx, gopdIdx);
    if (gopdFn) {
      gopdFn.body.unshift(
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: carrierIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: hasOwnIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: externGetIdx },
                { op: "i32.const", value: 0x07 },
                { op: "call", funcIdx: createDescriptorIdx },
                { op: "return" },
              ],
            },
          ],
        },
      );
    }
  }

  /** `if (!__is_instance_expando_carrier(obj)) <bail>;` */
  const requireCarrier = (bail: Instr[]): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: carrierIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: bail },
  ];

  // ── __instance_prop_set(obj, key, value) ─────────────────────────────────
  // S1's declared-field ladder already missed.  Query the existing bag before
  // deciding inherited descriptors; only a MISS/ALLOW can ensure and write an
  // own bag entry.
  const sharedSetAvailable = setDecideIdx !== undefined && setOwnIdx !== undefined && setResultGlobalIdx !== undefined;
  setFn(
    INSTANCE_PROP_SET,
    sharedSetAvailable
      ? [
          { name: "__bag", type: EXT },
          { name: "__decision", type: I32 },
        ]
      : [{ name: "__bag", type: EXT }],
    sharedSetAvailable
      ? [
          ...requireCarrier([{ op: "return" }]),
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: lookupIdx },
          { op: "local.set", index: 3 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: setDecideIdx! },
          { op: "local.tee", index: 4 },
          { op: "i32.const", value: 2 }, // SET_DECISION_HANDLED
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 1 }, { op: "global.set", index: setResultGlobalIdx! }, { op: "return" }],
          },
          { op: "local.get", index: 4 },
          { op: "i32.const", value: 3 }, // SET_DECISION_REFUSED
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 2 }, { op: "global.set", index: setResultGlobalIdx! }, { op: "return" }],
          },
          { op: "local.get", index: 3 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: ensureIdx },
              { op: "local.set", index: 3 },
            ],
          },
          { op: "local.get", index: 3 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            // A missing side-bag allocation is an unadmitted
            // representation boundary, not an OrdinarySet refusal.
            then: [{ op: "return" }],
          },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: setOwnIdx! },
          { op: "global.set", index: setResultGlobalIdx! },
        ]
      : [
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
