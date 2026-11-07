// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7291) Instruction sequences of the #1210 string builder, shared by the
 * legacy rewrite (`codegen/string-builder.ts`) and the IR builder lowering.
 *
 * A builder is four locals: an i16 `buf`, its used `len`, its `cap`, and `mat`,
 * a cached `$NativeString` view of `buf[0..len)` that every append clears
 * (#1580). Each emitter is pure: the caller owns local allocation and passes
 * the slot indices in, so both front-ends emit the same bytes.
 */
import type { Instr } from "../types.js";

export interface StringBuilderSlots {
  readonly buf: number;
  readonly len: number;
  readonly cap: number;
  readonly mat: number;
  /** (#1761) The buffer holds the final length, so appends never grow it. */
  readonly presized: boolean;
}

/** Type indices of the native string representation. */
export interface StringBuilderTypes {
  /** The i16 array. */
  readonly data: number;
  /** `$NativeString` (len, off, data). */
  readonly flat: number;
  /** `$AnyString`, the type of the `mat` slot. */
  readonly any: number;
}

/** Scratch locals of one append; `oldBuf` is required unless the builder is presized. */
export interface StringBuilderAppendScratch {
  readonly needed: number;
  readonly oldBuf?: number;
}

/** A never-iterated builder wastes little; a few iterations do not grow it. */
export const STRING_BUILDER_INITIAL_CAP = 16;

/** Empty doubling builder: `buf = new i16[cap]`, `len = 0`, `mat = null`. */
export function stringBuilderInitInstrs(t: StringBuilderTypes, sb: StringBuilderSlots, initialCap: number): Instr[] {
  return [
    { op: "i32.const", value: initialCap },
    { op: "array.new_default", typeIdx: t.data },
    { op: "local.set", index: sb.buf },
    { op: "i32.const", value: initialCap },
    { op: "local.set", index: sb.cap },
    ...stringBuilderResetInstrs(t, sb),
  ];
}

/** `len = 0`, `mat = null`: the tail of every init, presized or not. */
export function stringBuilderResetInstrs(t: StringBuilderTypes, sb: StringBuilderSlots): Instr[] {
  return [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: sb.len },
    { op: "ref.null", typeIdx: t.any },
    { op: "local.set", index: sb.mat },
  ];
}

/**
 * (#1761) Consumes the i32 loop bound: `cap = max(0, bound) * unitsPerIter`,
 * `buf = new i16[cap]`. Wasm has no `i32.max`, so the clamp is a `select`.
 */
export function stringBuilderPresizedAllocInstrs(
  t: StringBuilderTypes,
  sb: StringBuilderSlots,
  boundTmp: number,
  unitsPerIter: number,
): Instr[] {
  return [
    { op: "local.set", index: boundTmp },
    { op: "local.get", index: boundTmp },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: boundTmp },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    { op: "select" },
    ...(unitsPerIter !== 1 ? ([{ op: "i32.const", value: unitsPerIter }, { op: "i32.mul" }] as Instr[]) : []),
    { op: "local.set", index: sb.cap },
    { op: "local.get", index: sb.cap },
    { op: "array.new_default", typeIdx: t.data },
    { op: "local.set", index: sb.buf },
  ];
}

/**
 * Consumes a `ref $AnyString` and appends it: flatten, grow to `needed` if
 * the builder is not presized, copy, bump `len`, clear `mat`.
 */
export function stringBuilderAppendStringInstrs(
  t: StringBuilderTypes,
  sb: StringBuilderSlots,
  scratch: StringBuilderAppendScratch & { readonly rhs: number; readonly rhsLen: number },
  helpers: { readonly flatten: number; readonly nextCap: number },
): Instr[] {
  const { rhs, rhsLen, needed } = scratch;
  return [
    { op: "call", funcIdx: helpers.flatten },
    { op: "local.set", index: rhs },
    { op: "local.get", index: rhs },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: t.flat, fieldIdx: 0 },
    { op: "local.set", index: rhsLen },
    { op: "local.get", index: sb.len },
    { op: "local.get", index: rhsLen },
    { op: "i32.add" },
    { op: "local.set", index: needed },
    ...stringBuilderGrowInstrs(t, sb, scratch, helpers.nextCap),
    { op: "local.get", index: sb.buf },
    { op: "ref.as_non_null" },
    { op: "local.get", index: sb.len },
    { op: "local.get", index: rhs },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: t.flat, fieldIdx: 2 },
    { op: "local.get", index: rhs },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: t.flat, fieldIdx: 1 },
    { op: "local.get", index: rhsLen },
    { op: "array.copy", dstTypeIdx: t.data, srcTypeIdx: t.data },
    ...stringBuilderCommitInstrs(t, sb, needed),
  ];
}

