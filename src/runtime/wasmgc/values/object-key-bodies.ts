// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, TypeHandle, ValType } from "../../../wasm/model/instructions.js";

/** Already-reserved string/key coordinates. This module neither allocates nor looks up resources. */
export interface ObjectKeyResources {
  readonly anyStrTypeIdx: TypeHandle;
  readonly nativeStrTypeIdx: TypeHandle;
  readonly nativeStrRef: ValType;
  readonly strDataTypeIdx: TypeHandle;
  readonly symbolTypeIdx: TypeHandle;
  readonly symbolKeysEnabled: boolean;
  readonly strFlattenIdx: FuncHandle;
  readonly strEqualsIdx: FuncHandle;
}
export interface ObjectHashResources extends Omit<ObjectKeyResources, "strEqualsIdx"> {
  readonly hashedStrTypeIdx: TypeHandle;
  readonly nativeFirst: boolean;
}
export interface ObjectFindResources extends ObjectKeyResources {
  readonly objectTypeIdx: TypeHandle;
  readonly propMapTypeIdx: TypeHandle;
  readonly propEntryTypeIdx: TypeHandle;
  readonly keyEqualsIdx: FuncHandle;
  readonly objHashIdx: FuncHandle;
  readonly tombstoneFlag: number;
}

/** The registered prefix remains mutable until the legacy caller installs its late arm. */
export function buildObjectPropertyKeyPrefix(resources: {
  readonly anyStrTypeIdx: TypeHandle;
  readonly boxNumTypeIdx: TypeHandle;
  readonly unboxNumberIdx: FuncHandle;
  readonly numToStringIdx: FuncHandle;
}): Instr[] {
  const { anyStrTypeIdx, boxNumTypeIdx, unboxNumberIdx, numToStringIdx } = resources;
  return [
    // any = any.convert_extern(key)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    // if (ref.test $AnyString any) return key unchanged
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "return" }],
    },
    // else if (boxed number) return number_toString(__unbox_number(key))
    ...(boxNumTypeIdx >= 0
      ? ([
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: boxNumTypeIdx },
          // (#3673) …or an i31-boxed small int (unbox helper handles both).
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: -20 },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: unboxNumberIdx },
              { op: "call", funcIdx: numToStringIdx },
              { op: "return" },
            ],
          },
        ] satisfies Instr[])
      : []),
    // #2042 R2 — object-key arm. A computed access with an OBJECT key
    // (`obj[{valueOf:()=>2}]`) reaches here as a `$Object` externref; the
    // downstream `ref.cast $AnyString` in `__obj_find`/`__obj_hash` then traps
    // ("illegal cast"). Run the object through `__extern_toString` (§7.1.1
    // ToPrimitive(string) → ToString — the same canonical ToString used by
    // `String(x)` / template literals), yielding the canonical string key.
    // `__extern_toString` is registered LATER in this same `ensureObjectRuntime`
    // pass, so the call is spliced in below once its funcIdx is known (the body
    // array is held by reference in `mod.functions`). The splice goes BEFORE
    // the unchanged-fallthrough so non-object opaque keys (Symbols) still
    // pass through untouched.
    // <<R2-OBJECT-ARM-SPLICE>>
    // else return key unchanged (Symbol / opaque — preserve existing behaviour)
    { op: "local.get", index: 0 },
  ];
}

export function prependObjectKeyCoercion(
  toPropertyKeyIdx: FuncHandle | undefined,
  keyParamIdx: number,
  body: Instr[],
): Instr[] {
  return toPropertyKeyIdx === undefined
    ? body
    : [
        { op: "local.get", index: keyParamIdx },
        { op: "call", funcIdx: toPropertyKeyIdx },
        { op: "local.set", index: keyParamIdx },
        ...body,
      ];
}

