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
import { FUNCTION_FROM_PROTO, PROTO_FROM_FUNCTION } from "./proto-function-value.js"; // (#4637 A1)

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
  /** (#4721) standalone Proxy type, for receiver-preserving prototype reads. */
  proxyTypeIdx?: number;
  /** `$ProxyTraps` type paired with `proxyTypeIdx`. */
  proxyTrapsTypeIdx?: number;
  objRefNull: ValType;
  propMapRef: ValType;
  boundaryObjectGetPrototypeIdx?: number;
  boundaryObjectSetPrototypeIdx?: number;
  INITIAL_CAP: number;
  OBJ_FLAG_NONEXTENSIBLE: number;
  /** Distinguishes an explicit null [[Prototype]] from the implicit terminal. */
  OBJ_FLAG_NULL_PROTO: number;
}

/**
 * (#4643) An APPROVED function-constructor instance is a `__fnctor_<F>` STRUCT,
 * not an `$Object`, so it has no `$proto` FIELD at all — its `[[Prototype]]` is
 * F's per-fnctor prototype global, reached through the `__fnctor_proto_start`
 * ladder that `__extern_get` already uses for inherited reads.
 *
 * `__getPrototypeOf` and `__isPrototypeOf` both tested `$Object` and stopped, so
 * `Object.getPrototypeOf(inst)` answered `null` and `proto.isPrototypeOf(inst)`
 * answered `false` for EVERY such instance — measured 2026-08-23 for an
 * OBJECT-valued prototype as well as a function-valued one, which is why fixing
 * the callable-into-`$proto` write alone does not move those two rows.
 *
 * Both arms below are emitted only when the ladder was reserved (it is, in
 * `ensureObjectRuntime`, BEFORE `buildObjectPrototypeHelpers` — so the index is
 * stable and the body is filled at finalize by
 * `fillFnctorPrototypeDispatchArms`). A module with no approved fnctor reserves
 * nothing, the `funcMap` lookup answers `undefined`, and not one instruction
 * changes.
 */
const FNCTOR_PROTO_START = "__fnctor_proto_start";

/**
 * `__getPrototypeOf`'s non-`$Object` arm: answer F's prototype object when the
 * receiver is a fnctor instance. Only when the ladder answers NON-NULL — an
 * unrecognised receiver falls through to the caller's null/boundary answer, so
 * this widens a MISSING answer and never replaces a present one. `devirtualize`
 * is the same reverse map the `$Object` arm uses, so a function-valued prototype
 * reports the FUNCTION and never the internal bag.
 *
 * `protoSlot` is a scratch externref local appended to the helper's list.
 */
function fnctorGetPrototypeArm(ctx: CodegenContext, protoSlot: number, devirtualize: Instr[]): Instr[] {
  const startIdx = ctx.funcMap.get(FNCTOR_PROTO_START);
  if (startIdx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: startIdx },
    { op: "local.tee", index: protoSlot },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: protoSlot }, ...devirtualize, { op: "return" }],
    },
  ];
}

/**
 * `__isPrototypeOf`'s seed for a fnctor-instance CANDIDATE, emitted after `cur`
 * has been computed and before the walk.
 *
 * `cur` is null here (the candidate is not an `$Object`) and the walk would
 * answer 0 for every such candidate. Its first `[[Prototype]]` link is the
 * ladder's answer; seed `cur` with it and compare THAT link explicitly, because
 * the loop steps to `cur.$proto` before its first comparison — which is right
 * for an `$Object` candidate, since §20.1.3.3 asks whether O is in V's prototype
 * CHAIN and V itself must never match. The loop then continues from the seeded
 * link unchanged.
 *
 * Tests before it casts: the ladder answers whatever the S2 store holds. That
 * store is canonicalized at the WRITE (`expressions/fnctor-prototype.ts`), but a
 * value the proto-view map cannot canonicalize (`F.prototype = 5`) must make
 * this DECLINE, never trap.
 */
