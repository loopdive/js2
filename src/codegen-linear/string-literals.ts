// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";
import type { LinearContext } from "./context.js";

const LITERAL_CACHE_GLOBAL_PREFIX = "__str_literal_cache_";

export function isLinearStringLiteralCacheGlobal(name: string): boolean {
  return name.startsWith(LITERAL_CACHE_GLOBAL_PREFIX);
}

/** Materialize each immutable literal once per instance, then reuse its arena pointer. */
export function linearStringLiteralInstrs(
  ctx: LinearContext,
  value: string,
  strFromDataIdx = ctx.funcMap.get("__str_from_data"),
  plannedBytes?: readonly number[],
): readonly Instr[] {
  const encoded = plannedBytes === undefined ? [...new TextEncoder().encode(value)] : [...plannedBytes];
  let literal = ctx.stringLiterals.get(value);
  if (literal === undefined) {
    const cacheGlobalIdx = ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `${LITERAL_CACHE_GLOBAL_PREFIX}${ctx.stringLiterals.size}`,
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    literal = { offset: ctx.dataSegmentOffset, bytes: encoded, cacheGlobalIdx };
    ctx.stringLiterals.set(value, literal);
    ctx.dataSegmentOffset += literal.bytes.length;
  } else if (literal.bytes.length !== encoded.length || literal.bytes.some((byte, index) => byte !== encoded[index])) {
    throw new Error(`linear string runtime: conflicting data bytes for ${JSON.stringify(value)}`);
  }
  if (strFromDataIdx === undefined) throw new Error("linear string runtime: __str_from_data helper missing");

  // #4540 — in linked mode the literal image is copied into a block obtained
  // from the engine's allocator, so `literal.offset` is a position WITHIN the
  // image, not an address. One runtime bias corrects every offset because the
  // image preserves the link-time layout byte for byte. Standalone keeps the
  // bare constant, so its emitted bytes are unchanged.
  const literalAddr: Instr[] =
    ctx.roDataBiasGlobalIdx === undefined
      ? [{ op: "i32.const", value: literal.offset }]
      : [
          { op: "global.get", index: ctx.roDataBiasGlobalIdx },
          { op: "i32.const", value: literal.offset },
          { op: "i32.add" },
        ];

  const materialize: Instr[] = [
    ...literalAddr,
    { op: "i32.const", value: literal.bytes.length },
    { op: "call", funcIdx: strFromDataIdx },
    { op: "global.set", index: literal.cacheGlobalIdx },
    { op: "global.get", index: literal.cacheGlobalIdx },
  ];
  return [
    { op: "global.get", index: literal.cacheGlobalIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: materialize,
      else: [{ op: "global.get", index: literal.cacheGlobalIdx }],
    },
  ];
}