/** Preserve both cached-hash mutations and the native-first no-Symbol stack shape. */
export function buildObjectHashBody(resources: ObjectHashResources): Instr[] {
  const {
    anyStrTypeIdx,
    nativeStrTypeIdx,
    nativeStrRef,
    strDataTypeIdx,
    hashedStrTypeIdx,
    symbolTypeIdx,
    symbolKeysEnabled,
    nativeFirst,
    strFlattenIdx,
  } = resources;
  const FNV_OFFSET = 0x811c9dc5 | 0;
  const FNV_PRIME = 0x01000193;
  return [
    // (#2866) keyAny = any.convert_extern(key). A Symbol key hashes by its i32
    // identity id (consistent with `__key_equals`'s id-compare); a string key
    // takes the FNV-1a path below. The two hash spaces may collide — open
    // addressing resolves any collision via `__key_equals`, so that is benign.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    // The standalone Symbol discriminator consumes the value left by tee.
    // Native-first JS deliberately has no Symbol carrier yet, so store
    // without leaving an otherwise-unconsumed anyref on the stack. Preserve
    // the compatibility lane's historical instruction stream exactly.
    {
      op: !symbolKeysEnabled && nativeFirst ? "local.set" : "local.tee",
      index: 7,
    },
    ...(symbolKeysEnabled
      ? ([
          { op: "ref.test", typeIdx: symbolTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 7 },
              { op: "ref.cast", typeIdx: symbolTypeIdx },
              { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 }, // $Symbol.id
              { op: "i32.const", value: 0x7fffffff },
              { op: "i32.and" },
              { op: "return" },
            ],
          },
        ] satisfies Instr[])
      : []),
    // str = flat key, or flatten(cast<$AnyString>(keyAny)) for a rope. The
    // dynamic object path overwhelmingly receives an already-flat slice;
    // inline flatten's first discriminator so that case avoids a helper call.
    { op: "local.get", index: 7 },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "local.tee", index: 8 },
    { op: "ref.test", typeIdx: nativeStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: nativeStrRef },
      then: [
        { op: "local.get", index: 8 },
        { op: "ref.cast", typeIdx: nativeStrTypeIdx },
      ],
      else: [{ op: "local.get", index: 8 }, { op: "ref.as_non_null" }, { op: "call", funcIdx: strFlattenIdx }],
    },
    { op: "local.tee", index: 1 },
    // (#3673 round 9) Cached-hash fast path: interned literal keys carry a
    // compile-time-baked FNV hash in the `$HashedString` subtype's field 3
    // (0 = uncomputed; else masked hash | sign bit). Most $Object probes use
    // constant keys, so this turns the O(len) FNV walk into one struct.get.
    ...(hashedStrTypeIdx >= 0
      ? ([
          { op: "ref.test", typeIdx: hashedStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx: hashedStrTypeIdx },
              { op: "struct.get", typeIdx: hashedStrTypeIdx, fieldIdx: 3 },
              { op: "local.tee", index: 6 },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 0x7fffffff },
                  { op: "i32.and" },
                  { op: "return" },
                ],
              },
            ],
          },
          { op: "local.get", index: 1 },
        ] satisfies Instr[])
      : []),
    // len = str.len ; off = str.off ; data = str.data
    { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 3 },
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: 4 },
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: 2 },
    // A one-code-unit transient key has no cache slot to populate and does
    // not need the generic counted loop. Cookie-style parsers commonly
    // materialize exactly this shape from `slice(start, end)` before a
    // dynamic object probe, so fold the single FNV step directly.
    { op: "local.get", index: 3 },
    { op: "i32.const", value: 1 },
    { op: "i32.eq" },
    ...(hashedStrTypeIdx >= 0
      ? ([
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: hashedStrTypeIdx },
          { op: "i32.eqz" },
          { op: "i32.and" },
        ] satisfies Instr[])
      : []),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: FNV_OFFSET },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 4 },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "i32.xor" },
        { op: "i32.const", value: FNV_PRIME },
        { op: "i32.mul" },
        { op: "i32.const", value: 0x7fffffff },
        { op: "i32.and" },
        { op: "return" },
      ],
    },
    // h = FNV_OFFSET ; i = 0
    { op: "i32.const", value: FNV_OFFSET },
    { op: "local.set", index: 6 },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 5 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i >= len break
            { op: "local.get", index: 5 },
            { op: "local.get", index: 3 },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            // h = (h ^ data[off + i]) * FNV_PRIME
            { op: "local.get", index: 6 },
            { op: "local.get", index: 2 },
            { op: "local.get", index: 4 },
            { op: "local.get", index: 5 },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "i32.xor" },
            { op: "i32.const", value: FNV_PRIME },
            { op: "i32.mul" },
            { op: "local.set", index: 6 },
            // i++
            { op: "local.get", index: 5 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 5 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // (#3673 round 9) Cache write-back: a `$HashedString` probe key (a
    // flatten-memoized flat copy) stores `(h & mask) | signbit` so its next
    // probe takes the fast path above. Interned literals never reach here
    // (their baked hash short-circuits).
    ...(hashedStrTypeIdx >= 0
      ? ([
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: hashedStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx: hashedStrTypeIdx },
              { op: "local.get", index: 6 },
              { op: "i32.const", value: 0x7fffffff },
              { op: "i32.and" },
              { op: "i32.const", value: -0x80000000 },
              { op: "i32.or" },
              { op: "struct.set", typeIdx: hashedStrTypeIdx, fieldIdx: 3 },
            ],
          },
        ] satisfies Instr[])
      : []),
    // return h & 0x7fffffff  (non-negative; masking happens at call sites too)
    { op: "local.get", index: 6 },
    { op: "i32.const", value: 0x7fffffff },
    { op: "i32.and" },
  ];
}

