// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm Unicode 17.0.0 normalization for `String.prototype.normalize`.
 *
 * This builder is deliberately demand-driven: the main native-string prelude
 * does not pay for the UCD tables unless a module actually invokes normalize.
 * The generated table contract is pinned in `normalize-tables.ts`; all table
 * globals are materialised once per module and the algorithm below performs
 * decomposition, canonical ordering, composition, Hangul handling, and
 * WTF-16 surrogate preservation without a host/ICU import.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import {
  NORMALIZE_CANONICAL_KEYS,
  NORMALIZE_CANONICAL_LENGTHS,
  NORMALIZE_CANONICAL_OFFSETS,
  NORMALIZE_CANONICAL_VALUES,
  NORMALIZE_CCC_RANGES,
  NORMALIZE_COMPATIBILITY_KEYS,
  NORMALIZE_COMPATIBILITY_LENGTHS,
  NORMALIZE_COMPATIBILITY_OFFSETS,
  NORMALIZE_COMPATIBILITY_VALUES,
  NORMALIZE_COMPOSITION_PAIRS,
} from "./normalize-tables.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { addFuncType, getOrRegisterArrayType } from "./registry/types.js";

const I32: ValType = { kind: "i32" };

const HANGUL_S_BASE = 0xac00;
const HANGUL_S_COUNT = 11172;
const HANGUL_L_BASE = 0x1100;
const HANGUL_V_BASE = 0x1161;
const HANGUL_T_BASE = 0x11a7;
const HANGUL_L_COUNT = 19;
const HANGUL_V_COUNT = 21;
const HANGUL_T_COUNT = 28;
const HANGUL_N_COUNT = HANGUL_V_COUNT * HANGUL_T_COUNT;
const ARRAY_NEW_FIXED_MAX = 10_000;

export const NORMALIZE_FORM_RANGE_ERROR = "RangeError: The normalization form should be one of NFC, NFD, NFKC, NFKD";
export const NORMALIZE_SYMBOL_STRING_ERROR = "Cannot convert a Symbol value to a string";
export const NORMALIZE_NULLISH_RECEIVER_ERROR = "String.prototype.normalize called on null or undefined";

/**
 * Provision the two observable error surfaces before callers capture helper
 * handles. Both throw builders may settle a late-import batch; their returned
 * instruction templates are deliberately discarded here and rebuilt at the
 * actual branch site after the handles are read.
 */
export function ensureNormalizeErrorSurface(ctx: CodegenContext, fctx: FunctionContext): void {
  buildThrowJsErrorInstrs(ctx, "TypeError", NORMALIZE_SYMBOL_STRING_ERROR, { flush: fctx, forceInModuleCtor: true });
  buildThrowJsErrorInstrs(ctx, "TypeError", NORMALIZE_NULLISH_RECEIVER_ERROR, { flush: fctx, forceInModuleCtor: true });
  buildThrowJsErrorInstrs(ctx, "RangeError", NORMALIZE_FORM_RANGE_ERROR, { flush: fctx });
}

/**
 * Turn an already-flattened normalization-form string into the small enum used
 * by `__str_normalize`: NFC=0, NFD=1, NFKC=2, NFKD=3. Both direct and
 * reflective call paths use this exact comparison ladder after their own
 * observable ToString/default work, so validation cannot drift between them.
 */
export function emitNormalizeFormMode(ctx: CodegenContext, fctx: FunctionContext, formLocal: number): boolean {
  ensureNativeStringHelpers(ctx);

  // Provision every operation that can grow an import/function table before
  // resolving the comparison helper. In particular, the native RangeError
  // path may register `__new_RangeError` and flush late-import shifts against
  // this caller. The short form literals currently materialise as globals, but
  // keeping their provisioning here also makes that fact non-essential to the
  // comparison handle's lifetime.
  const forms = ["NFC", "NFD", "NFKC", "NFKD"] as const;
  const formLiteralInstrs = forms.map((form) => nativeStringLiteralInstrs(ctx, form));
  const invalidFormInstrs = buildThrowJsErrorInstrs(ctx, "RangeError", NORMALIZE_FORM_RANGE_ERROR, { flush: fctx });
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (equalsIdx === undefined) return false;

  let otherwise: Instr[] = [...invalidFormInstrs, { op: "i32.const", value: 0 }];
  for (let mode = forms.length - 1; mode >= 0; mode--) {
    otherwise = [
      { op: "local.get", index: formLocal },
      ...formLiteralInstrs[mode]!,
      { op: "call", funcIdx: equalsIdx },
      {
        op: "if",
        blockType: { kind: "val", type: I32 },
        then: [{ op: "i32.const", value: mode }],
        else: otherwise,
      },
    ];
  }
  fctx.body.push(...otherwise);
  return true;
}

