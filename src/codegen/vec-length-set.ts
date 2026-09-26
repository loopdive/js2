// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Dynamic-path Array `length` WRITE + own-ness for `$__vec_base` receivers —
 * the ArraySetLength (§10.4.2.1) slice the #3251 overlay deferred ("`length`
 * keys keep the legacy no-op/miss — ArraySetLength is slice 3") and #3537's
 * `__vec_prop_set` explicitly refuses (its "length" exclusion arm).
 *
 * Trigger (test262 harness, `propertyhelper-verifywritable-array-length.js`):
 * propertyHelper's `isWritable(array, "length")` writes
 * `obj[name] = 2**32 - 1` through the dynamic lane — `__extern_set(vec,
 * "length", box(n))` — which was a silent no-op, so `writeSucceeded` read
 * false and `verifyWritable` reported a writable `length` as non-writable.
 * Its revert path also consults `__hasOwnProperty(array, "length")`, which
 * answered 0 (vec receivers only reach the expando bag), steering the revert
 * into `delete obj[name]` instead of restoring the old length.
 *
 * Three coordinated arms, mirroring the static `maybeEmitVecLengthDefine`
 * (array-length-define.ts) semantics on the dynamic chokepoints:
 *
 *  1. `__extern_set`: vec receiver + string key `"length"` → validate
 *     (integral, `0 ≤ n ≤ 2**32-1`; an invalid length stays the legacy no-op
 *     rather than the spec RangeError — minting an error constructor at
 *     FINALIZE shifts func indices, the #4221 hazard), then store
 *     `ToUint32(n)` into the `$__vec_base` length field. When the new length
 *     exceeds the backing capacity and is ≤ 16M (the static path's allocation
 *     guard), the concrete carrier's `$data` is reallocated + copied so the
 *     `length <= array.len(data)` invariant holds; huge-but-valid lengths
 *     (sparse territory) update the field only — exactly the static rule.
 *  2. `__hasOwnProperty` / `__object_hasOwn`: vec + `"length"` → 1. `length`
 *     IS an own property of every Array (§10.4.2); the bag-only route made
 *     `Object.prototype.hasOwnProperty.call(arr, "length")` lie. (`in` was
 *     already correct via `fillDynamicForinVecArms`'s `__extern_has` arm;
 *     `propertyIsEnumerable` stays 0 — `length` is non-enumerable.)
 *  3. The dynamic length READ (`fillDynamicForinVecArms`'s `__extern_get`
 *     `"length"` arm) converts UNSIGNED — see the one-word change there. A
 *     stored `2**32-1` reads back as `4294967295`, not `-1`; every ordinary
 *     length (< 2**31) is unchanged.
 *
 * Splice discipline: prepends at body[0] with appended locals (the
 * `fillExternGetErrorProps` pattern — never renumber), receiver-gated on
 * `ref.test $__vec_base` + string-key `"length"` so every other receiver/key
 * falls through byte-identically. Runs between `fillExternSetVecArms` and
 * `fillTaDynViewMopArms` (dyn-view arms must keep the front slot).
 * Standalone only (`ctx.externGetIdxReserved`); host output untouched.
 */
import type { Instr, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import {
  ARGUMENTS_LENGTH_ABSENT_FIELD,
  ARGUMENTS_LENGTH_OVERRIDE_FIELD,
  ARGUMENTS_LENGTH_VALUE_FIELD,
  buildArgumentsLengthAbsentTail,
  buildArgumentsLengthReviveCall,
} from "./arguments-length-brand.js"; // (#4658)
import { nativeStringLiteralInstrs, stringConstantExternrefInstrs } from "./native-strings.js";
import { buildArrayLikeToLengthFromExternref } from "./object-runtime-enumeration.js"; // (#6651 cluster H)
import { NON_ARRAY_BYTE_VEC_ELEM_KINDS } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { getArrTypeIdxFromVec, getOrRegisterVecBaseType } from "./registry/types.js";

/** `key == "length"` over an externref key (param `keyParam`); i32 on stack. */
function keyIsLengthInstrs(
  ctx: CodegenContext,
  keyParam: number,
  strFlattenIdx: number,
  strEqualsIdx: number,
): Instr[] {
  return [
    { op: "local.get", index: keyParam },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: keyParam },
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

export function fillVecLengthDynamicArms(ctx: CodegenContext): void {
  if (!ctx.externGetIdxReserved) return; // host imports own the dynamic path
  if (ctx.anyStrTypeIdx < 0) return;
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const unboxNumIdx = ctx.funcMap.get("__unbox_number");
  if (strFlattenIdx === undefined || strEqualsIdx === undefined || unboxNumIdx === undefined) return;
  // #4504's Reflect/strict wrappers observe the final state through this
  // channel. A valid write to Array's physical own `length` succeeds even
  // while the descriptor-aware runtime is active; invalid legacy no-ops leave
  // the channel UNADMITTED rather than masquerading as descriptor refusals.
  const setResultGlobalIdx = ctx.externSetResultGlobalIdx;
  const publishSuccess = (): Instr[] =>
    setResultGlobalIdx === undefined
      ? []
      : ([
          { op: "i32.const", value: 1 },
          { op: "global.set", index: setResultGlobalIdx },
        ] satisfies Instr[]);
  // §10.4.2.4 step 3 applies ToUint32(ToNumber(value)) — and ToNumber runs
  // ToPrimitive first, so `arr.length = new Number(1)` / `new String("1")` /
  // `new Boolean(false)` must unwrap through valueOf before the numeric
  // validation (test262 S15.4.5.1_A1.3_T1/T2). `__unbox_number` alone only
  // answers already-primitive boxes, so wrapper-object writes read as invalid
  // and silently no-oped. `__to_primitive` is a defined function whenever the
  // standalone object runtime is present; when it is absent (no object support
  // compiled in), wrapper objects cannot exist either, so the bare unbox is
  // still complete. Both funcs already exist at finalize — no minting, no
  // funcidx shift (the #4221 hazard this fill is written around).
  const toPrimIdx = ctx.funcMap.get("__to_primitive");
  if (toPrimIdx !== undefined) addStringConstantGlobal(ctx, "number");
  const toNumberInstrs: Instr[] =
    toPrimIdx !== undefined
      ? [
          ...stringConstantExternrefInstrs(ctx, "number"),
          { op: "call", funcIdx: toPrimIdx },
          { op: "call", funcIdx: unboxNumIdx },
        ]
      : [{ op: "call", funcIdx: unboxNumIdx }];
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  const findFn = (name: string) => ctx.mod.functions.find((f) => f.name === name);

  // ── 1. `__extern_set` ArraySetLength-lite arm ────────────────────────────
  const setFn = findFn("__extern_set");
  if (setFn) {
    // Concrete carriers for the grow-realloc arm (the fillExternSetVecArms
    // enumeration; kinds without an array-typed `$data` stay field-only).
    const seen = new Set<number>();
    const carriers: { typeIdx: number; arrTypeIdx: number }[] = [];
    for (const [elemKind, vecTypeIdx] of ctx.vecTypeMap.entries()) {
      if (NON_ARRAY_BYTE_VEC_ELEM_KINDS.has(elemKind)) continue;
      if (seen.has(vecTypeIdx)) continue;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      const arrDef = ctx.mod.types[arrTypeIdx];
      if (!arrDef || arrDef.kind !== "array") continue;
      seen.add(vecTypeIdx);
      carriers.push({ typeIdx: vecTypeIdx, arrTypeIdx });
    }
    carriers.sort((a, b) => a.typeIdx - b.typeIdx);

    // params: 0=obj 1=key 2=value ; appended locals
    const lAny = 3 + setFn.locals.length;
    const lN = lAny + 1;
    const lNew = lAny + 2;
    const lCap = lAny + 3;
    const lNewData = lAny + 4;
    setFn.locals.push(
      { name: "__veclen_any", type: { kind: "anyref" } },
      { name: "__veclen_n", type: { kind: "f64" } },
      { name: "__veclen_new", type: { kind: "i32" } },
      { name: "__veclen_cap", type: { kind: "i32" } },
      { name: "__veclen_newdata", type: { kind: "anyref" } },
    );

    // An arguments object's `length` is an ordinary, configurable data
    // property (§10.4.4), not the Array-exotic index-domain length carried by
    // the shared vec prefix.  In particular, propertyHelper writes the string
    // "unlikelyValue" through `__extern_set` while checking writability.  The
    // numeric ArraySetLength arm below must not feed that value through
    // `__unbox_number` and silently leave the old physical length unchanged.
    // Preserve the value in the nominal arguments subtype and let the dynamic
    // read arm return it.  The static member-set dispatcher has the same
    // fields/semantics; this is its runtime-keyed counterpart.
    const argumentsTypeIdx = ctx.structMap.get("__arguments_vec");
    const argumentsLengthWrite: Instr[] =
      argumentsTypeIdx === undefined
        ? []
        : [
            { op: "local.get", index: lAny },
            { op: "ref.test", typeIdx: argumentsTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: lAny },
                { op: "ref.cast", typeIdx: argumentsTypeIdx },
                { op: "local.get", index: 2 },
                { op: "struct.set", typeIdx: argumentsTypeIdx, fieldIdx: ARGUMENTS_LENGTH_VALUE_FIELD },
                { op: "local.get", index: lAny },
                { op: "ref.cast", typeIdx: argumentsTypeIdx },
                { op: "i32.const", value: 1 },
                { op: "struct.set", typeIdx: argumentsTypeIdx, fieldIdx: ARGUMENTS_LENGTH_OVERRIDE_FIELD },
                { op: "local.get", index: lAny },
                { op: "ref.cast", typeIdx: argumentsTypeIdx },
                { op: "i32.const", value: 0 },
                { op: "struct.set", typeIdx: argumentsTypeIdx, fieldIdx: ARGUMENTS_LENGTH_ABSENT_FIELD },
                ...publishSuccess(),
                { op: "return" },
              ],
            },
          ];

    const growArms: Instr[] = [];
    for (const { typeIdx, arrTypeIdx } of carriers) {
      growArms.push(
        { op: "local.get", index: lAny },
        { op: "ref.test", typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // cap = array.len(vec.data); grow only when cap < newLen.
            { op: "local.get", index: lAny },
            { op: "ref.cast", typeIdx },
            { op: "struct.get", typeIdx, fieldIdx: 1 },
            { op: "array.len" },
            { op: "local.tee", index: lCap },
            { op: "local.get", index: lNew },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // newData = array.new_default(newLen)
                { op: "local.get", index: lNew },
                { op: "array.new_default", typeIdx: arrTypeIdx },
                { op: "local.set", index: lNewData },
                // array.copy(newData, 0, vec.data, 0, cap)
                { op: "local.get", index: lNewData },
                { op: "ref.cast", typeIdx: arrTypeIdx },
                { op: "i32.const", value: 0 },
                { op: "local.get", index: lAny },
                { op: "ref.cast", typeIdx },
                { op: "struct.get", typeIdx, fieldIdx: 1 },
                { op: "i32.const", value: 0 },
                { op: "local.get", index: lCap },
                { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
                // vec.data = newData
                { op: "local.get", index: lAny },
                { op: "ref.cast", typeIdx },
                { op: "local.get", index: lNewData },
                { op: "ref.cast", typeIdx: arrTypeIdx },
                { op: "struct.set", typeIdx, fieldIdx: 1 },
              ],
            },
          ],
        },
      );
    }

    const arm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: lAny },
      { op: "ref.test", typeIdx: vecBaseIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...keyIsLengthInstrs(ctx, 1, strFlattenIdx, strEqualsIdx),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...argumentsLengthWrite,
              // n = ToNumber(ToPrimitive(value)); valid: integral ∧ 0 ≤ n ≤ 2**32-1.
              { op: "local.get", index: 2 },
              ...toNumberInstrs,
              { op: "local.tee", index: lN },
              { op: "f64.floor" },
              { op: "local.get", index: lN },
              { op: "f64.eq" }, // integral (false for NaN)
              { op: "local.get", index: lN },
              { op: "f64.const", value: 0 },
              { op: "f64.ge" },
              { op: "i32.and" },
              { op: "local.get", index: lN },
              { op: "f64.const", value: 4294967295 },
              { op: "f64.le" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // newLen = ToUint32(n) — unsigned trunc keeps 2**32-1 as the
                  // 0xFFFFFFFF bit pattern the unsigned read arm round-trips.
                  { op: "local.get", index: lN },
                  { op: "i32.trunc_sat_f64_u" },
                  { op: "local.set", index: lNew },
                  // GROW (n ≤ 16M): per-carrier realloc, the static path's
                  // allocation guard; huge valid lengths update the field only.
                  { op: "local.get", index: lN },
                  { op: "f64.const", value: 16777216 },
                  { op: "f64.le" },
                  { op: "if", blockType: { kind: "empty" }, then: growArms },
                  // vec.length = newLen
                  { op: "local.get", index: lAny },
                  { op: "ref.cast", typeIdx: vecBaseIdx },
                  { op: "local.get", index: lNew },
                  { op: "struct.set", typeIdx: vecBaseIdx, fieldIdx: 0 },
                  // (#4658) A store to `length` recreates the property after a
                  // §10.4.4 `delete args.length`; clear the tombstone so
                  // `hasOwnProperty` / gOPD see it again.
                  ...buildArgumentsLengthReviveCall(ctx, 0),
                  ...publishSuccess(),
                ],
              },
              // "length" on a vec is handled terminally (a valid write stored
              // above; an invalid one keeps the legacy lenient no-op — the
              // finalize-time RangeError is deferred, see the module doc).
              { op: "return" },
            ],
          },
        ],
      },
    ];
    setFn.body.splice(0, 0, ...arm);
  }

  // ── 2. `__hasOwnProperty` / `__object_hasOwn`: vec + "length" → 1 ───────
  // (#4658) …unless this is a branded `arguments` object whose `length` was
  // deleted. Called per function — the helper is a factory for the shared-Instr
  // reason its own doc gives.
  const absentTail = (): Instr[] => buildArgumentsLengthAbsentTail(ctx, 0);
  for (const name of ["__hasOwnProperty", "__object_hasOwn"]) {
    const fn = findFn(name);
    if (!fn) continue;
    // params: 0=obj 1=key ; appended local
    const hAny = 2 + fn.locals.length;
    fn.locals.push({ name: "__veclen_any", type: { kind: "anyref" } });
    const arm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: hAny },
      { op: "ref.test", typeIdx: vecBaseIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...keyIsLengthInstrs(ctx, 1, strFlattenIdx, strEqualsIdx),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // (#4658) §10.4.4 makes `length` configurable on an `arguments`
              // object, so a successful `delete args.length` must make this
              // answer 0 — `propertyHelper.isConfigurable` decides the
              // attribute by exactly that delete-then-hasOwn round trip. The
              // tombstone lives on the overlay companion; `[]` (and therefore
              // the unconditional 1 below) for any module that never branded an
              // arguments object, so Array receivers are byte-identical.
              ...absentTail(),
              { op: "i32.const", value: 1 },
              { op: "return" },
            ],
          },
        ],
      },
    ];
    fn.body.splice(0, 0, ...arm);
  }

  // ── 3. `__extern_length`: an arguments object's OWN ordinary `length` ─────
  spliceArgumentsExternLengthArm(ctx, findFn("__extern_length"));
}

