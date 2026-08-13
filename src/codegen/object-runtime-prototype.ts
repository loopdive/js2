// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3274, subtask of #3182) Object-runtime **prototype-chain** helper builders,
 * extracted verbatim from `ensureObjectRuntime` in `object-runtime.ts` as
 * WAVE-B slice 3 of the mega-function decomposition.
 *
 * This module owns the registration of the native (`--target standalone`)
 * prototype-chain operations:
 *
 *   - `__getPrototypeOf`        (Object.getPrototypeOf / Reflect.getPrototypeOf)
 *   - `__object_create`         (Object.create with a proto + optional props)
 *   - `__object_setPrototypeOf` (Object.setPrototypeOf / Reflect.setPrototypeOf)
 *   - `__isPrototypeOf`         (Object.prototype.isPrototypeOf chain walk)
 *
 * Pure relocation: the code is byte-for-byte identical to the inline block it
 * replaced (proved via `scripts/prove-emit-identity.mjs`). Everything it reads
 * from the enclosing `ensureObjectRuntime` scope is threaded in through
 * `ObjectPrototypeHelperState` so the `registerNative` call ORDER (and the
 * minted func-index sequence) is preserved exactly.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Everything the prototype-chain block reads from the `ensureObjectRuntime` scope. */
export interface ObjectPrototypeHelperState {
  registerNative: (
    name: string,
    paramTypes: ValType[],
    resultTypes: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ) => number;
  propEntryTypeIdx: number;
  propMapTypeIdx: number;
  objectTypeIdx: number;
  objRefNull: ValType;
  propMapRef: ValType;
  boundaryObjectGetPrototypeIdx?: number;
  boundaryObjectSetPrototypeIdx?: number;
  INITIAL_CAP: number;
  OBJ_FLAG_NONEXTENSIBLE: number;
}

