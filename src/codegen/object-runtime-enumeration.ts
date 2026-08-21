// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3274, subtask of #3182) Object-runtime **enumeration / array-like / object-static**
 * helper builders, extracted verbatim from `ensureObjectRuntime` in
 * `object-runtime.ts` as WAVE-B slice 2 of the mega-function decomposition.
 *
 * This module owns the registration of the native (`--target standalone`)
 * enumeration + array-like-index + Object static helpers:
 *
 *   - `__object_keys` / `__object_keys_forin`   (own enumerable string keys)
 *   - `__extern_length` / `__extern_get_idx` / `__extern_has_idx` (array-like index ops)
 *   - `__object_values` / `__object_entries`     (Object.values / Object.entries)
 *   - `__object_assign`                          (Object.assign)
 *   - `__object_is`                              (Object.is / SameValue)
 *
 * Pure relocation: the code is byte-for-byte identical to the inline block it
 * replaced, so the emitted Wasm is unchanged (proved via
 * `scripts/prove-emit-identity.mjs`). Everything it reads from the enclosing
 * `ensureObjectRuntime` scope is threaded in through `ObjectEnumerationHelperState`
 * so the `registerNative` call ORDER (and the minted func-index sequence) is
 * preserved exactly.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { getStringToNumberProvider, getToPrimitiveProvider } from "./coercion-engine.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { addUnionImportsViaRegistry } from "./shared.js";
import { getOrRegisterVecBaseType } from "./registry/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { buildExternGetIdxBody } from "./object-runtime.js";
import { bagKeysTail, buildBagPushKeys } from "./carrier-bag-visibility.js"; // (#4010 S3) carrier-bag key enumeration
// (#4160) prototype-index companion consult for the vec OOB Has (resolves to
// `undefined` unless `ctx.standalone && ctx.protoIndexDirty` reserved it).
import { protoIndexForInPushInstrs, protoIndexHasIdxInstrs } from "./proto-index-store.js";
import { stringExoticPushKeysPrologue } from "./string-exotic-own-props.js"; // (#4491) §10.4.3 own index keys

/**
 * Everything the enumeration/array-like/object-static block reads from the
 * enclosing `ensureObjectRuntime` scope.
 */
export interface ObjectEnumerationHelperState {
  registerNative: (
    name: string,
    paramTypes: ValType[],
    resultTypes: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ) => number;
  /** `ctx.standalone` — gates the native $Object array-like arms. */
  objArrayLikeArms: boolean;
  anyStrTypeIdx: number;
  propEntryTypeIdx: number;
  propMapTypeIdx: number;
  objectTypeIdx: number;
  objVecTypeIdx: number;
  objVecArrTypeIdx: number;
  objRefNull: ValType;
  propMapRef: ValType;
  entryRefNull: ValType;
  strFlattenIdx: number;
  strEqualsIdx: number;
  objVecNewIdx: number;
  objVecPushIdx: number;
  objOrderedIdx: number;
  objOrderedAllIdx: number;
  boundaryObjectKeysIdx?: number;
  boundaryObjectForInKeysIdx?: number;
  FLAG_ENUMERABLE: number;
  FLAG_TOMBSTONE: number;
}

/** Non-$Object for-in snapshot: admitted JS object, or carrier bag + prototype. */
function nonObjectForInKeysIf(ctx: CodegenContext, boundaryObjectForInKeysIdx?: number): Instr {
  return {
    op: "if",
    blockType: { kind: "empty" },
    then: [
      ...(boundaryObjectForInKeysIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: boundaryObjectForInKeysIdx },
            { op: "local.tee", index: 10 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 10 }, { op: "return" }],
            },
          ] satisfies Instr[])
        : []),
      ...buildBagPushKeys(ctx, { vecLocal: 7, includeNonEnum: false }),
      ...protoIndexForInPushInstrs(ctx, 0, 7, 8),
      { op: "local.get", index: 7 },
      { op: "return" },
    ],
  };
}

/**
 * Register the enumeration + array-like-index + Object-static native helpers.
 * Called once, in place, from `ensureObjectRuntime`.
 */
/**
 * (#2036 / #3317 / #4556, extracted from `buildObjectEnumerationHelpers` to fit
 * the function-size budget — behaviour unchanged) The array-like open-`$Object`
 * arm of standalone `__extern_length`: ToLength(Get(O, "length")) per §23.1.3,
 * so a borrowed `Array.prototype.<m>.call(arrayLike, …)` iterates correctly.
 *
 * Locals it uses, as registered by the caller: 1=any(anyref), 2=lenF64(f64),
 * 3=lenTrunc(f64), 4=primExt(externref, the ToPrimitive scratch).
 */