export function buildObjectKeyEqualsBody(resources: ObjectKeyResources): Instr[] {
  const { anyStrTypeIdx, symbolTypeIdx, strFlattenIdx, strEqualsIdx } = resources;
  return [
    { op: "local.get", index: 1 }, // searchIsSym
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        // symbol search: ref.test $Symbol(storedKey) && id == searchSymId
        { op: "local.get", index: 0 },
        { op: "ref.test", typeIdx: symbolTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 0 },
            { op: "ref.cast", typeIdx: symbolTypeIdx },
            { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 },
            { op: "local.get", index: 2 }, // searchSymId
            { op: "i32.eq" },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
      else: [
        // string search: ref.test $AnyString(storedKey) && str_equals(flatten(storedKey), fkey)
        { op: "local.get", index: 0 },
        { op: "ref.test", typeIdx: anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 0 },
            { op: "ref.cast", typeIdx: anyStrTypeIdx },
            { op: "call", funcIdx: strFlattenIdx },
            { op: "local.get", index: 3 }, // fkey (ref_null $NativeString)
            { op: "ref.as_non_null" },
            { op: "call", funcIdx: strEqualsIdx },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
    },
  ];
}

export function buildObjectKeyClassification(
  resources: ObjectKeyResources,
  keyParamIdx: number,
  searchAnyLocal: number,
  isSymLocal: number,
  symIdLocal: number,
  fkeyLocal: number,
): Instr[] {
  const { anyStrTypeIdx, nativeStrTypeIdx, symbolTypeIdx, symbolKeysEnabled, strFlattenIdx } = resources;
  return [
    { op: "local.get", index: keyParamIdx },
    { op: "any.convert_extern" },
    { op: "local.set", index: searchAnyLocal },
    ...(symbolKeysEnabled
      ? ([
          { op: "local.get", index: searchAnyLocal },
          { op: "ref.test", typeIdx: symbolTypeIdx },
          { op: "local.tee", index: isSymLocal },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: searchAnyLocal },
              { op: "ref.cast", typeIdx: symbolTypeIdx },
              { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: symIdLocal },
              { op: "ref.null", typeIdx: nativeStrTypeIdx },
              { op: "local.set", index: fkeyLocal },
            ],
            else: [
              { op: "local.get", index: searchAnyLocal },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "call", funcIdx: strFlattenIdx },
              { op: "local.set", index: fkeyLocal },
            ],
          },
        ] satisfies Instr[])
      : ([
          { op: "i32.const", value: 0 },
          { op: "local.set", index: isSymLocal },
          { op: "local.get", index: searchAnyLocal },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          { op: "local.set", index: fkeyLocal },
        ] satisfies Instr[])),
  ];
}

