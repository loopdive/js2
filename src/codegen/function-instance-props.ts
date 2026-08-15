// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4436) `length` as a genuine OWN property of a **user function instance**
 * under `--target standalone`.
 *
 * ## What was missing
 * #2896 gave *builtin* function values reflective `name`/`length` by minting a
 * per-(builtin, member) meta SUBTYPE and answering from
 * `ctx.builtinFnMetaByTypeIdx`. A **user** closure gets no meta subtype, so
 * every reflective surface saw nothing (measured on `main` 2026-08-15,
 * `--target standalone`):
 *
 * | read on `function f(a,b){}`                      | before | spec |
 * | ------------------------------------------------ | ------ | ---- |
 * | `f.length` (STATIC fold, typed receiver)         | 2      | 2    |
 * | `f["length"]` (DYNAMIC key — `verifyProperty`)   | **0**  | 2    |
 * | `f.hasOwnProperty("length")`                     | false  | true |
 * | `Object.getOwnPropertyDescriptor(f,"length")`    | undef  | desc |
 * | `Object.getOwnPropertyNames(f)` ∋ `"length"`     | false  | true |
 *
 * The dynamic read's `0` is not an accident: `dyn-read.ts`'s closure arm
 * deliberately returned a flat `box_number(0)` for any closure
 * `__builtinfn_get_meta` declined ("arity not statically tracked"). It IS
 * tracked — every struct in the funcref-wrapper hierarchy carries the closure's
 * declared formal count in the `$arity` header slot (#3673). This module reads
 * it.
 *
 * ## Mechanism — one generic arm, six surfaces
 * Rather than a new reflective path, this appends a **generic closure arm** to
 * the three #2896 helpers that every reflective surface already funnels
 * through. Adding it there means `hasOwnProperty`, `getOwnPropertyDescriptor`,
 * `getOwnPropertyNames`, `delete`, the non-writable `__extern_set` refusal
 * (`buildBuiltinFnSetRefusalArm`) and the dynamic `fn[key]` read all move
 * together, and cannot disagree with each other:
 *
 * ```
 * __builtinfn_get_meta(fn, "length")  → box_number($arity)   (the descriptor VALUE)
 * __builtinfn_delete(fn, "length")    → bag tombstone, 1     (configurable: true)
 * __builtinfn_push_ownnames(fn, vec)  → push "length"        (getOwnPropertyNames)
 * ```
 *
 * `__builtinfn_gopd` derives its descriptor from `get_meta` with
 * `FLAG_CONFIGURABLE`, i.e. `{writable:false, enumerable:false,
 * configurable:true}` — exactly §10.2.4 for a function's `length`. So the
 * descriptor is right by construction, not by a second spelling of the flags.
 *
 * ## Ordering — the builtin arms MUST win
 * `fillFunctionInstanceProps` runs **before** `fillBuiltinFnMeta`, and both
 * splice at body index 0, so the builtin arms end up in FRONT of the generic
 * one. That is required, not incidental: a builtin meta struct is itself a
 * descendant of the funcref-wrapper root, so the generic `ref.test` matches it
 * too. The builtin arm always `return`s (including the deleted case, where it
 * returns null explicitly), so the generic arm is unreachable for any receiver
 * #2896 owns and builtin metadata is never shadowed by a raw `$arity`.
 *
 * ## Deletability before visibility — the #4010 ordering law
 * #4010 records it as a law, with a receipt: #4055 v1 widened `hasOwnProperty`
 * over a side table without a working `delete` underneath and the merge queue
 * parked it for **-684** host-free passes. `propertyHelper.js`'s
 * `isConfigurable` is `delete obj[name]; return !hasOwnProperty(obj, name)`, so
 * a visible-but-undeletable `length` fails every `verifyProperty` that names
 * `configurable: true` — which is all of them. This module therefore ships the
 * delete arm in the same change as the visibility arm.
 *
 * The tombstone is #4098's **self-referential bag entry** (`bag[k] === bag`),
 * reused rather than reinvented: the closure `$bag` is keyed by `eqref`
 * identity, the marker is unforgeable (a bag is unreachable from user source),
 * and #4194 already filters it out of `gOPD` / `Object.keys` / for-in through
 * `buildBagMarkerTestInstrs`. Reusing it means `delete f.length` cannot leak a
 * phantom own property into enumeration.
 *
 * ## Why presence is checked MARKER-INCLUSIVE
 * The generic arm answers only while the bag holds **no** entry for the key —
 * `__fninst_bag_owns` deliberately does NOT filter the tombstone, unlike
 * `__carrier_bag_has`. That one predicate covers both post-`delete` states in
 * the same shape:
 *
 * - after `delete f.length` the bag holds the marker ⇒ `get_meta` declines ⇒
 *   `hasOwnProperty` is false (the bag surfaces filter the marker);
 * - after a subsequent `f.length = 5` the marker is overwritten with `5` ⇒
 *   `get_meta` still declines ⇒ the bag's own value answers, so the resurrected
 *   property is not shadowed by `$arity`.
 *
 * Filtering the marker here would make the first case answer `$arity` again and
 * silently un-delete the property.
 *
 * ## Scope — `length` only, and why `name` is NOT here
 * `$arity` is a per-INSTANCE field, so `length` needs no per-function type.
 * `name` has no runtime carrier on a user closure and cannot be added without
 * either a new header field (which changes gc-mode bytes — #2896's standing
 * constraint) or a per-function meta subtype. Left as a measured residual on
 * the issue rather than half-answered here.
 *
 * ## Known value divergence (documented, not hidden)
 * `$arity` is the **declared formal count**, which equals §15.1.5
 * ExpectedArgumentCount for every parameter list without a defaulted or
 * optional parameter (rest is already excluded at the allocation site, which
 * pushes `max(0, params - 1)`). For `function f(x = 42) {}` the spec `length`
 * is 0 while `$arity` is 1. `$arity` cannot simply be re-pointed at the spec
 * value: `closure-exports.ts`'s under-application widening dispatches at
 * `max(n, $arity)` and would stop padding omitted arguments. The exact-value
 * fix needs the per-function meta subtype above; it is tracked as this issue's
 * residual.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { CLOSURE_ARITY_FIELD_IDX, getFuncRefWrapperRootTypeIdx } from "./closures/funcref-wrapper-types.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";

/** `(externref fn, externref key) -> i32` — 1 iff fn's bag holds ANY entry for key. */
export const FNINST_BAG_OWNS = "__fninst_bag_owns";
/** `(externref fn, externref key) -> i32` — 1 iff the #4098 marker was written. */
export const FNINST_TOMBSTONE = "__fninst_tombstone";

const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";
const CLOSURE_BAG_ENSURE = "__closure_bag_ensure";

const EXT: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/**
 * `{writable:false, enumerable:false, configurable:true}` — §10.2.4, the
 * attribute set of a function object's `length`. Same literal
 * `object-runtime.ts` uses for the #2896 builtin descriptors, so the two paths
 * cannot drift apart in what they claim about the same property.
 */
const FLAG_CONFIGURABLE = 0x04;

/**
 * Reserve the two natives as placeholder defined funcs so the spliced arms can
 * bake a `call <idx>` before the fill knows their bodies. Append-only mint (no
 * funcIdx shifts), idempotent, and a no-op outside standalone — in gc/host mode
 * the `env::__extern_*` imports own the dynamic-property path and registering
 * these would only shift `funcMap` indices.
 */
export function reserveFunctionInstanceProps(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  if (ctx.funcMap.get(FNINST_BAG_OWNS) !== undefined) return;

  const reserve = (name: string): void => {
    const typeIdx = addFuncType(ctx, [EXT, EXT], [I32], `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    // Locals are assigned at FILL; the "nothing to add" placeholder uses none.
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: [],
      body: [{ op: "i32.const", value: 0 }],
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
  };

  reserve(FNINST_BAG_OWNS);
  reserve(FNINST_TOMBSTONE);
}

/**
 * Fill the two natives and splice the generic closure arms into the three
 * #2896 helpers.
 *
 * MUST run before `fillBuiltinFnMeta` — see the module header's ordering note.
 * Every dependency is resolved BY NAME (funcIdx math across phases is
 * shift-sensitive) and a missing one leaves the `0` placeholders in place, so a
 * skipped fill degrades to exactly today's behaviour instead of trapping.
 */
export function fillFunctionInstanceProps(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const bagOwnsIdx = ctx.funcMap.get(FNINST_BAG_OWNS);
  const tombstoneIdx = ctx.funcMap.get(FNINST_TOMBSTONE);
  if (bagOwnsIdx === undefined || tombstoneIdx === undefined) return;

  const rootIdx = getFuncRefWrapperRootTypeIdx(ctx);
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  const lookupIdx = ctx.funcMap.get(CLOSURE_BAG_LOOKUP);
  const ensureIdx = ctx.funcMap.get(CLOSURE_BAG_ENSURE);
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (
    rootIdx === undefined ||
    objectTypeIdx === undefined ||
    lookupIdx === undefined ||
    ensureIdx === undefined ||
    objFindIdx === undefined ||
    externSetIdx === undefined ||
    boxNumIdx === undefined ||
    strFlattenIdx === undefined ||
    strEqualsIdx === undefined ||
    anyStrTypeIdx < 0
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

  // ── __fninst_bag_owns(fn, key) -> i32 ─────────────────────────────────────
  // LOOKUP, never ENSURE: a presence *query* must not allocate a bag, or merely
  // reading `f.length` would mutate the side table and hand a later
  // `__integrity_bag` consumer a carrier that previously had none
  // (`carrier-bag-hasown.ts`'s rule). Marker-INCLUSIVE by design — see header.
  setFn(
    FNINST_BAG_OWNS,
    [{ name: "__bag", type: EXT }],
    [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: lookupIdx },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      // The bag is a `__new_plain_object` product; screen before the cast so a
      // future substrate change can never trap inside a helper that must not
      // throw (#3468 S1 discipline).
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
    ],
  );

  // ── __fninst_tombstone(fn, key) -> i32 ────────────────────────────────────
  // ENSURE (not lookup): a delete is a mutation, and it is the one operation
  // that legitimately has to create the receiver's bag. The stored value is the
  // bag ITSELF — #4098's unforgeable marker.
  setFn(
    FNINST_TOMBSTONE,
    [{ name: "__bag", type: EXT }],
    [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: ensureIdx },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      { op: "local.get", index: 2 }, // receiver = the bag
      { op: "local.get", index: 1 }, // key
      { op: "local.get", index: 2 }, // value = the bag  ← the marker
      { op: "call", funcIdx: externSetIdx },
      { op: "i32.const", value: 1 },
    ],
  );

  /**
   * `local.get <recvAny>; ref.test $root` — is the receiver a closure in the
   * funcref-wrapper hierarchy? Closure shapes OUTSIDE it (fnctor ctor closures)
   * are deliberately not matched; they keep today's answers.
   */
  const isClosure = (anyLocal: number): Instr[] => [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx: rootIdx },
  ];

  /**
   * `i32`: is param 1 the string `"length"`?
   *
   * Classified HERE rather than read from `fillBuiltinFnMeta`'s shared
   * `isLen` local (5): that preamble returns early when the module
   * materialized no builtin closure at all (`metaMap.size === 0`), which would
   * leave local 5 unset and silently disable this arm for exactly the programs
   * that have only user functions. A non-string key can never be `"length"`,
   * so the `ref.test` guard also keeps the flatten/compare off every
   * numeric-key read.
   *
   * A FACTORY (fresh `Instr` objects per call): the same shape goes into two
   * different function bodies, and aliasing one `Instr[]` into both would
   * double-remap on a later import shift (see
   * `reference_shared_instr_object_dce_double_remap`).
   */
  const keyIsLength = (): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "call", funcIdx: strFlattenIdx },
        { op: "ref.as_non_null" },
        ...nativeStringLiteralInstrs(ctx, "length"),
        { op: "call", funcIdx: strEqualsIdx },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];

  /** `!__fninst_bag_owns(param0, param1)` — the bag has not taken the key over. */
  const bagFree = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: bagOwnsIdx },
    { op: "i32.eqz" },
  ];

  /**
   * The shared `(receiver is a closure) && (key is "length") && (bag free)`
   * guard, wrapping `then`. `anyLocal` receives `any.convert_extern(param0)`.
   */
  const closureLengthArm = (anyLocal: number, then: Instr[]): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocal },
    ...isClosure(anyLocal),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...keyIsLength(), ...bagFree(), { op: "i32.and" }, { op: "if", blockType: { kind: "empty" }, then }],
    },
  ];

  // ── generic arm: __builtinfn_get_meta(fn, "length") → box_number($arity) ──
  // Registered locals: 2 = any, 3 = fkey, 4 = isName, 5 = isLen. Only 2 is
  // touched here, and `fillBuiltinFnMeta`'s preamble re-sets it in front.
  const getMetaFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_get_meta");
  if (getMetaFn) {
    getMetaFn.body.splice(
      0,
      0,
      ...closureLengthArm(2, [
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: rootIdx },
        { op: "struct.get", typeIdx: rootIdx, fieldIdx: CLOSURE_ARITY_FIELD_IDX },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: boxNumIdx },
        { op: "return" },
      ]),
    );
  }

  // ── __builtinfn_gopd's get_meta→descriptor prologue, when #2896 won't ─────
  //
  // `__getOwnPropertyDescriptor` calls `__builtinfn_gopd`, whose body is
  // otherwise filled ONLY by `fillBuiltinFnMeta` — and that fill returns early
  // when the module materialized no builtin closure meta type at all
  // (`metaMap.size === 0`). A program of nothing but user functions is exactly
  // that case, so `__builtinfn_gopd` would keep its `ref.null.extern`
  // placeholder and `gOPD(f, "length")` would answer `undefined` even though
  // `hasOwnProperty` (which calls `get_meta` DIRECTLY, one level up) answers
  // true. Measured: that split is precisely what the first cut of this module
  // produced. Splicing here only when #2896 will not is what keeps the two
  // surfaces consistent without emitting the prologue twice.
  const metaMap = ctx.builtinFnMetaByTypeIdx;
  const builtinFillWillRun = metaMap !== undefined && metaMap.size > 0;
  const gopdFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_gopd");
  const getMetaFuncIdx = ctx.funcMap.get("__builtinfn_get_meta");
  const createDescIdx = ctx.funcMap.get("__create_descriptor");
  if (!builtinFillWillRun && gopdFn && getMetaFuncIdx !== undefined && createDescIdx !== undefined) {
    gopdFn.body.splice(
      0,
      0,
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: getMetaFuncIdx },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "i32.const", value: FLAG_CONFIGURABLE },
          { op: "call", funcIdx: createDescIdx },
          { op: "return" },
        ],
      },
    );
  }

  // ── generic arm: __builtinfn_delete(fn, "length") → tombstone, 1 ──────────
  const deleteFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_delete");
  if (deleteFn) {
    deleteFn.body.splice(
      0,
      0,
      ...closureLengthArm(2, [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: tombstoneIdx },
        // A failed ensure (no bag substrate) must NOT report "handled", or
        // `delete` would claim success while the property stays visible.
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
      ]),
    );
  }

  // ── generic arm: __builtinfn_push_ownnames(fn, vec) → push "length" ───────
  // `getOwnPropertyNames` only. for-in / `Object.keys` read `__obj_ordered`
  // (enumerable-only) and never reach here, which is what keeps `length`
  // correctly non-enumerable.
  //
  // Params are (0 = fn, 1 = vec) and the ONLY registered local is 2 — the vec
  // parameter must not be clobbered, so the receiver is narrowed into 2.
  //
  // ⚠ This arm PUSHES AND FALLS THROUGH — it must NOT return 1. The caller in
  // `object-runtime-descriptors.ts` reads the result as "this receiver's own
  // names are COMPLETE" and returns the vector immediately, skipping the
  // `bagKeysIf` carrier-bag key source directly below it. That is right for a
  // builtin function value (`name`/`length` are all it has) and wrong for a user
  // closure, which also carries #3468 expandos: returning 1 here dropped `p`
  // from `Object.getOwnPropertyNames(f)` after `f.p = 12` (caught by
  // `issue-4010.test.ts` "function: getOwnPropertyNames includes the expando").
  // Falling through lets the bag arm append the expandos after `length`, which
  // is also the correct §10.1.11 creation order.
  const pushOwnFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_push_ownnames");
  if (pushOwnFn && objVecPushIdx !== undefined) {
    pushOwnFn.body.splice(
      0,
      0,
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 },
      ...isClosure(2),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // Presence is asked with the SAME `"length"` key the arm would push.
          { op: "local.get", index: 0 },
          ...nativeStringLiteralInstrs(ctx, "length"),
          { op: "extern.convert_any" },
          { op: "call", funcIdx: bagOwnsIdx },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 }, // vec
              ...nativeStringLiteralInstrs(ctx, "length"),
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
            ],
          },
        ],
      },
    );
  }
}
