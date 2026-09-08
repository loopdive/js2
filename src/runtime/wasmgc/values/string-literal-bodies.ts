// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import type { NativeStringLayout } from "./string-layouts.js";

/** #1588 encoding evidence selected by the backend-neutral IR analysis. */
export type StringEncoding = "ascii" | "utf8-guaranteed" | "wtf16";

/** V8's validated upper bound for one `array.new_fixed` instruction. */
const ARRAY_NEW_FIXED_MAX = 10000;

export type NativeLiteralPlan =
  | { readonly kind: "global"; readonly key: string; readonly refTypeIdx: number; readonly init: Instr[] }
  | { readonly kind: "callable"; readonly key: string; readonly chunks: readonly string[] };

/** Selection, encoding evidence and oversized fallback shared by both callers. */
export function planNativeStringLiteral(
  layout: NativeStringLayout,
  utf8Storage: boolean,
  value: string,
  encoding?: StringEncoding,
): NativeLiteralPlan {
  const utf8 = utf8Storage && layout.utf8StrTypeIdx >= 0 && (encoding === "ascii" || encoding === "utf8-guaranteed");
  if (utf8 && utf8Encode(value).length <= ARRAY_NEW_FIXED_MAX) {
    return {
      kind: "global",
      key: `u8:${value}`,
      refTypeIdx: layout.utf8StrTypeIdx,
      init: utf8StringLiteralInstrs(layout, value),
    };
  }
  if (value.length > ARRAY_NEW_FIXED_MAX) {
    return { kind: "callable", key: `__strlit_materialize:u16:${value}`, chunks: splitOversizedNativeLiteral(value) };
  }
  return {
    kind: "global",
    key: `u16:${value}`,
    refTypeIdx: layout.nativeStrTypeIdx,
    init: nativeStringLiteralInitInstrs(layout, value),
  };
}

/**
 * FNV-1a over UTF-16 code units in the stored `$HashedString` encoding.
 * This must remain byte-identical to `__obj_hash`.
 */
export function nativeStringLiteralHash(value: string): number {
  let hash = 0x811c9dc5 | 0;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash & 0x7fffffff) | 0x80000000 | 0;
}

/** Raw immutable-global initializer for an i16-backed native literal. */
function nativeStringLiteralInitInstrs(layout: NativeStringLayout, value: string): Instr[] {
  const instrs: Instr[] = [
    { op: "i32.const", value: value.length },
    { op: "i32.const", value: 0 },
  ];
  for (let index = 0; index < value.length; index++) {
    instrs.push({ op: "i32.const", value: value.charCodeAt(index) });
  }
  instrs.push({
    op: "array.new_fixed",
    typeIdx: layout.nativeStrDataTypeIdx,
    length: value.length,
  });
  if (layout.hashedStrTypeIdx >= 0) {
    instrs.push(
      { op: "i32.const", value: nativeStringLiteralHash(value) },
      { op: "i32.const", value: 0 },
      { op: "ref.null", typeIdx: -18 },
      { op: "ref.null", typeIdx: -18 },
      { op: "ref.null", typeIdx: -18 },
      { op: "struct.new", typeIdx: layout.hashedStrTypeIdx },
    );
    return instrs;
  }
  instrs.push({ op: "struct.new", typeIdx: layout.nativeStrTypeIdx });
  return instrs;
}

/** Raw immutable-global initializer for an i8-backed UTF-8 literal. */
function utf8StringLiteralInstrs(layout: NativeStringLayout, value: string): Instr[] {
  const bytes = utf8Encode(value);
  const instrs: Instr[] = [
    { op: "i32.const", value: value.length },
    { op: "i32.const", value: bytes.length },
    { op: "i32.const", value: 0 },
  ];
  for (const byte of bytes) instrs.push({ op: "i32.const", value: byte });
  instrs.push(
    { op: "array.new_fixed", typeIdx: layout.utf8StrDataTypeIdx, length: bytes.length },
    { op: "struct.new", typeIdx: layout.utf8StrTypeIdx },
  );
  return instrs;
}

/** Encode well-formed UTF-16 as UTF-8 and reject stale encoding evidence. */
function utf8Encode(value: string): number[] {
  const out: number[] = [];
  for (let index = 0; index < value.length; index++) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;
      if (low < 0xdc00 || low > 0xdfff) {
        throw new Error("native string literal has a lone high surrogate despite UTF-8 encoding evidence");
      }
      codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
      index++;
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      throw new Error("native string literal has a lone low surrogate despite UTF-8 encoding evidence");
    }
    if (codePoint <= 0x7f) {
      out.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      out.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return out;
}

/** Split into fixed-array-safe i16 leaves; code-point iteration crosses leaf boundaries. */
function splitOversizedNativeLiteral(value: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += ARRAY_NEW_FIXED_MAX) {
    chunks.push(value.slice(offset, offset + ARRAY_NEW_FIXED_MAX));
  }
  return chunks;
}

export function buildOversizedNativeStringLiteral(
  layout: NativeStringLayout,
  chunks: readonly string[],
  globals: readonly number[],
): { locals: LocalDef[]; body: Instr[] } {
  if (chunks.length < 2 || chunks.length !== globals.length) throw new Error("invalid native literal chunks");
  const strRef: ValType = { kind: "ref", typeIdx: layout.anyStrTypeIdx };
  const body: Instr[] = [
    { op: "global.get", index: globals[0]! },
    { op: "local.set", index: 0 },
  ];
  let cumulativeLength = chunks[0]!.length;
  for (let index = 1; index < chunks.length; index++) {
    cumulativeLength += chunks[index]!.length;
    body.push(
      { op: "i32.const", value: cumulativeLength },
      { op: "local.get", index: 0 },
      { op: "global.get", index: globals[index]! },
      { op: "struct.new", typeIdx: layout.consStrTypeIdx },
      { op: "local.set", index: 0 },
    );
  }
  body.push({ op: "local.get", index: 0 });

  return { locals: [{ name: "value", type: strRef }], body };
}