export function buildObjectKeyMatch(
  resources: ObjectKeyResources & { readonly propEntryTypeIdx: TypeHandle; readonly keyEqualsIdx: FuncHandle },
  entryLocal: number,
  isSymLocal: number,
  symIdLocal: number,
  fkeyLocal: number,
): Instr[] {
  const { anyStrTypeIdx, symbolKeysEnabled, strFlattenIdx, strEqualsIdx, propEntryTypeIdx, keyEqualsIdx } = resources;
  return symbolKeysEnabled
    ? [
        { op: "local.get", index: entryLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
        { op: "local.get", index: isSymLocal },
        { op: "local.get", index: symIdLocal },
        { op: "local.get", index: fkeyLocal },
        { op: "call", funcIdx: keyEqualsIdx },
      ]
    : [
        { op: "local.get", index: entryLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "call", funcIdx: strFlattenIdx },
        { op: "local.get", index: fkeyLocal },
        { op: "ref.as_non_null" },
        { op: "call", funcIdx: strEqualsIdx },
      ];
}

/** Own-table lookup only; a tombstone does not terminate collision probing. */
export function buildObjectFindBody(resources: ObjectFindResources): Instr[] {
  const { objectTypeIdx, propMapTypeIdx, propEntryTypeIdx, objHashIdx, tombstoneFlag } = resources;
  return [
    // (#2866) classify the search key → searchAny(8)/isSym(9)/symId(10)/fkey(7)
    ...buildObjectKeyClassification(resources, 1, 8, 9, 10, 7),
    // arr = o.props ; cap = arr.len ; mask = cap - 1
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
    { op: "local.tee", index: 2 },
    { op: "array.len" },
    { op: "local.tee", index: 3 },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: 4 },
    // i = hash(key) & mask
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: objHashIdx },
    { op: "local.get", index: 4 },
    { op: "i32.and" },
    { op: "local.set", index: 5 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // e = arr[i]
            { op: "local.get", index: 2 },
            { op: "local.get", index: 5 },
            { op: "array.get", typeIdx: propMapTypeIdx },
            { op: "local.tee", index: 6 },
            // if e == null → key absent → return null
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "ref.null", typeIdx: propEntryTypeIdx }, { op: "return" }],
            },
            // if !(e.flags & TOMBSTONE) && key_match(e.key) → return e  (#2866)
            { op: "local.get", index: 6 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
            { op: "i32.const", value: tombstoneFlag },
            { op: "i32.and" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...buildObjectKeyMatch(resources, 6, 9, 10, 7),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "local.get", index: 6 }, { op: "return" }],
                },
              ],
            },
            // i = (i + 1) & mask ; loop
            { op: "local.get", index: 5 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: 4 },
            { op: "i32.and" },
            { op: "local.set", index: 5 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "ref.null", typeIdx: propEntryTypeIdx },
  ];
}

/** Caller supplies a fresh hint sequence at the original late registration point. */
export function buildObjectPropertyKeyLateArm(resources: {
  readonly externToStringIdx: FuncHandle;
  readonly toPrimitiveIdx: FuncHandle;
  readonly symbolKeysEnabled: boolean;
  readonly symbolTypeIdx: TypeHandle;
  readonly stringHintInstrs: readonly Instr[];
}): Instr[] {
  const { externToStringIdx, toPrimitiveIdx, symbolKeysEnabled, symbolTypeIdx, stringHintInstrs } = resources;
  const toStringArm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: externToStringIdx },
    { op: "return" },
  ];
  const nonSymbolToStringArm: Instr[] = [
    // primitive = ToPrimitive(key, "string"); reuse parameter 0 so this
    // splice needs no additional local in the already-expanded helper.
    { op: "local.get", index: 0 },
    ...stringHintInstrs,
    { op: "call", funcIdx: toPrimitiveIdx },
    { op: "local.set", index: 0 },
    ...(symbolKeysEnabled
      ? ([
          // ToPropertyKey preserves a Symbol primitive instead of
          // applying ToString to it.
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: symbolTypeIdx },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 0 }, { op: "return" }] },
        ] satisfies Instr[])
      : []),
    ...toStringArm,
  ];
  return nonSymbolToStringArm;
}
