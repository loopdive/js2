// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7011) Dynamic-object (MOP) arms for the native `$__sab` carrier in the
 * standalone object runtime. A SharedArrayBuffer reached through an `any`
 * slot — the shape every test262 `var sab = new SharedArrayBuffer(n)` has —
 * is a byte vec to the generic natives, which answered `undefined` for its
 * accessors and `ArrayBuffer.prototype` for its [[Prototype]]. Two
 * finalize-time arms, PREPENDED (in front of the ArrayBuffer arms, since
 * `$__sab` subtypes the ArrayBuffer byte vec):
 *  - `__getPrototypeOf(sab)` → the `SharedArrayBuffer.prototype` glue
 *    singleton (identity-equal to a static `SharedArrayBuffer.prototype` read);
 *  - `__extern_get(sab, "byteLength" | "maxByteLength" | "growable")` → the
 *    provider's `__sab_get` accessor helper.
 * Byte-inert for every module that never constructed a SharedArrayBuffer.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { ensureSharedArrayBufferNativeProtoGlue } from "../array-object-proto.js";
import { definedFuncAt } from "../func-space.js";
import { buildLazyNativeProtoGetInstrs } from "../native-proto.js";
import { nativeStringLiteralInstrs } from "../native-strings.js";
import { ensureSabHelper } from "./shared-array-buffer.js";

const ACCESSORS = ["byteLength", "maxByteLength", "growable"] as const;

export function fillSharedArrayBufferMopArms(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const sabIdx = ctx.structMap.get("__sab");
  if (sabIdx === undefined) return;
  const fnOf = (name: string) => {
    const idx = ctx.funcMap.get(name);
    return idx === undefined ? undefined : definedFuncAt(ctx, idx);
  };

  const protoFn = fnOf("__getPrototypeOf");
  const brand = ensureSharedArrayBufferNativeProtoGlue(ctx);
  const read = brand === undefined ? null : buildLazyNativeProtoGetInstrs(ctx, brand);
  if (protoFn && read) {
    protoFn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: sabIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...read, { op: "return" }],
      },
    );
  }

  const getFn = fnOf("__extern_get");
  const getterIdx = ensureSabHelper(ctx, "get");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (
    !getFn ||
    getterIdx === undefined ||
    strEqualsIdx === undefined ||
    strFlattenIdx === undefined ||
    anyStrTypeIdx < 0
  ) {
    return;
  }
  const keyIs = (lit: string): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "call", funcIdx: strFlattenIdx },
    ...nativeStringLiteralInstrs(ctx, lit),
    { op: "call", funcIdx: strEqualsIdx },
  ];
  const arms: Instr[] = [];
  ACCESSORS.forEach((name, which) => {
    arms.push(...keyIs(name), {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "i32.const", value: which },
        { op: "call", funcIdx: getterIdx },
        { op: "return" },
      ],
    });
  });
  getFn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: sabIdx },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: arms },
  );
}
