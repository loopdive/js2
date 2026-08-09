// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4230 L1) The #3251 descriptor **overlay** made visible to the three
 * KEY-ENUMERATION surfaces, plus the `$__vec_base` arm `__getOwnPropertyNames`
 * never had at all.
 *
 * ## Two root causes, both measured on `upstream/main`, `--target standalone`
 *
 * ```js
 * const a = [];  Object.defineProperty(a, "p", { value: 12, enumerable: true });
 * a.p                                // 12   ✓  (the value was always fine)
 * Object.getOwnPropertyDescriptor(a, "p")   // {value:12,enumerable:true} ✓
 * Object.keys(a).length              // 0    ✗ node: 1     <- RC1
 * Object.getOwnPropertyNames(a).length // 0  ✗ node: 2
 * for (k in a) …                     // 0    ✗ node: 1     <- RC1
 *
 * Object.getOwnPropertyNames([1,2,3]).length   // 0 ✗ node: 4  <- RC2
 * ```
 *
 * - **RC1 — the overlay is invisible to every key walk.** A vec has THREE own-key
 *   stores: its `$data` elements, the #3537 expando bag, and the #3251 overlay
 *   companion. `fillDynamicForinVecArms` enumerates the first, #4010 S3's
 *   `bagKeysTail` the second, and **nothing** the third. So a `defineProperty`
 *   expando on an array is readable and describable but un-enumerable — which is
 *   precisely what `propertyHelper.js`'s `verifyEnumerable` measures, hence the
 *   `descriptor should be enumerable` family.
 * - **RC2 — `__getOwnPropertyNames` has no vec arm.** Its non-`$Object` branch is
 *   `bagKeysIf`, which returns the (usually empty) bag and never reaches the
 *   index keys or `length`. So gOPN over ANY array answers `[]`.
 *
 * ## The dedup hazard #4230 named, and how it is closed
 * #4230's leftover section flagged this explicitly:
 *
 * > this is not a copy-paste of `__vec_props_keysrc`. The overlay SEEDS real
 * > array elements as companion entries (`SEED_FLAGS = 0xbf`, enumerable), so
 * > unioning it into `Object.keys` would DUPLICATE index keys the vec path
 * > already emits — and that surface builds an `$objvec` of strings via
 * > `__objvec_push`, not an `$Object`, so dedup is not free.
 *
 * `__vec_props_keysrc` sidesteps it by REFUSING any vec with `length !== 0`.
 * That is not available here — enumerating a non-empty array is the whole point
 * — so the seeds are filtered by identity instead: an overlay entry is skipped
 * when its key is a **canonical array-index string below `length`**, because the
 * index loop has already emitted exactly that key. Canonicity is decided by a
 * ROUND TRIP (`ToString(ToNumber(key)) === key`), not by "parses as a number":
 * `"00"`, `"1.5"`, `" 1"` and `"+1"` all parse to a number but are ordinary
 * named properties that must NOT be dropped. `"length"` is filtered by name for
 * the same reason (the overlay's `LENGTH_SEED_FLAGS` entry is non-enumerable, so
 * only `getOwnPropertyNames`' `__obj_ordered_all` would ever see it, and the vec
 * arm emits `length` itself).
 *
 * The round trip costs one `number_toString` per overlay entry, so it is skipped
 * entirely when `length === 0` — the dominant shape (`var arrObj = []`), where
 * no index key can exist in any store.
 *
 * ## Demand gate — a module with no descriptor/own-key call is byte-identical
 * Everything here hangs off ONE pre-scan flag, `ctx.vecOwnKeysDirty`
 * (`array-holes.ts`), set only by a syntactic `Object`/`Reflect`
 * `defineProperty` / `defineProperties` / two-arg `create` / `getOwnPropertyNames`
 * / `ownKeys` / `getOwnPropertyDescriptors` mention. No mention ⇒ no overlay
 * named expando can exist and no one asks for own names ⇒ not one instruction,
 * local, type or function is added (#4232's lesson: unconditional pull-ins cost
 * code size and compile time on every module that does not use the feature).
 * gc/host output is unchanged twice over: the flag is only consulted under
 * `ctx.standalone`, and the `env::__object_keys` / `env::__getOwnPropertyNames`
 * imports own these paths there.
 *
 * ## Reserve / fill, and what a skipped fill degrades to
 * `__vec_overlay_lookup` is minted inside `ensureOverlayCore` at FINALIZE, after
 * `fillDynamicForinVecArms` has already baked the `__object_keys` vec arm. So
 * this native follows the #4230 / #1888-S5b reserve-then-fill discipline: it is
 * reserved as a placeholder returning `0` ("nothing added"), the call is baked
 * into the key-walk arms, and the real body is installed from
 * `fillObjVecReflectionHelpers`. A skipped fill therefore degrades to *exactly*
 * today's answer — never a trap, never a silent extra key.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { addFuncType, getOrRegisterVecBaseType } from "./registry/types.js";