function constI32Array(values: readonly number[], typeIdx: number): Instr[] {
  if (values.length > ARRAY_NEW_FIXED_MAX) {
    throw new Error(
      `normalize table has ${values.length} values, exceeding array.new_fixed maximum ${ARRAY_NEW_FIXED_MAX}`,
    );
  }
  const instrs: Instr[] = [];
  for (const value of values) instrs.push({ op: "i32.const", value });
  instrs.push({ op: "array.new_fixed", typeIdx, length: values.length });
  return instrs;
}

function addTableGlobal(ctx: CodegenContext, name: string, values: readonly number[], typeIdx: number): number {
  const index = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name,
    type: { kind: "ref", typeIdx },
    mutable: false,
    init: constI32Array(values, typeIdx),
  });
  return index;
}

/** `keys` is the sorted code-point column of a decomposition index. */
function emitNormalizeIndexLookup(ctx: CodegenContext, i32ArrTypeIdx: number): number {
  const existing = ctx.nativeStrHelpers.get("__normalize_lookup_index");
  if (existing !== undefined) return existing;
  const arrRef: ValType = { kind: "ref", typeIdx: i32ArrTypeIdx };
  const typeIdx = addFuncType(ctx, [I32, arrRef], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__normalize_lookup_index", funcIdx);

  // params cp(0), keys(1); locals lo(2), hi(3), mid(4), key(5)
  const CP = 0,
    KEYS = 1,
    LO = 2,
    HI = 3,
    MID = 4,
    KEY = 5;
  const get = (index: number): Instr => ({ op: "local.get", index });
  const set = (index: number): Instr => ({ op: "local.set", index });
  const c = (value: number): Instr => ({ op: "i32.const", value });
  const keyGet = (offset: Instr[]): Instr[] => [get(KEYS), ...offset, { op: "array.get", typeIdx: i32ArrTypeIdx }];
  const body: Instr[] = [
    c(0),
    set(LO),
    get(KEYS),
    { op: "array.len" },
    set(HI),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(LO),
            get(HI),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            get(LO),
            get(HI),
            { op: "i32.add" },
            c(1),
            { op: "i32.shr_u" },
            set(MID),
            ...keyGet([get(MID)]),
            set(KEY),
            get(CP),
            get(KEY),
            { op: "i32.lt_u" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [get(MID), set(HI)],
              else: [
                get(CP),
                get(KEY),
                { op: "i32.gt_u" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [get(MID), c(1), { op: "i32.add" }, set(LO)],
                  else: [get(MID), { op: "return" }],
                },
              ],
            },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    c(-1),
  ];
  pushDefinedFunc(ctx, funcIdx, {
    name: "__normalize_lookup_index",
    typeIdx,
    locals: [
      { name: "lo", type: I32 },
      { name: "hi", type: I32 },
      { name: "mid", type: I32 },
      { name: "key", type: I32 },
    ],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}

/** `ranges` is sorted inclusive [start, end, canonicalCombiningClass] triples. */
function emitNormalizeCccLookup(ctx: CodegenContext, i32ArrTypeIdx: number): number {
  const existing = ctx.nativeStrHelpers.get("__normalize_ccc");
  if (existing !== undefined) return existing;
  const arrRef: ValType = { kind: "ref", typeIdx: i32ArrTypeIdx };
  const typeIdx = addFuncType(ctx, [I32, arrRef], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__normalize_ccc", funcIdx);

  // params cp(0), ranges(1); locals lo(2), hi(3), mid(4), base(5), start(6), end(7)
  const CP = 0,
    RANGES = 1,
    LO = 2,
    HI = 3,
    MID = 4,
    BASE = 5,
    START = 6,
    END = 7;
  const get = (index: number): Instr => ({ op: "local.get", index });
  const set = (index: number): Instr => ({ op: "local.set", index });
  const c = (value: number): Instr => ({ op: "i32.const", value });
  const rangeGet = (offset: Instr[]): Instr[] => [get(RANGES), ...offset, { op: "array.get", typeIdx: i32ArrTypeIdx }];
  const body: Instr[] = [
    c(0),
    set(LO),
    get(RANGES),
    { op: "array.len" },
    c(3),
    { op: "i32.div_u" },
    set(HI),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(LO),
            get(HI),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            get(LO),
            get(HI),
            { op: "i32.add" },
            c(1),
            { op: "i32.shr_u" },
            set(MID),
            get(MID),
            c(3),
            { op: "i32.mul" },
            set(BASE),
            ...rangeGet([get(BASE)]),
            set(START),
            get(CP),
            get(START),
            { op: "i32.lt_u" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [get(MID), set(HI)],
              else: [
                ...rangeGet([get(BASE), c(1), { op: "i32.add" }]),
                set(END),
                get(CP),
                get(END),
                { op: "i32.gt_u" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [get(MID), c(1), { op: "i32.add" }, set(LO)],
                  else: [...rangeGet([get(BASE), c(2), { op: "i32.add" }]), { op: "return" }],
                },
              ],
            },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    c(0),
  ];
  pushDefinedFunc(ctx, funcIdx, {
    name: "__normalize_ccc",
    typeIdx,
    locals: [
      { name: "lo", type: I32 },
      { name: "hi", type: I32 },
      { name: "mid", type: I32 },
      { name: "base", type: I32 },
      { name: "start", type: I32 },
      { name: "end", type: I32 },
    ],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}

/** `pairs` is sorted [first, second, composite] triples; -1 means no pair. */
function emitNormalizeCompositionLookup(ctx: CodegenContext, i32ArrTypeIdx: number): number {
  const existing = ctx.nativeStrHelpers.get("__normalize_compose");
  if (existing !== undefined) return existing;
  const arrRef: ValType = { kind: "ref", typeIdx: i32ArrTypeIdx };
  const typeIdx = addFuncType(ctx, [I32, I32, arrRef], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__normalize_compose", funcIdx);

  // params first(0), second(1), pairs(2); locals lo(3), hi(4), mid(5), base(6), left(7), right(8)
  const FIRST = 0,
    SECOND = 1,
    PAIRS = 2,
    LO = 3,
    HI = 4,
    MID = 5,
    BASE = 6,
    LEFT = 7,
    RIGHT = 8;
  const get = (index: number): Instr => ({ op: "local.get", index });
  const set = (index: number): Instr => ({ op: "local.set", index });
  const c = (value: number): Instr => ({ op: "i32.const", value });
  const pairGet = (offset: Instr[]): Instr[] => [get(PAIRS), ...offset, { op: "array.get", typeIdx: i32ArrTypeIdx }];
  const body: Instr[] = [
    c(0),
    set(LO),
    get(PAIRS),
    { op: "array.len" },
    c(3),
    { op: "i32.div_u" },
    set(HI),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(LO),
            get(HI),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            get(LO),
            get(HI),
            { op: "i32.add" },
            c(1),
            { op: "i32.shr_u" },
            set(MID),
            get(MID),
            c(3),
            { op: "i32.mul" },
            set(BASE),
            ...pairGet([get(BASE)]),
            set(LEFT),
            ...pairGet([get(BASE), c(1), { op: "i32.add" }]),
            set(RIGHT),
            // Tuple ordering: (first, second) versus (left, right).
            get(FIRST),
            get(LEFT),
            { op: "i32.lt_u" },
            get(FIRST),
            get(LEFT),
            { op: "i32.eq" },
            get(SECOND),
            get(RIGHT),
            { op: "i32.lt_u" },
            { op: "i32.and" },
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [get(MID), set(HI)],
              else: [
                get(FIRST),
                get(LEFT),
                { op: "i32.gt_u" },
                get(FIRST),
                get(LEFT),
                { op: "i32.eq" },
                get(SECOND),
                get(RIGHT),
                { op: "i32.gt_u" },
                { op: "i32.and" },
                { op: "i32.or" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [get(MID), c(1), { op: "i32.add" }, set(LO)],
                  else: [...pairGet([get(BASE), c(2), { op: "i32.add" }]), { op: "return" }],
                },
              ],
            },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    c(-1),
  ];
  pushDefinedFunc(ctx, funcIdx, {
    name: "__normalize_compose",
    typeIdx,
    locals: [
      { name: "lo", type: I32 },
      { name: "hi", type: I32 },
      { name: "mid", type: I32 },
      { name: "base", type: I32 },
      { name: "left", type: I32 },
      { name: "right", type: I32 },
    ],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}

/**
 * Install `__str_normalize(s, formMode) -> NativeString` on demand.
 *
 * formMode: 0 NFC, 1 NFD, 2 NFKC, 3 NFKD. Call sites perform the observable
 * form coercion/RangeError work; this helper receives only a validated mode.
 */
export function ensureStrNormalize(ctx: CodegenContext): number | undefined {
  const cached = ctx.nativeStrHelpers.get("__str_normalize");
  if (cached !== undefined) return cached;
  ensureNativeStringHelpers(ctx);

  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const nextCapIdx = ctx.nativeStrHelpers.get("__str_buf_next_cap");
  if (flattenIdx === undefined || nextCapIdx === undefined || ctx.nativeStrTypeIdx < 0 || ctx.anyStrTypeIdx < 0) {
    return undefined;
  }

  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const i32ArrTypeIdx = getOrRegisterArrayType(ctx, "i32");
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32ArrTypeIdx };
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  const canonicalKeysGlobal = addTableGlobal(
    ctx,
    "__normalize_canonical_keys",
    NORMALIZE_CANONICAL_KEYS,
    i32ArrTypeIdx,
  );
  const canonicalOffsetsGlobal = addTableGlobal(
    ctx,
    "__normalize_canonical_offsets",
    NORMALIZE_CANONICAL_OFFSETS,
    i32ArrTypeIdx,
  );
  const canonicalLengthsGlobal = addTableGlobal(
    ctx,
    "__normalize_canonical_lengths",
    NORMALIZE_CANONICAL_LENGTHS,
    i32ArrTypeIdx,
  );
  const canonicalValuesGlobal = addTableGlobal(
    ctx,
    "__normalize_canonical_values",
    NORMALIZE_CANONICAL_VALUES,
    i32ArrTypeIdx,
  );
  const compatibilityKeysGlobal = addTableGlobal(
    ctx,
    "__normalize_compatibility_keys",
    NORMALIZE_COMPATIBILITY_KEYS,
    i32ArrTypeIdx,
  );
  const compatibilityOffsetsGlobal = addTableGlobal(
    ctx,
    "__normalize_compatibility_offsets",
    NORMALIZE_COMPATIBILITY_OFFSETS,
    i32ArrTypeIdx,
  );
  const compatibilityLengthsGlobal = addTableGlobal(
    ctx,
    "__normalize_compatibility_lengths",
    NORMALIZE_COMPATIBILITY_LENGTHS,
    i32ArrTypeIdx,
  );
  const compatibilityValuesGlobal = addTableGlobal(
    ctx,
    "__normalize_compatibility_values",
    NORMALIZE_COMPATIBILITY_VALUES,
    i32ArrTypeIdx,
  );
  const cccGlobal = addTableGlobal(ctx, "__normalize_ccc_ranges", NORMALIZE_CCC_RANGES, i32ArrTypeIdx);
  const compositionGlobal = addTableGlobal(
    ctx,
    "__normalize_composition_pairs",
    NORMALIZE_COMPOSITION_PAIRS,
    i32ArrTypeIdx,
  );

  const lookupIndexIdx = emitNormalizeIndexLookup(ctx, i32ArrTypeIdx);
  const cccIdx = emitNormalizeCccLookup(ctx, i32ArrTypeIdx);
  const composeIdx = emitNormalizeCompositionLookup(ctx, i32ArrTypeIdx);
  const typeIdx = addFuncType(ctx, [strRef, I32], [flatStrRef]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__str_normalize", funcIdx);

  // params s(0), form(1). All remaining names below are function locals.
  const S = 0,
    FORM = 1,
    FLAT = 2,
    LEN = 3,
    OFF = 4,
    DATA = 5,
    MAP_KEYS = 6,
    MAP_OFFSETS = 7,
    MAP_LENGTHS = 8,
    MAP_VALUES = 9,
    CCC = 10,
    PAIRS = 11,
    BUFFER = 12,
    CAP = 13,
    COUNT = 14,
    I = 15,
    UNIT = 16,
    NEXT_UNIT = 17,
    CP = 18,
    MAP_ENTRY = 19,
    MAP_OFFSET = 20,
    MAP_LENGTH = 21,
    MAP_I = 22,
    EMIT_CP = 23,
    CCC_VALUE = 24,
    INSERT = 25,
    PREV = 26,
    PREV_CCC = 27,
    HANGUL_INDEX = 28,
    HANGUL_T = 29,
    NEW_BUFFER = 30,
    OUT_COUNT = 31,
    STARTER_INDEX = 32,
    STARTER = 33,
    LAST_CCC = 34,
    COMPOSITE = 35,
    OUT_LENGTH = 36,
    OUT_DATA = 37,
    WRITE = 38;
  const get = (index: number): Instr => ({ op: "local.get", index });
  const set = (index: number): Instr => ({ op: "local.set", index });
  const c = (value: number): Instr => ({ op: "i32.const", value });
  const bufferGet = (offset: Instr[]): Instr[] => [get(BUFFER), ...offset, { op: "array.get", typeIdx: i32ArrTypeIdx }];
  const mapOffsetsGet = (offset: Instr[]): Instr[] => [
    get(MAP_OFFSETS),
    ...offset,
    { op: "array.get", typeIdx: i32ArrTypeIdx },
  ];
  const mapLengthsGet = (offset: Instr[]): Instr[] => [
    get(MAP_LENGTHS),
    ...offset,
    { op: "array.get", typeIdx: i32ArrTypeIdx },
  ];
  const mapValuesGet = (offset: Instr[]): Instr[] => [
    get(MAP_VALUES),
    ...offset,
    { op: "array.get", typeIdx: i32ArrTypeIdx },
  ];
  const sourceUnitAt = (offset: Instr[]): Instr[] => [
    get(DATA),
    get(OFF),
    ...offset,
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
  ];

  // Grow a mutable scalar buffer before a single new element is appended.
  const growForOne = (): Instr[] => [
    get(COUNT),
    c(1),
    { op: "i32.add" },
    get(CAP),
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(CAP),
        get(COUNT),
        c(1),
        { op: "i32.add" },
        { op: "call", funcIdx: nextCapIdx },
        set(CAP),
        get(CAP),
        { op: "array.new_default", typeIdx: i32ArrTypeIdx },
        set(NEW_BUFFER),
        get(NEW_BUFFER),
        c(0),
        get(BUFFER),
        c(0),
        get(COUNT),
        { op: "array.copy", dstTypeIdx: i32ArrTypeIdx, srcTypeIdx: i32ArrTypeIdx },
        get(NEW_BUFFER),
        set(BUFFER),
      ],
    },
  ];

  // Insert EMIT_CP into the current starter-delimited segment. Stable ordering
  // keeps equal CCC values in source order and preserves surrogates as CCC-0
  // barriers, exactly like the UAX #15 canonical-order step.
  const appendOrdered = (): Instr[] => [
    get(EMIT_CP),
    get(CCC),
    { op: "call", funcIdx: cccIdx },
    set(CCC_VALUE),
    ...growForOne(),
    get(CCC_VALUE),
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(BUFFER),
        get(COUNT),
        get(EMIT_CP),
        { op: "array.set", typeIdx: i32ArrTypeIdx },
        get(COUNT),
        c(1),
        { op: "i32.add" },
        set(COUNT),
      ],
      else: [
        get(COUNT),
        set(INSERT),
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                get(INSERT),
                { op: "i32.eqz" },
                { op: "br_if", depth: 1 },
                ...bufferGet([get(INSERT), c(1), { op: "i32.sub" }]),
                set(PREV),
                get(PREV),
                get(CCC),
                { op: "call", funcIdx: cccIdx },
                set(PREV_CCC),
                get(PREV_CCC),
                { op: "i32.eqz" },
                { op: "br_if", depth: 1 },
                get(PREV_CCC),
                get(CCC_VALUE),
                { op: "i32.le_u" },
                { op: "br_if", depth: 1 },
                get(BUFFER),
                get(INSERT),
                get(PREV),
                { op: "array.set", typeIdx: i32ArrTypeIdx },
                get(INSERT),
                c(1),
                { op: "i32.sub" },
                set(INSERT),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        get(BUFFER),
        get(INSERT),
        get(EMIT_CP),
        { op: "array.set", typeIdx: i32ArrTypeIdx },
        get(COUNT),
        c(1),
        { op: "i32.add" },
        set(COUNT),
      ],
    },
  ];

  // Generated mappings are terminal except for Hangul syllables (asserted by
  // gen-normalize-tables). Expand Hangul here so a table value and a direct
  // input syllable follow the same UAX #15 decomposition path.
  const appendDecomposed = (): Instr[] => [
    get(CP),
    set(EMIT_CP),
    get(EMIT_CP),
    c(HANGUL_S_BASE),
    { op: "i32.ge_u" },
    get(EMIT_CP),
    c(HANGUL_S_BASE + HANGUL_S_COUNT),
    { op: "i32.lt_u" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        get(EMIT_CP),
        c(HANGUL_S_BASE),
        { op: "i32.sub" },
        set(HANGUL_INDEX),
        get(HANGUL_INDEX),
        c(HANGUL_N_COUNT),
        { op: "i32.div_u" },
        c(HANGUL_L_BASE),
        { op: "i32.add" },
        set(EMIT_CP),
        ...appendOrdered(),
        get(HANGUL_INDEX),
        c(HANGUL_N_COUNT),
        { op: "i32.rem_u" },
        c(HANGUL_T_COUNT),
        { op: "i32.div_u" },
        c(HANGUL_V_BASE),
        { op: "i32.add" },
        set(EMIT_CP),
        ...appendOrdered(),
        get(HANGUL_INDEX),
        c(HANGUL_T_COUNT),
        { op: "i32.rem_u" },
        set(HANGUL_T),
        get(HANGUL_T),
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [],
          else: [get(HANGUL_T), c(HANGUL_T_BASE), { op: "i32.add" }, set(EMIT_CP), ...appendOrdered()],
        },
      ],
      else: appendOrdered(),
    },
  ];

  const appendMapped = (): Instr[] => [
    get(CP),
    get(MAP_KEYS),
    { op: "call", funcIdx: lookupIndexIdx },
    set(MAP_ENTRY),
    get(MAP_ENTRY),
    c(0),
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...mapOffsetsGet([get(MAP_ENTRY)]),
        set(MAP_OFFSET),
        ...mapLengthsGet([get(MAP_ENTRY)]),
        set(MAP_LENGTH),
        c(0),
        set(MAP_I),
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                get(MAP_I),
                get(MAP_LENGTH),
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                ...mapValuesGet([get(MAP_OFFSET), get(MAP_I), { op: "i32.add" }]),
                set(CP),
                ...appendDecomposed(),
                get(MAP_I),
                c(1),
                { op: "i32.add" },
                set(MAP_I),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
      else: appendDecomposed(),
    },
  ];

  const composeOrdered = (): Instr[] => [
    c(0),
    set(OUT_COUNT),
    c(-1),
    set(STARTER_INDEX),
    c(0),
    set(STARTER),
    c(0),
    set(LAST_CCC),
    c(0),
    set(I),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(I),
            get(COUNT),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            ...bufferGet([get(I)]),
            set(CP),
            get(CP),
            get(CCC),
            { op: "call", funcIdx: cccIdx },
            set(CCC_VALUE),
            c(-1),
            set(COMPOSITE),
            get(STARTER_INDEX),
            c(0),
            { op: "i32.ge_s" },
            get(LAST_CCC),
            { op: "i32.eqz" },
            get(LAST_CCC),
            get(CCC_VALUE),
            { op: "i32.lt_u" },
            { op: "i32.or" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // Hangul L + V -> LV.
                get(STARTER),
                c(HANGUL_L_BASE),
                { op: "i32.ge_u" },
                get(STARTER),
                c(HANGUL_L_BASE + HANGUL_L_COUNT),
                { op: "i32.lt_u" },
                { op: "i32.and" },
                get(CP),
                c(HANGUL_V_BASE),
                { op: "i32.ge_u" },
                { op: "i32.and" },
                get(CP),
                c(HANGUL_V_BASE + HANGUL_V_COUNT),
                { op: "i32.lt_u" },
                { op: "i32.and" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    get(STARTER),
                    c(HANGUL_L_BASE),
                    { op: "i32.sub" },
                    c(HANGUL_N_COUNT),
                    { op: "i32.mul" },
                    get(CP),
                    c(HANGUL_V_BASE),
                    { op: "i32.sub" },
                    c(HANGUL_T_COUNT),
                    { op: "i32.mul" },
                    { op: "i32.add" },
                    c(HANGUL_S_BASE),
                    { op: "i32.add" },
                    set(COMPOSITE),
                  ],
                },
                // Hangul LV + T -> LVT, only if L/V did not apply.
                get(COMPOSITE),
                c(0),
                { op: "i32.lt_s" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    get(STARTER),
                    c(HANGUL_S_BASE),
                    { op: "i32.ge_u" },
                    get(STARTER),
                    c(HANGUL_S_BASE + HANGUL_S_COUNT),
                    { op: "i32.lt_u" },
                    { op: "i32.and" },
                    get(STARTER),
                    c(HANGUL_S_BASE),
                    { op: "i32.sub" },
                    c(HANGUL_T_COUNT),
                    { op: "i32.rem_u" },
                    { op: "i32.eqz" },
                    { op: "i32.and" },
                    get(CP),
                    c(HANGUL_T_BASE),
                    { op: "i32.gt_u" },
                    { op: "i32.and" },
                    get(CP),
                    c(HANGUL_T_BASE + HANGUL_T_COUNT),
                    { op: "i32.lt_u" },
                    { op: "i32.and" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        get(STARTER),
                        get(CP),
                        c(HANGUL_T_BASE),
                        { op: "i32.sub" },
                        { op: "i32.add" },
                        set(COMPOSITE),
                      ],
                    },
                  ],
                },
                // Table composition follows the two algorithmic Hangul cases.
                get(COMPOSITE),
                c(0),
                { op: "i32.lt_s" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [get(STARTER), get(CP), get(PAIRS), { op: "call", funcIdx: composeIdx }, set(COMPOSITE)],
                },
              ],
            },
            get(COMPOSITE),
            c(0),
            { op: "i32.ge_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                get(BUFFER),
                get(STARTER_INDEX),
                get(COMPOSITE),
                { op: "array.set", typeIdx: i32ArrTypeIdx },
                get(COMPOSITE),
                set(STARTER),
              ],
              else: [
                get(BUFFER),
                get(OUT_COUNT),
                get(CP),
                { op: "array.set", typeIdx: i32ArrTypeIdx },
                get(CCC_VALUE),
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [get(OUT_COUNT), set(STARTER_INDEX), get(CP), set(STARTER)],
                },
                get(OUT_COUNT),
                c(1),
                { op: "i32.add" },
                set(OUT_COUNT),
                get(CCC_VALUE),
                set(LAST_CCC),
              ],
            },
            get(I),
            c(1),
            { op: "i32.add" },
            set(I),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];

  const body: Instr[] = [
    get(S),
    { op: "call", funcIdx: flattenIdx },
    set(FLAT),
    get(FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    set(LEN),
    get(FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    set(OFF),
    get(FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    set(DATA),
    get(FORM),
    c(2),
    { op: "i32.ge_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: compatibilityKeysGlobal },
        set(MAP_KEYS),
        { op: "global.get", index: compatibilityOffsetsGlobal },
        set(MAP_OFFSETS),
        { op: "global.get", index: compatibilityLengthsGlobal },
        set(MAP_LENGTHS),
        { op: "global.get", index: compatibilityValuesGlobal },
        set(MAP_VALUES),
      ],
      else: [
        { op: "global.get", index: canonicalKeysGlobal },
        set(MAP_KEYS),
        { op: "global.get", index: canonicalOffsetsGlobal },
        set(MAP_OFFSETS),
        { op: "global.get", index: canonicalLengthsGlobal },
        set(MAP_LENGTHS),
        { op: "global.get", index: canonicalValuesGlobal },
        set(MAP_VALUES),
      ],
    },
    { op: "global.get", index: cccGlobal },
    set(CCC),
    { op: "global.get", index: compositionGlobal },
    set(PAIRS),
    c(16),
    set(CAP),
    c(16),
    { op: "array.new_default", typeIdx: i32ArrTypeIdx },
    set(BUFFER),
    c(0),
    set(COUNT),
    c(0),
    set(I),
    // Decode UTF-16 to Unicode scalars, retaining unpaired code units as a
    // scalar in the surrogate range. Each selected table slice is already
    // recursively expanded except algorithmic Hangul.
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(I),
            get(LEN),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            ...sourceUnitAt([get(I)]),
            set(UNIT),
            get(I),
            c(1),
            { op: "i32.add" },
            set(I),
            get(UNIT),
            c(0xd800),
            { op: "i32.ge_u" },
            get(UNIT),
            c(0xdbff),
            { op: "i32.le_u" },
            { op: "i32.and" },
            get(I),
            get(LEN),
            { op: "i32.lt_u" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...sourceUnitAt([get(I)]),
                set(NEXT_UNIT),
                get(NEXT_UNIT),
                c(0xdc00),
                { op: "i32.ge_u" },
                get(NEXT_UNIT),
                c(0xdfff),
                { op: "i32.le_u" },
                { op: "i32.and" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    get(UNIT),
                    c(0xd800),
                    { op: "i32.sub" },
                    c(10),
                    { op: "i32.shl" },
                    get(NEXT_UNIT),
                    c(0xdc00),
                    { op: "i32.sub" },
                    { op: "i32.add" },
                    c(0x10000),
                    { op: "i32.add" },
                    set(CP),
                    get(I),
                    c(1),
                    { op: "i32.add" },
                    set(I),
                  ],
                  else: [get(UNIT), set(CP)],
                },
              ],
              else: [get(UNIT), set(CP)],
            },
            ...appendMapped(),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // Odd modes are NFD/NFKD; even modes compose to NFC/NFKC.
    get(FORM),
    c(1),
    { op: "i32.and" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: composeOrdered(),
      else: [get(COUNT), set(OUT_COUNT)],
    },
    // Size the exact WTF-16 output once, then encode scalars. A raw surrogate
    // remains a one-unit value; only scalar values above U+FFFF emit a pair.
    c(0),
    set(OUT_LENGTH),
    c(0),
    set(I),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(I),
            get(OUT_COUNT),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            ...bufferGet([get(I)]),
            set(CP),
            get(OUT_LENGTH),
            get(CP),
            c(0xffff),
            { op: "i32.gt_u" },
            {
              op: "if",
              blockType: { kind: "val", type: I32 },
              then: [c(2)],
              else: [c(1)],
            },
            { op: "i32.add" },
            set(OUT_LENGTH),
            get(I),
            c(1),
            { op: "i32.add" },
            set(I),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    get(OUT_LENGTH),
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    set(OUT_DATA),
    c(0),
    set(WRITE),
    c(0),
    set(I),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(I),
            get(OUT_COUNT),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            ...bufferGet([get(I)]),
            set(CP),
            get(CP),
            c(0xffff),
            { op: "i32.gt_u" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                get(CP),
                c(0x10000),
                { op: "i32.sub" },
                set(HANGUL_INDEX),
                get(OUT_DATA),
                get(WRITE),
                get(HANGUL_INDEX),
                c(10),
                { op: "i32.shr_u" },
                c(0xd800),
                { op: "i32.add" },
                { op: "array.set", typeIdx: strDataTypeIdx },
                get(WRITE),
                c(1),
                { op: "i32.add" },
                set(WRITE),
                get(OUT_DATA),
                get(WRITE),
                get(HANGUL_INDEX),
                c(0x3ff),
                { op: "i32.and" },
                c(0xdc00),
                { op: "i32.add" },
                { op: "array.set", typeIdx: strDataTypeIdx },
                get(WRITE),
                c(1),
                { op: "i32.add" },
                set(WRITE),
              ],
              else: [
                get(OUT_DATA),
                get(WRITE),
                get(CP),
                { op: "array.set", typeIdx: strDataTypeIdx },
                get(WRITE),
                c(1),
                { op: "i32.add" },
                set(WRITE),
              ],
            },
            get(I),
            c(1),
            { op: "i32.add" },
            set(I),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    get(OUT_LENGTH),
    c(0),
    get(OUT_DATA),
    { op: "struct.new", typeIdx: strTypeIdx },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__str_normalize",
    typeIdx,
    locals: [
      { name: "flat", type: flatStrRef },
      { name: "len", type: I32 },
      { name: "off", type: I32 },
      { name: "data", type: strDataRef },
      { name: "mapKeys", type: i32ArrRef },
      { name: "mapOffsets", type: i32ArrRef },
      { name: "mapLengths", type: i32ArrRef },
      { name: "mapValues", type: i32ArrRef },
      { name: "ccc", type: i32ArrRef },
      { name: "pairs", type: i32ArrRef },
      { name: "buffer", type: i32ArrRef },
      { name: "cap", type: I32 },
      { name: "count", type: I32 },
      { name: "i", type: I32 },
      { name: "unit", type: I32 },
      { name: "nextUnit", type: I32 },
      { name: "cp", type: I32 },
      { name: "mapEntry", type: I32 },
      { name: "mapOffset", type: I32 },
      { name: "mapLength", type: I32 },
      { name: "mapI", type: I32 },
      { name: "emitCp", type: I32 },
      { name: "cccValue", type: I32 },
      { name: "insert", type: I32 },
      { name: "prev", type: I32 },
      { name: "prevCcc", type: I32 },
      { name: "hangulIndex", type: I32 },
      { name: "hangulT", type: I32 },
      { name: "newBuffer", type: i32ArrRef },
      { name: "outCount", type: I32 },
      { name: "starterIndex", type: I32 },
      { name: "starter", type: I32 },
      { name: "lastCcc", type: I32 },
      { name: "composite", type: I32 },
      { name: "outLength", type: I32 },
      { name: "outData", type: strDataRef },
      { name: "write", type: I32 },
    ],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}