function fnctorIsPrototypeOfSeed(
  ctx: CodegenContext,
  objectTypeIdx: number,
  curSlot: number,
  targetSlot: number,
  protoSlot: number,
): Instr[] {
  const startIdx = ctx.funcMap.get(FNCTOR_PROTO_START);
  if (startIdx === undefined) return [];
  const compareFirstLink: Instr[] = [
    { op: "local.get", index: protoSlot },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.tee", index: curSlot },
    { op: "local.get", index: targetSlot },
    { op: "ref.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
  ];
  const seedFromLadder: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: startIdx },
    { op: "local.tee", index: protoSlot },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: protoSlot },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: objectTypeIdx },
        { op: "if", blockType: { kind: "empty" }, then: compareFirstLink },
      ],
    },
  ];
  return [
    { op: "local.get", index: curSlot },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: seedFromLadder },
  ];
}

/** The scratch local both arms above use, appended so existing indices are untouched. */
function fnctorProtoLocal(ctx: CodegenContext): { name: string; type: ValType }[] {
  return ctx.funcMap.get(FNCTOR_PROTO_START) === undefined
    ? []
    : [{ name: "__fnctorProto", type: { kind: "externref" } }];
}

/**
 * `__getPrototypeOf`'s LAST resort, unchanged from before #4643 and extracted
 * verbatim: the dynamic-boundary import when one exists, else the host-free
 * `null`. A FACTORY, like the three in `native-dynamic-instanceof.ts` — a shared
 * `Instr` object would be double-remapped by the finalize index walks.
 */
function boundaryGetPrototypeArm(boundaryIdx: number | undefined): Instr[] {
  return boundaryIdx === undefined
    ? [{ op: "ref.null.extern" }]
    : [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: boundaryIdx },
      ];
}