/**
 * (#6651 cluster H) §10.4.4 — an arguments exotic object's `length` is an
 * ORDINARY data property, NOT the Array-exotic index-domain length the shared
 * `$__vec_base` prefix carries. `args.length = 6` (arm 1 above, and
 * `member-set-dispatch.ts`'s `argumentsLengthSetArm`) therefore records the
 * value in the `$__arguments_vec` override fields and deliberately leaves the
 * physical backing alone.
 *
 * `__extern_length` — the array-like length every generic spec loop reads
 * (`Array.prototype.concat`'s §23.1.3.1 walk, `Array.from`, the borrowed HOFs)
 * — read field 0 regardless, so it answered the PHYSICAL count for an arguments
 * object whose own `length` says something else. Measured on the branch base,
 * standalone: after `args.length = 6` on a 3-argument `arguments`,
 * `[].concat(args)` produced a THREE-element result where §23.1.3.1 wants six
 * (three values + three holes) — test262 `built-ins/Array/prototype/concat/
 * Array.prototype.concat_{sloppy-arguments,sloppy-arguments-with-dupes,
 * strict-arguments}.js`.
 *
 * The conversion is the shared §7.1.20 `ToLength(ToNumber(v))` the `$Object`
 * array-like arm uses, not a bare unbox: the stored value is an arbitrary JS
 * value (propertyHelper writes the string `"unlikelyValue"` through this very
 * path), and ToLength of a non-numeric one is 0 — never a fallback to the
 * physical count.
 *
 * The override bit is set ONLY by an explicit write/define, so an untouched
 * arguments object keeps the physical answer, and a module that never brands
 * one is byte-identical: the arm is not emitted at all.
 */
