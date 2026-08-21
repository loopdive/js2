// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3537) Array ($Vec) expando own-property side table for `--target standalone`.
 *
 * ## The gap
 * A real array is a `__vec_<kind>` struct subtyping `$__vec_base` — NOT a
 * `$Object` — so the three terminal dynamic-property helpers in
 * `object-runtime.ts` (`__extern_set`, `__extern_get`, `__extern_method_call`)
 * fall through their `ref.test $Object` gate for an array receiver. A named
 * expando write (`arr.index = 0`, the classic test262 `__expected` harness
 * shape) is silently dropped and the read answers undefined. Measured as
 * cluster 6 of the #3468 exposure histogram (~208 projected cliff tests) and
 * part of the broader own-property family (#3468 closures / this array arm /
 * builtin namespaces / class prototypes).
 *
 * ## The fix (mirror of the #3468 C-core side table, ARRAY arm)
 * Keep vecs as-is and give the dead arms a fallback: a runtime,
 * array-identity-keyed side table mapping each expando-carrying vec to a fresh
 * `$Object` "bag" holding its named own properties. Element storage, `.length`,
 * and every existing read path are untouched — the bag is consulted only where
 * today's behavior is a silent miss, so the change is strictly additive.
 *
 * `"length"` is REFUSED at set time (native-string compare, the
 * `fillBuiltinFnMeta` classify pattern): the bag can never shadow the real vec
 * length no matter which read path answers `.length`. Numeric index keys are
 * out of scope (vec ELEMENTS; per-index descriptor fidelity is #3251's overlay
 * epic), as is reflection over the bag (`in`/`delete`/keys — family follow-on).
 *
 * ## Composition, not modification (#3468 ownership boundary)
 * `closure-props.ts` is #3468-owned and NOT edited. The `buildVecOrClosure*`
 * builders below emit the vec-carrier branch FIRST and fall through to the
 * UNCHANGED closure arm builders, so closure semantics are byte-preserved and
 * the two substrates stay independently owned.
 *
 * ## Reserve-then-fill (same funcIdx-ordering discipline as closure-props)
 * The helper bodies self-call `__extern_get`/`__extern_set` on the bag, whose
 * funcIdxs are not known while `ensureObjectRuntime` builds the arm bodies —
 * so the five helpers are reserved as `unreachable` stubs before the arms bake
 * their `call <idx>`, and filled at FINALIZE (`fillVecPropHelpers`), routed
 * through `funcMap` so the late-import index shifter stays in sync.
 *
 * ## Byte-neutrality
 * Everything is gated on `ctx.standalone || ctx.wasi` (via the reserve call
 * site). In gc/host mode the `env::__extern_*` host imports own the dynamic
 * property path and none of this is emitted — host output stays byte-identical.
 */