/** Register the prototype-chain native helpers. Called once, in place, from `ensureObjectRuntime`. */
export function buildObjectPrototypeHelpers(ctx: CodegenContext, s: ObjectPrototypeHelperState): void {
  const {
    registerNative,
    propEntryTypeIdx,
    propMapTypeIdx,
    objectTypeIdx,
    objRefNull,
    propMapRef,
    boundaryObjectGetPrototypeIdx,
    boundaryObjectSetPrototypeIdx,
    INITIAL_CAP,
    OBJ_FLAG_NONEXTENSIBLE,
  } = s;

  // ── Prototype-chain ops (#1472 Phase C) ──────────────────────────────────
  //
  // The $Object struct already carries the [[Prototype]] in field 0 ($proto,
  // ref null $Object) and __extern_get/__extern_has already walk it. These four
  // helpers expose the chain directly. All operate purely on the $proto field;
  // non-$Object / null receivers return a lenient null/0 (never throw into
  // Wasm — the receiver-dispatch / ToObject checks live at the call site).

  // __getPrototypeOf(externref) -> externref (ES §20.1.2.12):
  //   $Object → extern.convert_any($proto) (may be null); non-$Object → null.
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
          { op: "extern.convert_any" },
        ],
        else:
          boundaryObjectGetPrototypeIdx === undefined
            ? [{ op: "ref.null.extern" }]
            : [
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: boundaryObjectGetPrototypeIdx },
              ],
      },
    ];
    registerNative(
      "__getPrototypeOf",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [{ name: "any", type: { kind: "anyref" } }],
      body,
    );
  }

  // __object_create(externref proto) -> externref (ES §20.1.2.2):
  //   fresh empty $Object with $proto = (proto is $Object ? proto : null).
  //   Object.create(null) passes a null externref → $proto stays null.
  //   (The descriptors second arg is materialised separately by the call site.)
  {
    const body: Instr[] = [
      // props = new $PropMap(INITIAL_CAP) (all null)
      { op: "ref.null", typeIdx: propEntryTypeIdx },
      { op: "i32.const", value: INITIAL_CAP },
      { op: "array.new", typeIdx: propMapTypeIdx },
      { op: "local.set", index: 2 },
      // proto = (any.convert_extern(arg) is $Object ? cast : null)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: objRefNull },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
        ],
        else: [{ op: "ref.null", typeIdx: objectTypeIdx }],
      },
      // struct.new $Object {proto, props, count=0, tombstones=0, flags=0, nextSeq=0}
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 }, // nextSeq (#1837)
      { op: "struct.new", typeIdx: objectTypeIdx },
      { op: "extern.convert_any" },
    ];
    registerNative(
      "__object_create",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "props", type: propMapRef },
      ],
      body,
    );
  }

  // __object_setPrototypeOf(externref obj, externref proto) -> externref
  //   (ES §20.1.2.21 Object.setPrototypeOf → §10.1.2 [[SetPrototypeOf]] →
  //   §10.1.2.1 OrdinarySetPrototypeOf). #1888 Slice 7. Writes $Object.$proto
  //   (field 0) after the OrdinarySetPrototypeOf checks, then returns obj.
  //
  //   Per §20.1.2.21 the return value is always the first argument `obj`, even
  //   when the [[SetPrototypeOf]] would have been observably a no-op or refused.
  //   (Object.setPrototypeOf returns O regardless of the boolean result, except
  //   that a *false* result throws a TypeError in the spec — see the dual-mode
  //   note below.)
  //
  //   OrdinarySetPrototypeOf(O, V), with V restricted to Object|null here
  //   (a non-$Object externref V coerces to null, matching __object_create):
  //     1. current = O.[[Prototype]].
  //     2. If SameValue(V, current) → true (no write; ref.eq, both nullable).
  //     3. If O is non-extensible (OBJ_FLAG_NONEXTENSIBLE) → false (NO write).
  //     4. Cycle check: walk p = V; while p ≠ null: if p === O → false (refuse,
  //        never build a cyclic chain that a later proto-walk would loop on);
  //        p = p.$proto. (We do not model the exotic [[GetPrototypeOf]] short-
  //        circuit — all our objects are ordinary.)
  //     5. O.[[Prototype]] = V → true.
  //
  //   Dual-mode posture (#1472 / #1888): a *refused* set (steps 3/4 → false)
  //   is a SILENT no-op in standalone, NOT a thrown TypeError. This mirrors the
  //   freeze-write refusal posture (the #1473 error machinery is a separate
  //   layer) and keeps this slice from pulling __new_TypeError / the exn tag
  //   late into the runtime. The proto is simply left unchanged; obj is still
  //   returned. A non-$Object obj receiver is also a silent no-op (the ToObject
  //   / RequireObjectCoercible receiver guard lives at the #820k call site).
  //
  // params: 0=obj(externref) 1=proto(externref)
  // locals: 2=o(ref null $Object) 3=v(ref null $Object) 4=p(ref null $Object)
  //         5=any(anyref)
  {
    const body: Instr[] = [
      // o = (obj is $Object ? cast : null); if not an $Object → return obj as-is
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 5 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 5 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "local.set", index: 2 },
        ],
        else: [
          ...(boundaryObjectSetPrototypeIdx === undefined
            ? ([{ op: "local.get", index: 0 }, { op: "return" }] satisfies Instr[])
            : ([
                { op: "local.get", index: 0 },
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: boundaryObjectSetPrototypeIdx },
                { op: "local.tee", index: 6 },
                { op: "ref.is_null" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "local.get", index: 0 }, { op: "return" }],
                },
                { op: "local.get", index: 6 },
                { op: "return" },
              ] satisfies Instr[])),
        ],
      },
      // v = (proto is $Object ? cast : null) — non-$Object/null proto ⇒ null
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 5 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: objRefNull },
        then: [
          { op: "local.get", index: 5 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
        ],
        else: [{ op: "ref.null", typeIdx: objectTypeIdx }],
      },
      { op: "local.set", index: 3 },
      // step 2: if SameValue(v, o.$proto) → no-op (return obj)
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
      { op: "ref.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // step 3: if o.flags & OBJ_FLAG_NONEXTENSIBLE → refuse (return obj, no write)
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // step 4: cycle check — p = v ; while p != null { if p === o → refuse ; p = p.$proto }
      { op: "local.get", index: 3 },
      { op: "local.set", index: 4 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if p == null break (end of candidate chain, no cycle)
              { op: "local.get", index: 4 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // if ref.eq(p, o) → cycle → refuse (return obj, no write)
              { op: "local.get", index: 4 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "local.get", index: 0 }, { op: "return" }],
              },
              // p = p.$proto ; loop
              { op: "local.get", index: 4 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // step 5: o.$proto = v
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 3 },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 0 },
      // return obj
      { op: "local.get", index: 0 },
    ];
    registerNative(
      "__object_setPrototypeOf",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "o", type: objRefNull },
        { name: "v", type: objRefNull },
        { name: "p", type: objRefNull },
        { name: "any", type: { kind: "anyref" } },
        ...(boundaryObjectSetPrototypeIdx !== undefined
          ? [{ name: "boundaryResult", type: { kind: "externref" } as ValType }]
          : []),
      ],
      body,
    );
  }

  // __isPrototypeOf(externref obj, externref candidate) -> i32 (ES §20.1.3.3):
  //   1 iff obj appears in candidate's prototype chain. Walk candidate.$proto
  //   and ref.eq each level against obj. Non-$Object obj/candidate → 0.
  //
  // params: 0=obj(externref) 1=candidate(externref)
  // locals: 2=target(ref null $Object) 3=cur(ref null $Object) 4=any(anyref)
  {
    const body: Instr[] = [
      // target = (obj is $Object ? cast : null); if null → 0
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 4 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 4 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 2 },
      // cur = (candidate is $Object ? cast : null)
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 4 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: objRefNull },
        then: [
          { op: "local.get", index: 4 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
        ],
        else: [{ op: "ref.null", typeIdx: objectTypeIdx }],
      },
      { op: "local.set", index: 3 },
      // walk: cur = cur.$proto ; if cur == null → 0 ; if cur === target → 1
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if cur == null break (candidate had no [[Prototype]])
              { op: "local.get", index: 3 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // cur = cur.$proto
              { op: "local.get", index: 3 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 3 },
              // if cur == null break (reached end of chain)
              { op: "local.get", index: 3 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // if ref.eq(cur, target) → 1
              { op: "local.get", index: 3 },
              { op: "local.get", index: 2 },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 1 }, { op: "return" }],
              },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
    ];
    registerNative(
      "__isPrototypeOf",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "target", type: objRefNull },
        { name: "cur", type: objRefNull },
        { name: "any", type: { kind: "anyref" } },
      ],
      body,
    );
  }
}
