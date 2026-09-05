// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4562) Materialise a function's intrinsic `length` / `name` as a real
 * property record before the first `Object.defineProperty` over it merges.
 *
 * ## The defect
 *
 * A function's `length` and `name` are not bag entries. `length` is read off
 * the closure's `$arity` header slot / the per-declaration `$__fn_instance_meta`
 * struct (#4436, #4437), and a builtin's off its #2896 meta subtype. Every
 * reflective surface funnels through `__builtinfn_get_meta`, which SYNTHESISES
 * the descriptor — `__builtinfn_gopd` pairs the value with `FLAG_CONFIGURABLE`,
 * i.e. §10.2.4's `{writable:false, enumerable:false, configurable:true}`.
 *
 * The define appliers do not go through that surface. They substitute the
 * carrier's own-property bag for the receiver and run §10.1.6.3 against it —
 * and the bag holds no entry for `length`, so `current` is **undefined** and the
 * merge builds a fresh record out of the partial descriptor alone. Measured on
 * the branch point, `--target standalone`:
 *
 * ```js
 * function fn(a) {}
 * Object.getOwnPropertyDescriptor(fn, "length");   // 1/--C   correct
 * Object.defineProperty(fn, "length", { value: 7 });
 * Object.getOwnPropertyDescriptor(fn, "length");   // 7/---   configurable LOST
 *
 * function g(a, b) {}
 * Object.defineProperty(g, "length", { configurable: false });
 * g.length;                                        // undefined — want 2
 * ```
 *
 * The second shape is the sharp one: with `value` omitted there is nothing to
 * rebuild the record from, so the VALUE itself is destroyed. A **custom**
 * property on the same function merges correctly (`2/WEC`), which is what
 * isolates the cause to the missing record rather than to the merge.
 *
 * ## The fix, and why it is not a representation change
 *
 * The merge is proven correct — nine descriptor shapes re-measured under #4562,
 * standalone and js-host identical on every one, and
 * `built-ins/Object/defineProperty` sits at 1066/1131. What it lacks is an
 * INPUT. So this seeds one: on the first define over an intrinsic key, insert
 * `{value: <meta>, writable:false, enumerable:false, configurable:true}` into
 * the bag and let the existing merge run against it. Nothing about how `length`
 * is stored changes; the intrinsic simply stops being invisible to §10.1.6.3.
 *
 * ## Two guards, each load-bearing
 *
 *  - **Seed only when the bag holds NO entry for the key.**
 *    `__builtinfn_get_meta`'s generic closure arm already declines once the bag
 *    owns the key (#4436's marker-INCLUSIVE presence test), so for a user
 *    closure the null test alone would do. A #2896 BUILTIN meta arm does not
 *    consult the bag — it answers from the static subtype unconditionally — so
 *    without `__fninst_bag_owns` the seed would re-fire on every subsequent
 *    define and overwrite the merged record with the intrinsic each time,
 *    turning a two-step define into a silent revert.
 *  - **Seed only when `get_meta` answers.** It is gated to the keys `"name"`
 *    and `"length"` and returns null for a DELETED one (the per-instance
 *    deleted bits / the #4098 bag tombstone). Null means the own property is
 *    genuinely absent, and §10.1.6.3 with `current` undefined is then the
 *    RIGHT answer — a fresh define after `delete fn.length` must not resurrect
 *    the old attributes.
 *
 * `get_meta` is called twice rather than teed into a scratch local: it is pure,
 * it runs only on the define path for a function receiver, and a local would
 * mean widening the fixed local layout of both appliers that host this arm.
 *
 * Standalone only. In JS-host mode `__defineProperty_value` is the host import
 * and the receiver never reaches a carrier bag; the host lane starts from a
 * different and worse place (`gOPD(fn, "length")` is `undefined` outright) and
 * needs its own fix.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { FNINST_BAG_OWNS } from "./function-instance-props.js";

/** `(externref recv, externref bag, externref key) -> ()` */
const FNINST_SEED = "__fninst_seed_intrinsic";

const EXT: ValType = { kind: "externref" };

/**
 * The host descriptor-flag encoding `__defineProperty_value` decodes, spelling
 * `{value: <meta>, writable:false, enumerable:false, configurable:true}` with
 * every attribute EXPLICITLY specified: value bit 2 (configurable true) +
 * specified bits 3/4/5 + has-value bit 7. The specified bits matter — an
 * unspecified attribute takes CompletePropertyDescriptor's `false` default,
 * which is right for W and E by accident and WRONG for C.
 */
const SEED_FLAGS = (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 7); // 0xBC

/**
 * `[] -> []` — seed the intrinsic record for `key` into the carrier bag.
 *
 * ## Why this is a reserved native and not inline instructions
 *
 * The seed's final act is a `__defineProperty_value` on the BAG — a plain
 * `$Object`, so the recursion bottoms out immediately and the proven §10.1.6.3
 * insert does the storing (seq bookkeeping, load-factor grow, the S4
 * preflight). But this arm is emitted while `__defineProperty_value`'s OWN body
 * is being built, and `registerNative` publishes its funcMap entry only
 * afterwards — measured: `defineIdx` is `undefined` on the first of the two
 * callers and defined on the second. So the call is baked against a RESERVED
 * index and the body filled at finalize, the same reserve/fill discipline
 * `reserveVecOverlayHelpers` and `reserveFunctionInstanceProps` use. Minting is
 * append-only, so reserving lazily here shifts nothing.
 *
 * `bagLocalIdx` must already hold the ENSURED bag (non-null). Returns an empty
 * sequence when the substrate is absent, which leaves exactly today's
 * behaviour rather than trapping.
 */
export function fnIntrinsicSeedInstrs(
  ctx: CodegenContext,
  recvLocalIdx: number,
  bagLocalIdx: number,
  keyLocalIdx: number,
): Instr[] {
  if (!ctx.standalone) return [];
  if (ctx.funcMap.get(FNINST_BAG_OWNS) === undefined) return [];
  if (ctx.funcMap.get("__builtinfn_get_meta") === undefined) return [];
  let seedIdx = ctx.funcMap.get(FNINST_SEED);
  if (seedIdx === undefined) {
    const typeIdx = addFuncType(ctx, [EXT, EXT, EXT], [], `$${FNINST_SEED}_type`);
    seedIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, seedIdx, { name: FNINST_SEED, typeIdx, locals: [], body: [], exported: false });
    ctx.funcMap.set(FNINST_SEED, seedIdx);
  }
  return [
    { op: "local.get", index: recvLocalIdx },
    { op: "local.get", index: bagLocalIdx },
    { op: "local.get", index: keyLocalIdx },
    { op: "call", funcIdx: seedIdx },
  ];
}

/**
 * Fill the reserved seed native. Called from the TAIL of
 * `fillFunctionInstanceProps`, which is load-bearing twice over: by then
 * `__defineProperty_value` is registered, and reaching that call site is itself
 * the proof that `__fninst_bag_owns` got a real body rather than keeping its
 * reserve-time constant-`0` placeholder. That matters for correctness, not just
 * for effect — a placeholder answers "the bag never owns this key", which is
 * exactly the condition under which the seed would re-fire on every define and
 * overwrite the merged record. A missing dependency leaves the empty
 * placeholder body, so a skipped fill degrades to exactly today's behaviour.
 *
 * ## Two guards, each load-bearing
 *
 *  - **Seed only when the bag holds NO entry for the key.**
 *    `__builtinfn_get_meta`'s generic closure arm already declines once the bag
 *    owns the key (#4436's marker-INCLUSIVE presence test), so for a user
 *    closure the null test alone would do. A #2896 BUILTIN meta arm does not
 *    consult the bag — it answers from the static subtype unconditionally — so
 *    without `__fninst_bag_owns` the seed would re-fire on every subsequent
 *    define and overwrite the merged record with the intrinsic each time,
 *    turning a two-step define into a silent revert.
 *  - **Seed only when `get_meta` answers.** It is gated to the keys `"name"`
 *    and `"length"` and returns null for a DELETED one (the per-instance
 *    deleted bits / the #4098 bag tombstone). Null means the own property is
 *    genuinely absent, and §10.1.6.3 with `current` undefined is then the
 *    RIGHT answer — a fresh define after `delete fn.length` must not resurrect
 *    the old attributes.
 *
 * `get_meta` is called twice rather than teed into a scratch local: it is pure
 * and runs only on the define path for a function receiver.
 */
export function fillFnIntrinsicSeed(ctx: CodegenContext): void {
  const seedIdx = ctx.funcMap.get(FNINST_SEED);
  if (seedIdx === undefined) return;
  const fn = definedFuncAt(ctx, seedIdx);
  if (!fn) return;
  const bagOwnsIdx = ctx.funcMap.get(FNINST_BAG_OWNS);
  const getMetaIdx = ctx.funcMap.get("__builtinfn_get_meta");
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (bagOwnsIdx === undefined || getMetaIdx === undefined || defineIdx === undefined) return;

  const metaValue: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: getMetaIdx },
  ];
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: bagOwnsIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...metaValue,
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // bag[key] = {value: <meta>, writable:F, enumerable:F, configurable:T}
            { op: "local.get", index: 1 },
            { op: "local.get", index: 2 },
            ...metaValue,
            { op: "f64.const", value: SEED_FLAGS },
            { op: "call", funcIdx: defineIdx },
            { op: "drop" },
          ],
        },
      ],
    },
  ];
}