import type { FieldDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import {
  buildClosurePropGetMissArm,
  buildClosurePropMethodCallElseArm,
  buildClosurePropSetMissArm,
} from "./closure-props.js";
import { buildTransferredCharAtMethodArm } from "./char-at-transfer.js";
import { buildBuiltinFnSetRefusalArm } from "./carrier-bag-visibility.js"; // (#4010 S3) the -684 fix, at its source
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { protoIndexRecvGetMissInstrs } from "./proto-index-store.js"; // (#4176) inherited proto-named consult
import { addFuncType, getOrRegisterVecBaseType } from "./registry/types.js";

/** Reserved helper names. */
const IS_VEC_PROP_CARRIER = "__is_vec_prop_carrier";
const VEC_BAG_LOOKUP = "__vec_bag_lookup";
const VEC_BAG_ENSURE = "__vec_bag_ensure";
/**
 * (#4247) The two terminal bag accessors are EXPORTED so a caller that has
 * already decided, at compile time, that a key names an ordinary property can
 * address the bag directly.
 *
 * Why direct addressing is required rather than "just call `__extern_set`":
 * `__extern_set`/`__extern_get` carry a spliced `$__vec_base` prologue that
 * runs `__unbox_number(key)` first and, when that is not NaN, handles the key
 * TERMINALLY as a vec element (in-bounds → `array.set`; anything else → silent
 * no-op) without ever reaching this bag. In standalone `__unbox_number` parses
 * NATIVE STRINGS (StringToNumber, registry/imports.ts), so even the string
 * spelling `"4294967295"` is eaten by that prologue. That is right for an
 * ordinary index and wrong for a §10.4.2.2 non-index key, which is a named
 * property. `array-nonindex-key.ts` owns that distinction.
 */
export const VEC_PROP_GET = "__vec_prop_get";
export const VEC_PROP_SET = "__vec_prop_set";

/** $VecPropEntry field indices. */
const F_NEXT = 0;
const F_KEY = 1;
const F_BAG = 2;

/**
 * `__extern_get`'s non-object receiver arm: vec carrier → side-table read;
 * otherwise the UNCHANGED #3468 closure arm (which itself answers the
 * undefined-read sentinel for every other brand).
 */
export function buildVecOrClosurePropGetMissArm(ctx: CodegenContext, getMiss: () => Instr[]): Instr[] {
  const closureArm = buildClosurePropGetMissArm(ctx, getMiss);
  const isVecIdx = ctx.funcMap.get(IS_VEC_PROP_CARRIER);
  const vecGetIdx = ctx.funcMap.get(VEC_PROP_GET);
  if (isVecIdx === undefined || vecGetIdx === undefined) return closureArm;
  return [
    { op: "local.get", index: 0 }, // obj
    { op: "call", funcIdx: isVecIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 }, // obj
        { op: "local.get", index: 1 }, // key
        { op: "call", funcIdx: vecGetIdx },
        { op: "return" },
      ],
    },
    ...closureArm,
  ];
}

/**
 * `__extern_set`'s non-object receiver arm: vec carrier → side-table write.
 *
 * (#4010 S3) Headed by the BUILTIN-FN REFUSAL, which is the fix for the -684.
 * `name` / `length` on a builtin function value are `writable: false`, so
 * §10.1.9 OrdinarySet over them is a no-op — but before this the write fell
 * through to the #3468 closure bag and sat there invisibly, because the #2896
 * read arm shadowed it. `propertyHelper.isWritable` performs exactly that write
 * (`obj[name] = "unlikelyValue"`) BEFORE `isConfigurable` does
 * `delete obj[name]; return !hasOwnProperty(obj, name)` — so a bag-aware
 * `hasOwnProperty` answers `true` and ~700 files whose descriptor is
 * `configurable: true` fail. That dormant pollution, not the query widening, is
 * what cost #4055 v1 **-684** host-free passes. `__builtinfn_get_meta` is
 * non-null exactly while the metadata property is live, so after
 * `delete fn.name` the refusal stops applying and an assignment lands — also
 * what the spec says. See carrier-bag-visibility.ts.
 */
export function buildVecOrClosurePropSetMissArm(ctx: CodegenContext): Instr[] {
  // The refusal heads the WHOLE arm, before the vec branch: it is a no-op for a
  // vec receiver (`__builtinfn_get_meta` answers null), and putting it first
  // states the §10.1.9 precedence rather than relying on that coincidence.
  const refusal = buildBuiltinFnSetRefusalArm(ctx);
  const closureArm = buildClosurePropSetMissArm(ctx);
  const isVecIdx = ctx.funcMap.get(IS_VEC_PROP_CARRIER);
  const vecSetIdx = ctx.funcMap.get(VEC_PROP_SET);
  if (isVecIdx === undefined || vecSetIdx === undefined) return [...refusal, ...closureArm];
  return [
    ...refusal,
    { op: "local.get", index: 0 }, // obj
    { op: "call", funcIdx: isVecIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 }, // obj
        { op: "local.get", index: 1 }, // key
        { op: "local.get", index: 2 }, // value
        { op: "call", funcIdx: vecSetIdx },
        { op: "return" },
      ],
    },
    ...closureArm,
  ];
}

