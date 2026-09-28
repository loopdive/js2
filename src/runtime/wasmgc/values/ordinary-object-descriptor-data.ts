// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import {
  descriptorFlagBit,
  descriptorTypeError,
  type OrdinaryDescriptorResources,
} from "./ordinary-object-descriptor-common.js";

/** Validate before any descriptor mutation, including all non-configurable transitions. */
function buildOrdinaryObjectDataPreflight(d: OrdinaryDescriptorResources): Instr[] {
  const { objectTypeIdx, propEntryTypeIdx, objFindIdx } = d;
  const {
    writable: FLAG_WRITABLE,
    enumerable: FLAG_ENUMERABLE,
    configurable: FLAG_CONFIGURABLE,
    accessor: FLAG_ACCESSOR,
    nonExtensible: OBJ_FLAG_NONEXTENSIBLE,
  } = d.flags;
  const HOST_WRITABLE_SPECIFIED = 8;
  const HOST_ENUMERABLE_SPECIFIED = 16;
  const HOST_CONFIGURABLE_SPECIFIED = 32;
  const HOST_HAS_VALUE = 128;
  return [
    // e = __obj_find(o, key)  (local 11)
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: objFindIdx },
    { op: "local.tee", index: 11 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      // current is undefined (new property): §10.1.6.3 step 2 — reject if the
      // object is non-extensible.
      then: [
        { op: "local.get", index: 4 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
        { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          // (#5316 r6) DELIBERATELY NOT guarded by the receiver-owns-the-key
          // predicate its accessor twin uses (`accNonExtensibleArm` below).
          // The guard was written here for symmetry, measured, and reverted:
          // it silenced the throw of
          // `Object.defineProperty(Object.freeze({existing:null}),"existing",
          // {value:2})`, which node throws and this arm correctly threw — so
          // the arm IS reachable for a frozen carrier receiver. A data→data
          // redefine of an existing property is legal on a merely
          // non-extensible or sealed object and illegal on a frozen one, so
          // relaxing the refusal by ownership alone is too coarse, and no
          // probe shows this arm refusing a define that must succeed. See the
          // r6 probe table in plan/issues/5316-*.md.
          then: descriptorTypeError(d.errors, 0),
        },
      ],
      // current exists: §10.1.6.3 step 4 — if current is non-configurable, gate
      // the forbidden transitions.
      else: [
        // efl = e.flags  (local 12)
        { op: "local.get", index: 11 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
        { op: "local.set", index: 12 },
        // if (efl & FLAG_CONFIGURABLE) == 0  → current is non-configurable
        ...descriptorFlagBit(12, FLAG_CONFIGURABLE),
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // 4.a: Desc specifies configurable:true → reject.
            ...descriptorFlagBit(9, HOST_CONFIGURABLE_SPECIFIED),
            ...descriptorFlagBit(9, 1 << 2), // configurable value bit
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: descriptorTypeError(d.errors, 1),
            },
            // 4.b: Desc specifies enumerable that differs from current → reject.
            ...descriptorFlagBit(9, HOST_ENUMERABLE_SPECIFIED),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...descriptorFlagBit(9, 1 << 1), // desc enumerable value
                ...descriptorFlagBit(12, FLAG_ENUMERABLE), // current enumerable
                { op: "i32.ne" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: descriptorTypeError(d.errors, 2),
                },
              ],
            },
            // 4.c: data↔accessor conversion. This is the DATA define path; if the
            // current entry is an accessor, converting it to data is forbidden.
            //
            // (#4491) …but only when Desc is NOT generic. Step 4.c reads "If
            // IsGenericDescriptor(Desc) is false and IsAccessorDescriptor(Desc)
            // is not IsAccessorDescriptor(current)" — a descriptor that mentions
            // neither [[Value]] nor [[Writable]] converts nothing, so
            // `Object.defineProperty(o, k, {})` (and an attributes-only
            // descriptor that agrees with the current attributes) over a
            // non-configurable accessor is a legal no-op, not a TypeError.
            // Steps 4.a/4.b above still reject a generic descriptor that asks
            // for configurable:true or a different enumerable, and step 5's
            // `keepAccessor` arm below already applies the generic case
            // correctly — this only removes a throw that pre-empted it
            // (`built-ins/Object/defineProperty/15.2.3.6-4-59`).
            ...descriptorFlagBit(9, HOST_HAS_VALUE),
            ...descriptorFlagBit(9, HOST_WRITABLE_SPECIFIED),
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...descriptorFlagBit(12, FLAG_ACCESSOR),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: descriptorTypeError(d.errors, 3),
                },
              ],
            },
            // 4.d: both data, current non-writable (FLAG_WRITABLE clear) → reject
            // a writable:true request OR a value change (SameValue).
            ...descriptorFlagBit(12, FLAG_WRITABLE),
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // writable false→true
                ...descriptorFlagBit(9, HOST_WRITABLE_SPECIFIED),
                ...descriptorFlagBit(9, 1 << 0), // desc writable value
                { op: "i32.and" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: descriptorTypeError(d.errors, 4),
                },
                // value change: Desc has a value (hasValue) AND
                // !SameValue(descValue, e.value) → reject.
                ...descriptorFlagBit(9, HOST_HAS_VALUE),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // __object_is(descValue (param 2), e.value)
                    { op: "local.get", index: 2 },
                    { op: "local.get", index: 11 },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                    { op: "extern.convert_any" },
                    { op: "call", funcIdx: d.sameValueIdx },
                    { op: "i32.eqz" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: descriptorTypeError(d.errors, 5),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/** Ordinary arm only. The caller has put the real object/bag in local 5. */
export function buildOrdinaryObjectDataDescriptorBody(
  d: OrdinaryDescriptorResources,
  undefinedAnyValue: readonly Instr[],
): Instr[] {
  const { objectTypeIdx, propEntryTypeIdx, objFindIdx, objInsertIdx, objGrowIdx } = d;
  const {
    writable: FLAG_WRITABLE,
    enumerable: FLAG_ENUMERABLE,
    configurable: FLAG_CONFIGURABLE,
    accessor: FLAG_ACCESSOR,
    nonExtensible: OBJ_FLAG_NONEXTENSIBLE,
    noneHeap: NONE_HEAP,
  } = d.flags;
  const NATIVE_ATTR_MASK = FLAG_WRITABLE | FLAG_ENUMERABLE | FLAG_CONFIGURABLE;
  const HOST_HAS_VALUE = 128;
  const HOST_WRITABLE_SPECIFIED = 8;
  return [
    // o = cast<$Object>(any)
    { op: "local.get", index: 5 },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: 4 },
    // hf = trunc_s(flagsF64)  (the host encoding is a small non-negative int)
    { op: "local.get", index: 3 },
    { op: "i32.trunc_f64_s" },
    { op: "local.set", index: 9 },
    // nflags = hf & (WRITABLE|ENUMERABLE|CONFIGURABLE)
    // Host value bits 0/1/2 line up with native FLAG_* bit positions, so a
    // direct mask is the translation. (Specified/hasValue/accessor bits 3-7
    // are dropped.)
    { op: "local.get", index: 9 },
    { op: "i32.const", value: NATIVE_ATTR_MASK },
    { op: "i32.and" },
    { op: "local.set", index: 8 },
    // #2042 S4 — ValidateAndApplyPropertyDescriptor preflight (throws on an
    // invalid (re)definition before any table mutation).
    ...buildOrdinaryObjectDataPreflight(d),
    // (#2992 S3) EXISTING live entry → §10.1.6.3 steps 5-10 in-place MERGE.
    // A partial descriptor must PRESERVE every unspecified attribute and the
    // current [[Value]]; the old blanket `__obj_insert` reset unspecified
    // attrs to false, clobbered the value with the (null) value param on a
    // flags-only define, and wiped FLAG_ACCESSOR off accessor properties
    // (15.2.3.6-4-82-*, -107, -75; the "obj.prop stays 2010" family).
    // e (local 11) and efl (local 12) were resolved by the preflight.
    { op: "local.get", index: 11 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // spec = (hf >> 3) & 7 — the host "specified" bits 3/4/5 shift onto
        // the native W/E/C bit positions 0/1/2 (locals 6/7 are scratch here;
        // the merge path returns before the grow section reuses them).
        { op: "local.get", index: 9 },
        { op: "i32.const", value: 3 },
        { op: "i32.shr_u" },
        { op: "i32.const", value: 7 },
        { op: "i32.and" },
        { op: "local.set", index: 6 },
        // mergedWEC = ((efl & 7) & ~spec) | (hf & spec)
        { op: "local.get", index: 12 },
        { op: "i32.const", value: 7 },
        { op: "i32.and" },
        { op: "local.get", index: 6 },
        { op: "i32.const", value: -1 },
        { op: "i32.xor" },
        { op: "i32.and" },
        { op: "local.get", index: 9 },
        { op: "local.get", index: 6 },
        { op: "i32.and" },
        { op: "i32.or" },
        { op: "local.set", index: 7 },
        // nf = (efl & ~0x0F) | mergedWEC  (clears W/E/C + FLAG_ACCESSOR;
        // any other entry bits are preserved)
        { op: "local.get", index: 12 },
        { op: "i32.const", value: -16 },
        { op: "i32.and" },
        { op: "local.get", index: 7 },
        { op: "i32.or" },
        { op: "local.set", index: 8 },
        // keepAccessor = existing accessor AND a GENERIC desc (no [[Value]],
        // no [[Writable]]) — §10.1.6.3 step 6: generic descs only touch
        // attributes, the accessor halves stay live.
        ...descriptorFlagBit(12, FLAG_ACCESSOR),
        { op: "local.get", index: 9 },
        { op: "i32.const", value: HOST_HAS_VALUE | HOST_WRITABLE_SPECIFIED },
        { op: "i32.and" },
        { op: "i32.eqz" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // flags-only update of an accessor: e.flags = nf | FLAG_ACCESSOR
            { op: "local.get", index: 11 },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 8 },
            { op: "i32.const", value: FLAG_ACCESSOR },
            { op: "i32.or" },
            { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          ],
          else: [
            // data result: e.flags = nf (FLAG_ACCESSOR cleared)
            { op: "local.get", index: 11 },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 8 },
            { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
            // [[Value]]: specified → overwrite; converting accessor→data →
            // canonical undefined; otherwise PRESERVE the current value.
            ...descriptorFlagBit(9, HOST_HAS_VALUE),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 11 },
                { op: "ref.as_non_null" },
                { op: "local.get", index: 2 },
                { op: "any.convert_extern" },
                { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
              ],
              else: [
                ...descriptorFlagBit(12, FLAG_ACCESSOR),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: 11 },
                    { op: "ref.as_non_null" },
                    ...structuredClone(undefinedAnyValue),
                    { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                  ],
                },
              ],
            },
            // converting accessor→data: clear the stale get/set slots.
            ...descriptorFlagBit(12, FLAG_ACCESSOR),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 11 },
                { op: "ref.as_non_null" },
                { op: "ref.null", typeIdx: NONE_HEAP },
                { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                { op: "local.get", index: 11 },
                { op: "ref.as_non_null" },
                { op: "ref.null", typeIdx: NONE_HEAP },
                { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
              ],
            },
          ],
        },
        // merged in place — return O.
        { op: "local.get", index: 0 },
        { op: "return" },
      ],
    },
    // load = o.count + o.tombstones ; cap = o.props.len ; grow at LF 0.7
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
    { op: "i32.add" },
    { op: "local.set", index: 7 },
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
    { op: "array.len" },
    { op: "local.set", index: 6 },
    // if (load + 1) * 10 >= cap * 7 → grow
    { op: "local.get", index: 7 },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "i32.const", value: 10 },
    { op: "i32.mul" },
    { op: "local.get", index: 6 },
    { op: "i32.const", value: 7 },
    { op: "i32.mul" },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 4 }, { op: "ref.as_non_null" }, { op: "call", funcIdx: objGrowIdx }],
    },
    // seq = o.nextSeq ; o.nextSeq = seq + 1  (#1837)
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 5 },
    { op: "local.set", index: 10 },
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 10 },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 5 },
    // __obj_insert(o, key, any.convert_extern(value), nflags, seq)
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "any.convert_extern" },
    { op: "local.get", index: 8 },
    { op: "local.get", index: 10 },
    { op: "call", funcIdx: objInsertIdx },
    // return obj (host import returns O)
    { op: "local.get", index: 0 },
  ];
}
