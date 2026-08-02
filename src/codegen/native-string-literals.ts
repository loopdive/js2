// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** #1588 encoding evidence selected by the backend-neutral IR analysis. */
export type StringEncoding = "ascii" | "utf8-guaranteed" | "wtf16";

export type NativeStringLiteralMaterialization =
  | { readonly kind: "global"; readonly globalIdx: number }
  | { readonly kind: "callable"; readonly funcIdx: number };

/** V8's validated upper bound for one `array.new_fixed` instruction. */
const ARRAY_NEW_FIXED_MAX = 10000;

function nativeStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
}

function nativeLiteralUsesUtf8(ctx: CodegenContext, encoding: StringEncoding | undefined): boolean {
  return ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0 && (encoding === "ascii" || encoding === "utf8-guaranteed");
}

/**
 * Select the exact native materialization once.
 *
 * Common literals retain the immutable interned-global path introduced for
 * Acorn. A literal beyond `array.new_fixed`'s validated limit uses one cached
 * rope-building helper assembled from interned, fixed-size chunks.
 */
export function nativeStringLiteralMaterialization(
  ctx: CodegenContext,
  value: string,
  encoding?: StringEncoding,
): NativeStringLiteralMaterialization {
  if (nativeLiteralUsesUtf8(ctx, encoding)) {
    const bytes = utf8Encode(value);
    if (bytes.length > ARRAY_NEW_FIXED_MAX) {
      if (value.length <= ARRAY_NEW_FIXED_MAX) {
        const inline = nativeStringLiteralInitInstrs(ctx, value);
        return {
          kind: "global",
          globalIdx: internNativeStringLiteral(ctx, `u16:${value}`, ctx.nativeStrTypeIdx, inline),
        };
      }
      return { kind: "callable", funcIdx: ensureOversizedNativeStringLiteralHelper(ctx, value) };
    }
    const inline = utf8StringLiteralInstrs(ctx, value);
    return {
      kind: "global",
      globalIdx: internNativeStringLiteral(ctx, `u8:${value}`, ctx.utf8StrTypeIdx, inline),
    };
  }

  if (value.length > ARRAY_NEW_FIXED_MAX) {
    return { kind: "callable", funcIdx: ensureOversizedNativeStringLiteralHelper(ctx, value) };
  }
  const inline = nativeStringLiteralInitInstrs(ctx, value);
  return {
    kind: "global",
    globalIdx: internNativeStringLiteral(ctx, `u16:${value}`, ctx.nativeStrTypeIdx, inline),
  };
}

/** Emit one exact global read or materializer call for a native literal. */
export function nativeStringLiteralInstrs(ctx: CodegenContext, value: string, encoding?: StringEncoding): Instr[] {
  const materialization = nativeStringLiteralMaterialization(ctx, value, encoding);
  return materialization.kind === "global"
    ? [{ op: "global.get", index: materialization.globalIdx }]
    : [{ op: "call", funcIdx: materialization.funcIdx }];
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
function nativeStringLiteralInitInstrs(ctx: CodegenContext, value: string): Instr[] {
  const instrs: Instr[] = [
    { op: "i32.const", value: value.length },
    { op: "i32.const", value: 0 },
  ];
  for (let index = 0; index < value.length; index++) {
    instrs.push({ op: "i32.const", value: value.charCodeAt(index) });
  }
  instrs.push({
    op: "array.new_fixed",
    typeIdx: ctx.nativeStrDataTypeIdx,
    length: value.length,
  });
  if (ctx.hashedStrTypeIdx >= 0) {
    instrs.push(
      { op: "i32.const", value: nativeStringLiteralHash(value) },
      { op: "i32.const", value: 0 },
      { op: "ref.null", typeIdx: -18 },
      { op: "ref.null", typeIdx: -18 },
      { op: "ref.null", typeIdx: -18 },
      { op: "struct.new", typeIdx: ctx.hashedStrTypeIdx },
    );
    return instrs;
  }
  instrs.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
  return instrs;
}

/** Plan one immutable literal global and return its absolute global index. */
function internNativeStringLiteral(ctx: CodegenContext, key: string, refTypeIdx: number, init: Instr[]): number {
  const existing = ctx.nativeStrLiteralGlobals.get(key);
  if (existing !== undefined) return existing;
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: `__strlit_${ctx.nativeStrLiteralGlobals.size}`,
    type: { kind: "ref", typeIdx: refTypeIdx },
    mutable: false,
    init,
  });
  ctx.nativeStrLiteralGlobals.set(key, globalIdx);
  return globalIdx;
}

/** Raw immutable-global initializer for an i8-backed UTF-8 literal. */
function utf8StringLiteralInstrs(ctx: CodegenContext, value: string): Instr[] {
  const bytes = utf8Encode(value);
  const instrs: Instr[] = [
    { op: "i32.const", value: value.length },
    { op: "i32.const", value: bytes.length },
    { op: "i32.const", value: 0 },
  ];
  for (const byte of bytes) instrs.push({ op: "i32.const", value: byte });
  instrs.push(
    { op: "array.new_fixed", typeIdx: ctx.utf8StrDataTypeIdx, length: bytes.length },
    { op: "struct.new", typeIdx: ctx.utf8StrTypeIdx },
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

/**
 * Build one zero-argument helper that returns the exact literal as a native
 * rope of i16 leaves. The native rope flattener consumes NativeString leaves,
 * so even a UTF-8-proven oversized literal deliberately uses this shared i16
 * representation. The helper avoids invalid oversized fixed-array operations.
 */
function ensureOversizedNativeStringLiteralHelper(ctx: CodegenContext, value: string): number {
  const cacheKey = `__strlit_materialize:u16:${value}`;
  const existing = ctx.nativeStrHelpers.get(cacheKey);
  if (existing !== undefined) return existing;
  if (ctx.anyStrTypeIdx < 0 || ctx.consStrTypeIdx < 0) {
    throw new Error("oversized native string literal requires the complete native-string type family");
  }

  const chunks = splitOversizedNativeLiteral(value);
  if (chunks.length < 2) {
    throw new Error("oversized native string literal did not split into fixed-array-safe chunks");
  }
  const globals = chunks.map((chunk) => {
    const materialization = nativeStringLiteralMaterialization(ctx, chunk, "wtf16");
    if (materialization.kind !== "global") {
      throw new Error("oversized native string literal chunk exceeded the fixed-array limit");
    }
    return materialization.globalIdx;
  });

  const strRef = nativeStringType(ctx);
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
      { op: "struct.new", typeIdx: ctx.consStrTypeIdx },
      { op: "local.set", index: 0 },
    );
  }
  body.push({ op: "local.get", index: 0 });

  const helperOrdinal = ctx.nativeStrHelpers.size;
  const typeIdx = addFuncType(ctx, [], [strRef]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: `__strlit_materialize_${helperOrdinal}`,
    typeIdx,
    locals: [{ name: "value", type: strRef }],
    body,
    exported: false,
  });
  ctx.nativeStrHelpers.set(cacheKey, funcIdx);
  return funcIdx;
}
