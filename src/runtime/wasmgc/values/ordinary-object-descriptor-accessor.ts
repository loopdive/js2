// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import {
  descriptorFlagBit,
  descriptorTypeError,
  type OrdinaryDescriptorResources,
  type OrdinaryAccessorNonExtensible,
} from "./ordinary-object-descriptor-common.js";

export interface OrdinaryAccessorDescriptorResources extends OrdinaryDescriptorResources {
  readonly nonExtensible: OrdinaryAccessorNonExtensible;
}

/** Legacy carrier fields retain their real own-key check; ordinary tables require no extra lookup. */
function buildOrdinaryAccessorNonExtensible(
  resources: OrdinaryDescriptorResources,
  d: OrdinaryAccessorNonExtensible,
): Instr[] {
  const { objectTypeIdx } = resources;
  const { sealed: OBJ_FLAG_SEALED, frozen: OBJ_FLAG_FROZEN } = resources.flags;
  return d.ownKeyIdx === undefined
    ? descriptorTypeError(d.errors, 0)
    : [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: d.ownKeyIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 5 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
            { op: "i32.const", value: OBJ_FLAG_SEALED | OBJ_FLAG_FROZEN },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: descriptorTypeError(d.errors, 0),
            },
          ],
          else: descriptorTypeError(d.errors, 1),
        },
      ];
}

function buildOrdinaryAccessorExisting(d: OrdinaryAccessorDescriptorResources): Instr[] {
  const { objectTypeIdx, propEntryTypeIdx, objFindIdx, objInsertIdx, objGrowIdx } = d;
  const {
    enumerable: FLAG_ENUMERABLE,
    configurable: FLAG_CONFIGURABLE,
    accessor: FLAG_ACCESSOR,
    nonExtensible: OBJ_FLAG_NONEXTENSIBLE,
    noneHeap: NONE_HEAP,
  } = d.flags;
  const NATIVE_ATTR_MASK = FLAG_ENUMERABLE | FLAG_CONFIGURABLE;
  const ACC_HOST_ENUMERABLE_SPECIFIED = 16;
  const ACC_HOST_CONFIGURABLE_SPECIFIED = 32;
  const ACC_HOST_GET_SPECIFIED = 256;
  const ACC_HOST_SET_SPECIFIED = 512;
  return [
    // efl = e.flags
    { op: "local.get", index: 12 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: 13 },
    // non-configurable current → §10.1.6.3 step 7 rejections
    ...descriptorFlagBit(13, FLAG_CONFIGURABLE),
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // 7.a configurable:true requested
        ...descriptorFlagBit(10, ACC_HOST_CONFIGURABLE_SPECIFIED),
        ...descriptorFlagBit(10, 1 << 2),
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: descriptorTypeError(d.errors, 0),
        },
        // 7.b enumerable flip requested
        ...descriptorFlagBit(10, ACC_HOST_ENUMERABLE_SPECIFIED),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...descriptorFlagBit(10, 1 << 1),
            ...descriptorFlagBit(13, FLAG_ENUMERABLE),
            { op: "i32.ne" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: descriptorTypeError(d.errors, 1),
            },
          ],
        },
        // 7.c current is a data property → data→accessor conversion forbidden
        ...descriptorFlagBit(13, FLAG_ACCESSOR),
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: descriptorTypeError(d.errors, 2),
        },
        // 7.d/e [[Get]]/[[Set]] change (SameValue) forbidden
        { op: "local.get", index: 14 },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 2 },
            { op: "local.get", index: 12 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
            { op: "extern.convert_any" },
            { op: "call", funcIdx: d.sameValueIdx },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: descriptorTypeError(d.errors, 3),
            },
          ],
        },
        { op: "local.get", index: 15 },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 3 },
            { op: "local.get", index: 12 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
            { op: "extern.convert_any" },
            { op: "call", funcIdx: d.sameValueIdx },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: descriptorTypeError(d.errors, 4),
            },
          ],
        },
      ],
    },
    // merge flags: spec = (hf >> 3) & 6 (E/C only — accessors carry no W)
    // nf = (efl & ~0x0F) | ((efl & 6 & ~spec) | (hf & spec)) | FLAG_ACCESSOR
    // (locals 7/8 are scratch here; this path returns before grow uses them)
    { op: "local.get", index: 10 },
    { op: "i32.const", value: 3 },
    { op: "i32.shr_u" },
    { op: "i32.const", value: 6 },
    { op: "i32.and" },
    { op: "local.set", index: 7 },
    { op: "local.get", index: 13 },
    { op: "i32.const", value: 6 },
    { op: "i32.and" },
    { op: "local.get", index: 7 },
    { op: "i32.const", value: -1 },
    { op: "i32.xor" },
    { op: "i32.and" },
    { op: "local.get", index: 10 },
    { op: "local.get", index: 7 },
    { op: "i32.and" },
    { op: "i32.or" },
    { op: "local.set", index: 8 },
    { op: "local.get", index: 12 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 13 },
    { op: "i32.const", value: -16 },
    { op: "i32.and" },
    { op: "local.get", index: 8 },
    { op: "i32.or" },
    { op: "i32.const", value: FLAG_ACCESSOR },
    { op: "i32.or" },
    { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
    // halves: specified → overwrite; absent → preserve (a data entry's
    // slots are already null, so conversion data→accessor is covered)
    { op: "local.get", index: 14 },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 12 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 2 },
        { op: "any.convert_extern" },
        { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
      ],
    },
    { op: "local.get", index: 15 },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 12 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 3 },
        { op: "any.convert_extern" },
        { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
      ],
    },
    // converting data→accessor: the data value slot dies.
    ...descriptorFlagBit(13, FLAG_ACCESSOR),
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 12 },
        { op: "ref.as_non_null" },
        { op: "ref.null", typeIdx: NONE_HEAP },
        { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
      ],
    },
    // merged in place — return O.
    { op: "local.get", index: 0 },
    { op: "return" },
  ];
}