/**
 * `__extern_method_call`'s non-object receiver arm: a vec carrying a
 * function-valued expando dispatches like the $Object path (`__extern_get`
 * resolves through the side table after the get-arm wiring; a miss normalizes
 * to null and `__apply_closure` keeps its legacy null no-op → undefined,
 * byte-equal to today's Slice-4 placeholder behavior for builtin vec methods).
 * Non-vec receivers fall through to the UNCHANGED #3468 closure arm.
 */
export function buildVecOrClosurePropMethodCallElseArm(
  ctx: CodegenContext,
  externGetIdx: number,
  applyClosureIdx: number,
  // (#4221) `__extern_method_call`'s absent-callee TypeError guard, threaded
  // down so the TERMINAL miss raises the same §13.3.6.2 step-5 error the
  // `$Object` arm already does. A FACTORY — a shared `Instr` object would be
  // double-remapped by the finalize walks.
  absentCalleeGuard: () => Instr[] = () => [],
): Instr[] {
  const closureArm = buildClosurePropMethodCallElseArm(ctx, externGetIdx, applyClosureIdx, absentCalleeGuard);
  const transferredCharAtArm = buildTransferredCharAtMethodArm(ctx, externGetIdx, applyClosureIdx);
  const isVecIdx = ctx.funcMap.get(IS_VEC_PROP_CARRIER);
  if (isVecIdx === undefined) return [...transferredCharAtArm, ...closureArm];
  return [
    ...transferredCharAtArm,
    { op: "local.get", index: 0 }, // recv
    { op: "call", funcIdx: isVecIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: 0 }, // recv
        { op: "local.get", index: 1 }, // name
        { op: "call", funcIdx: externGetIdx },
        ...(ctx.funcMap.has("__nullish_to_null")
          ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
          : []),
        { op: "local.get", index: 0 }, // thisArg
        { op: "local.get", index: 2 }, // args
        { op: "call", funcIdx: applyClosureIdx },
      ],
      else: closureArm,
    },
  ];
}

/**
 * Register the `$VecPropEntry` struct type + `$__vec_prop_head` global and
 * reserve the five vec-expando helper placeholders. Called from
 * `ensureObjectRuntime` right after `reserveClosurePropHelpers`, BEFORE the
 * `__extern_*` bodies bake their `call <idx>`. Idempotent
 * (`ctx.vecPropHelpersReserved`). Appends types/globals/funcs only — never
 * shifts an existing index.
 */
