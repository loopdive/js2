// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
/** Construction data only; a native owner must authenticate every layout/provider. */
export interface PrototypeChainSeed {
  readonly startIdx: number | undefined;
  readonly objectTypeIdx: number;
  readonly curSlot: number;
  readonly targetSlot: number;
  readonly protoSlot: number;
  readonly candidateSlot: number;
  /** (#6944) `__fnctor_struct_proto_ok`: the first link is a terminating chain of fnctor structs. */
  readonly structHopOkIdx?: number;
}

/**
 * (#6944) `G.prototype = new F()` makes the first link a fnctor STRUCT. The
 * target is always an `$Object`, so no struct link can match it: step over the
 * struct links to the first `$Object` (or null). The guard proved the hop chain
 * terminates, so the loop needs no counter.
 */
function hopStructLinks(
  startIdx: number,
  okIdx: number | undefined,
  protoSlot: number,
  objectTypeIdx: number,
): Instr[] {
  if (okIdx === undefined) return [];
  return [
    { op: "local.get", index: protoSlot },
    { op: "call", funcIdx: okIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: protoSlot },
                { op: "call", funcIdx: startIdx },
                { op: "local.tee", index: protoSlot },
                { op: "ref.is_null" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: protoSlot },
                { op: "any.convert_extern" },
                { op: "ref.test", typeIdx: objectTypeIdx },
                { op: "br_if", depth: 1 },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

function buildFnctorPrototypeSeed(d: PrototypeChainSeed): Instr[] {
  const { startIdx, objectTypeIdx, curSlot, targetSlot, protoSlot } = d;
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
    { op: "local.set", index: protoSlot },
    ...hopStructLinks(startIdx, d.structHopOkIdx, protoSlot, objectTypeIdx),
    { op: "local.get", index: protoSlot },
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

function buildClassPrototypeSeed(d: PrototypeChainSeed): Instr[] {
  const { startIdx: getPrototypeOfIdx, objectTypeIdx, curSlot, targetSlot, protoSlot, candidateSlot } = d;
  if (getPrototypeOfIdx === undefined) return [];
  const compareFirstLink: Instr[] = [
    { op: "local.get", index: protoSlot },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.tee", index: curSlot },
    { op: "local.get", index: targetSlot },
    { op: "ref.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
  ];
  const seedFromGetPrototypeOf: Instr[] = [
    { op: "local.get", index: candidateSlot },
    { op: "call", funcIdx: getPrototypeOfIdx },
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
    { op: "if", blockType: { kind: "empty" }, then: seedFromGetPrototypeOf },
  ];
}

export interface PrototypeChainBindings {
  readonly objectTypeIdx: number;
  readonly objRefNull: ValType;
  readonly proxyGetTargetIdx?: number;
  readonly protoFromFunctionIdx?: number;
  readonly fnctor: PrototypeChainSeed;
  readonly classInstance: PrototypeChainSeed;
}
/** Full legacy walk and seeds. Unsupported candidate carriers retain the donor's zero result. */
export function buildIsPrototypeOfBody(d: PrototypeChainBindings): Instr[] {
  const { objectTypeIdx, objRefNull } = d;
  return [
    // target = (obj is $Object ? cast : null); if null → 0
    // (#4637 A1) A CALLABLE receiver — `P.isPrototypeOf(m)` — is first mapped
    // to the `$Object` proto-view that `__object_create` put in `m`'s chain,
    // so the `ref.eq` below compares the same identity from both ends.
    // Deliberately only the RECEIVER: `x.isPrototypeOf(f)` walks a function's
    // OWN chain, which this issue does not model, and keeps today's `0`.
    { op: "local.get", index: 0 },
    ...(d.proxyGetTargetIdx === undefined ? [] : [{ op: "call", funcIdx: d.proxyGetTargetIdx } as Instr]),
    ...(d.protoFromFunctionIdx === undefined ? [] : [{ op: "call", funcIdx: d.protoFromFunctionIdx } as Instr]),
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
    ...buildFnctorPrototypeSeed(d.fnctor), // (#4643) cur=3, target=2, scratch=5
    // (#6622) Tried only when the fnctor seed ALSO declined (cur still
    // null): candidate=local 1 is the raw externref param, scratch is the
    // next local slot after fnctorProtoLocal's (present only when a fnctor
    // ladder exists, so this index is computed rather than hard-coded).
    ...buildClassPrototypeSeed(d.classInstance),
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
}
