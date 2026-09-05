// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Finalize-time `$__ta_ctor` metadata arm for `__builtinfn_get_meta`.
 *
 * A TypedArray CONSTRUCTOR used as a first-class VALUE lowers to the per-kind
 * `$__ta_ctor` singleton (`{kind: i32}`, #3054 D). A dynamic property read on
 * that value (`for (TA of ctors) … TA.name`) routes through the standalone
 * `__extern_get` native, whose receiver ladder has no `$__ta_ctor` arm — the
 * read missed to null, and the test262 TypedArray harness's
 * `TA.name.slice(0, -5)` then trapped on the null string cast
 * (`illegal cast in __closure_*`, harness/testTypedArray-conversions.js
 * standalone; testWithTypedArrayConstructors' whole callback body was dead).
 *
 * `__extern_get` (and the other reflective readers) already consult
 * `__builtinfn_get_meta(v, key)` FIRST — the #2896 builtin-function
 * name/length metadata native, registered under `--target standalone` with a
 * null default body and spliced full at finalize (`fillBuiltinFnMeta`). This
 * fill splices the disjoint `$__ta_ctor` arm into the same native, so every
 * consumer of the meta consult resolves `ctor.name` (the spec ctor name,
 * §23.2.5) and `ctor.length` (3, §23.2.5.1) host-free. Same splice discipline
 * as `fillBuiltinFnMeta` (never rebuild a helper body at finalize; type
 * indices are rec-group stable; the one baked `call` reads funcMap at fill
 * time so later shifts adjust it like all others).
 *
 * No-op unless standalone AND a `$__ta_ctor` type was registered — modules
 * that never use a TA constructor as a value are byte-identical.
 */

import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { TA_CTOR_BYTES, TA_CTOR_KINDS } from "./registry/types.js";
import { ensureTypedArrayViewNativeProtoGlue } from "./array-object-proto.js";
import { buildLazyNativeProtoGetInstrs } from "./native-proto.js";
import { FNINST_BAG_OWNS, FNINST_TOMBSTONE } from "./function-instance-props.js";

/**
 * `{writable:false, enumerable:false, configurable:false}` — §23.2.6.2's
 * attribute set for a TypedArray constructor's `BYTES_PER_ELEMENT`. The generic
 * `__builtinfn_gopd` prologue pairs every `get_meta` hit with
 * `FLAG_CONFIGURABLE` (right for `name`/`length`, §10.2.x), so this property
 * needs its own descriptor arm spliced in FRONT of it or `verifyNotConfigurable`
 * fails on a property `delete` correctly refuses to remove.
 */
const FLAG_NONE = 0x00;

/** Splice the `$__ta_ctor` name/length arm into `__builtinfn_get_meta`. */
export function fillTaCtorGetMetaArm(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.taCtorTypeIdx < 0) return;
  const taCtorTypeIdx = ctx.taCtorTypeIdx;
  const getMetaFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_get_meta");
  if (!getMetaFn) return;
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (boxNumIdx === undefined || strFlattenIdx === undefined || strEqualsIdx === undefined || anyStrTypeIdx < 0) {
    return;
  }

  // Per-kind `name` chain: kind == k → "<CtorName>" (extern). The kind field is
  // immutable i32 field 0 of `$__ta_ctor`. An unknown kind (impossible — the
  // singletons are minted only from TA_CTOR_KINDS indices) misses to null.
  let nameChain: Instr[] = [{ op: "ref.null.extern" }, { op: "return" }];
  for (let k = TA_CTOR_KINDS.length - 1; k >= 0; k--) {
    // (#4490 wave 2) Int8Array kind 0 no longer has a `$__ta_ctor` value: its
    // constructor is the mutable `$Object` carrier, whose own-property store
    // is the sole source of `name`/`length` state. Keep this synthetic metadata
    // arm retired for this ctor while the remaining constructors use it.
    if (k === 0) continue;
    nameChain = [
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: taCtorTypeIdx },
      { op: "struct.get", typeIdx: taCtorTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: k },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...nativeStringLiteralInstrs(ctx, TA_CTOR_KINDS[k]!), { op: "extern.convert_any" }, { op: "return" }],
      },
      ...nameChain,
    ];
  }

  // Key classification into the native's registered locals (2=any 3=fkey
  // 4=isName 5=isLen) — same shape as fillBuiltinFnMeta's preamble; the two
  // fills may both run and their receiver guards are disjoint, so redundant
  // classification is at worst a dead store.
  const classifyKey: Instr[] = [
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
        ...nativeStringLiteralInstrs(ctx, "name"),
        { op: "call", funcIdx: strEqualsIdx },
        { op: "local.set", index: 4 },
        { op: "local.get", index: 3 },
        { op: "ref.as_non_null" },
        ...nativeStringLiteralInstrs(ctx, "length"),
        { op: "call", funcIdx: strEqualsIdx },
        { op: "local.set", index: 5 },
      ],
    },
  ];

  /**
   * `i32`: is param 1 the string `key`? Self-contained — reads only the key
   * PARAM, writes no local, so it composes with `classifyKey`'s local set
   * without needing a local slot this native has not registered. A non-string
   * key short-circuits to 0 before the flatten, so numeric-index reads on a
   * constructor value stay off the string path.
   *
   * A FACTORY (fresh `Instr` objects per call): the same shape is spliced into
   * three different function bodies, and aliasing one `Instr[]` across them
   * would double-remap on a later import shift.
   */
  const keyIs = (key: string): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "call", funcIdx: strFlattenIdx },
        { op: "ref.as_non_null" },
        ...nativeStringLiteralInstrs(ctx, key),
        { op: "call", funcIdx: strEqualsIdx },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];

  /**
   * `externref`: the boxed §23.2.6.2 `BYTES_PER_ELEMENT` for the receiver's
   * kind, or a null miss for an unknown kind (impossible — the singletons are
   * minted only from `TA_CTOR_KINDS` indices). Reads the receiver from the
   * PARAM rather than local 2 so the chain is safe to splice into
   * `__builtinfn_gopd`, whose local 2 is the descriptor value.
   */
  const bpeChain = (): Instr[] => {
    let chain: Instr[] = [{ op: "ref.null.extern" }];
    for (let k = TA_CTOR_KINDS.length - 1; k >= 0; k--) {
      chain = [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: taCtorTypeIdx },
        { op: "struct.get", typeIdx: taCtorTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: k },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [
            { op: "f64.const", value: TA_CTOR_BYTES[k] ?? 1 },
            { op: "call", funcIdx: boxNumIdx },
          ],
          else: chain,
        },
      ];
    }
    return chain;
  };

  /** `local.get 0; any.convert_extern; ref.test $__ta_ctor` — receiver guard. */
  const isTaCtor = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: taCtorTypeIdx },
  ];

  /**
   * (#5194 step 1) `externref`: the receiver kind's `<View>.prototype` glue
   * singleton — the SAME object `__extern_get`'s `$__ta_ctor` arm and
   * `Object.getPrototypeOf(new View())` yield, so `TA.prototype ===
   * Object.getPrototypeOf(new TA(0))` holds by `ref.eq`. A kind whose glue this
   * module never materialized falls through to a null miss, which keeps the
   * arm's shape identical to `bpeChain`'s.
   *
   * This fill runs AFTER `fillTaDynViewMopArms`, which materializes every
   * registered view glue, so the reads below are plain global consults.
   */
  const protoChain = (): Instr[] => {
    let chain: Instr[] = [{ op: "ref.null.extern" }];
    for (let k = TA_CTOR_KINDS.length - 1; k >= 0; k--) {
      const brand = ensureTypedArrayViewNativeProtoGlue(ctx, TA_CTOR_KINDS[k]!);
      const protoInstrs = brand === undefined ? null : buildLazyNativeProtoGetInstrs(ctx, brand);
      if (!protoInstrs) continue;
      chain = [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: taCtorTypeIdx },
        { op: "struct.get", typeIdx: taCtorTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: k },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: protoInstrs,
          else: chain,
        },
      ];
    }
    return chain;
  };

  // ── `prototype` (§23.2.6.2 `{writable:false, enumerable:false,
  // ── configurable:false}`) ────────────────────────────────────────────────
  // Claiming the key in `get_meta` is what makes `hasOwnProperty(TA,
  // "prototype")` true — `verifyProperty`'s very first assertion, so all nine
  // `TypedArrayConstructors/<Kind>/prototype.js` rows died on it even though
  // the descriptor itself already read correctly. It also routes `TA.prototype
  // = x` into the shared write refusal, which is the §23.2.6.2 non-writability.
  getMetaFn.body.splice(0, 0, ...isTaCtor(), {
    op: "if",
    blockType: { kind: "empty" },
    then: [
      ...keyIs("prototype"),
      { op: "if", blockType: { kind: "empty" }, then: [...protoChain(), { op: "return" }] },
    ],
  });

  // ── `BYTES_PER_ELEMENT` static (§23.2.6.2) ────────────────────────────────
  // Answering it from `get_meta` buys the VALUE, `hasOwnProperty`, and the
  // §23.2.6.2 `writable: false` write refusal (`buildBuiltinFnSetRefusalArm`
  // refuses any `__extern_set` whose key `get_meta` claims) in one arm. Int8Array
  // is NOT excluded here the way `name`/`length` are: its `$Object` carrier never
  // produces a `$__ta_ctor` value, so the receiver guard already declines for it
  // and a kind-0 arm is unreachable rather than wrong.
  getMetaFn.body.splice(0, 0, ...isTaCtor(), {
    op: "if",
    blockType: { kind: "empty" },
    then: [
      ...keyIs("BYTES_PER_ELEMENT"),
      { op: "if", blockType: { kind: "empty" }, then: [...bpeChain(), { op: "return" }] },
    ],
  });

  // `__builtinfn_gopd`'s generic prologue pairs every `get_meta` hit with
  // `FLAG_CONFIGURABLE`; `BYTES_PER_ELEMENT` is non-configurable, so its
  // descriptor is built HERE and returned before that prologue runs (this fill
  // is ordered after `fillBuiltinFnMeta`, and both splice at index 0, so this
  // arm lands in front).
  const gopdFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_gopd");
  const createDescIdx = ctx.funcMap.get("__create_descriptor");
  if (gopdFn && createDescIdx !== undefined) {
    gopdFn.body.splice(0, 0, ...isTaCtor(), {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...keyIs("BYTES_PER_ELEMENT"),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...bpeChain(),
            { op: "i32.const", value: FLAG_NONE },
            { op: "call", funcIdx: createDescIdx },
            { op: "return" },
          ],
        },
      ],
    });
    // (#5194 step 1) `prototype` is all-false too (§23.2.6.2), so it needs the
    // same front-spliced descriptor: once `get_meta` claims the key the generic
    // prologue would otherwise pair it with `FLAG_CONFIGURABLE` and
    // `verifyNotConfigurable` would fail on a property `delete` refuses.
    gopdFn.body.splice(0, 0, ...isTaCtor(), {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...keyIs("prototype"),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...protoChain(),
            { op: "i32.const", value: FLAG_NONE },
            { op: "call", funcIdx: createDescIdx },
            { op: "return" },
          ],
        },
      ],
    });
  }

  // ── `name` / `length` deletability (§10.2.x `configurable: true`) ─────────
  // `propertyHelper`'s `isConfigurable` is `delete obj[k]; return
  // !hasOwnProperty(obj, k)`, so a visible-but-undeletable `name` fails every
  // `verifyProperty` that names `configurable: true` — which is what
  // `TypedArrayConstructors/<Kind>/{name,length}.js` do. Tombstoning through the
  // SAME `__fninst_*` bag the closure arms use keeps one deletion substrate; the
  // bag is identity-keyed on the receiver's eqref, and `$__ta_ctor` is a plain
  // struct, so the generic registry arm serves it with no per-carrier slot.
  const bagOwnsIdx = ctx.funcMap.get(FNINST_BAG_OWNS);
  const tombstoneIdx = ctx.funcMap.get(FNINST_TOMBSTONE);
  const deleteFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_delete");
  if (deleteFn && tombstoneIdx !== undefined) {
    deleteFn.body.splice(0, 0, ...isTaCtor(), {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...keyIs("name"),
        ...keyIs("length"),
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: tombstoneIdx },
            // A failed ensure (no bag substrate) must NOT report "handled", or
            // `delete` would claim success while the property stays visible.
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 1 }, { op: "return" }],
            },
          ],
        },
      ],
    });
  }

  getMetaFn.body.splice(
    0,
    0,
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: 2 },
    { op: "local.get", index: 2 },
    { op: "ref.test", typeIdx: taCtorTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // Int8Array (kind 0) is intentionally excluded from the synthetic
        // metadata surface; its `$Object` carrier is handled by the ordinary
        // object runtime instead.
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: taCtorTypeIdx },
        { op: "struct.get", typeIdx: taCtorTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 0 },
        { op: "i32.ne" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...classifyKey,
            // The bag consult is what makes the synthetic `name`/`length` pair
            // DELETABLE: once the arm above tombstones the key, `get_meta` must
            // stop claiming it or `hasOwnProperty` would still answer true and
            // `isConfigurable` would report false.
            ...(bagOwnsIdx === undefined
              ? ([{ op: "i32.const", value: 0 }] satisfies Instr[])
              : ([
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 1 },
                  { op: "call", funcIdx: bagOwnsIdx },
                ] satisfies Instr[])),
            {
              op: "if",
              blockType: { kind: "empty" },
              // Deleted (or overwritten) — decline, and let the receiver's own
              // bag answer through the ordinary carrier-bag ladder.
              then: [],
              else: [
                { op: "local.get", index: 4 }, // isName
                { op: "if", blockType: { kind: "empty" }, then: nameChain },
                { op: "local.get", index: 5 }, // isLen
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  // §23.2.5.1: every TypedArray constructor's `length` is 3.
                  then: [{ op: "f64.const", value: 3 }, { op: "call", funcIdx: boxNumIdx }, { op: "return" }],
                },
              ],
            },
          ],
        },
        // A `$__ta_ctor` receiver with any other key keeps the null-miss
        // default so `__extern_get`'s remaining ladder still runs.
      ],
    },
  );
}