/** Ordinary arm only. The caller has put the real object/bag in local 6. */
export function buildOrdinaryObjectAccessorDescriptorBody(d: OrdinaryAccessorDescriptorResources): Instr[] {
  const { objectTypeIdx, propEntryTypeIdx, objFindIdx, objInsertIdx, objGrowIdx } = d;
  const {
    enumerable: FLAG_ENUMERABLE,
    configurable: FLAG_CONFIGURABLE,
    accessor: FLAG_ACCESSOR,
    nonExtensible: OBJ_FLAG_NONEXTENSIBLE,
    noneHeap: NONE_HEAP,
  } = d.flags;
  const NATIVE_ATTR_MASK = FLAG_ENUMERABLE | FLAG_CONFIGURABLE;
  const ACC_HOST_ENUMERABLE_SPECIFIED = 16;
  const ACC_HOST_CONFIGURABLE_SPECIFIED = 32;
  const ACC_HOST_GET_SPECIFIED = 256;
  const ACC_HOST_SET_SPECIFIED = 512;
  return [
    // o = cast<$Object>(any)
    { op: "local.get", index: 6 },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: 5 },
    // hf = trunc_s(flagsF64)
    { op: "local.get", index: 4 },
    { op: "i32.trunc_f64_s" },
    { op: "local.set", index: 10 },
    // getSpec/setSpec — legacy fallback: no bit 8/9 set ⇒ both specified.
    { op: "local.get", index: 10 },
    { op: "i32.const", value: ACC_HOST_GET_SPECIFIED | ACC_HOST_SET_SPECIFIED },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...descriptorFlagBit(10, ACC_HOST_GET_SPECIFIED),
        { op: "local.set", index: 14 },
        ...descriptorFlagBit(10, ACC_HOST_SET_SPECIFIED),
        { op: "local.set", index: 15 },
      ],
      else: [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: 14 },
        { op: "i32.const", value: 1 },
        { op: "local.set", index: 15 },
      ],
    },
    // nflags = (hf & (ENUMERABLE|CONFIGURABLE)) | FLAG_ACCESSOR
    { op: "local.get", index: 10 },
    { op: "i32.const", value: NATIVE_ATTR_MASK },
    { op: "i32.and" },
    { op: "i32.const", value: FLAG_ACCESSOR },
    { op: "i32.or" },
    { op: "local.set", index: 9 },
    // (#2992 S3) e = __obj_find(o, key) — existing live entry → validate + merge in place.
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: objFindIdx },
    { op: "local.tee", index: 12 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildOrdinaryAccessorExisting(d),
    },
    // NEW key on a non-extensible object → TypeError (§10.1.6.3 step 2,
    // matches the data-path preflight; previously a silent no-op).
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
    { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildOrdinaryAccessorNonExtensible(d, d.nonExtensible),
    },
    // load = o.count + o.tombstones ; cap = o.props.len ; grow at LF 0.7
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
    { op: "i32.add" },
    { op: "local.set", index: 8 },
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
    { op: "array.len" },
    { op: "local.set", index: 7 },
    // if (load + 1) * 10 >= cap * 7 → grow
    { op: "local.get", index: 8 },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "i32.const", value: 10 },
    { op: "i32.mul" },
    { op: "local.get", index: 7 },
    { op: "i32.const", value: 7 },
    { op: "i32.mul" },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 5 }, { op: "ref.as_non_null" }, { op: "call", funcIdx: objGrowIdx }],
    },
    // seq = o.nextSeq ; o.nextSeq = seq + 1  (#1837)
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 5 },
    { op: "local.set", index: 11 },
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 11 },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 5 },
    // __obj_insert(o, key, ref.null any, nflags, seq) — value slot stays null
    // for an accessor; this creates the entry (or updates flags in place) and
    // handles growth/tombstone reuse in one place.
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 1 },
    { op: "ref.null", typeIdx: NONE_HEAP },
    { op: "local.get", index: 9 },
    { op: "local.get", index: 11 },
    { op: "call", funcIdx: objInsertIdx },
    // e = __obj_find(o, key) — re-locate the just-inserted/updated entry to
    // write the accessor slots. (__obj_insert does not take get/set params.)
    // It is always non-null here: either we just created it, or the update-in-
    // place branch matched an existing live entry. The only way to get null is
    // a non-extensible object refusing a NEW key — in which case there are no
    // accessor slots to write, so the null-guarded if is a correct no-op.
    { op: "local.get", index: 5 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: objFindIdx },
    { op: "local.tee", index: 12 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // e.get = any.convert_extern(getter) ; e.set = any.convert_extern(setter)
        // A null externref (absent get/set) converts to a null anyref, which
        // GOPD reads back as `undefined` for that half of the descriptor.
        { op: "local.get", index: 12 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 2 },
        { op: "any.convert_extern" },
        { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
        { op: "local.get", index: 12 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 3 },
        { op: "any.convert_extern" },
        { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
        // e.value = null (clear any prior data value — accessors hold no value)
        { op: "local.get", index: 12 },
        { op: "ref.as_non_null" },
        { op: "ref.null", typeIdx: NONE_HEAP },
        { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
      ],
    },
    // return obj (host import returns O)
    { op: "local.get", index: 0 },
  ];
}
