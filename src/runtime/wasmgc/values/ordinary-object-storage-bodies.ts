// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, TypeHandle } from "../../../wasm/model/instructions.js";
import { buildObjectKeyClassification, buildObjectKeyMatch, type ObjectFindResources } from "./object-key-bodies.js";

export interface OrdinaryObjectCreateResources {
  readonly objectTypeIdx: TypeHandle;
  readonly propMapTypeIdx: TypeHandle;
  readonly initialCapacity: number;
}
export interface OrdinaryObjectInsertResources extends ObjectFindResources {
  readonly noneHeap: TypeHandle;
  readonly nonExtensibleFlag: number;
}
export interface OrdinaryObjectGrowResources {
  readonly objectTypeIdx: TypeHandle;
  readonly propMapTypeIdx: TypeHandle;
  readonly propEntryTypeIdx: TypeHandle;
  readonly objInsertIdx: FuncHandle;
  readonly objFindIdx: FuncHandle;
  readonly tombstoneFlag: number;
  readonly accessorFlag: number;
}

/** Canonical storage construction; the compatibility caller keeps the default prototype encoding. */
export function buildOrdinaryObjectCreateBody(resources: OrdinaryObjectCreateResources): Instr[] {
  const { objectTypeIdx, propMapTypeIdx, initialCapacity: INITIAL_CAP } = resources;
  return [
    { op: "ref.null", typeIdx: objectTypeIdx }, // proto
    { op: "i32.const", value: INITIAL_CAP }, // props: array.new_default count
    { op: "array.new_default", typeIdx: propMapTypeIdx },
    { op: "i32.const", value: 0 }, // count
    { op: "i32.const", value: 0 }, // tombstones
    { op: "i32.const", value: 0 }, // flags
    { op: "i32.const", value: 0 }, // nextSeq (#1837)
    { op: "struct.new", typeIdx: objectTypeIdx },
    { op: "extern.convert_any" },
  ];
}

