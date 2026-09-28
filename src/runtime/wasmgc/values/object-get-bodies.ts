// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";
import {
  buildInstanceRead,
  buildProtoIndexRead,
  buildReversePeerRead,
  buildTemplateRawRead,
  buildVecOrClosureRead,
  type InstanceReadBinding,
  type ProtoIndexReadBinding,
  type ReversePeerReadBinding,
  type TemplateRawReadBinding,
  type VecOrClosureReadBinding,
} from "./object-get-arms.js";

/** Initial getter recipe only. Later legacy finalization keeps its existing body-splice order.
 * Captured operands do not grant native resource admission or completion authority.
 */
export interface ObjectGetBindings {
  readonly objectTypeIdx: number;
  readonly propEntryTypeIdx: number;
  readonly objFindIdx: FuncHandle;
  readonly callAccessorGetIdx: FuncHandle;
  readonly accessorFlag: number;
  readonly reflectGetReceiverActiveGlobalIdx: number;
  readonly reflectGetReceiverGlobalIdx: number;
  readonly explicitReceiverLocal: number;
  readonly nullProtoRootLocal: number | undefined;
  readonly protoCacheEnabled: boolean;
  readonly hashedStringTypeIdx: number;
  readonly bfnGetMetaIdx: FuncHandle | undefined;
  readonly fnctorProtoStartIdx: FuncHandle | undefined;
  readonly objectTerminalAllowsImplicitProtoIdx: FuncHandle;
  readonly templateRaw: TemplateRawReadBinding | undefined;
  readonly boundaryGet: FuncHandle | undefined;
  readonly reversePeer: ReversePeerReadBinding | undefined;
  readonly instance: InstanceReadBinding | undefined;
  readonly missingPrototype: VecOrClosureReadBinding;
  readonly invalidPrototype: VecOrClosureReadBinding | undefined;
  readonly objectProtoMiss: ProtoIndexReadBinding | undefined;
  readonly getterMiss: readonly Instr[];
  readonly terminalMiss: Instr[];
}

export function buildObjectGetBody(bindings: ObjectGetBindings): Instr[] {
  return [...buildGetEntryAndCursor(bindings), ...buildGetPropertyWalk(bindings), ...buildGetTerminalMiss(bindings)];
}