import { buildBagPushKeys } from "./carrier-bag-visibility.js";
import { overlayRouteActive } from "./typed-lane-overlay-route.js";

/** `(externref obj, externref vec, i32 includeNonEnum) -> i32` — 1 iff an overlay existed. */
export const VEC_OVERLAY_PUSH_KEYS = "__vec_overlay_push_keys";

/** #3251 descriptor overlay (`vec-overlay.ts`) — minted at FINALIZE. */
const VEC_OVERLAY_LOOKUP = "__vec_overlay_lookup";

/** `$PropEntry.$flags` mirrors of the object-runtime ABI (stable since #1888). */
const FLAG_INTERNAL = 0x10;
const FLAG_DELETED_INDEX = 0x40;

const EXT: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/**
 * The one demand gate. `vecOwnKeysDirty` is the cheap syntactic pre-scan flag; a
 * module that never mentions a descriptor-defining or own-name-reading builtin
 * cannot observe anything this module does, so it gets none of it.
 */
export function vecOwnKeysEnumerationActive(ctx: CodegenContext): boolean {
  return ctx.standalone === true && ctx.vecOwnKeysDirty === true;
}

/**
 * Reserve `__vec_overlay_push_keys` so `fillDynamicForinVecArms` can bake a
 * `call <idx>` before `__vec_overlay_lookup` exists. Append-only mint (no
 * funcIdx shifts), idempotent, and a no-op unless the demand gate is open.
 */