/** Register the prototype-chain native helpers. Called once, in place, from `ensureObjectRuntime`. */
export function buildObjectPrototypeHelpers(ctx: CodegenContext, s: ObjectPrototypeHelperState): void {
  const {
    registerNative,
    propEntryTypeIdx,
    propMapTypeIdx,
    objectTypeIdx,
    proxyTypeIdx,
    proxyTrapsTypeIdx,
    objRefNull,
    propMapRef,
    boundaryObjectGetPrototypeIdx,
    boundaryObjectSetPrototypeIdx,
    INITIAL_CAP,
    OBJ_FLAG_NONEXTENSIBLE,
    OBJ_FLAG_NULL_PROTO,
  } = s;

  // (#4637 A1) The bag↔callable proto-view map, reserved just above in
  // `ensureObjectRuntime`. `undefined` in gc/host (nothing reserved) — every
  // consult below then emits its exact pre-#4637 instructions, so those lanes
  // stay byte-identical by construction.
  const protoFromFunctionIdx = ctx.funcMap.get(PROTO_FROM_FUNCTION);
  const functionFromProtoIdx = ctx.funcMap.get(FUNCTION_FROM_PROTO);
  // A Proxy with no `get` trap has the same [[Get]] target operation as its
  // target. Recursively unwrap that narrow case before storing the prototype;
  // the recursive helper preserves nested proxy forwarding and leaves a
  // present (including non-callable) trap intact (#4721).
  let proxyGetTargetIdx: number | undefined;
  if (proxyTypeIdx !== undefined && proxyTrapsTypeIdx !== undefined) {
    const name = "__proxy_get_target_if_absent";
    const getTargetIdx = s.registerNative(
      name,
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [{ name: "any", type: { kind: "anyref" } }],
      [],
    );
    proxyGetTargetIdx = getTargetIdx;
    const target = (): Instr[] => [
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: proxyTypeIdx! },
      { op: "struct.get", typeIdx: proxyTypeIdx!, fieldIdx: 1 },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: getTargetIdx },
    ];
    const helper = ctx.mod.functions.find((f) => f.name === name)!;
    helper.body = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: proxyTypeIdx },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: 3 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: target(),
            else: [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx: proxyTypeIdx },
              { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: 3 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: 0 },
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "externref" } },
                then: target(),
                else: [{ op: "local.get", index: 0 }],
              },
            ],
          },
        ],
        else: [{ op: "local.get", index: 0 }],
      },
    ];
  }
  /** Map a callable in a `[[Prototype]]` POSITION to the `$Object` view of it. */
  const canonicalizeProtoArg = (paramIdx: number): Instr[] => {
    const proto: Instr[] = [{ op: "local.get", index: paramIdx }];
    if (proxyGetTargetIdx !== undefined) proto.push({ op: "call", funcIdx: proxyGetTargetIdx });
    if (protoFromFunctionIdx !== undefined) proto.push({ op: "call", funcIdx: protoFromFunctionIdx });
    return proto;
  };
  /** Map a proto-view `$Object` back to the callable it stands for, on the way OUT. */
  const devirtualizeProtoResult = (): Instr[] =>
    functionFromProtoIdx === undefined ? [] : [{ op: "call", funcIdx: functionFromProtoIdx }];

  // `$Object.$proto === null` has two encodings in the standalone runtime:
  // an ordinary object whose implicit Object.prototype terminal is omitted, and
  // an explicitly null-prototype object. Keep the bit checks/final writes as
  // factories: both writer and status bodies are remapped independently later.
  const nullPrototypeFlagIsSet = (objectLocal: number): Instr[] => [
    { op: "local.get", index: objectLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
    { op: "i32.const", value: OBJ_FLAG_NULL_PROTO },
    { op: "i32.and" },
  ];
  const returnIfSameEncodedPrototype = (onSame: () => Instr[]): Instr[] => [
    { op: "local.get", index: 3 },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
    { op: "ref.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // With equal encoded references, SameValue also requires the raw
        // JavaScript null classifications to agree. Otherwise either an
        // ordinary object must become explicitly null-prototype, or a marked
        // null-prototype object must clear that marker for a non-null input
        // which has no `$Object` representation.
        { op: "local.get", index: 1 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...nullPrototypeFlagIsSet(2), { op: "if", blockType: { kind: "empty" }, then: onSame() }],
          else: [
            ...nullPrototypeFlagIsSet(2),
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: onSame() },
          ],
        },
      ],
    },
  ];
  const updateNullPrototypeFlag = (): Instr[] => [
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
    { op: "i32.const", value: ~OBJ_FLAG_NULL_PROTO },
    { op: "i32.and" },
    // Use the original input, not the canonicalized `$Object` view: only a
    // JavaScript null request receives the explicit-null-prototype marker.
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: OBJ_FLAG_NULL_PROTO }],
      else: [{ op: "i32.const", value: 0 }],
    },
    { op: "i32.or" },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 4 },
  ];

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
          // (#4637 A1) `$proto` may be the `$Object` PROTO-VIEW of a function
          // value (see `proto-function-value.ts`). Answering the view itself
          // would publish an object the program can never name — a WRONG answer
          // where the base has a merely missing one — so map it back to the
          // callable. A non-registered `$Object` maps to itself.
          ...devirtualizeProtoResult(),
        ],
        else: [
          ...fnctorGetPrototypeArm(ctx, 2, devirtualizeProtoResult()), // (#4643) scratch local 2
          ...boundaryGetPrototypeArm(boundaryObjectGetPrototypeIdx),
        ],
      },
    ];
    registerNative(
      "__getPrototypeOf",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [{ name: "any", type: { kind: "anyref" } }, ...fnctorProtoLocal(ctx)],
      body,
    );
  }

  // __object_create(externref proto) -> externref (ES §20.1.2.2):
  //   fresh empty $Object with $proto = (proto is $Object ? proto : null).
  //   Object.create(null) passes a null externref → $proto stays null and its
  //   dedicated flag distinguishes that state from the implicit terminal.
  //   (The descriptors second arg is materialised separately by the call site.)
  {
    const body: Instr[] = [
      // props = new $PropMap(INITIAL_CAP) (all null)
      { op: "ref.null", typeIdx: propEntryTypeIdx },
      { op: "i32.const", value: INITIAL_CAP },
      { op: "array.new", typeIdx: propMapTypeIdx },
      { op: "local.set", index: 2 },
      // proto = (any.convert_extern(arg) is $Object ? cast : null)
      // (#4637 A1) A CALLABLE argument is first mapped to its `$Object`
      // proto-view, so `Object.create(f)` / `new F()` with `F.prototype = f`
      // produce a walkable chain instead of storing null.
      ...canonicalizeProtoArg(0),
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
      // struct.new $Object {proto, props, count=0, tombstones=0,
      //   flags=(raw proto is null ? NULL_PROTO : 0), nextSeq=0}
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: OBJ_FLAG_NULL_PROTO }],
        else: [{ op: "i32.const", value: 0 }],
      },
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
      // (#4637 A1) …after mapping a CALLABLE `proto` to its `$Object` view, so
      // `Object.setPrototypeOf(o, f)` builds the same walkable link
      // `__object_create` does. The §10.1.2.1 checks below (SameValue, the
      // extensibility refusal, the cycle walk) all run on the view, which is the
      // object that will actually be in the chain.
      ...canonicalizeProtoArg(1),
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
      // step 2: SameValue includes the explicit-null-prototype bit when both
      // encoded proto references are null.
      ...returnIfSameEncodedPrototype(() => [{ op: "local.get", index: 0 }, { op: "return" }]),
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
      // Keep every unrelated object flag and replace only the explicit-null
      // classification after the write has passed all refusal checks.
      ...updateNullPrototypeFlag(),
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

  // (#5148 cluster 2b) __object_setPrototypeOf_status(externref obj,
  //   externref proto) -> i32 — the BOOLEAN §10.1.2.1 OrdinarySetPrototypeOf
  //   would return for this (obj, proto) pair, WITHOUT performing the write.
  //
  //   `__object_setPrototypeOf` above is deliberately lenient: a step-3
  //   (non-extensible) or step-4 (cycle) refusal is a SILENT no-op there,
  //   because internal callers rely on that posture. But §20.1.2.21 step 4
  //   requires `Object.setPrototypeOf` to THROW a TypeError when the boolean is
  //   false, and the same is true of B.2.2.1's `__proto__` setter. Rather than
  //   forking the writer (which would duplicate the chain walk, the callable
  //   proto-view canonicalization and the boundary-object arm), the throwing
  //   call sites ask this pure predicate FIRST and then delegate the write.
  //
  //   Answers 1 (permissive) for every receiver the writer does not own — a
  //   non-`$Object` obj, and a `$Proxy` receiver, whose §10.5.2 trap arm is
  //   prepended to the writer only. Those keep their existing behaviour.
  //
  // params: 0=obj(externref) 1=proto(externref)
  // locals: 2=o(ref null $Object) 3=v(ref null $Object) 4=p(ref null $Object)
  //         5=any(anyref)
  {
    const body: Instr[] = [
      // Not an ordinary `$Object` receiver → not this native's business → 1.
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 5 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
      { op: "local.get", index: 5 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 2 },
      // v = the `$Object` view of proto (callable → its proto-view; else null).
      ...canonicalizeProtoArg(1),
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
      // step 2: SameValue includes the explicit-null-prototype bit when both
      // encoded proto references are null.
      ...returnIfSameEncodedPrototype(() => [{ op: "i32.const", value: 1 }, { op: "return" }]),
      // step 3: non-extensible → false.
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // step 4: cycle walk — p = v ; while p != null { if p === o → false }
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
              { op: "local.get", index: 4 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 4 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 0 }, { op: "return" }],
              },
              { op: "local.get", index: 4 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 1 },
    ];
    registerNative(
      "__object_setPrototypeOf_status",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "o", type: objRefNull },
        { name: "v", type: objRefNull },
        { name: "p", type: objRefNull },
        { name: "any", type: { kind: "anyref" } },
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
      // (#4637 A1) A CALLABLE receiver — `P.isPrototypeOf(m)` — is first mapped
      // to the `$Object` proto-view that `__object_create` put in `m`'s chain,
      // so the `ref.eq` below compares the same identity from both ends.
      // Deliberately only the RECEIVER: `x.isPrototypeOf(f)` walks a function's
      // OWN chain, which this issue does not model, and keeps today's `0`.
      ...canonicalizeProtoArg(0),
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
      ...fnctorIsPrototypeOfSeed(ctx, objectTypeIdx, 3, 2, 5), // (#4643) cur=3, target=2, scratch=5
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
        ...fnctorProtoLocal(ctx), // (#4643) local 5, appended: locals 2..4 keep their indices
      ],
      body,
    );
  }
}