function buildObjectArrayLikeLengthArm(ctx: CodegenContext, objectTypeIdx: number): Instr[] {
  const MAX_SAFE = 9007199254740991; // 2^53 - 1
  const externGetIdx2036 = ctx.funcMap.get("__extern_get")!;
  const unboxIdx2036 = ctx.funcMap.get("__unbox_number")!;
  // (#4556) ToNumber, not just unbox. §7.1.20 ToLength is
  // `ToIntegerOrInfinity(ToNumber(Get(O,"length")))`, and ToNumber of an
  // OBJECT runs the observable ToPrimitive(v, number) walk —
  // `valueOf` then `toString`. A bare `__unbox_number` skips that walk
  // entirely: an accessor `length` returning `{toString(){…}}` answered
  // NaN → clamped 0 → the borrowed HOF loop ran zero iterations, and a
  // THROWING `toString` never threw at all (test262
  // `Array/prototype/{every,forEach}/15.4.4.1{6,8}-4-{9,11}`).
  //
  // The closed-struct sibling arm (`fillExternArrayLikeStructArms`,
  // #3317) already runs exactly this sequence for a ref-typed `length`
  // FIELD; this brings the open-`$Object` arm — the shape
  // `Object.defineProperty(obj,"length",{get(){…}})` produces — into
  // line with it, so the two cannot disagree.
  //
  // `__to_primitive` is identity on a primitive, so a plain numeric or
  // string `length` reaches the same clamp as before. When any of the
  // three helpers is missing the arm degrades to the previous
  // unbox-only read rather than emitting a call to a funcIdx that does
  // not exist.
  const toPrimIdx2036 = getToPrimitiveProvider(ctx);
  const typeofStrIdx2036 = ctx.funcMap.get("__typeof_string");
  const strToNumIdx2036 = getStringToNumberProvider(ctx);
  const L_PRIM = 4; // scratch externref local (registered below)
  const toNumberInstrs: Instr[] =
    toPrimIdx2036 !== undefined && typeofStrIdx2036 !== undefined && strToNumIdx2036 !== undefined
      ? [
          { op: "ref.null.extern" }, // hint: number/default (valueOf → toString)
          { op: "call", funcIdx: toPrimIdx2036 },
          { op: "local.tee", index: L_PRIM },
          { op: "call", funcIdx: typeofStrIdx2036 },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: [
              { op: "local.get", index: L_PRIM },
              { op: "call", funcIdx: strToNumIdx2036 },
            ],
            else: [
              { op: "local.get", index: L_PRIM },
              { op: "call", funcIdx: unboxIdx2036 },
            ],
          },
        ]
      : [{ op: "call", funcIdx: unboxIdx2036 }];
  return [
    { op: "local.get", index: 1 },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        // lenVal = __extern_get(v, "length")  (proto-walk + marshaling)
        { op: "local.get", index: 0 },
        ...nativeStringLiteralInstrs(ctx, "length"),
        { op: "extern.convert_any" },
        { op: "call", funcIdx: externGetIdx2036 },
        // ToLength: ToNumber (above — NaN for a non-numeric length),
        // then truncate + clamp to [0, 2^53-1].
        ...toNumberInstrs,
        { op: "local.tee", index: 2 },
        // if NaN → 0 (n != n)
        { op: "local.get", index: 2 },
        { op: "f64.ne" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [{ op: "f64.const", value: 0 }],
          else: [
            // trunc toward zero
            { op: "local.get", index: 2 },
            { op: "f64.trunc" },
            { op: "local.tee", index: 3 },
            // if <= 0 → 0
            { op: "f64.const", value: 0 },
            { op: "f64.le" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } },
              then: [{ op: "f64.const", value: 0 }],
              else: [
                // min(trunc, 2^53-1)
                { op: "local.get", index: 3 },
                { op: "f64.const", value: MAX_SAFE },
                { op: "f64.min" },
              ],
            },
          ],
        },
      ],
      else: [{ op: "f64.const", value: 0 }],
    },
  ];
}