function spliceArgumentsExternLengthArm(ctx: CodegenContext, lenFn: WasmFunction | undefined): void {
  const argumentsTypeIdx = ctx.structMap.get("__arguments_vec");
  if (!lenFn || argumentsTypeIdx === undefined) return;
  const castArguments: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "ref.cast", typeIdx: argumentsTypeIdx },
  ];
  const arm: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "ref.test", typeIdx: argumentsTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...castArguments,
        { op: "struct.get", typeIdx: argumentsTypeIdx, fieldIdx: ARGUMENTS_LENGTH_OVERRIDE_FIELD },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...castArguments,
            { op: "struct.get", typeIdx: argumentsTypeIdx, fieldIdx: ARGUMENTS_LENGTH_VALUE_FIELD },
            ...buildArrayLikeToLengthFromExternref(ctx, ctx.symbolTypeIdx),
            { op: "return" },
          ],
        },
      ],
    },
  ];
  // `__extern_length`'s 3-instr preamble leaves the receiver in local 1
  // (`any`); locals 2..4 are the scratch the shared ToLength builder uses.
  // Splicing at 3 keeps that preamble first — the discipline
  // `fillExternArrayLikeStructArms` (#3169) follows — and lands this arm AHEAD
  // of the `$__vec_base` field-0 arm, which an arguments vec matches too.
  lenFn.body.splice(3, 0, ...arm);
}
