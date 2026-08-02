// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1588 PR-B — dual i8/i16 storage: type registration + literal materialization.
//
// Scope of PR-B part 1 (this test): the additive, gated scaffolding —
//   - `--utf8-storage` off → Utf8String / __str_data_u8 are NOT registered
//     (type table byte-identical to today).
//   - `--utf8-storage` on  → both types registered as AnyString subtypes.
//   - `nativeStringLiteralInstrs(ctx, value, encoding)` emits an i8-backed
//     Utf8String for ascii/utf8-guaranteed and the i16 NativeString otherwise.
//   - the UTF-8 byte encoding is correct (incl. astral scalars) and refuses
//     lone surrogates (defensive classifier-bug guard).

import { describe, expect, it } from "vitest";

import type { CodegenContext } from "../../src/codegen/context/types.js";
import { registerNativeStringTypes } from "../../src/codegen/registry/types.js";
import { nativeStringLiteralInstrs } from "../../src/codegen/native-strings.js";

// Minimal context exercising only the fields the type registration + literal
// emission touch — avoids the full createCodegenContext factory (which needs a
// ts.Program/checker). registerNativeStringTypes + nativeStringLiteralInstrs
// read ctx.mod.types, ctx.utf8Storage, and the *TypeIdx fields only.
function ctxWith(utf8Storage: boolean): CodegenContext {
  const ctx = {
    mod: { types: [] as unknown[], globals: [] as unknown[] },
    nativeStrings: true,
    utf8Storage,
    numImportGlobals: 0,
    nativeStrLiteralGlobals: new Map(),
    nativeStrDataTypeIdx: -1,
    anyStrTypeIdx: -1,
    nativeStrTypeIdx: -1,
    consStrTypeIdx: -1,
    utf8StrDataTypeIdx: -1,
    utf8StrTypeIdx: -1,
  } as unknown as CodegenContext;
  registerNativeStringTypes(ctx);
  return ctx;
}

function literalInitializer(ctx: CodegenContext, value: string, encoding: "ascii" | "utf8-guaranteed" | "wtf16") {
  const instrs = nativeStringLiteralInstrs(ctx, value, encoding);
  expect(instrs).toHaveLength(1);
  expect(instrs[0]?.op).toBe("global.get");
  const globalIndex = (instrs[0] as { op: "global.get"; index: number }).index - ctx.numImportGlobals;
  return ctx.mod.globals[globalIndex]!.init;
}

describe("#1588 PR-B — type registration gating", () => {
  it("flag off: Utf8String / __str_data_u8 are not registered", () => {
    const ctx = ctxWith(false);
    expect(ctx.utf8StrTypeIdx).toBe(-1);
    expect(ctx.utf8StrDataTypeIdx).toBe(-1);
    expect(ctx.mod.types.some((t) => "name" in t && t.name === "Utf8String")).toBe(false);
    expect(ctx.mod.types.some((t) => "name" in t && t.name === "__str_data_u8")).toBe(false);
  });

  it("flag on: both types registered as AnyString subtypes", () => {
    const ctx = ctxWith(true);
    expect(ctx.utf8StrDataTypeIdx).toBeGreaterThanOrEqual(0);
    expect(ctx.utf8StrTypeIdx).toBeGreaterThanOrEqual(0);
    const u8data = ctx.mod.types[ctx.utf8StrDataTypeIdx]!;
    expect(u8data.kind).toBe("array");
    expect((u8data as { element: { kind: string } }).element.kind).toBe("i8");
    const u8str = ctx.mod.types[ctx.utf8StrTypeIdx]!;
    expect(u8str.kind).toBe("struct");
    expect((u8str as { superTypeIdx: number }).superTypeIdx).toBe(ctx.anyStrTypeIdx);
    // Fields: len, byteLen, off, data
    expect((u8str as { fields: { name: string }[] }).fields.map((f) => f.name)).toEqual([
      "len",
      "byteLen",
      "off",
      "data",
    ]);
  });
});

