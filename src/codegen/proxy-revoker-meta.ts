// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5196 R3-4) Function metadata for the `Proxy.revocable(…).revoke` carrier.
 *
 * §28.2.2.1.1 makes the revocation function an anonymous built-in function with
 * `length` 0 and `name` `""`, both `{writable:false, enumerable:false,
 * configurable:true}`. The standalone carrier `__proxy_revoker` is a one-field
 * struct known only to `__apply_closure` (so calling it revokes) and
 * `__typeof_function` (so `typeof revoke` is "function"). Every reflective read
 * therefore missed: `gOPD(revoke, "length")` was `undefined`,
 * `revoke.hasOwnProperty("name")` false, `getOwnPropertyNames(revoke)` empty.
 *
 * The fix is deliberately ONE arm rather than four: `__builtinfn_get_meta` is
 * the single question `__builtinfn_gopd`, `__hasOwnProperty` and `__extern_get`
 * all ask, so claiming the two keys there answers the VALUE, the descriptor and
 * the has-own test at once — the decision travels with the carrier TYPE, not
 * with each reader. `__builtinfn_push_ownnames` is the one reader that
 * enumerates rather than asks, so it gets the matching arm (`length` before
 * `name`, the creation order `property-order.js` asserts).
 *
 * Shape and splice discipline copied from `fillTaCtorGetMetaArm`
 * (`ta-ctor-meta.ts`): a receiver `ref.test` guard that is disjoint from every
 * other arm, spliced at body index 0 at finalize, reading only the PARAMS so it
 * composes with whatever locals the host body uses.
 *
 * Byte-inert unless the module compiled a `Proxy.revocable` site
 * (`ctx.proxyRevocableSite`) — the `__proxy_revoker` struct type and the proxy
 * natives themselves exist in EVERY standalone module (measured 2026-09-03), so
 * their presence is not a usable gate.
 */
import type { CodegenContext } from "./context/types.js";
import type { Instr } from "../ir/types.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";

/** Field 1 of `__proxy_revoker`: bit 0 = `length` deleted, bit 1 = `name` deleted. */
const STATE_FIELD_IDX = 1;
const LENGTH_DELETED = 1;
const NAME_DELETED = 2;

export function fillProxyRevokerFnMeta(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.proxyRevocableSite !== true) return;
  const revokerTypeIdx = ctx.structMap.get("__proxy_revoker");
  if (revokerTypeIdx === undefined) return;
  const getMetaFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_get_meta");
  if (!getMetaFn) return;
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (boxNumIdx === undefined || strFlattenIdx === undefined || strEqualsIdx === undefined || anyStrTypeIdx < 0) {
    return;
  }

  /** `local.get 0; any.convert_extern; ref.test $__proxy_revoker` — receiver guard. */
  const isRevoker = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: revokerTypeIdx },
  ];

  /**
   * `i32`: is param 1 the string `key`? Reads only the key PARAM and writes no
   * local, so it is safe in any host body. A FACTORY — the same shape goes into
   * two bodies and a shared `Instr[]` would double-remap on a later import
   * shift.
   */
  const keyIs = (key: string): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "call", funcIdx: strFlattenIdx },
        { op: "ref.as_non_null" },
        ...nativeStringLiteralInstrs(ctx, key),
        { op: "call", funcIdx: strEqualsIdx },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];

  // `name` → "" and `length` → 0. Any other key falls through to whatever the
  // rest of the body answers (null — the revoker has no other own property),
  // which is what keeps `gOPD(revoke, "x")` undefined rather than a descriptor.
  /** i32: is the deleted bit `mask` clear on the receiver? */
  const notDeleted = (mask: number): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: revokerTypeIdx },
    { op: "struct.get", typeIdx: revokerTypeIdx, fieldIdx: STATE_FIELD_IDX },
    { op: "i32.const", value: mask },
    { op: "i32.and" },
    { op: "i32.eqz" },
  ];

  getMetaFn.body.splice(0, 0, ...isRevoker(), {
    op: "if",
    blockType: { kind: "empty" },
    then: [
      ...keyIs("name"),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...notDeleted(NAME_DELETED),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...nativeStringLiteralInstrs(ctx, ""), { op: "extern.convert_any" }, { op: "return" }],
          },
          { op: "ref.null.extern" },
          { op: "return" },
        ],
      },
      ...keyIs("length"),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...notDeleted(LENGTH_DELETED),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "f64.const", value: 0 }, { op: "call", funcIdx: boxNumIdx }, { op: "return" }],
          },
          { op: "ref.null.extern" },
          { op: "return" },
        ],
      },
    ],
  });

  // `delete revoke.length` / `.name` — §28.2.2.1.1 makes both configurable, so
  // the delete must actually take effect. Without this arm `__delete_property`
  // no-ops on the carrier and `verifyProperty` reports the property as
  // non-configurable.
  const deleteFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_delete");
  if (deleteFn) {
    const setBit = (mask: number): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: revokerTypeIdx },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: revokerTypeIdx },
      { op: "struct.get", typeIdx: revokerTypeIdx, fieldIdx: STATE_FIELD_IDX },
      { op: "i32.const", value: mask },
      { op: "i32.or" },
      { op: "struct.set", typeIdx: revokerTypeIdx, fieldIdx: STATE_FIELD_IDX },
      { op: "i32.const", value: 1 },
      { op: "return" },
    ];
    deleteFn.body.splice(0, 0, ...isRevoker(), {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...keyIs("name"),
        { op: "if", blockType: { kind: "empty" }, then: setBit(NAME_DELETED) },
        ...keyIs("length"),
        { op: "if", blockType: { kind: "empty" }, then: setBit(LENGTH_DELETED) },
      ],
    });
  }

  // Enumeration order is creation order: `length`, then `name`.
  const pushOwnFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_push_ownnames");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  if (pushOwnFn && objVecPushIdx !== undefined) {
    pushOwnFn.body.splice(0, 0, ...isRevoker(), {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...notDeleted(LENGTH_DELETED),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            ...nativeStringLiteralInstrs(ctx, "length"),
            { op: "extern.convert_any" },
            { op: "call", funcIdx: objVecPushIdx },
          ],
        },
        ...notDeleted(NAME_DELETED),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            ...nativeStringLiteralInstrs(ctx, "name"),
            { op: "extern.convert_any" },
            { op: "call", funcIdx: objVecPushIdx },
          ],
        },
        { op: "i32.const", value: 1 },
        { op: "return" },
      ],
    });
  }
}
