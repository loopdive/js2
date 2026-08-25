// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4658) The `arguments`-object BRAND that lets `__vec_gopd` tell §10.4.4's
 * `length` from §10.4.2's, for `--target standalone`.
 *
 * ## The defect
 * `arguments` is backed by the same opaque `$Vec` an array literal uses, so
 * `Object.getOwnPropertyDescriptor(arguments, "length")` is answered by
 * `__vec_gopd`'s ARRAY-length synthesis: `{value: <live length>, writable:
 * <companion bit>, enumerable: false, configurable: **false**}`. That is exactly
 * right for `[1, 2]` — an Array's `length` is `configurable: false` (§10.4.2.1)
 * — and wrong for an arguments object, whose `length` is a plain data property
 * `{writable: true, enumerable: false, configurable: true}` in BOTH
 * CreateMappedArgumentsObject (§10.4.4 step 7) and CreateUnmappedArgumentsObject
 * (step 4). Measured on the base sources, standalone:
 *
 * ```js
 * var argObj = (function () { return arguments })();
 * Object.getOwnPropertyDescriptor(argObj, "length")
 * // {value: 0, writable: true, enumerable: false, configurable: false}
 * ```
 *
 * `language/arguments-object/10.6-6-2` and `10.6-7-1` fail on exactly that bit
 * ("length descriptor should be configurable").
 *
 * ## Why a runtime brand, and why this one
 * `arguments-object-mop.ts` records the constraint that shaped #4622: *"Fixing
 * `__vec_gopd` is not available: it is shared with real arrays and there is no
 * runtime brand to split them on."* The syntactic escape hatch it used instead
 * cannot serve here — both failing tests hand the object to `verifyProperty`, a
 * harness FUNCTION, so the receiver at the gOPD site is a dynamic value with no
 * syntactic connection to any `arguments` binding. The brand is the missing
 * runtime fact, minted once at construction.
 *
 * It lives on the #3251 overlay COMPANION's `$Object.flags` (field 4), the same
 * internal-slot channel `OBJ_FLAG_RAWJSON` (#3176) and `OBJ_FLAG_CALLABLE` /
 * `OBJ_FLAG_CONSTRUCTOR` (#4120) already use; `0x40` was reserved as free in
 * `object-runtime.ts`'s flag table. It is an INTERNAL SLOT, not an own property:
 * nothing enumerates it, `Object.keys` cannot see it, and every existing reader
 * of that field masks only its own bits, so an unbranded module is unaffected
 * and a branded one changes exactly one descriptor bit.
 *
 * ## Why the companion, not the #3537 bag
 * `__vec_gopd`'s length arm ALREADY loads the companion (`__vec_overlay_lookup`
 * into its local 3) to read the `writable` bit off a companion `length` entry.
 * Reading the brand from the same non-null-checked local costs one `struct.get`
 * and no new lookup; hanging it on the bag would add a second table probe to a
 * path that is on every `gOPD(arr, "length")`.
 *
 * ## Table growth — why marking is not a new cost
 * `__vec_overlay_ensure` APPENDS to a linearly scanned pair table, so branding
 * every arguments object on every call would grow it unboundedly (the hazard
 * `ensureOverlayCore` documents for per-exec RegExp match results). It does not,
 * because the call site is gated on the SAME `shouldRegisterArgumentsWithHost`
 * proof #4578 uses to elide work for an unobservable arguments object — and
 * whenever that proof says "observable", `arguments-callee.ts` has already put a
 * companion on this vec via `__defineProperty_value(args, "callee", …)` (or the
 * strict poison accessor). The mark therefore hits an existing pair, or shares
 * the one entry the callee seed was going to append anyway. A function whose
 * `arguments` never escapes gets no mark, no companion, and no table entry.
 *
 * ## Reserve-then-fill
 * The mark is emitted from a function BODY (`emitArgumentsVecBody`), long before
 * the overlay core exists — the core is minted at FINALIZE. So the native is
 * reserved as a typed no-op stub at the construction site (the
 * `reserveVecOverlayPrime` pattern, append-only mint, no funcIdx shift) and
 * filled from `fillVecOverlayHelpers` once `__vec_overlay_ensure` and `$Object`
 * are resolvable. A module that never reaches the fill keeps the no-op body, so
 * host/gc output is byte-identical.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

const EXT: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/**
 * `$Object.flags` bit 6 — "this `$Object` is the overlay companion of an
 * `arguments` exotic object". `0x40` is the first free bit in
 * `object-runtime.ts`'s table (0x01/0x02/0x04 integrity, 0x08 rawJSON,
 * 0x10/0x20 callable/ctor).
 */
export const OBJ_FLAG_ARGUMENTS = 0x40;

/**
 * `$Object.flags` bit 7 — "this branded arguments object's `length` has been
 * DELETED". §10.4.4 makes `length` `configurable: true`, so `delete
 * args.length` must succeed AND the property must then be gone; the vec has no
 * per-key storage for `length` (`__vec_prop_set` refuses the key outright,
 * because the real vec length must never be shadowed by the bag), so the
 * deletion is recorded as a tombstone BIT rather than as a bag entry.
 *
 * Why the tombstone is required and not cosmetic: test262's
 * `propertyHelper.verifyProperty` does not read `configurable` off the
 * descriptor alone — `isConfigurable` performs `delete obj[name]` and then
 * asserts `!hasOwnProperty(obj, name)`. Without the tombstone
 * `language/arguments-object/10.6-6-2` and `10.6-7-1` keep failing with
 * "length descriptor should be configurable" even once gOPD answers `true`
 * (measured — that is exactly what the brand alone produced).
 */
export const OBJ_FLAG_ARGS_LENGTH_ABSENT = 0x80;

const MARK_NAME = "__args_brand_mark";
const ABSENT_NAME = "__args_len_absent";
const DELETE_NAME = "__args_len_delete";
const REVIVE_NAME = "__args_len_revive";
/**
 * (#4491 wave-7) `__args_is_branded(vec) -> i32` — the plain "is this vec an
 * `arguments` exotic?" query, which #4658 minted the brand for but never
 * exposed on its own (every one of its four natives asks about `length`).
 * §20.1.3.6 step 12 needs exactly that question and nothing about `length`:
 * `Object.prototype.toString.call(<arguments>)` must be `[object Arguments]`,
 * and the runtime classifier's `ref.test $__vec_base` arm answers
 * `[object Array]` because both share `$Vec` (the same conflation #4667 records
 * for `Array.isArray`).
 *
 * Deliberately NOT routed through `Array.isArray`/`__is_vec`: #4667's landing
 * hazard is that narrowing THAT predicate flips test262's `propertyHelper`
 * onto a string-valued `length` probe that #4658's residual 1 cannot satisfy,
 * silently trading `10.6-6-2` away. This native is read by the class-tag
 * classifier only, so it cannot reach that harness branch.
 */
const IS_BRANDED_NAME = "__args_is_branded";

/**
 * Reserve `__args_brand_mark(externref vec) -> ()` as a no-op stub. Idempotent;
 * returns the funcIdx, or `undefined` outside standalone (where the host's
 * `__register_arguments` owns §10.4.4 and the overlay is never built).
 */
export function reserveArgumentsLengthBrand(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get(MARK_NAME);
  if (existing !== undefined) return existing;
  const reserve = (name: string, params: ValType[], results: ValType[], placeholder: Instr[]): number => {
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: [], body: placeholder, exported: false });
    ctx.funcMap.set(name, funcIdx);
    return funcIdx;
  };
  // Placeholders are the "no arguments object was ever branded" answers, so a
  // module whose overlay core is never built keeps today's behaviour exactly.
  const markIdx = reserve(MARK_NAME, [EXT], [], []);
  reserve(ABSENT_NAME, [EXT], [I32], [{ op: "i32.const", value: 0 }]);
  reserve(DELETE_NAME, [EXT, EXT], [I32], [{ op: "i32.const", value: 0 }]);
  reserve(REVIVE_NAME, [EXT], [], []);
  reserve(IS_BRANDED_NAME, [EXT], [I32], [{ op: "i32.const", value: 0 }]);
  return markIdx;
}

/**
 * `i32` on the stack: has `length` been deleted from the branded arguments
 * object in param `objParam`? `[]` when nothing was ever branded, so the caller
 * must supply its own unconditional answer (see the call sites, which all keep
 * their pre-#4658 constant in that case).
 */
export function buildArgumentsLengthAbsentCall(ctx: CodegenContext, objParam = 0): Instr[] {
  const idx = ctx.funcMap.get(ABSENT_NAME);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: objParam },
    { op: "call", funcIdx: idx },
  ];
}

/**
 * `if (__args_len_delete(obj, key)) return 1;` — the §10.4.4 arm for
 * `delete <argumentsObject>.length`. `[]` when nothing was branded.
 *
 * Placed AFTER the caller's `configurable` gate on purpose: a sealed or frozen
 * arguments object answers `configurable: false` from `__vec_gopd`, so the gate
 * refuses the delete before this arm can record a tombstone.
 */
export function buildArgumentsLengthDeleteArm(ctx: CodegenContext, objParam: number, keyLocal: number): Instr[] {
  const idx = ctx.funcMap.get(DELETE_NAME);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: objParam },
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: idx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },
  ];
}

/**
 * `if (__args_len_absent(vec)) <miss>` for `__vec_gopd`'s `length` arm: a
 * branded arguments object whose `length` was deleted has no own `length` at
 * all, and gOPD must agree with the `__hasOwnProperty` arm that reads the same
 * tombstone bit.
 *
 * `miss` is a FACTORY so this payload never shares `Instr` identities with the
 * caller's own miss tail (`reference_shared_instr_object_dce_double_remap`).
 * `[]` when no arguments object was ever branded.
 */
export function buildArgumentsLengthDeletedBail(ctx: CodegenContext, miss: () => Instr[]): Instr[] {
  const call = buildArgumentsLengthAbsentCall(ctx, 0);
  if (call.length === 0) return [];
  return [...call, { op: "if", blockType: { kind: "empty" }, then: miss() }];
}

/**
 * `if (__args_len_absent(vec)) return 0;` — the presence tail for a site whose
 * next instruction is the unconditional "yes, `length` is here" answer
 * (`__hasOwnProperty` / `__object_hasOwn` / `__extern_has`). `[]` when nothing
 * was branded, so those sites keep their pre-#4658 constant.
 *
 * A FACTORY: this payload is spliced into several functions and a shared
 * `Instr` object reachable from more than one is remapped more than once by the
 * finalize walks (`reference_shared_instr_object_dce_double_remap`).
 */
export function buildArgumentsLengthAbsentTail(ctx: CodegenContext, objParam = 0): Instr[] {
  const call = buildArgumentsLengthAbsentCall(ctx, objParam);
  if (call.length === 0) return [];
  return [...call, { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] }];
}

/**
 * `if (__args_len_absent(vec)) return <miss>;` — the same tail for a VALUE site
 * (`__extern_get`'s `length` arm), where the absent answer is `undefined`
 * rather than `0`. `miss` is a factory for the same reason as above.
 */
export function buildArgumentsLengthAbsentMiss(ctx: CodegenContext, objParam: number, miss: () => Instr[]): Instr[] {
  const call = buildArgumentsLengthAbsentCall(ctx, objParam);
  if (call.length === 0) return [];
  return [...call, { op: "if", blockType: { kind: "empty" }, then: [...miss(), { op: "return" }] }];
}

/**
 * (#4491 wave-7) `i32` on the stack: is the vec in `objParam` a branded
 * `arguments` exotic? `[]` when the native was never reserved (host/gc lane),
 * so a caller must keep its own unconditional answer in that case.
 */
export function buildArgumentsIsBrandedCall(ctx: CodegenContext, objParam = 0): Instr[] {
  const idx = ctx.funcMap.get(IS_BRANDED_NAME);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: objParam },
    { op: "call", funcIdx: idx },
  ];
}

/** `__args_len_revive(obj)` — a store to `length` recreates the property. */
export function buildArgumentsLengthReviveCall(ctx: CodegenContext, objParam = 0): Instr[] {
  const idx = ctx.funcMap.get(REVIVE_NAME);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: objParam },
    { op: "call", funcIdx: idx },
  ];
}

/**
 * Emit `__args_brand_mark(<vec in argsLocalIdx>)` at an arguments-vec
 * construction site. No-op when the native could not be reserved.
 */
export function emitArgumentsLengthBrandMark(ctx: CodegenContext, fctx: FunctionContext, argsLocalIdx: number): void {
  const markIdx = reserveArgumentsLengthBrand(ctx);
  if (markIdx === undefined) return;
  fctx.body.push({ op: "local.get", index: argsLocalIdx });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "call", funcIdx: markIdx });
}

/**
 * FINALIZE fill: `comp = __vec_overlay_ensure(any(vec)); comp.flags |= 0x40`.
 *
 * The companion lands in a `(ref null $Object)` local and BOTH the `struct.set`
 * receiver and the `struct.get` are read back from it. Reading the receiver
 * through a non-externref local is load-bearing: `fixups.ts`'s backward stack
 * walk for `struct.set` receivers splices a repair `any.convert_extern +
 * ref.cast_null` when the deepest producer is an externref `local.get`, and on
 * an already-correct sequence that repair makes the module fail validation (the
 * hazard `builtin-callable-brand.ts` documents at its own flag OR).
 */
export function fillArgumentsLengthBrand(
  ctx: CodegenContext,
  objectTypeIdx: number,
  overlayEnsureIdx: number,
  overlayLookupIdx: number,
): void {
  const markIdx = ctx.funcMap.get(MARK_NAME);
  if (markIdx === undefined) return;
  const setFn = (name: string, locals: { name: string; type: ValType }[], body: Instr[]): void => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    fn.locals = locals;
    fn.body = body;
  };
  /**
   * A FACTORY, never a shared array — and this one bit, measured.
   *
   * Assigning ONE `{name, type}` array (and therefore one `ValType` object) to
   * all four `fn.locals` makes the finalize type-remap walk rewrite that single
   * object's `typeIdx` once PER FUNCTION, while the `struct.get`/`struct.set`
   * immediates (built fresh below) are remapped once each. The two drift apart:
   * `10.6-6-2` compiled to `(local $comp (ref null 153))` beside `struct.get
   * 159 4` and V8 rejected the module with *"struct.get[0] expected type (ref
   * null 159), found ref.as_non_null of type (ref 153)"* — attributed to
   * `testcase`, because the stub had been INLINED there. Same rule as
   * `reference_shared_instr_object_dce_double_remap`, one level out: it governs
   * local TYPE objects too, not only `Instr`s.
   */
  const comp = (): { name: string; type: ValType }[] => [
    { name: "comp", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
  ];
  /** `comp = __vec_overlay_lookup(any(param0))`; then `if (comp == null) <miss>`. */
  const loadCompanion = (compLocal: number, miss: Instr[]): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "call", funcIdx: overlayLookupIdx },
    { op: "local.tee", index: compLocal },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: miss },
  ];
  /** `comp.flags = (comp.flags & ~clear) | set` for a NON-NULL companion local. */
  const updateFlags = (compLocal: number, set: number, clear: number): Instr[] => [
    { op: "local.get", index: compLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: compLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
    { op: "i32.const", value: ~clear },
    { op: "i32.and" },
    { op: "i32.const", value: set },
    { op: "i32.or" },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 4 },
  ];
  /** `(comp.flags & mask) != 0` for a NON-NULL companion local. */
  const testFlag = (compLocal: number, mask: number): Instr[] => [
    { op: "local.get", index: compLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
    { op: "i32.const", value: mask },
    { op: "i32.and" },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
  ];

  // ── __args_brand_mark(vec) ───────────────────────────────────────────────
  // ENSURE, not lookup: this is the one site that creates the companion.
  //
  // The companion lands in a `(ref null $Object)` local and BOTH the
  // `struct.set` receiver and the `struct.get` are read back from it. Reading
  // the receiver through a non-externref local is load-bearing: `fixups.ts`'s
  // backward stack walk for `struct.set` receivers splices a repair
  // `any.convert_extern + ref.cast_null` when the deepest producer is an
  // externref `local.get`, and on an already-correct sequence that repair makes
  // the module fail validation (the hazard `builtin-callable-brand.ts`
  // documents at its own flag OR).
  setFn(MARK_NAME, comp(), [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "call", funcIdx: overlayEnsureIdx },
    { op: "local.set", index: 1 },
    ...updateFlags(1, OBJ_FLAG_ARGUMENTS, 0),
  ]);

  // ── __args_len_absent(vec) -> i32 ────────────────────────────────────────
  // A pure query: LOOKUP, never ensure (the `carrier-bag-hasown.ts` rule — a
  // query must not hand a later consumer a companion the receiver never had).
  setFn(ABSENT_NAME, comp(), [
    ...loadCompanion(1, [{ op: "i32.const", value: 0 }, { op: "return" }]),
    ...testFlag(1, OBJ_FLAG_ARGS_LENGTH_ABSENT),
  ]);

  // ── __args_len_delete(vec, key) -> i32 (1 = handled) ─────────────────────
  const keyIsLength = buildKeyIsLengthInstrs(ctx, 1);
  setFn(
    DELETE_NAME,
    comp(),
    keyIsLength === null
      ? [{ op: "i32.const", value: 0 }]
      : [
          ...keyIsLength,
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
          ...loadCompanion(2, [{ op: "i32.const", value: 0 }, { op: "return" }]),
          ...testFlag(2, OBJ_FLAG_ARGUMENTS),
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
          ...updateFlags(2, OBJ_FLAG_ARGS_LENGTH_ABSENT, 0),
          { op: "i32.const", value: 1 },
        ],
  );

  // ── __args_len_revive(vec) ───────────────────────────────────────────────
  setFn(REVIVE_NAME, comp(), [
    ...loadCompanion(1, [{ op: "return" }]),
    ...updateFlags(1, 0, OBJ_FLAG_ARGS_LENGTH_ABSENT),
  ]);

  // ── __args_is_branded(vec) -> i32 ────────────────────────────────────────
  // (#4491 wave-7) The same pure-query shape as ABSENT_NAME — LOOKUP, never
  // ensure — reading the brand bit itself rather than the length tombstone.
  setFn(IS_BRANDED_NAME, comp(), [
    ...loadCompanion(1, [{ op: "i32.const", value: 0 }, { op: "return" }]),
    ...testFlag(1, OBJ_FLAG_ARGUMENTS),
  ]);
}

/**
 * `key === "length"` over the externref key in `keyLocal`, i32 on the stack.
 * `null` when the native-string helpers this module cannot mint are absent, so
 * the caller degrades to "never mine".
 */
function buildKeyIsLengthInstrs(ctx: CodegenContext, keyLocal: number): Instr[] | null {
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (strFlattenIdx === undefined || strEqualsIdx === undefined || ctx.anyStrTypeIdx < 0) return null;
  return [
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        { op: "local.get", index: keyLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        { op: "call", funcIdx: strFlattenIdx },
        ...nativeStringLiteralInstrs(ctx, "length"),
        { op: "call", funcIdx: strEqualsIdx },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/**
 * `i32` on the stack: is the `(ref null $Object)` companion in `compLocal`
 * branded as an arguments object? `0` for a null companion (an ordinary array
 * that has never been reflected on), which keeps §10.4.2's `configurable:
 * false` as the default answer.
 */
export function buildArgumentsBrandBit(compLocal: number, objectTypeIdx: number): Instr[] {
  return [
    { op: "local.get", index: compLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: compLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
        { op: "i32.const", value: OBJ_FLAG_ARGUMENTS },
        { op: "i32.and" },
        { op: "i32.const", value: 0 },
        { op: "i32.ne" },
      ],
    },
  ];
}