export function reserveVecOverlayPushKeys(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(VEC_OVERLAY_PUSH_KEYS);
  if (existing !== undefined) return existing;
  if (!vecOwnKeysEnumerationActive(ctx)) return undefined;
  const typeIdx = addFuncType(ctx, [EXT, EXT, I32], [I32], `$${VEC_OVERLAY_PUSH_KEYS}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: VEC_OVERLAY_PUSH_KEYS,
    typeIdx,
    locals: [],
    // SAFE placeholder: "no overlay keys added", i.e. today's answer.
    body: [{ op: "i32.const", value: 0 }],
    exported: false,
  });
  ctx.funcMap.set(VEC_OVERLAY_PUSH_KEYS, funcIdx);
  return funcIdx;
}

/**
 * `__vec_overlay_push_keys(obj, vec, includeNonEnum); drop` — the additive tail
 * for a key-enumeration site that has already pushed index and bag keys.
 * Returns `[]` when the native was never reserved, so the caller is unchanged.
 */
export function buildOverlayPushKeys(
  ctx: CodegenContext,
  args: { vecLocal: number; includeNonEnum: boolean; objLocal?: number },
): Instr[] {
  const idx = ctx.funcMap.get(VEC_OVERLAY_PUSH_KEYS);
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
 * Fill `__vec_overlay_push_keys`. Called from `fillObjVecReflectionHelpers`
 * AFTER `fillVecOverlayHelpers` has minted `__vec_overlay_lookup`.
 * Order-independent with respect to its callers: they baked the RESERVED index.
 */
export function fillVecOverlayPushKeys(ctx: CodegenContext): void {
  const selfIdx = ctx.funcMap.get(VEC_OVERLAY_PUSH_KEYS);
  if (selfIdx === undefined) return;
  const fn = definedFuncAt(ctx, selfIdx);
  if (!fn) return;
  const types = ctx.objectRuntimeTypes;
  if (!types) return;
  const { objectTypeIdx, propMapTypeIdx, propEntryTypeIdx } = types;
  const overlayLookupIdx = ctx.funcMap.get(VEC_OVERLAY_LOOKUP);
  const objOrderedIdx = ctx.funcMap.get("__obj_ordered");
  const objOrderedAllIdx = ctx.funcMap.get("__obj_ordered_all");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const numToStringIdx = ctx.funcMap.get("number_toString");
  const strToNumIdx = ctx.funcMap.get("__str_to_number");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (
    overlayLookupIdx === undefined ||
    objOrderedIdx === undefined ||
    objOrderedAllIdx === undefined ||
    objVecPushIdx === undefined ||
    numToStringIdx === undefined ||
    strToNumIdx === undefined ||
    strFlattenIdx === undefined ||
    strEqualsIdx === undefined ||
    anyStrTypeIdx < 0
  ) {
    // Leave the `0` placeholder: the key walks keep today's exact answer.
    return;
  }
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);

  // params: 0 = obj, 1 = vec, 2 = includeNonEnum
  const L_OV = 3;
  const L_ARR = 4;
  const L_CAP = 5;
  const L_I = 6;
  const L_E = 7;
  const L_LEN = 8;
  const L_KEY = 9;
  const L_N = 10;

  /** `i32`: 1 iff the flattened key in `L_KEY` equals the literal. */
  const keyIs = (literal: string): Instr[] => [
    { op: "local.get", index: L_KEY },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "call", funcIdx: strFlattenIdx },
    ...nativeStringLiteralInstrs(ctx, literal),
    { op: "call", funcIdx: strEqualsIdx },
  ];

  /**
   * `i32`: 1 iff `L_KEY` is a CANONICAL array-index string in `[0, L_LEN)` —
   * i.e. a key the index loop has already pushed. `ToString(ToNumber(key)) ===
   * key` is the round trip that keeps `"00"` / `"1.5"` / `" 1"` (real named
   * properties) out of the filter. Short-circuits to 0 when the vec is empty,
   * which is both correct and the common shape.
   */
  const isSeededIndexKey: Instr[] = [
    { op: "local.get", index: L_LEN },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        { op: "local.get", index: L_KEY },
        { op: "call", funcIdx: strToNumIdx },
        { op: "local.tee", index: L_N },
        { op: "local.get", index: L_N },
        { op: "f64.eq" }, // n == n — rejects NaN (a non-numeric key)
        { op: "local.get", index: L_N },
        { op: "f64.const", value: 0 },
        { op: "f64.ge" },
        { op: "i32.and" },
        { op: "local.get", index: L_N },
        { op: "local.get", index: L_LEN },
        { op: "f64.convert_i32_s" },
        { op: "f64.lt" },
        { op: "i32.and" },
        // …and an INTEGER. The round trip below is necessary but NOT
        // sufficient: `ToString(1.5) === "1.5"`, so `"1.5"` would round-trip
        // cleanly and be dropped as if it were an index. Measured — the
        // `t_keys_noncanonical_fraction` row failed on exactly this before the
        // floor test was added.
        { op: "local.get", index: L_N },
        { op: "local.get", index: L_N },
        { op: "f64.floor" },
        { op: "f64.eq" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          then: [
            // ToString(n) === key ?
            { op: "local.get", index: L_KEY },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: anyStrTypeIdx },
            { op: "call", funcIdx: strFlattenIdx },
            { op: "local.get", index: L_N },
            { op: "call", funcIdx: numToStringIdx },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: anyStrTypeIdx },
            { op: "call", funcIdx: strFlattenIdx },
            { op: "call", funcIdx: strEqualsIdx },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];

  const orderedCall = (idx: number): Instr[] => [
    { op: "local.get", index: L_OV },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: idx },
    { op: "local.set", index: L_ARR },
  ];

  fn.locals = [
    { name: "ov", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
    { name: "arr", type: { kind: "ref_null", typeIdx: propMapTypeIdx } },
    { name: "cap", type: I32 },
    { name: "i", type: I32 },
    { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
    { name: "len", type: I32 },
    { name: "key", type: EXT },
    { name: "n", type: { kind: "f64" } },
  ];
  fn.body = [
    // Not a vec ⇒ nothing to add. `ref.test` never traps on a null/foreign ref.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: vecBaseIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: vecBaseIdx },
    { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
    { op: "local.set", index: L_LEN },
    // LOOKUP, never ENSURE: a query must not mint an overlay for a receiver that
    // had none (the `carrier-bag-hasown.ts` rule).
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: overlayLookupIdx },
    { op: "local.tee", index: L_OV },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 2 },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: orderedCall(objOrderedAllIdx),
      else: orderedCall(objOrderedIdx),
    },
    { op: "local.get", index: L_ARR },
    { op: "ref.as_non_null" },
    { op: "array.len" },
    { op: "local.set", index: L_CAP },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_CAP },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_ARR },
            { op: "ref.as_non_null" },
            { op: "local.get", index: L_I },
            { op: "array.get", typeIdx: propMapTypeIdx },
            { op: "local.tee", index: L_E },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },
            // Runtime bookkeeping is not an own property: INTERNAL records and
            // `delete arr[i]` gravestones both stay invisible.
            { op: "local.get", index: L_E },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
            { op: "i32.const", value: FLAG_INTERNAL | FLAG_DELETED_INDEX },
            { op: "i32.and" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_E },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                { op: "extern.convert_any" },
                { op: "local.set", index: L_KEY },
                // A non-STRING key (a symbol) is not an own *name*, and the two
                // filters below would `ref.cast $AnyStr` it — a TRAP inside a
                // helper that must never throw. Screen structurally, once.
                { op: "local.get", index: L_KEY },
                { op: "any.convert_extern" },
                { op: "ref.test", typeIdx: anyStrTypeIdx },
                { op: "i32.eqz" },
                // depth 0 is this `if` — leaving it lands on the increment
                // below, i.e. `continue`.
                { op: "br_if", depth: 0 },
                // Skip what the vec arm already emitted: `length`, and any
                // seeded canonical index below `length`.
                ...keyIs("length"),
                ...isSeededIndexKey,
                { op: "i32.or" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: 1 },
                    { op: "local.get", index: L_KEY },
                    { op: "call", funcIdx: objVecPushIdx },
                  ],
                },
              ],
            },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "i32.const", value: 1 },
  ];
}

/**
 * RC1b — `__extern_has`'s vec arm consults the #3251 overlay.
 *
 * Measured on `upstream/main`, standalone, for an array carrying one
 * `defineProperty` expando `p`:
 *
 * | predicate | answer | correct? |
 * | --- | --- | --- |
 * | `a.hasOwnProperty("p")` / `Object.hasOwn` | true | ✓ (#4010 S3's `__vec_gopd` prologue) |
 * | `a.propertyIsEnumerable("p")` | true | ✓ (same prologue) |
 * | `Object.getOwnPropertyDescriptor(a, "p")` | `{…}` | ✓ |
 * | **`"p" in a`** (`__extern_has`) | **false** | ✗ |
 *
 * So `__extern_has` was the ONE presence surface `fillVecHasOwnHelpers`
 * (`vec-bag-seed.ts`) did not reach — it got the #3537 bag consult but never the
 * overlay one. That inconsistency is not just wrong for `in`: the standalone
 * for-in loop re-checks every key from `__object_keys` through
 * `__extern_has`, so fixing `__object_keys` alone would have produced a key list
 * the loop then silently dropped. (Both halves are needed; either alone is
 * invisible. That is why they ship together.)
 *
 * Same shape as the `hasOwnProperty` prologue it mirrors: `__vec_gopd` says
 * "own" ⇒ return 1; anything else falls through to the caller's existing bag /
 * proto-companion consult, so this can add a `true` and never remove one.
 * Emitted only for a non-index, non-`length` string key (both already returned
 * above it), and only under the demand gate.
 */
export function buildVecOverlayHasArm(ctx: CodegenContext): Instr[] {
  if (!vecOwnKeysEnumerationActive(ctx)) return [];
  const vecGopdIdx = ctx.funcMap.get("__vec_gopd");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  if (vecGopdIdx === undefined || isUndefinedIdx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: vecGopdIdx },
    { op: "call", funcIdx: isUndefinedIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },
  ];
}

/**
 * RC2 — give `__getOwnPropertyNames` the `$__vec_base` arm it never had.
 *
 * Its non-`$Object` branch is `bagKeysIf`, which returns the carrier bag and
 * RETURNS, so a vec receiver never reaches an index key: `Object
 * .getOwnPropertyNames([1,2,3])` answered `[]` where the spec says
 * `["0","1","2","length"]`. This prepends a complete vec arm (indices →
 * `length` → bag → overlay, §10.1.11.1 order) ahead of that branch; every other
 * receiver falls through to the untouched body.
 *
 * Index presence is gated on `__extern_has_idx` under the #4222 overlay route,
 * exactly as `__object_keys`' arm is, so `delete arr[i]` removes the index from
 * gOPN too and the three surfaces cannot disagree.
 */
export function fillGopnVecArm(ctx: CodegenContext): void {
  if (!vecOwnKeysEnumerationActive(ctx)) return;
  const fn = ctx.mod.functions.find((f) => f.name === "__getOwnPropertyNames");
  if (!fn) return;
  const state = ctx as CodegenContext & { gopnVecArmFilled?: boolean };
  if (state.gopnVecArmFilled) return;
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const numToStringIdx = ctx.funcMap.get("number_toString");
  const externHasIdxIdx = ctx.funcMap.get("__extern_has_idx");
  if (objVecNewIdx === undefined || objVecPushIdx === undefined || numToStringIdx === undefined) return;
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);

  // Anchor on the semantic provider's own result-vector init (`__objvec_new` →
  // `local.set 7`) rather than a positional index: other finalize fills have
  // already prepended arms, and this one must sit AFTER `vec = __objvec_new()`.
  const initIdx = fn.body.findIndex((instr, index) => {
    const next = fn.body[index + 1];
    return instr.op === "call" && instr.funcIdx === objVecNewIdx && next?.op === "local.set" && next.index === 7;
  });
  if (initIdx < 0) return;

  const VEC = 7; // the native's own result vector
  const A = 1 + fn.locals.length; // anyref scratch
  const LEN = A + 1;
  const I = A + 2;
  fn.locals.push(
    { name: "__vecarm_any", type: { kind: "anyref" } },
    { name: "__vecarm_len", type: I32 },
    { name: "__vecarm_i", type: I32 },
  );

  const gateOnPresence = overlayRouteActive(ctx) && externHasIdxIdx !== undefined;
  const push: Instr[] = [
    { op: "local.get", index: VEC },
    { op: "local.get", index: I },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: numToStringIdx },
    { op: "call", funcIdx: objVecPushIdx },
  ];
  const pushKeyI: Instr[] = gateOnPresence
    ? [
        { op: "local.get", index: 0 },
        { op: "local.get", index: I },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: externHasIdxIdx as number },
        { op: "if", blockType: { kind: "empty" }, then: push },
      ]
    : push;

  const arm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: A },
    { op: "ref.test", typeIdx: vecBaseIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: A },
        { op: "ref.cast", typeIdx: vecBaseIdx },
        { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
        { op: "local.set", index: LEN },
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
                { op: "local.get", index: LEN },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...pushKeyI,
                { op: "local.get", index: I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // `length` is an own (non-enumerable) property of every array, and gOPN
        // is the non-enumerable-inclusive surface.
        { op: "local.get", index: VEC },
        ...nativeStringLiteralInstrs(ctx, "length"),
        { op: "extern.convert_any" }, // literal is a `ref $NativeString`; the vec takes externref
        { op: "call", funcIdx: objVecPushIdx },
        ...buildBagPushKeys(ctx, { vecLocal: VEC, includeNonEnum: true }),
        ...buildOverlayPushKeys(ctx, { vecLocal: VEC, includeNonEnum: true }),
        { op: "local.get", index: VEC },
        { op: "return" },
      ],
    },
  ];
  fn.body.splice(initIdx + 2, 0, ...arm);
  state.gopnVecArmFilled = true;
}
