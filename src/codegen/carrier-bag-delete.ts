// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4010 S2) `__carrier_bag_delete(obj, key)` — OrdinaryDelete over the
 * own-property side table of a **non-`$Object` receiver**, and the non-`$Object`
 * arms of `__delete_property` that reach it.
 *
 * ## The defect this closes
 * `__delete_property`'s non-`$Object` arm returned **1 (success) without
 * deleting anything**. That is the worst shape a gate can have: a loud claim of
 * success covering a silent wrong answer. Measured on current main, standalone:
 *
 * ```js
 * const a = [1,2,3]; a.q = 12; delete a.q;   // returns TRUE
 * a.q                                        // => 12   (STILL PRESENT)
 *
 * function f(){}  f.p = 12;  delete f.p;     // returns TRUE
 * f.p                                        // => 12   (STILL PRESENT)
 * ```
 *
 * Both values live in a per-receiver `$Object` **bag** — `vec-props.ts` (#3537)
 * for arrays, `closure-props.ts` (#3468) for functions — that the delete native
 * had never heard of. Because the bag IS an ordinary `$Object`, the whole of
 * OrdinaryDelete (§10.1.10: configurability preflight, `FLAG_TOMBSTONE`,
 * count/tombstone bookkeeping) is already implemented for it — this native only
 * has to find the right bag and delegate. No delete semantics are re-implemented
 * here, which is why a non-configurable bag entry still refuses correctly.
 *
 * ## Tri-state, because a detector must be able to say "I don't know"
 * The result is deliberately **-1 / 0 / 1**, not a boolean:
 *
 * | result | meaning                       | caller does            |
 * | ------ | ----------------------------- | ---------------------- |
 * | `-1`   | no bag, or the bag does not hold this key — **NOT HANDLED** | fall through, unchanged |
 * | `0`    | the bag holds it and refused (non-configurable)              | `return 0`              |
 * | `1`    | deleted                                                      | `return 1`              |
 *
 * Collapsing `-1` into `1` would make "I could not see anything" indistinguishable
 * from "there was nothing", which is exactly the defect above. It is also what
 * makes the change **strictly additive**: the arm fires only for a key the bag
 * demonstrably holds, so every receiver/key the old code answered for keeps its
 * answer bit-for-bit. In particular `delete fn.name` / `delete fn.length` on a
 * builtin stays with the #2896 `__builtinfn_delete` arm, which runs FIRST and
 * returns — this native is never consulted for it. That matters: the
 * `built-ins/**\/{name,length}.js` stratum is the ~700-file population whose
 * regression cost #4055 v1 **-684** host-free passes, and it is untouched here.
 *
 * ## Scope: delete only (#4010's ordering law)
 * > Own-property VISIBILITY cannot ship before own-property DELETABILITY.
 *
 * S1' fixed the value clobber; this is S2. **No visibility surface moves**:
 * `__hasOwnProperty` / `__object_hasOwn` / `__vec_gopd` / `Object.keys` reach is
 * byte-identical, pinned by the SCOPE PIN cases in `tests/issue-4010.test.ts`.
 * Widening those is S3 and is gated on running the `{name,length}.js` stratum
 * explicitly first.
 *
 * ## LOOKUP, never ENSURE
 * Same rule as `carrier-bag-hasown.ts`: deleting a key a receiver never had must
 * not allocate a bag for it and hand a later `__integrity_bag` consumer a
 * carrier that previously had none.
 *
 * ## Byte-neutrality
 * Reserved only when a carrier predicate exists (standalone/wasi — in gc/host
 * mode the `env::__extern_*` imports own the dynamic-property path), and the
 * placeholder body is `i32.const -1` ("not handled"), so a skipped fill degrades
 * to exactly today's behaviour instead of trapping.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { buildInstanceTombstoneDeleteArm } from "./instance-tombstones.js"; // (#4098 G1 s1)
import { addFuncType } from "./registry/types.js";

/** The tri-state carrier-bag delete native minted here. */
export const CARRIER_BAG_DELETE = "__carrier_bag_delete";

/** #3468 closure-own-property side table (`closure-props.ts`). */
const IS_CLOSURE_PROP_CARRIER = "__is_closure_prop_carrier";
const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";
/** #3537 array-expando side table (`vec-props.ts`). */
const IS_VEC_PROP_CARRIER = "__is_vec_prop_carrier";
const VEC_BAG_LOOKUP = "__vec_bag_lookup";
/** (#4098) Native `$Error_struct.$props` carrier (`error-props.ts`). */
const IS_ERROR_PROP_CARRIER = "__is_error_prop_carrier";
const ERROR_PROP_BAG_LOOKUP = "__error_prop_bag_lookup";

/** Sole local of `__carrier_bag_delete` (params are 0=obj, 1=key). */
const BAG = 2;

/**
 * Reserve `__carrier_bag_delete(externref, externref) -> i32` as an
 * `i32.const -1` placeholder, so `__delete_property`'s arms can bake a
 * `call <idx>` before `fillCarrierBagDelete` knows `__delete_property`'s own
 * index. Append-only mint (no funcIdx shifts), idempotent, and a no-op unless a
 * carrier substrate was reserved. Returns the funcIdx, or `undefined`.
 */
export function reserveCarrierBagDelete(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(CARRIER_BAG_DELETE);
  if (existing !== undefined) return existing;
  const hasCarrier =
    ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER) !== undefined ||
    ctx.funcMap.get(IS_VEC_PROP_CARRIER) !== undefined ||
    ctx.funcMap.get(IS_ERROR_PROP_CARRIER) !== undefined;
  if (!hasCarrier) return undefined;

  const externref = { kind: "externref" } as const;
  const typeIdx = addFuncType(ctx, [externref, externref], [{ kind: "i32" }], `$${CARRIER_BAG_DELETE}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: CARRIER_BAG_DELETE,
    typeIdx,
    locals: [{ name: "bag", type: externref }],
    // Safe no-op: "not handled" ⇒ every caller keeps its pre-#4010 answer.
    body: [{ op: "i32.const", value: -1 }],
    exported: false,
  });
  ctx.funcMap.set(CARRIER_BAG_DELETE, funcIdx);
  return funcIdx;
}

/**
 * The non-`$Object` head of `__delete_property`'s body, in emission order:
 *
 * 1. the #2896 builtin-fn metadata arm (`delete fn.name` / `delete fn.length`) —
 *    UNCHANGED, and deliberately first, so the `{name,length}.js` stratum never
 *    reaches the bag arm;
 * 2. `if (!(obj is $Object))` → consult the carrier bag; only a definite answer
 *    (`>= 0`) returns, otherwise the historical `return 1` no-op success.
 *
 * `resultLocal` must be an i32 local of the enclosing native.
 */
export function buildNonObjectDeleteArms(
  ctx: CodegenContext,
  args: {
    bfnDeleteIdx: number | undefined;
    boundaryDeleteIdx?: number;
    objectTypeIdx: number;
    anyLocal: number;
    resultLocal: number;
  },
): Instr[] {
  const cbdIdx = ctx.funcMap.get(CARRIER_BAG_DELETE);
  const bagArm: Instr[] =
    cbdIdx === undefined
      ? []
      : [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: cbdIdx },
          { op: "local.tee", index: args.resultLocal },
          { op: "i32.const", value: 0 },
          { op: "i32.ge_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: args.resultLocal }, { op: "return" }],
          },
        ];
  const boundaryArm: Instr[] =
    args.boundaryDeleteIdx === undefined
      ? []
      : [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: args.boundaryDeleteIdx },
          { op: "local.tee", index: args.resultLocal },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: args.resultLocal },
              { op: "i32.const", value: 2 },
              { op: "i32.eq" },
              { op: "return" },
            ],
          },
        ];
  return [
    ...(args.bfnDeleteIdx !== undefined
      ? ([
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: args.bfnDeleteIdx },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: args.anyLocal },
    { op: "ref.test", typeIdx: args.objectTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      // (#4098 G1 s1) The instance-tombstone arm goes LAST, for the same reason
      // the bag arm is second: every receiver/key an earlier arm answers for
      // keeps its answer bit-for-bit. `delete fn.name`/`fn.length` on a builtin
      // stays with `__builtinfn_delete` and never reaches here — that stratum is
      // the ~700 files whose regression cost #4055 v1 its -684.
      then: [
        ...boundaryArm,
        ...bagArm,
        ...buildInstanceTombstoneDeleteArm(ctx),
        { op: "i32.const", value: 1 },
        { op: "return" },
      ],
    },
  ];
}

/**
 * Fill `__carrier_bag_delete` at FINALIZE, once `__delete_property` /
 * `__obj_find` and the carrier substrates are in `funcMap`:
 *
 * ```
 * bag = closure-carrier ? __closure_bag_lookup(obj)
 *     : vec-carrier     ? __vec_bag_lookup(obj)
 *     : null;                                  // LOOKUP, never ensure
 * if (bag == null || !(bag is $Object)) return -1;
 * if (__obj_find(bag, key) == null) return -1; // the bag does not hold it
 * return __delete_property(bag, key);          // §10.1.10, already correct
 * ```
 *
 * Leaves the `-1` placeholder in place when any dependency is missing.
 */
export function fillCarrierBagDelete(ctx: CodegenContext): void {
  const cbdIdx = ctx.funcMap.get(CARRIER_BAG_DELETE);
  if (cbdIdx === undefined) return;
  const fn = definedFuncAt(ctx, cbdIdx);
  if (!fn) return;
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const deleteIdx = ctx.funcMap.get("__delete_property");
  if (objectTypeIdx === undefined || objFindIdx === undefined || deleteIdx === undefined) return;

  /** `if (<carrier predicate>) bag = <lookup>(obj);` guarded on bag still being null. */
  const lookupArm = (isIdx: number | undefined, lookupIdx: number | undefined): Instr[] =>
    isIdx === undefined || lookupIdx === undefined
      ? []
      : [
          { op: "local.get", index: BAG },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: isIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "call", funcIdx: lookupIdx },
                  { op: "local.set", index: BAG },
                ],
              },
            ],
          },
        ];

  const closureArm = lookupArm(ctx.funcMap.get(IS_CLOSURE_PROP_CARRIER), ctx.funcMap.get(CLOSURE_BAG_LOOKUP));
  const vecArm = lookupArm(ctx.funcMap.get(IS_VEC_PROP_CARRIER), ctx.funcMap.get(VEC_BAG_LOOKUP));
  const errorArm = lookupArm(ctx.funcMap.get(IS_ERROR_PROP_CARRIER), ctx.funcMap.get(ERROR_PROP_BAG_LOOKUP));
  if (closureArm.length === 0 && vecArm.length === 0 && errorArm.length === 0) return;

  const notHandled: Instr[] = [{ op: "i32.const", value: -1 }, { op: "return" }];
  fn.body = [
    ...closureArm,
    ...vecArm,
    ...errorArm,
    { op: "local.get", index: BAG },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: notHandled.map((i) => ({ ...i })) },
    // The `ref.test` is not decoration: a bag is a `__new_plain_object` product
    // today, but a bare `ref.cast` would turn any future substrate change into a
    // trap inside a helper that must never throw (#3468 S1 discipline).
    { op: "local.get", index: BAG },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: notHandled.map((i) => ({ ...i })) },
    // Presence in the bag is what makes this arm additive — see the tri-state
    // table above. `__obj_find` already skips tombstoned entries, so a key
    // deleted twice reports "not handled" and the caller's `return 1` (delete of
    // an absent own property succeeds, §10.1.10 step 2) stands.
    { op: "local.get", index: BAG },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: objFindIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: notHandled.map((i) => ({ ...i })) },
    { op: "local.get", index: BAG },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: deleteIdx },
  ];
}