export function reserveVecPropHelpers(ctx: CodegenContext): void {
  if (ctx.vecPropHelpersReserved) return;

  // The shared array supertype every concrete `__vec_<kind>` subtypes (#2186).
  // Resolved at RESERVE time so the fill's `ref.test` never registers a type
  // at finalize.
  ctx.vecPropBaseTypeIdx = getOrRegisterVecBaseType(ctx);

  // --- $VecPropEntry struct: { next: (ref null self); key: eqref; bag: externref } ---
  const entryTypeIdx = ctx.mod.types.length;
  const entryFields: FieldDef[] = [
    // next — immutable; a prepend creates a NEW head whose next = old head.
    { name: "next", type: { kind: "ref_null", typeIdx: entryTypeIdx }, mutable: false },
    // key — the vec identity, narrowed to eqref. Compared with `ref.eq`.
    { name: "key", type: { kind: "eqref" }, mutable: false },
    // bag — the per-array own-property `$Object`, wrapped to externref.
    { name: "bag", type: { kind: "externref" }, mutable: false },
  ];
  ctx.mod.types.push({ kind: "struct", name: "$VecPropEntry", fields: entryFields });
  ctx.vecPropEntryTypeIdx = entryTypeIdx;

  // --- $__vec_prop_head : (mut ref null $VecPropEntry) = ref.null ---
  const headGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "$__vec_prop_head",
    type: { kind: "ref_null", typeIdx: entryTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: entryTypeIdx }],
  });
  ctx.vecPropHeadGlobalIdx = headGlobalIdx;

  // --- Reserve the five helper placeholders (filled by fillVecPropHelpers) ---
  const reserve = (name: string, params: ValType[], results: ValType[]): void => {
    if (ctx.funcMap.get(name) !== undefined) return;
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    const placeholder: WasmFunction = {
      name,
      typeIdx,
      locals: [],
      // Placeholder; filled at FINALIZE. `unreachable` is valid for any result
      // type if the fill is ever skipped.
      body: [{ op: "unreachable" }],
      exported: false,
    };
    pushDefinedFunc(ctx, funcIdx, placeholder);
    ctx.funcMap.set(name, funcIdx);
  };

  const externref: ValType = { kind: "externref" };
  reserve(IS_VEC_PROP_CARRIER, [externref], [{ kind: "i32" }]);
  reserve(VEC_BAG_LOOKUP, [externref], [externref]);
  reserve(VEC_BAG_ENSURE, [externref], [externref]);
  reserve(VEC_PROP_GET, [externref, externref], [externref]);
  reserve(VEC_PROP_SET, [externref, externref, externref], []);

  ctx.vecPropHelpersReserved = true;
}

/**
 * Fill the five reserved vec-expando helper bodies at FINALIZE, once
 * `__extern_get`/`__extern_set`/`__new_plain_object` are in `funcMap`. No-op
 * when never reserved (gc/host mode). Mirrors `fillClosurePropHelpers`.
 */
