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
import { TA_CTOR_KINDS } from "./registry/types.js";

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
        ...classifyKey,
        { op: "local.get", index: 4 }, // isName
        { op: "if", blockType: { kind: "empty" }, then: nameChain },
        { op: "local.get", index: 5 }, // isLen
        {
          op: "if",
          blockType: { kind: "empty" },
          // §23.2.5.1: every TypedArray constructor's `length` property is 3.
          then: [{ op: "f64.const", value: 3 }, { op: "call", funcIdx: boxNumIdx }, { op: "return" }],
        },
        // A `$__ta_ctor` receiver with any other key keeps the null-miss
        // default so `__extern_get`'s remaining ladder still runs.
      ],
    },
  );
}