export function buildObjectEnumerationHelpers(ctx: CodegenContext, s: ObjectEnumerationHelperState): void {
  const {
    registerNative,
    objArrayLikeArms,
    anyStrTypeIdx,
    propEntryTypeIdx,
    propMapTypeIdx,
    objectTypeIdx,
    objVecTypeIdx,
    objVecArrTypeIdx,
    objRefNull,
    propMapRef,
    entryRefNull,
    strFlattenIdx,
    strEqualsIdx,
    objVecNewIdx,
    objVecPushIdx,
    objOrderedIdx,
    objOrderedAllIdx,
    boundaryObjectKeysIdx,
    boundaryObjectForInKeysIdx,
    FLAG_ENUMERABLE,
    FLAG_TOMBSTONE,
  } = s;

  // ── __object_keys(externref obj) -> externref ────────────────────────────
  //
  // ES §20.1.2.18 / §10.1.11.1 — own enumerable string keys in
  // OrdinaryOwnPropertyKeys order: integer-index keys ascending first, then
  // string keys in insertion order. We delegate the filtering + ordering to
  // __obj_ordered (#1837), which returns a compacted $PropMap (live + enumerable
  // entries in spec order, trailing nulls), then push each entry's key into a
  // fresh $ObjVec. Non-$Object receivers return an empty $ObjVec (host returns []
  // for those that reach here; ToObject-throw on null/undefined is handled at the
  // call site).
  //
  // params: 0=obj(externref)
  // locals: 1=any(anyref) 2=o(ref null $Object) 3=arr(ordered ref $PropMap) 4=cap
  //         5=i 6=e(ref null $PropEntry) 7=vec(externref)
  {
    const body: Instr[] = [
      // vec = __objvec_new()
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      // (#4491) §10.4.3 String-exotic own INDEX keys — see the native's doc.
      ...stringExoticPushKeysPrologue(ctx, 7),
      // any = any.convert_extern(obj); if !$Object → an explicitly admitted
      // JS-owned object's own enumerable keys, otherwise the native carrier
      // bag's keys (or the empty vec).
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...(boundaryObjectKeysIdx !== undefined
            ? ([
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: boundaryObjectKeysIdx },
                { op: "local.tee", index: 8 },
                { op: "ref.is_null" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "local.get", index: 8 }, { op: "return" }],
                },
              ] satisfies Instr[])
            : []),
          ...bagKeysTail(ctx, { vecLocal: 7, includeNonEnum: false }),
        ],
      },
      // o = cast<$Object>(any) ; arr = __obj_ordered(o) ; cap = arr.len
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "call", funcIdx: objOrderedIdx },
      { op: "local.tee", index: 3 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
      // i = 0
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
              // if i >= cap break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // e = arr[i] ; ordered array is compacted — stop at first null
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // __objvec_push(vec, extern.convert_any(e.key))
              { op: "local.get", index: 7 },
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
              // i++ ; loop
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return vec
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__object_keys",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "vec", type: { kind: "externref" } },
        ...(boundaryObjectKeysIdx !== undefined
          ? [{ name: "boundaryKeys", type: { kind: "externref" } as ValType }]
          : []),
      ],
      body,
    );
  }

  // ── __object_keys_forin(externref obj) -> externref ──────────────────────
  //
  // #2964 — for-in enumeration over a dynamic `$Object`, INCLUDING inherited
  // enumerable string keys from the prototype chain (§14.7.5.9
  // EnumerateObjectProperties). `__object_keys` above is OWN-only (Object.keys
  // semantics); for-in must additionally walk `$proto` links and, at each
  // level, yield the enumerable own keys that are NOT shadowed by a
  // closer-level own property (enumerable OR non-enumerable — a non-enumerable
  // own property still shadows an inherited same-named key).
  //
  // Algorithm (per level, receiver → proto → …, until $proto is null):
  //   1. enumerable own keys (`__obj_ordered`, OrdinaryOwnPropertyKeys order —
  //      integer-index ascending then insertion order, #1837): yield each key
  //      not already in the `seen` set.
  //   2. ALL own keys (`__obj_ordered_all`, incl. non-enumerable): add each to
  //      `seen` so it shadows the same name at lower (proto) levels.
  // The `seen` set is a fresh empty `$Object` (null $proto) used purely as a
  // membership table via `__object_hasOwn`/`__extern_set` — this reuses the exact
  // key hashing + equality the property map uses, so there is no native-string
  // representation mismatch. The own-only test remains correct even after the
  // Object.prototype companion has gained properties of its own.
  //
  // params: 0=obj(externref)
  // locals: 1=any(anyref) 2=cur(ref null $Object) 3=arr(ref null $PropMap)
  //         4=cap(i32) 5=i(i32) 6=e(ref null $PropEntry) 7=vec(externref result)
  //         8=seen(externref scratch $Object) 9=keyExt(externref)
  {
    const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;
    const objectHasOwnIdx = ctx.funcMap.get("__object_hasOwn")!;
    const externSetIdx = ctx.funcMap.get("__extern_set")!;
    const body: Instr[] = [
      // vec = __objvec_new() ; seen = __new_plain_object()
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 8 },
      // (#4491) Same §10.4.3 index keys as `__object_keys` above, and it MUST
      // move in lockstep with it — `Object/keys/15.2.3.14-6-3` asserts the two
      // agree on a String object, so teaching only one turns a vacuous
      // both-empty pass into a real mismatch.
      ...stringExoticPushKeysPrologue(ctx, 7),
      // any = any.convert_extern(obj); if !$Object → the carrier bag's keys, else empty (#4010 S3)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      nonObjectForInKeysIf(ctx, boundaryObjectForInKeysIdx),
      // cur = cast<$Object>(any)
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 2 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if cur == null break out of levels
              { op: "local.get", index: 2 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // ---- yield enumerable own keys not already seen ----
              // arr = __obj_ordered(cur) ; cap = arr.len ; i = 0
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "call", funcIdx: objOrderedIdx },
              { op: "local.tee", index: 3 },
              { op: "array.len" },
              { op: "local.set", index: 4 },
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
                      // if i >= cap break
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 4 },
                      { op: "i32.ge_s" },
                      { op: "br_if", depth: 1 },
                      // e = arr[i] ; compacted — stop at first null
                      { op: "local.get", index: 3 },
                      { op: "ref.as_non_null" },
                      { op: "local.get", index: 5 },
                      { op: "array.get", typeIdx: propMapTypeIdx },
                      { op: "local.tee", index: 6 },
                      { op: "ref.is_null" },
                      { op: "br_if", depth: 1 },
                      // keyExt = extern.convert_any(e.key)
                      { op: "local.get", index: 6 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                      { op: "extern.convert_any" },
                      { op: "local.set", index: 9 },
                      // if __object_hasOwn(seen, keyExt) == 0 → __objvec_push(vec, keyExt)
                      { op: "local.get", index: 8 },
                      { op: "local.get", index: 9 },
                      { op: "call", funcIdx: objectHasOwnIdx },
                      { op: "i32.eqz" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 7 },
                          { op: "local.get", index: 9 },
                          { op: "call", funcIdx: objVecPushIdx },
                        ],
                      },
                      // i++ ; loop
                      { op: "local.get", index: 5 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 5 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // ---- mark ALL own keys (incl. non-enumerable) into `seen` ----
              // arr = __obj_ordered_all(cur) ; cap = arr.len ; i = 0
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "call", funcIdx: objOrderedAllIdx },
              { op: "local.tee", index: 3 },
              { op: "array.len" },
              { op: "local.set", index: 4 },
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
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 4 },
                      { op: "i32.ge_s" },
                      { op: "br_if", depth: 1 },
                      { op: "local.get", index: 3 },
                      { op: "ref.as_non_null" },
                      { op: "local.get", index: 5 },
                      { op: "array.get", typeIdx: propMapTypeIdx },
                      { op: "local.tee", index: 6 },
                      { op: "ref.is_null" },
                      { op: "br_if", depth: 1 },
                      { op: "local.get", index: 6 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                      { op: "extern.convert_any" },
                      { op: "local.set", index: 9 },
                      // if !__object_hasOwn(seen, keyExt) → __extern_set(seen, keyExt, keyExt)
                      { op: "local.get", index: 8 },
                      { op: "local.get", index: 9 },
                      { op: "call", funcIdx: objectHasOwnIdx },
                      { op: "i32.eqz" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 8 },
                          { op: "local.get", index: 9 },
                          { op: "local.get", index: 9 },
                          { op: "call", funcIdx: externSetIdx },
                        ],
                      },
                      { op: "local.get", index: 5 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 5 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // cur = cur.$proto ; loop
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      ...protoIndexForInPushInstrs(ctx, 0, 7, 8),
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__object_keys_forin",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "cur", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "vec", type: { kind: "externref" } },
        { name: "seen", type: { kind: "externref" } },
        { name: "keyExt", type: { kind: "externref" } },
        ...(boundaryObjectForInKeysIdx !== undefined
          ? [{ name: "boundaryKeys", type: { kind: "externref" } as ValType }]
          : []),
      ],
      body,
    );
  }

  // ── __extern_length(externref v) -> f64 ──────────────────────────────────
  //
  // Standalone numeric "length". Recognises a wrapped $ObjVec (enumeration
  // result) and returns its f64 len. #2036: ALSO recognises a real array-like
  // `$Object` ({0:x, length:n}) — ToLength(Get(O, "length")) per §23.1.3 so
  // borrowed Array.prototype generics (`indexOf.call(arrayLike, …)`) iterate
  // correctly. Any other value returns 0 (matches the host import fallback).
  //
  // params: 0=v(externref) ; locals: 1=any(anyref) 2=lenF64(f64) 3=lenTrunc(f64)
  {
    const MAX_SAFE = 9007199254740991; // 2^53 - 1
    // #2036 — array-like $Object arm (standalone only): ToLength(Get(O,"length")).
    // In gc/host mode the host `__extern_length` JS import owns this path, so the
    // arm is omitted and the body stays the original $ObjVec-or-0 to keep host
    // output byte-identical.
    const objLengthArm: Instr[] = objArrayLikeArms
      ? buildObjectArrayLikeLengthArm(ctx, objectTypeIdx)
      : [{ op: "f64.const", value: 0 }];
    // (#2186) `$__vec_base` arm: a real array literal / array result boxed to
    // externref is a `__vec_<elemKind>` struct subtyping `$__vec_base`. Its
    // length (field 0) is readable through the shared supertype regardless of
    // element kind — fixing `.length` === 0 for arrays read through the externref
    // boundary (e.g. `const a:any = [1,2,3]; a.length`). Checked BEFORE the
    // $ObjVec arm (a vec is not an $ObjVec). `objArrayLikeArms` (standalone) gates
    // this since host mode's `__extern_length` import owns the path.
    const vecBaseIdx = objArrayLikeArms ? getOrRegisterVecBaseType(ctx) : -1;
    const vecBaseArm: Instr[] = objArrayLikeArms
      ? [
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: vecBaseIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx: vecBaseIdx },
              { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
              { op: "f64.convert_i32_s" },
              { op: "return" },
            ],
          },
        ]
      : [];
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 },
      ...vecBaseArm,
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: objVecTypeIdx },
          { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
          { op: "f64.convert_i32_s" },
        ],
        else: objLengthArm,
      },
    ];
    registerNative(
      "__extern_length",
      [{ kind: "externref" }],
      [{ kind: "f64" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "lenF64", type: { kind: "f64" } },
        { name: "lenTrunc", type: { kind: "f64" } },
        // (#4556) local 4 — the ToPrimitive scratch used by the `$Object`
        // ToNumber walk above AND by the closed-struct arms
        // `fillExternArrayLikeStructArms` splices in later (#3317). Registering
        // it HERE gives both a single, stable slot; the fill locates it by NAME
        // so the two can never claim different indices.
        { name: "primExt", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __extern_get_idx(externref v, f64 idx) -> externref ───────────────────
  //
  // Standalone indexed read. Recognises a wrapped $ObjVec and returns
  // data[i32(idx)] when 0 <= idx < len; otherwise null. Any non-$ObjVec value
  // returns null (matches the host import's null/undefined fallback).
  //
  // params: 0=v(externref) 1=idx(f64) ; locals: 2=any(anyref) 3=vec(ref null $ObjVec) 4=i
  {
    // The array-like `$Object` arm (#2036) + the $ObjVec/typed-vec arms are all
    // built by the shared `buildExternGetIdxBody` builder below — the `$Object`
    // arm returns `__extern_get(v, number_toString(idx))` (the canonical decimal
    // key, NOT a truncated one — see #2551). number_toString is canonical
    // Number::toString, matching how `{0:x}` stores numeric-literal keys.
    // (#2190) The per-element-kind `__vec_<k>` indexing arms are NOT known yet
    // (array literals of a given element kind may be compiled AFTER this
    // runtime is emitted). They are appended at FINALIZE by
    // `fillExternGetIdxVecArms` — which rebuilds this whole body via the shared
    // `buildExternGetIdxBody` builder with the now-complete carrier set. Here we
    // bake the body WITHOUT vec arms (empty list) and flag the reserve.
    const body = buildExternGetIdxBody({
      objArrayLikeArms,
      objectTypeIdx,
      objVecTypeIdx,
      objVecArrTypeIdx,
      numberToStringIdx: objArrayLikeArms ? ctx.funcMap.get("number_toString")! : -1,
      externGetIdx: objArrayLikeArms ? ctx.funcMap.get("__extern_get")! : -1,
      vecArms: [],
      // (#2106 S1) OOB / non-indexable miss = undefined under the singleton
      // regime (`arr[oob] === undefined`), consistent with the `$Object` arm
      // which delegates to the (flipped) `__extern_get`. Legacy: null.
      missInstrs: () => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }],
    });
    registerNative(
      "__extern_get_idx",
      [{ kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "vec", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
    );
    // Reserve the typed-vec fill only in standalone (host mode's `__extern_get_idx`
    // JS import owns the path; registering arms there would shift funcMap indices).
    if (objArrayLikeArms) ctx.externGetIdxReserved = true;
  }
  const externSetIdx = ctx.funcMap.get("__extern_set")!;

  // ── __object_values(externref obj) -> externref ──────────────────────────
  //
  // ES §20.1.2.22 — own enumerable string-keyed values. Same hash-slot walk as
  // __object_keys but pushes each LIVE + enumerable entry's *value* (stored as
  // anyref; wrapped back to externref) into a fresh $ObjVec. Non-$Object
  // receivers return an empty $ObjVec (the ToObject-throw on null/undefined is
  // handled at the call site, matching __object_keys).
  //
  // params: 0=obj(externref)
  // locals: 1=any(anyref) 2=o(ref null $Object) 3=arr(ref $PropMap) 4=cap 5=i
  //         6=e(ref null $PropEntry) 7=vec(externref)
  {
    const body: Instr[] = [
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 7 }, { op: "return" }],
      },
      // o = cast<$Object>(any) ; arr = __obj_ordered(o) ; cap = arr.len (#1837)
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "call", funcIdx: objOrderedIdx },
      { op: "local.tee", index: 3 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
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
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // e = arr[i] ; compacted ordered array — stop at first null
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // __objvec_push(vec, extern.convert_any(e.value))
              { op: "local.get", index: 7 },
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__object_values",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "vec", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __object_entries(externref obj) -> externref ─────────────────────────
  //
  // ES §20.1.2.5 — own enumerable [key, value] pairs. Each entry is itself a
  // 2-element $ObjVec (key at idx 0, value at idx 1), wrapped to externref and
  // pushed into the outer $ObjVec. The native __extern_get_idx already indexes a
  // $ObjVec, so `entry[0]`/`entry[1]` in consuming code reads back correctly
  // without any host array. Non-$Object receivers return an empty $ObjVec.
  //
  // params: 0=obj(externref)
  // locals: 1=any(anyref) 2=o(ref null $Object) 3=arr(ref $PropMap) 4=cap 5=i
  //         6=e(ref null $PropEntry) 7=vec(externref) 8=pair(externref)
  {
    const body: Instr[] = [
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 7 }, { op: "return" }],
      },
      // o = cast<$Object>(any) ; arr = __obj_ordered(o) ; cap = arr.len (#1837)
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "call", funcIdx: objOrderedIdx },
      { op: "local.tee", index: 3 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
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
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // e = arr[i] ; compacted ordered array — stop at first null
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // pair = __objvec_new()
              { op: "call", funcIdx: objVecNewIdx },
              { op: "local.set", index: 8 },
              // __objvec_push(pair, extern.convert_any(e.key))
              { op: "local.get", index: 8 },
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
              // __objvec_push(pair, extern.convert_any(e.value))
              { op: "local.get", index: 8 },
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
              // __objvec_push(vec, pair)
              { op: "local.get", index: 7 },
              { op: "local.get", index: 8 },
              { op: "call", funcIdx: objVecPushIdx },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__object_entries",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "vec", type: { kind: "externref" } },
        { name: "pair", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __extern_has_idx(externref v, f64 idx) -> i32 ─────────────────────────
  //
  // Standalone HasProperty(O, ToString(idx)) for array-like indexed access.
  // Recognises a wrapped $ObjVec, a real array carrier (`$__vec_base`, #3183)
  // and an array-like `$Object`: present iff 0 <= i32(idx) < len. Any other
  // value returns 0 (matches the host import's null fallback).
  //
  // params: 0=v(externref) 1=idx(f64) ; locals: 2=any(anyref) 3=i
  {
    // #2036 — array-like $Object arm (standalone only): HasProperty(O,
    // ToString(idx)) so indexOf/forEach hole-skipping (§23.1.3 "HasProperty") is
    // correct — __extern_has does the proto-walk; a present-but-undefined entry
    // returns true while an absent (hole) index returns false. Omitted in
    // gc/host mode (the host import owns the path).
    const objHasArm: Instr[] = objArrayLikeArms
      ? [
          { op: "local.get", index: 2 },
          { op: "ref.test", typeIdx: objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "f64.trunc" },
              { op: "call", funcIdx: ctx.funcMap.get("number_toString")! },
              { op: "call", funcIdx: ctx.funcMap.get("__extern_has")! },
              { op: "return" },
            ],
          },
        ]
      : [];
    // (#3183) `$__vec_base` arm: a real array literal / array result boxed to
    // externref is a `__vec_<elemKind>` struct subtyping `$__vec_base`, which is
    // NOT a `$ObjVec` — so without this arm a numeric HasProperty on an
    // any-typed vec (`n in arr`, or the for-in liveness guard's index probe via
    // `__extern_has`'s #3183 arm) answered 0. Length (field 0) is readable
    // uniformly through the supertype regardless of element kind (mirrors the
    // #2186 `__extern_length` arm); present iff 0 <= trunc_sat(idx) < len.
    // Checked before the `$ObjVec` arm (a vec is not an $ObjVec, so the $ObjVec
    // fast path is untouched). Standalone-gated; host import owns the path in
    // gc/host mode.
    const vecBaseHasIdx = objArrayLikeArms ? getOrRegisterVecBaseType(ctx) : -1;
    // (#4160) Under `protoIndexDirty`, an OOB index on a real array is a
    // prototype lookup (§7.3.12 walks the chain; the chain is
    // Array.prototype → Object.prototype), so the miss consults the
    // prototype-index companions instead of answering a constant 0. In-bounds
    // stays the dense-presence answer, byte-for-byte. `protoHasConsult` is
    // `undefined` for every flag-clear / host compile → the exact
    // pre-existing `i32.and; return` tail is emitted.
    const protoHasConsult = objArrayLikeArms ? protoIndexHasIdxInstrs(ctx, 1, 1) : undefined;
    const vecHasArm: Instr[] = objArrayLikeArms
      ? [
          { op: "local.get", index: 2 },
          { op: "ref.test", typeIdx: vecBaseHasIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "i32.trunc_sat_f64_s" },
              { op: "local.tee", index: 3 },
              { op: "i32.const", value: 0 },
              { op: "i32.ge_s" },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 2 },
              { op: "ref.cast", typeIdx: vecBaseHasIdx },
              { op: "struct.get", typeIdx: vecBaseHasIdx, fieldIdx: 0 },
              { op: "i32.lt_s" },
              { op: "i32.and" },
              ...(protoHasConsult === undefined
                ? []
                : ([
                    {
                      op: "if",
                      blockType: { kind: "val", type: { kind: "i32" } },
                      then: [{ op: "i32.const", value: 1 }],
                      else: protoHasConsult,
                    },
                  ] satisfies Instr[])),
              { op: "return" },
            ],
          },
        ]
      : [];
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 },
      ...objHasArm,
      ...vecHasArm,
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // i = i32(idx) ; if i < 0 → 0
      { op: "local.get", index: 1 },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.tee", index: 3 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // result = i < vec.len
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objVecTypeIdx },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
      { op: "i32.lt_s" },
    ];
    registerNative(
      "__extern_has_idx",
      [{ kind: "externref" }, { kind: "f64" }],
      [{ kind: "i32" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
    );
  }

  // ── __object_assign(externref target, externref sources) -> externref ─────
  //
  // ES §20.1.2.1 Object.assign(target, ...sources). `sources` is a $ObjVec of
  // source externrefs (the call sites build it via __js_array_new/__js_array_push,
  // which standalone routes to __objvec_new/__objvec_push — same signatures). For
  // each source that is one of our $Objects, copy every LIVE + enumerable own
  // property into `target` via the native __extern_set (which itself grows/inserts
  // and is a no-op on a non-$Object target). Sources that are not $Objects (e.g.
  // null/undefined/primitives) are skipped, matching the spec's "ignore nullish
  // sources" + our open-object-only own-key enumeration. Returns `target`.
  //
  // params: 0=target(externref) 1=sources(externref)
  // locals: 2=any(anyref) 3=sv(ref null $ObjVec) 4=slen 5=si
  //         6=srcAny(anyref) 7=so(ref null $Object) 8=arr(ref $PropMap) 9=cap 10=i
  //         11=e(ref null $PropEntry) 12=srcExt(externref)
  {
    const body: Instr[] = [
      // any = any.convert_extern(sources) ; if !$ObjVec → return target
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // sv = cast<$ObjVec>(any) ; slen = sv.len ; si = 0
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objVecTypeIdx },
      { op: "local.tee", index: 3 },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
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
              // if si >= slen break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // srcExt = sv.data[si]
              { op: "local.get", index: 3 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: objVecArrTypeIdx },
              { op: "local.tee", index: 12 },
              // srcAny = any.convert_extern(srcExt)
              { op: "any.convert_extern" },
              { op: "local.tee", index: 6 },
              // if !$Object → skip this source
              { op: "ref.test", typeIdx: objectTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // so = cast<$Object>(srcAny) ; arr = so.props ; cap = arr.len
                  { op: "local.get", index: 6 },
                  { op: "ref.cast", typeIdx: objectTypeIdx },
                  { op: "local.tee", index: 7 },
                  { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
                  { op: "local.tee", index: 8 },
                  { op: "array.len" },
                  { op: "local.set", index: 9 },
                  { op: "i32.const", value: 0 },
                  { op: "local.set", index: 10 },
                  {
                    op: "block",
                    blockType: { kind: "empty" },
                    body: [
                      {
                        op: "loop",
                        blockType: { kind: "empty" },
                        body: [
                          { op: "local.get", index: 10 },
                          { op: "local.get", index: 9 },
                          { op: "i32.ge_s" },
                          { op: "br_if", depth: 1 },
                          // e = arr[i]
                          { op: "local.get", index: 8 },
                          { op: "local.get", index: 10 },
                          { op: "array.get", typeIdx: propMapTypeIdx },
                          { op: "local.tee", index: 11 },
                          { op: "ref.is_null" },
                          { op: "i32.eqz" },
                          {
                            op: "if",
                            blockType: { kind: "empty" },
                            then: [
                              // (!tombstone) && enumerable
                              { op: "local.get", index: 11 },
                              { op: "ref.as_non_null" },
                              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                              { op: "i32.const", value: FLAG_TOMBSTONE },
                              { op: "i32.and" },
                              { op: "i32.eqz" },
                              { op: "local.get", index: 11 },
                              { op: "ref.as_non_null" },
                              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                              { op: "i32.const", value: FLAG_ENUMERABLE },
                              { op: "i32.and" },
                              { op: "i32.eqz" },
                              { op: "i32.eqz" }, // normalise enumerable bit to 0/1
                              { op: "i32.and" },
                              {
                                op: "if",
                                blockType: { kind: "empty" },
                                then: [
                                  // __extern_set(target, extern.convert_any(e.key),
                                  //              extern.convert_any(e.value))
                                  { op: "local.get", index: 0 },
                                  { op: "local.get", index: 11 },
                                  { op: "ref.as_non_null" },
                                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                                  { op: "extern.convert_any" },
                                  { op: "local.get", index: 11 },
                                  { op: "ref.as_non_null" },
                                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                                  { op: "extern.convert_any" },
                                  { op: "call", funcIdx: externSetIdx },
                                ],
                              },
                            ],
                          },
                          { op: "local.get", index: 10 },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          { op: "local.set", index: 10 },
                          { op: "br", depth: 0 },
                        ],
                      },
                    ],
                  },
                ],
              },
              // si++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return target
      { op: "local.get", index: 0 },
    ];
    registerNative(
      "__object_assign",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "sv", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
        { name: "slen", type: { kind: "i32" } },
        { name: "si", type: { kind: "i32" } },
        { name: "srcAny", type: { kind: "anyref" } },
        { name: "so", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "srcExt", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __object_is(externref a, externref b) -> i32 (#2042 S3 — Object.is) ────
  //
  // SameValue (§7.2.10) over two boxed externrefs. Tag-dispatched like the
  // union-helper `===` lowering, but with the SameValue numeric rule:
  // NaN is SameValue NaN, and +0 is NOT SameValue -0. Comparing the f64 bit
  // patterns (`i64.reinterpret_f64` + `i64.eq`) gives exactly that — equal NaN
  // bit patterns compare equal, and +0 (0x0…) vs -0 (0x8000…) compare unequal.
  // boolean → unbox i32; bigint → i64; both-null → equal; else ref identity.
  //
  // NATIVE-PROVIDER (`semanticProviders === "native-first"`), not merely
  // standalone-only (#2609/#4397). The
  // native `__defineProperty_value` block below is registered UNCONDITIONALLY by
  // this runtime and its #2042-S4 ValidateAndApplyPropertyDescriptor preflight
  // bakes a direct `call __object_is` for the SameValue value-change check. WASI
  // is host-free too (no JS `__object_is` import — `--target wasi` sets
  // `ctx.wasi` but leaves `ctx.standalone` false), so gating this registration on
  // `ctx.standalone` alone left `funcMap.get("__object_is")` undefined in WASI,
  // and the define helper baked an undefined funcIdx → "function index out of
  // range — undefined at __defineProperty_value" hard emit error (loopdive/js2wasm#389).
  // The compatibility-provider path still owns `__object_is` via its JS import,
  // so its output stays byte-identical.
  if (ctx.targetProfile.semanticProviders === "native-first") {
    addUnionImportsViaRegistry(ctx);
    const typeofNumIdx = ctx.funcMap.get("__typeof_number")!;
    const typeofBoolIdx = ctx.funcMap.get("__typeof_boolean")!;
    const typeofBigIdx = ctx.funcMap.get("__typeof_bigint")!;
    const unboxNumIdx = ctx.funcMap.get("__unbox_number")!;
    const unboxBoolIdx = ctx.funcMap.get("__unbox_boolean")!;
    const toBigIdx = ctx.funcMap.get("__to_bigint")!;
    const EQ_HEAP = -19; // WasmGC `eq` abstract heap type

    // params: a=0, b=1 ; locals: aa=2 (anyref), ba=3 (anyref)
    const bothTag = (tagIdx: number): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: tagIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: tagIdx },
      { op: "i32.and" },
    ];
    // Reference identity over the WasmGC `eq` heap (the anyref temps are already
    // materialised in locals 2/3 by `identityArm`'s preamble below).
    const refIdentityArm: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: EQ_HEAP },
      { op: "local.get", index: 3 },
      { op: "ref.test", typeIdx: EQ_HEAP },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: EQ_HEAP },
          { op: "local.get", index: 3 },
          { op: "ref.cast", typeIdx: EQ_HEAP },
          { op: "ref.eq" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ];
    // String SameValue = value equality (flatten both, __str_equals); else ref
    // identity. `__str_flatten`/`__str_equals` are resolved at the top of this
    // same `ensureObjectRuntime` pass (object-runtime helpers already call them,
    // e.g. __obj_hash/__obj_find), so the call indices are regime-consistent.
    const stringOrIdentityArm: Instr[] =
      strFlattenIdx !== undefined && strEqualsIdx !== undefined && anyStrTypeIdx >= 0
        ? [
            { op: "local.get", index: 2 },
            { op: "ref.test", typeIdx: anyStrTypeIdx },
            { op: "local.get", index: 3 },
            { op: "ref.test", typeIdx: anyStrTypeIdx },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: 2 },
                { op: "ref.cast", typeIdx: anyStrTypeIdx },
                { op: "call", funcIdx: strFlattenIdx },
                { op: "local.get", index: 3 },
                { op: "ref.cast", typeIdx: anyStrTypeIdx },
                { op: "call", funcIdx: strFlattenIdx },
                { op: "call", funcIdx: strEqualsIdx },
              ],
              else: refIdentityArm,
            },
          ]
        : refIdentityArm;
    const identityArm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 3 },
      ...stringOrIdentityArm,
    ];
    const bigintArm = (elseArm: Instr[]): Instr[] => [
      ...bothTag(typeofBigIdx),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: toBigIdx },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: toBigIdx },
          { op: "i64.eq" },
        ],
        else: elseArm,
      },
    ];
    const boolArm = (elseArm: Instr[]): Instr[] => [
      ...bothTag(typeofBoolIdx),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: unboxBoolIdx },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: unboxBoolIdx },
          { op: "i32.eq" },
        ],
        else: elseArm,
      },
    ];
    const numberArm = (elseArm: Instr[]): Instr[] => [
      ...bothTag(typeofNumIdx),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // SameValue numbers: compare f64 bit patterns (NaN==NaN, +0!=-0).
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: unboxNumIdx },
          { op: "i64.reinterpret_f64" },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: unboxNumIdx },
          { op: "i64.reinterpret_f64" },
          { op: "i64.eq" },
        ],
        else: elseArm,
      },
    ];
    const nullArm = (rest: Instr[]): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 }],
        else: rest,
      },
    ];
    registerNative(
      "__object_is",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "aa", type: { kind: "anyref" } },
        { name: "ba", type: { kind: "anyref" } },
      ],
      nullArm(numberArm(boolArm(bigintArm(identityArm)))),
    );
  }
}