describe("#1588 PR-B — literal materialization", () => {
  it("ascii literal with flag on → i8 Utf8String", () => {
    const ctx = ctxWith(true);
    const instrs = literalInitializer(ctx, "hi", "ascii");
    // struct.new of the Utf8String type, array.new_fixed of the i8 data type.
    expect(instrs.some((i) => i.op === "struct.new" && (i as { typeIdx: number }).typeIdx === ctx.utf8StrTypeIdx)).toBe(
      true,
    );
    expect(
      instrs.some((i) => i.op === "array.new_fixed" && (i as { typeIdx: number }).typeIdx === ctx.utf8StrDataTypeIdx),
    ).toBe(true);
    // len=2, byteLen=2 for ascii.
    const consts = instrs.filter((i) => i.op === "i32.const").map((i) => (i as { value: number }).value);
    expect(consts[0]).toBe(2); // len (code units)
    expect(consts[1]).toBe(2); // byteLen
    expect(consts[2]).toBe(0); // off
    expect(consts.slice(3)).toEqual([0x68, 0x69]); // 'h','i'
  });

  it("wtf16 literal with flag on → i16 NativeString (unchanged path)", () => {
    const ctx = ctxWith(true);
    const instrs = literalInitializer(ctx, "\uD800x", "wtf16");
    expect(
      instrs.some((i) => i.op === "struct.new" && (i as { typeIdx: number }).typeIdx === ctx.hashedStrTypeIdx),
    ).toBe(true);
  });

  it("ascii literal with flag OFF → i16 NativeString even if encoding says ascii", () => {
    const ctx = ctxWith(false);
    const instrs = literalInitializer(ctx, "hi", "ascii");
    expect(
      instrs.some((i) => i.op === "struct.new" && (i as { typeIdx: number }).typeIdx === ctx.hashedStrTypeIdx),
    ).toBe(true);
  });

  it("utf8-guaranteed multi-byte literal encodes correct UTF-8 bytes", () => {
    const ctx = ctxWith(true);
    // "é" = U+00E9 → 0xC3 0xA9 (2 bytes); len=1, byteLen=2.
    const instrs = literalInitializer(ctx, "é", "utf8-guaranteed");
    const consts = instrs.filter((i) => i.op === "i32.const").map((i) => (i as { value: number }).value);
    expect(consts[0]).toBe(1); // len (1 code unit)
    expect(consts[1]).toBe(2); // byteLen (2 UTF-8 bytes)
    expect(consts[2]).toBe(0); // off
    expect(consts.slice(3)).toEqual([0xc3, 0xa9]);
  });

  it("astral scalar (surrogate pair) encodes as 4 UTF-8 bytes", () => {
    const ctx = ctxWith(true);
    // U+1F600 😀 = surrogate pair (len 2 code units) → F0 9F 98 80.
    const instrs = literalInitializer(ctx, "\u{1f600}", "utf8-guaranteed");
    const consts = instrs.filter((i) => i.op === "i32.const").map((i) => (i as { value: number }).value);
    expect(consts[0]).toBe(2); // len (2 code units)
    expect(consts[1]).toBe(4); // byteLen
    expect(consts.slice(3)).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it("falls back to one interned i16 global when UTF-8 bytes alone exceed the fixed-array limit", () => {
    const ctx = ctxWith(true);
    const value = "💩".repeat(2_501); // 10,004 UTF-8 bytes, 5,002 UTF-16 code units.
    const instrs = literalInitializer(ctx, value, "utf8-guaranteed");
    expect(instrs).toContainEqual({
      op: "array.new_fixed",
      typeIdx: ctx.nativeStrDataTypeIdx,
      length: 5_002,
    });
    expect(instrs).toContainEqual({ op: "struct.new", typeIdx: ctx.hashedStrTypeIdx });
  });
});