function buildGetEntryAndCursor(d: ObjectGetBindings): Instr[] {
  return [
    // Consume a one-shot explicit receiver. Ordinary [[Get]] calls select
    // their target (param 0). Clearing the bit before any accessor call keeps
    // nested property reads independent.
    { op: "global.get", index: d.reflectGetReceiverActiveGlobalIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "global.get", index: d.reflectGetReceiverGlobalIdx }],
      else: [{ op: "local.get", index: 0 }],
    },
    { op: "local.set", index: d.explicitReceiverLocal },
    { op: "i32.const", value: 0 },
    { op: "global.set", index: d.reflectGetReceiverActiveGlobalIdx },
    // (#3673 round 9b) The per-key prototype-lookup cache HIT arm is NOT
    // here — it is prepended at FINALIZE by `unshiftExternGetProtoCacheArm`
    // so it lands BEFORE the closed-struct field-ladder arms that the
    // finalize fills unshift onto this body (the ladder is most of the cost
    // the cache exists to skip). Population lives inline below (data-
    // property branch); locals 8/9 are reserved at registration.
    // (#2896) Builtin-fn metadata arm: `fn[key]` for key "name"/"length" on a
    // builtin function value answers its spec metadata (host-free). Non-meta
    // receivers/keys fall through unchanged (the helper returns null).
    ...(d.bfnGetMetaIdx !== undefined
      ? ([
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: d.bfnGetMetaIdx },
          { op: "local.tee", index: 6 },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 6 }, { op: "return" }],
          },
        ] satisfies Instr[])
      : []),
    // any = any.convert_extern(obj)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 4 },
    ...buildTemplateRawRead(d.templateRaw),
    // Plain `$Object` starts its walk at itself. An approved native fnctor
    // instance starts at its per-fnctor prototype `$Object`, but param 0 stays
    // the ORIGINAL instance so an accessor found on that prototype receives
    // the correct `this`. Every other non-object keeps the closure-side-table
    // miss path.
    { op: "ref.test", typeIdx: d.objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 4 },
        { op: "ref.cast", typeIdx: d.objectTypeIdx },
        { op: "local.set", index: 2 },
        // Keep the original `$Object` root for the terminal miss below; the
        // cursor in local 2 is overwritten by every prototype hop.
        ...(d.nullProtoRootLocal === undefined
          ? []
          : ([
              { op: "local.get", index: 2 },
              { op: "local.set", index: d.nullProtoRootLocal },
            ] satisfies Instr[])),
        // (#3673 round 9b) a depth-0 (OWN) data hit on a plain $Object may
        // populate the per-key cache too — covers acorn's per-parse
        // `options.<x>` singleton reads. Same soundness argument as the
        // fnctor arm: population implies every earlier arm missed for this
        // exact receiver, and hits are owner-`ref.eq`-confined to it.
        ...(d.protoCacheEnabled
          ? ([
              { op: "i32.const", value: 1 },
              { op: "local.set", index: 9 },
            ] satisfies Instr[])
          : []),
      ],
      else: [
        // A raw JS object is serviced only when this module's export wrapper
        // admitted it at the dynamic boundary. The import returns null for
        // every other receiver, preserving the native instance/vec/closure
        // fallback below. A present JS property whose value is `undefined`
        // returns the non-null native undefined carrier, so miss and value do
        // not alias.
        // (#5383 S2d) The standalone lane reaches the SAME arm with the peer
        // provider's normalising terminal: "not a `$Object` of mine" is
        // exactly the question, and the wrapper's null-for-a-miss contract is
        // the same one this arm was written against. The closed-struct field
        // ladder is unshifted onto the FRONT of this body at finalize, so a
        // receiver this module can decode never gets here.
        // (#5383 S17) The PROVIDER side takes its own arm shape instead —
        // `reverseGetArmInstrs`, which is null-answer-aware. It cannot share
        // this one: here `null` means "not the peer's", while a consumer bag
        // field whose VALUE is `null` arrives as the same `ref.null.extern`,
        // and collapsing the two answers `undefined` for a present null.
        ...(d.boundaryGet !== undefined
          ? ([
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: d.boundaryGet! },
              { op: "local.tee", index: 6 },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "local.get", index: 6 }, { op: "return" }],
              },
            ] satisfies Instr[])
          : buildReversePeerRead(d.reversePeer, 6)),
        // (#4194) The receiver is not a `$Object`. Consult the instance
        // expando bag FIRST — an own property shadows the prototype chain
        // (§7.3.2), and this position (rather than inside the miss arm below)
        // is what covers `__fnctor_` receivers at all: `__fnctor_proto_start`
        // answers non-null for a fnctor WITH a prototype, so control takes the
        // proto walk and never reaches the miss arm. Acorn's `Node` is exactly
        // that shape, and the enumeration side already lists its bag keys — a
        // key that enumerates but reads `undefined` is the divergence this
        // substrate exists to remove. The arm falls through on a bag miss, so
        // the fnctor walk and the #4176 companion consult are unchanged.
        ...buildInstanceRead(d.instance),
        ...(d.fnctorProtoStartIdx === undefined
          ? buildVecOrClosureRead(d.missingPrototype)
          : ([
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: d.fnctorProtoStartIdx },
              { op: "local.tee", index: 7 },
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: buildVecOrClosureRead(d.missingPrototype),
              },
              // (#4639/#4637 cross-lane trap, 2026-08-23) TEST before the
              // cast: `__fnctor_proto_start` answers whatever the S2 store
              // holds, and for `G.prototype = P` with `P` a FUNCTION that WAS
              // a raw CALLABLE, not a `$Object` — a naked `ref.cast` here was
              // an UNCATCHABLE `illegal cast` trap on an inherited read.
              // (#4643) That callable no longer arrives — the S2 store is
              // canonicalized at the WRITE (`fnctor-prototype.ts`), so the
              // walk now resolves the read through the callable's bag. The
              // test STAYS: the global can still hold a non-object the
              // proto-view map cannot canonicalize (`G.prototype = 5`), whose
              // graceful answer is this miss arm's `undefined`. Do not restore
              // the naked cast.
              { op: "local.get", index: 7 },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: d.objectTypeIdx },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: buildVecOrClosureRead(d.invalidPrototype!),
              },
              { op: "local.get", index: 7 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: d.objectTypeIdx },
              { op: "local.set", index: 2 },
              // Preserve the actual fnctor `$Object` walk root too. The
              // cursor below is advanced through its chain before the
              // receiver-aware companion tail decides whether an implicit
              // Object.prototype terminal is available.
              ...(d.nullProtoRootLocal === undefined
                ? []
                : ([
                    { op: "local.get", index: 2 },
                    { op: "local.set", index: d.nullProtoRootLocal },
                  ] satisfies Instr[])),
              // (#3673 round 9b) walk starts at a fnctor prototype → a
              // first-proto data hit below may populate the per-key cache.
              ...(d.protoCacheEnabled
                ? ([
                    { op: "i32.const", value: 1 },
                    { op: "local.set", index: 9 },
                  ] satisfies Instr[])
                : []),
            ] satisfies Instr[])),
      ],
    },
  ];
}