/** Canonical PropertyKey input; the legacy caller retains its existing coercion prefix. */
export function buildOrdinaryObjectInsertBody(resources: OrdinaryObjectInsertResources): Instr[] {
  const {
    objectTypeIdx,
    propMapTypeIdx,
    propEntryTypeIdx,
    objHashIdx,
    noneHeap: NONE_HEAP,
    nonExtensibleFlag: OBJ_FLAG_NONEXTENSIBLE,
    tombstoneFlag: FLAG_TOMBSTONE,
  } = resources;
  return [
    // (#2866) classify the search key → searchAny(12)/isSym(13)/symId(14)/fkey(10).
    // searchAny is the raw converted key (string OR $Symbol) — it is what gets
    // STORED into `$PropEntry.key`, preserving Symbol identity in the table.
    ...buildObjectKeyClassification(resources, 1, 12, 13, 14, 10),
    // arr = o.props ; cap = arr.len ; mask = cap - 1
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
    { op: "local.tee", index: 5 },
    { op: "array.len" },
    { op: "local.tee", index: 6 },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: 7 },
    // i = hash(key) & mask
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: objHashIdx },
    { op: "local.get", index: 7 },
    { op: "i32.and" },
    { op: "local.set", index: 8 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // e = arr[i]
            { op: "local.get", index: 5 },
            { op: "local.get", index: 8 },
            { op: "array.get", typeIdx: propMapTypeIdx },
            { op: "local.tee", index: 9 },
            // empty slot → create new entry here, UNLESS the object is
            // non-extensible (#1472 Phase B Blocker A Half 2). A
            // sealed/preventExtensions/frozen object refuses NEW keys per ES
            // §10.4.7 [[DefineOwnProperty]] extensibility check — sloppy no-op
            // (strict throw deferred to #1473). Updates of existing keys are
            // unaffected (they take the update-in-place branch below). A
            // frozen object never reaches __obj_insert via __extern_set (the
            // FROZEN gate there returns first), but __obj_insert is also
            // called during __obj_grow rehash — where the table is rebuilt
            // from existing live entries, all of which take the empty-slot
            // branch. We must NOT refuse those, so the gate is keyed on the
            // OBJECT's NON_EXTENSIBLE bit, which during a grow only matters
            // when a non-extensible object grows (it can't — no new key was
            // accepted, so load never rises to force a grow). Safe.
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // if o.flags & NON_EXTENSIBLE → refuse new key (return)
                { op: "local.get", index: 0 },
                { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
                { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
                { op: "i32.and" },
                { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
                // arr[i] = struct.new $PropEntry { searchAny, value, flags, seq,
                //                                   get=null, set=null }  (#2866:
                //   store the raw converted key — $AnyString or $Symbol)
                { op: "local.get", index: 5 },
                { op: "local.get", index: 8 },
                { op: "local.get", index: 12 },
                { op: "local.get", index: 2 },
                { op: "local.get", index: 3 },
                { op: "local.get", index: 4 }, // seq (#1837)
                { op: "ref.null", typeIdx: NONE_HEAP }, // get (#1888 S5) — data path: null
                { op: "ref.null", typeIdx: NONE_HEAP }, // set (#1888 S5) — data path: null
                { op: "struct.new", typeIdx: propEntryTypeIdx },
                { op: "array.set", typeIdx: propMapTypeIdx },
                // o.count++
                { op: "local.get", index: 0 },
                { op: "local.get", index: 0 },
                { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 2 },
                { op: "return" },
              ],
            },
            // occupied + LIVE + key matches → update in place  (#2866 key_match)
            ...buildObjectKeyMatch(resources, 9, 13, 14, 10),
            // AND not a tombstone
            { op: "local.get", index: 9 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
            { op: "i32.const", value: FLAG_TOMBSTONE },
            { op: "i32.and" },
            { op: "i32.eqz" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // e.value = value ; e.flags = flags ; return (update in place,
                // seq untouched — first-insertion order preserved per #1837)
                { op: "local.get", index: 9 },
                { op: "ref.as_non_null" },
                { op: "local.get", index: 2 },
                { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                { op: "local.get", index: 9 },
                { op: "ref.as_non_null" },
                { op: "local.get", index: 3 },
                { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                { op: "return" },
              ],
            },
            // collision → i = (i + 1) & mask ; loop
            { op: "local.get", index: 8 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: 7 },
            { op: "i32.and" },
            { op: "local.set", index: 8 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/** Rehash preserves entry order and both accessor halves; replacing props invalidates caches. */
export function buildOrdinaryObjectGrowBody(resources: OrdinaryObjectGrowResources): Instr[] {
  const {
    objectTypeIdx,
    propMapTypeIdx,
    propEntryTypeIdx,
    objInsertIdx,
    objFindIdx,
    tombstoneFlag: FLAG_TOMBSTONE,
    accessorFlag: FLAG_ACCESSOR,
  } = resources;
  return [
    // (#3673 round 21) No generation bump: a grow REPLACES `o.props`, and
    // every per-key cache hit `ref.eq`s the stored props array against the
    // live one — the replacement itself invalidates exactly this object's
    // cached entries.
    // old = o.props ; oldLen = old.len ; newCap = oldLen * 2
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
    { op: "local.tee", index: 1 },
    { op: "array.len" },
    { op: "local.tee", index: 4 },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.set", index: 2 },
    // o.props = new $PropMap[newCap] ; o.count = 0 ; o.tombstones = 0
    { op: "local.get", index: 0 },
    { op: "local.get", index: 2 },
    { op: "array.new_default", typeIdx: propMapTypeIdx },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: 0 },
    { op: "i32.const", value: 0 },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 2 },
    { op: "local.get", index: 0 },
    { op: "i32.const", value: 0 },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 3 },
    // for i in 0..oldLen: replay live entries
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 3 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 3 },
            { op: "local.get", index: 4 },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            // e = old[i]
            { op: "local.get", index: 1 },
            { op: "local.get", index: 3 },
            { op: "array.get", typeIdx: propMapTypeIdx },
            { op: "local.tee", index: 5 },
            // if e != null && !(e.flags & TOMBSTONE): re-insert
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 5 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                { op: "i32.const", value: FLAG_TOMBSTONE },
                { op: "i32.and" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // __obj_insert(o, extern.convert_any(e.key), e.value,
                    // e.flags, e.seq) — PRESERVE the original seq across the
                    // rehash so insertion order survives a resize (#1837)
                    { op: "local.get", index: 0 },
                    { op: "local.get", index: 5 },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                    { op: "extern.convert_any" },
                    { op: "local.get", index: 5 },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                    { op: "local.get", index: 5 },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                    { op: "local.get", index: 5 },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 3 }, // seq
                    { op: "call", funcIdx: objInsertIdx },
                    // __obj_insert preserves the common key/value/flags/seq
                    // fields but initializes accessor halves to null. During
                    // a rehash that would silently turn every existing
                    // accessor into a getter-less/setter-less property. Find
                    // the freshly inserted entry and copy both live halves.
                    { op: "local.get", index: 5 },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                    { op: "i32.const", value: FLAG_ACCESSOR },
                    { op: "i32.and" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: 0 },
                        { op: "local.get", index: 5 },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                        { op: "extern.convert_any" },
                        { op: "call", funcIdx: objFindIdx },
                        { op: "local.tee", index: 6 },
                        { op: "ref.is_null" },
                        { op: "i32.eqz" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: 6 },
                            { op: "ref.as_non_null" },
                            { op: "local.get", index: 5 },
                            { op: "ref.as_non_null" },
                            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                            { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                            { op: "local.get", index: 6 },
                            { op: "ref.as_non_null" },
                            { op: "local.get", index: 5 },
                            { op: "ref.as_non_null" },
                            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
                            { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            // i++
            { op: "local.get", index: 3 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 3 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}