/**
 * (#1744) Consumes one i32 code unit and appends it without materialising a
 * one-unit string: the `s += x.charAt(i)` / `s += "c"` hot path.
 */
export function stringBuilderAppendCodeUnitInstrs(
  t: StringBuilderTypes,
  sb: StringBuilderSlots,
  scratch: StringBuilderAppendScratch & { readonly cu: number },
  nextCap: number,
): Instr[] {
  const { cu, needed } = scratch;
  return [
    { op: "local.set", index: cu },
    { op: "local.get", index: sb.len },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: needed },
    ...stringBuilderGrowInstrs(t, sb, scratch, nextCap),
    { op: "local.get", index: sb.buf },
    { op: "ref.as_non_null" },
    { op: "local.get", index: sb.len },
    { op: "local.get", index: cu },
    { op: "array.set", typeIdx: t.data },
    ...stringBuilderCommitInstrs(t, sb, needed),
  ];
}

/**
 * Consumes a `ref $AnyString` receiver and an i32 index and appends
 * `receiver.charAt(index)` as one code unit; an index out of range appends
 * nothing, since `charAt` then yields `""`.
 */
export function stringBuilderAppendCharAtInstrs(
  t: StringBuilderTypes,
  sb: StringBuilderSlots,
  scratch: StringBuilderAppendScratch & { readonly receiver: number; readonly index: number; readonly cu: number },
  helpers: { readonly flatten: number; readonly nextCap: number },
): Instr[] {
  const { receiver, index } = scratch;
  const field = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: receiver },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: t.flat, fieldIdx },
  ];
  return [
    { op: "local.set", index },
    { op: "call", funcIdx: helpers.flatten },
    { op: "local.set", index: receiver },
    { op: "local.get", index },
    ...field(0),
    { op: "i32.lt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...field(2),
        ...field(1),
        { op: "local.get", index },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: t.data },
        ...stringBuilderAppendCodeUnitInstrs(t, sb, scratch, helpers.nextCap),
      ],
    },
  ];
}

/**
 * (#1580) Pushes `ref $NativeString` for the current contents, materialising
 * it into `mat` only when an append has cleared the cache.
 */
export function stringBuilderReadInstrs(t: StringBuilderTypes, sb: StringBuilderSlots): Instr[] {
  return [
    { op: "local.get", index: sb.mat },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: sb.len },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: sb.buf },
        { op: "ref.as_non_null" },
        { op: "struct.new", typeIdx: t.flat },
        { op: "local.set", index: sb.mat },
      ],
    },
    { op: "local.get", index: sb.mat },
    { op: "ref.cast", typeIdx: t.flat },
  ];
}

/** Doubling growth to `needed`; nothing for a presized builder. */
function stringBuilderGrowInstrs(
  t: StringBuilderTypes,
  sb: StringBuilderSlots,
  scratch: StringBuilderAppendScratch,
  nextCap: number,
): Instr[] {
  if (sb.presized) return [];
  const { needed, oldBuf } = scratch;
  return [
    { op: "local.get", index: needed },
    { op: "local.get", index: sb.cap },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: sb.cap },
        { op: "local.get", index: needed },
        { op: "call", funcIdx: nextCap },
        { op: "local.set", index: sb.cap },
        // The old buffer is the copy source after `buf` is replaced.
        { op: "local.get", index: sb.buf },
        { op: "local.set", index: oldBuf! },
        { op: "local.get", index: sb.cap },
        { op: "array.new_default", typeIdx: t.data },
        { op: "local.set", index: sb.buf },
        { op: "local.get", index: sb.buf },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: oldBuf! },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: sb.len },
        { op: "array.copy", dstTypeIdx: t.data, srcTypeIdx: t.data },
      ],
    },
  ];
}

/** `len = needed`, `mat = null`: a reader must re-materialise. */
function stringBuilderCommitInstrs(t: StringBuilderTypes, sb: StringBuilderSlots, needed: number): Instr[] {
  return [
    { op: "local.get", index: needed },
    { op: "local.set", index: sb.len },
    { op: "ref.null", typeIdx: t.any },
    { op: "local.set", index: sb.mat },
  ];
}

/** The native helpers a builder calls. */
export interface StringBuilderHelpers {
  readonly flatten: number;
  readonly nextCap: number;
}

/** What the WasmGC resolver answers when the native string builder applies. */
export interface StringBuilderLowering {
  readonly types: StringBuilderTypes;
  readonly helpers: StringBuilderHelpers;
}

/** One builder's scratch locals, shared by all of its appends. */
export interface StringBuilderScratch {
  readonly needed: number;
  readonly oldBuf: number;
  readonly rhs: number;
  readonly rhsLen: number;
  readonly cu: number;
  readonly receiver: number;
  readonly index: number;
}