function buildGetPropertyWalk(d: ObjectGetBindings): Instr[] {
  return [
    // proto-walk loop
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if o == null break
            { op: "local.get", index: 2 },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },
            // e = __obj_find(o, key)
            { op: "local.get", index: 2 },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: d.objFindIdx },
            { op: "local.tee", index: 3 },
            // if e != null → resolve the property
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // (#1888 S5b) Accessor branch: if (e.flags & d.accessorFlag),
                // invoke the stored getter with the ORIGINAL receiver (param 0,
                // §6.2.5.5 Get — NOT the proto-walk cursor) bound as `this`.
                { op: "local.get", index: 3 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 2 },
                { op: "i32.const", value: d.accessorFlag },
                { op: "i32.and" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // getter = extern.convert_any(e.$get)
                    { op: "local.get", index: 3 },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 4 },
                    { op: "extern.convert_any" },
                    { op: "local.tee", index: 5 },
                    // if getter == null → return undefined (§6.2.5.5 step 3)
                    { op: "ref.is_null" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [...d.getterMiss, { op: "return" }],
                    },
                    // Ordinary access selected param 0 above; Reflect.get
                    // selected its explicit third argument.
                    { op: "local.get", index: d.explicitReceiverLocal },
                    { op: "local.get", index: 5 },
                    { op: "call", funcIdx: d.callAccessorGetIdx },
                    { op: "return" },
                  ],
                },
                // (#3673 round 9b) Populate the per-key cache: a DATA entry
                // found on the FIRST prototype object of a fnctor receiver
                // (canCache still 1 — cleared on every proto advance) with
                // an interned `$HashedString` key. All the earlier arms
                // (field ladder, builtin meta) missed for this fnctor class,
                // so the cache-hit shortcut is sound for the whole class.
                ...(d.protoCacheEnabled
                  ? ([
                      { op: "local.get", index: 9 },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 1 },
                          { op: "any.convert_extern" },
                          { op: "ref.test", typeIdx: d.hashedStringTypeIdx },
                          {
                            op: "if",
                            blockType: { kind: "empty" },
                            then: [
                              { op: "local.get", index: 1 },
                              { op: "any.convert_extern" },
                              { op: "ref.cast", typeIdx: d.hashedStringTypeIdx },
                              { op: "local.set", index: 8 },
                              { op: "local.get", index: 8 },
                              { op: "ref.as_non_null" },
                              { op: "local.get", index: 2 },
                              { op: "ref.as_non_null" },
                              { op: "struct.set", typeIdx: d.hashedStringTypeIdx, fieldIdx: 5 }, // cacheOwner
                              { op: "local.get", index: 8 },
                              { op: "ref.as_non_null" },
                              { op: "local.get", index: 3 },
                              { op: "ref.as_non_null" },
                              { op: "struct.set", typeIdx: d.hashedStringTypeIdx, fieldIdx: 6 }, // cacheEntry
                              // (#3673 round 21) owner's props array — the
                              // per-object staleness witness (grow replaces it).
                              { op: "local.get", index: 8 },
                              { op: "ref.as_non_null" },
                              { op: "local.get", index: 2 },
                              { op: "ref.as_non_null" },
                              { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 1 }, // props
                              { op: "struct.set", typeIdx: d.hashedStringTypeIdx, fieldIdx: 7 }, // cacheProps
                              { op: "local.get", index: 8 },
                              { op: "ref.as_non_null" },
                              { op: "i32.const", value: 1 },
                              { op: "struct.set", typeIdx: d.hashedStringTypeIdx, fieldIdx: 4 }, // populated
                            ],
                          },
                        ],
                      },
                    ] satisfies Instr[])
                  : []),
                // Data property → return extern.convert_any(e.value)
                { op: "local.get", index: 3 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 1 },
                { op: "extern.convert_any" },
                { op: "return" },
              ],
            },
            // o = o.proto ; loop
            { op: "local.get", index: 2 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: d.objectTypeIdx, fieldIdx: 0 },
            { op: "local.set", index: 2 },
            // (#3673 round 9b) left the first prototype — stop cache writes.
            ...(d.protoCacheEnabled
              ? ([
                  { op: "i32.const", value: 0 },
                  { op: "local.set", index: 9 },
                ] satisfies Instr[])
              : []),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

function buildGetTerminalMiss(d: ObjectGetBindings): Instr[] {
  return [
    // not found anywhere → miss (undefined under the S1 regime; legacy null).
    // (#4160, receiver-aware since #4176) Under the store flags the
    // chain-exhausted miss consults the proto-property companions — the
    // helper itself answers the undefined miss when the companions have
    // nothing. RECEIVER-aware (`__protoidx_get_r`): an ordinary `$Object`
    // consults Object.prototype's companion as before, and a boxed-primitive
    // WRAPPER (also a `$Object` — see WRAPPER_PRIMITIVE_KEY) consults its
    // own brand first (`String.prototype.x` visible on `new String()`).
    // Consulted ONLY here, where own + every `$proto` link have missed, so
    // an own entry (even one holding `undefined`) still shadows (§7.3.2).
    ...(d.objectProtoMiss === undefined
      ? d.terminalMiss
      : ([
          // An explicitly null final terminal has no implicit
          // Object.prototype companion. This narrow terminal gate applies to
          // real `$Object` walks (direct or fnctor); an unrooted non-$Object
          // caller keeps the existing receiver-aware consult.
          { op: "local.get", index: d.nullProtoRootLocal! },
          { op: "call", funcIdx: d.objectTerminalAllowsImplicitProtoIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: buildProtoIndexRead(d.objectProtoMiss)!,
            else: d.terminalMiss,
          },
        ] satisfies Instr[])),
  ];
}