export function fillVecPropHelpers(ctx: CodegenContext): void {
  if (!ctx.vecPropHelpersReserved) return;

  const entryTypeIdx = ctx.vecPropEntryTypeIdx;
  const headGlobalIdx = ctx.vecPropHeadGlobalIdx;
  const vecBaseTypeIdx = ctx.vecPropBaseTypeIdx;
  if (entryTypeIdx === undefined || headGlobalIdx === undefined || vecBaseTypeIdx === undefined) return;

  const isVecIdx = ctx.funcMap.get(IS_VEC_PROP_CARRIER);
  const bagLookupIdx = ctx.funcMap.get(VEC_BAG_LOOKUP);
  const bagEnsureIdx = ctx.funcMap.get(VEC_BAG_ENSURE);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");
  const setDecideIdx = ctx.funcMap.get("__extern_set_decide");
  const setOwnIdx = ctx.funcMap.get("__extern_set_own");
  const setResultGlobalIdx = ctx.externSetResultGlobalIdx;

  const setBody = (name: string, locals: { name: string; type: ValType }[], body: Instr[]): void => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    fn.locals = locals;
    fn.body = body;
  };

  // The undefined-read sentinel, matching `__extern_get`'s `getMiss()` factory
  // (fresh arrays — shared Instr objects get double-remapped by finalize walks;
  // see reference_shared_instr_object_dce_double_remap).
  const getMiss = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];

  // ── __is_vec_prop_carrier(externref value) -> i32 ──
  // One `ref.test $__vec_base` — every concrete `__vec_<kind>` array struct
  // subtypes the shared base (#2186), unlike the per-subtype closure chain.
  setBody(
    IS_VEC_PROP_CARRIER,
    [],
    [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: vecBaseTypeIdx }],
  );

  // ── shared list-walk pieces (byte-mirror of closure-props) ──
  // Locals: 1 = recvEq (eqref), 2 = cur (ref null $VecPropEntry).
  const walkLocals: { name: string; type: ValType }[] = [
    { name: "__recvEq", type: { kind: "eqref" } },
    { name: "__cur", type: { kind: "ref_null", typeIdx: entryTypeIdx } },
  ];
  const walkLoop = (onHit: Instr[]): Instr => ({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: 2 },
          { op: "ref.is_null" },
          { op: "br_if", depth: 1 }, // cur == null → exit block
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_KEY },
          { op: "local.get", index: 1 }, // recvEq
          { op: "ref.eq" },
          { op: "if", blockType: { kind: "empty" }, then: onHit },
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_NEXT },
          { op: "local.set", index: 2 },
          { op: "br", depth: 0 }, // continue loop
        ],
      },
    ],
  });
  const narrowRecvToEq: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    // recv is guarded by __is_vec_prop_carrier at every call site, and a vec is
    // a struct ⇒ the cast to the concrete base is always safe (also narrower —
    // and therefore stricter — than closure-props' abstract-eq cast).
    { op: "ref.cast", typeIdx: vecBaseTypeIdx },
    { op: "local.set", index: 1 },
    { op: "global.get", index: headGlobalIdx },
    { op: "local.set", index: 2 },
  ];

  // ── __vec_bag_lookup(externref recv) -> externref ── (read; never creates)
  {
    const onHit: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_BAG },
      { op: "return" },
    ];
    setBody(VEC_BAG_LOOKUP, walkLocals, [...narrowRecvToEq, walkLoop(onHit), { op: "ref.null.extern" }]);
  }

  // ── __vec_bag_ensure(externref recv) -> externref ── (miss → allocate+prepend)
  if (newPlainObjectIdx !== undefined) {
    const ensureLocals: { name: string; type: ValType }[] = [
      ...walkLocals,
      { name: "__bag", type: { kind: "externref" } },
    ];
    const onHit: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: entryTypeIdx, fieldIdx: F_BAG },
      { op: "return" },
    ];
    setBody(VEC_BAG_ENSURE, ensureLocals, [
      ...narrowRecvToEq,
      walkLoop(onHit),
      // miss: bag = __new_plain_object()
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 3 },
      // head = struct.new $VecPropEntry { next: head, key: recvEq, bag }
      { op: "global.get", index: headGlobalIdx }, // next
      { op: "local.get", index: 1 }, // key (recvEq)
      { op: "local.get", index: 3 }, // bag
      { op: "struct.new", typeIdx: entryTypeIdx },
      { op: "global.set", index: headGlobalIdx },
      { op: "local.get", index: 3 }, // return bag
    ]);
  }

  // ── __vec_prop_get(externref obj, externref key) -> externref ──
  // (#4176) The final miss consults the proto-property companions RECEIVER-
  // AWARE (`__protoidx_get_r`: vec ⇒ Array.prototype's companion, then
  // Object.prototype's) — `Array.prototype.enumerable = true; arrObj.enumerable`
  // is the §8.10.5 inherited-descriptor-field idiom. The builder returns
  // `undefined` unless the store was reserved, so a flag-clear module keeps
  // this body byte-identical.
  if (isVecIdx !== undefined && bagLookupIdx !== undefined && externGetIdx !== undefined) {
    setBody(
      VEC_PROP_GET,
      [{ name: "__bag", type: { kind: "externref" } }],
      [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: isVecIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: bagLookupIdx },
            { op: "local.tee", index: 2 }, // bag
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 2 }, // bag
                { op: "local.get", index: 1 }, // key
                { op: "call", funcIdx: externGetIdx },
                { op: "return" },
              ],
            },
          ],
        },
        ...(protoIndexRecvGetMissInstrs(ctx, 0, 1) ?? getMiss()),
      ],
    );
  } else {
    setBody(VEC_PROP_GET, [], [...getMiss()]);
  }

  // ── __vec_prop_set(externref obj, externref key, externref value) -> () ──
  // Refuses `"length"` (the real vec length must never be shadowed by the
  // bag). Native-string classify per the `fillBuiltinFnMeta` pattern; a
  // non-string key can never be "length", so it stores directly.
  {
    const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
    const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
    const anyStrTypeIdx = ctx.anyStrTypeIdx;
    const canStore =
      isVecIdx !== undefined &&
      bagEnsureIdx !== undefined &&
      externSetIdx !== undefined &&
      strFlattenIdx !== undefined &&
      strEqualsIdx !== undefined &&
      anyStrTypeIdx >= 0;
    if (canStore) {
      const sharedSetAvailable =
        bagLookupIdx !== undefined &&
        setDecideIdx !== undefined &&
        setOwnIdx !== undefined &&
        setResultGlobalIdx !== undefined;
      // This helper is the named-expando lane, not ArraySetLength itself (the
      // dynamic length arm owns that physical property). Keep its historical
      // unsupported `"length"` no-op UNADMITTED: publishing REFUSED here would
      // make a strict dynamic write throw even though no descriptor/integrity
      // refusal was observed by this helper.
      const refusal: Instr[] = [{ op: "return" }];
      setBody(
        VEC_PROP_SET,
        sharedSetAvailable
          ? [
              { name: "__fkey", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
              { name: "__bag", type: { kind: "externref" } },
              { name: "__decision", type: { kind: "i32" } },
            ]
          : [{ name: "__fkey", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } }],
        [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: isVecIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
          // "length" exclusion: string key equal to "length" → refuse.
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "call", funcIdx: strFlattenIdx },
              { op: "local.set", index: 3 },
              { op: "local.get", index: 3 },
              { op: "ref.as_non_null" },
              ...nativeStringLiteralInstrs(ctx, "length"),
              { op: "call", funcIdx: strEqualsIdx },
              { op: "if", blockType: { kind: "empty" }, then: refusal },
            ],
          },
          ...(sharedSetAvailable
            ? ([
                // Existing bag before inherited lookup; do not allocate merely
                // to discover a native Array/Object prototype refusal.
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: bagLookupIdx! },
                { op: "local.set", index: 4 },
                { op: "local.get", index: 0 },
                { op: "local.get", index: 4 },
                { op: "local.get", index: 1 },
                { op: "local.get", index: 2 },
                { op: "call", funcIdx: setDecideIdx! },
                { op: "local.tee", index: 5 },
                { op: "i32.const", value: 2 },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 1 },
                    { op: "global.set", index: setResultGlobalIdx! },
                    { op: "return" },
                  ],
                },
                { op: "local.get", index: 5 },
                { op: "i32.const", value: 3 },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // This is a real nearest-descriptor refusal, not the
                    // helper's historical unsupported boundary.
                    { op: "i32.const", value: 2 },
                    { op: "global.set", index: setResultGlobalIdx! },
                    { op: "return" },
                  ],
                },
                { op: "local.get", index: 4 },
                { op: "ref.is_null" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: 0 },
                    { op: "call", funcIdx: bagEnsureIdx },
                    { op: "local.set", index: 4 },
                  ],
                },
                { op: "local.get", index: 4 },
                { op: "ref.is_null" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  // Allocation/representation failure remains the legacy
                  // unsupported no-op. It is not an OrdinarySet refusal.
                  then: [{ op: "return" }],
                },
                { op: "local.get", index: 4 },
                { op: "local.get", index: 1 },
                { op: "local.get", index: 2 },
                { op: "call", funcIdx: setOwnIdx! },
                { op: "global.set", index: setResultGlobalIdx! },
              ] satisfies Instr[])
            : ([
                // Legacy flag-clear path: direct own write through the bag.
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: bagEnsureIdx },
                { op: "local.get", index: 1 },
                { op: "local.get", index: 2 },
                { op: "call", funcIdx: externSetIdx },
              ] satisfies Instr[])),
        ],
      );
    } else {
      // Deps absent — keep the pre-#3537 semantics exactly: silent no-op.
      setBody(VEC_PROP_SET, [], []);
    }
  }
}
