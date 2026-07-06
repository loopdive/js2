// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm `String.prototype.isWellFormed` (§22.1.3.8) /
 * `String.prototype.toWellFormed` (§22.1.3.34) for standalone / WASI targets
 * (#3068). In JS-host mode these dispatch through the generic
 * `__extern_method_call` bridge to the real engine method; under
 * `--target standalone` / `--target wasi` there is no JS host, so the call fell
 * through to the "Unknown string method" stub (invalid Wasm for `isWellFormed`,
 * wrong result for `toWellFormed`). This module emits WasmGC-native
 * implementations following the #679/#682 dual-backend pattern (mirrors
 * `escape-native.ts`, but even simpler: both operate on UTF-16 CODE UNITS with a
 * 1:1 substitution, so there is no UTF-8 transcoding and no Unicode tables).
 *
 * A UTF-16 sequence is "well formed" iff every leading surrogate
 * (`U+D800..U+DBFF`) is immediately followed by a trailing surrogate
 * (`U+DC00..U+DFFF`), and there is no unpaired trailing surrogate.
 *
 * - `isWellFormed()` → `1` when well formed, else `0` (an i32 boolean).
 * - `toWellFormed()` → a copy of the string with every lone surrogate replaced
 *   by U+FFFD (REPLACEMENT CHARACTER). Replacement is one code unit for one, so
 *   the output has the same length as the input.
 *
 * Both helpers take the already-flattened receiver (`ref $NativeString`, the
 * value the method arm produces via `emitReceiver()` + `emitFlatten()`), so they
 * read the struct fields directly (0 = length, 1 = offset, 2 = i16 data array).
 * They are registered in `ctx.nativeStrHelpers` under `__str_isWellFormed` /
 * `__str_toWellFormed` as DEFINED funcs via `mintDefinedFunc`/`pushDefinedFunc`
 * (batched late-import shift keeps their funcMap index correct), emitted from
 * `ensureNativeStringHelpers`.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting

const i32: ValType = { kind: "i32" };

const get = (i: number): Instr => ({ op: "local.get", index: i }) as Instr;
const set = (i: number): Instr => ({ op: "local.set", index: i }) as Instr;
const c = (value: number): Instr => ({ op: "i32.const", value }) as Instr;

const HI_LO = 0xd800; // leading (high) surrogate range [0xD800, 0xDBFF]
const HI_HI = 0xdbff;
const LO_LO = 0xdc00; // trailing (low) surrogate range [0xDC00, 0xDFFF]
const LO_HI = 0xdfff;
const REPLACEMENT = 0xfffd; // U+FFFD REPLACEMENT CHARACTER

/** `(v >= lo) & (v <= hi)` on the i32 in local `L_V`, unsigned. */
function inRange(vLocal: number, lo: number, hi: number): Instr[] {
  return [
    get(vLocal),
    c(lo),
    { op: "i32.ge_u" } as Instr,
    get(vLocal),
    c(hi),
    { op: "i32.le_u" } as Instr,
    { op: "i32.and" } as Instr,
  ];
}

/**
 * Emit the native `__str_isWellFormed` / `__str_toWellFormed` helpers and
 * register them in `ctx.nativeStrHelpers`. Idempotent. Called from
 * `ensureNativeStringHelpers` with the NativeString struct + its i16 backing
 * array type indices already registered.
 */
export function emitNativeWellFormedHelpers(ctx: CodegenContext, strTypeIdx: number, strDataTypeIdx: number): void {
  if (ctx.nativeStrHelpers.has("__str_isWellFormed")) return;

  const strRef: ValType = { kind: "ref", typeIdx: strTypeIdx };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  // ── __str_isWellFormed(s: ref $NativeString) -> i32 ──
  {
    const typeIdx = addFuncType(ctx, [strRef], [i32]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_isWellFormed", funcIdx);

    // params: s(0)
    // locals: len(1) off(2) data(3) end(4) i(5) ch(6) ch2(7) viol(8)
    const L_LEN = 1;
    const L_OFF = 2;
    const L_DATA = 3;
    const L_END = 4;
    const L_I = 5;
    const L_CH = 6;
    const L_CH2 = 7;
    const L_VIOL = 8;

    const readData = (idxInstrs: Instr[]): Instr[] => [
      get(L_DATA),
      ...idxInstrs,
      { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr,
    ];

    // `br`/`br_if` only appear at the loop-body top level (depth 0 = loop,
    // depth 1 = the enclosing block); the per-code-unit classification uses
    // structured `if`/`else` (no branches) writing a violation flag into `viol`.
    const loopBody: Instr[] = [
      // if i >= end break
      get(L_I),
      get(L_END),
      { op: "i32.ge_s" } as Instr,
      { op: "br_if", depth: 1 } as Instr,
      // ch = data[i]
      ...readData([get(L_I)]),
      set(L_CH),
      // isLeadingSurrogate(ch) ?
      ...inRange(L_CH, HI_LO, HI_HI),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // (i + 1 < end) ?
          get(L_I),
          c(1),
          { op: "i32.add" } as Instr,
          get(L_END),
          { op: "i32.lt_s" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // ch2 = data[i+1]
              ...readData([get(L_I), c(1), { op: "i32.add" } as Instr]),
              set(L_CH2),
              // isTrailingSurrogate(ch2) ?
              ...inRange(L_CH2, LO_LO, LO_HI),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [], // valid pair
                else: [c(1), set(L_VIOL)], // lone leading surrogate
              } as unknown as Instr,
            ],
            else: [c(1), set(L_VIOL)], // leading surrogate with no following unit
          } as unknown as Instr,
        ],
        else: [
          // not leading: a trailing surrogate here is lone
          ...inRange(L_CH, LO_LO, LO_HI),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [c(1), set(L_VIOL)],
            else: [],
          } as unknown as Instr,
        ],
      } as unknown as Instr,
      // if viol break
      get(L_VIOL),
      { op: "br_if", depth: 1 } as Instr,
      // advance i by 2 for a valid surrogate pair, else 1
      get(L_I),
      c(2),
      c(1),
      ...inRange(L_CH, HI_LO, HI_HI),
      get(L_I),
      c(1),
      { op: "i32.add" } as Instr,
      get(L_END),
      { op: "i32.lt_s" } as Instr,
      { op: "i32.and" } as Instr,
      ...inRange(L_CH2, LO_LO, LO_HI),
      { op: "i32.and" } as Instr,
      { op: "select" } as Instr,
      { op: "i32.add" } as Instr,
      set(L_I),
      { op: "br", depth: 0 } as Instr,
    ];

    const bodyFinal: Instr[] = [
      get(0),
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 } as Instr,
      set(L_LEN),
      get(0),
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 } as Instr,
      set(L_OFF),
      get(0),
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 } as Instr,
      set(L_DATA),
      get(L_OFF),
      get(L_LEN),
      { op: "i32.add" } as Instr,
      set(L_END),
      get(L_OFF),
      set(L_I),
      c(0),
      set(L_VIOL),
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
      } as Instr,
      get(L_VIOL),
      { op: "i32.eqz" } as Instr,
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_isWellFormed",
      typeIdx,
      locals: [
        { name: "len", type: i32 }, // L_LEN
        { name: "off", type: i32 }, // L_OFF
        { name: "data", type: strDataRef }, // L_DATA
        { name: "end", type: i32 }, // L_END
        { name: "i", type: i32 }, // L_I
        { name: "ch", type: i32 }, // L_CH
        { name: "ch2", type: i32 }, // L_CH2
        { name: "viol", type: i32 }, // L_VIOL
      ],
      body: bodyFinal,
      exported: false,
    } as unknown as WasmFunction);
  }

  // ── __str_toWellFormed(s: ref $NativeString) -> ref $NativeString ──
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_toWellFormed", funcIdx);

    // params: s(0)
    // locals: len(1) off(2) data(3) end(4) i(5) ch(6) ch2(7) out(8) n(9)
    const L_LEN = 1;
    const L_OFF = 2;
    const L_DATA = 3;
    const L_END = 4;
    const L_I = 5;
    const L_CH = 6;
    const L_CH2 = 7;
    const L_OUT = 8;
    const L_N = 9;

    const readData = (idxInstrs: Instr[]): Instr[] => [
      get(L_DATA),
      ...idxInstrs,
      { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr,
    ];
    // out[nOffset] = value
    const writeOut = (nOffsetInstrs: Instr[], valueInstrs: Instr[]): Instr[] => [
      get(L_OUT),
      ...nOffsetInstrs,
      ...valueInstrs,
      { op: "array.set", typeIdx: strDataTypeIdx } as Instr,
    ];

    const loopBody: Instr[] = [
      // if i >= end break
      get(L_I),
      get(L_END),
      { op: "i32.ge_s" } as Instr,
      { op: "br_if", depth: 1 } as Instr,
      // ch = data[i]
      ...readData([get(L_I)]),
      set(L_CH),
      // isLeadingSurrogate(ch) ?
      ...inRange(L_CH, HI_LO, HI_HI),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // (i + 1 < end) ?
          get(L_I),
          c(1),
          { op: "i32.add" } as Instr,
          get(L_END),
          { op: "i32.lt_s" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // ch2 = data[i+1]
              ...readData([get(L_I), c(1), { op: "i32.add" } as Instr]),
              set(L_CH2),
              // isTrailingSurrogate(ch2) ?
              ...inRange(L_CH2, LO_LO, LO_HI),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // valid pair: out[n] = ch; out[n+1] = ch2; n += 2; i += 2
                  ...writeOut([get(L_N)], [get(L_CH)]),
                  ...writeOut([get(L_N), c(1), { op: "i32.add" } as Instr], [get(L_CH2)]),
                  get(L_N),
                  c(2),
                  { op: "i32.add" } as Instr,
                  set(L_N),
                  get(L_I),
                  c(2),
                  { op: "i32.add" } as Instr,
                  set(L_I),
                ],
                else: [
                  // lone leading surrogate: out[n] = U+FFFD; n += 1; i += 1
                  ...writeOut([get(L_N)], [c(REPLACEMENT)]),
                  get(L_N),
                  c(1),
                  { op: "i32.add" } as Instr,
                  set(L_N),
                  get(L_I),
                  c(1),
                  { op: "i32.add" } as Instr,
                  set(L_I),
                ],
              } as unknown as Instr,
            ],
            else: [
              // leading surrogate at end: out[n] = U+FFFD; n += 1; i += 1
              ...writeOut([get(L_N)], [c(REPLACEMENT)]),
              get(L_N),
              c(1),
              { op: "i32.add" } as Instr,
              set(L_N),
              get(L_I),
              c(1),
              { op: "i32.add" } as Instr,
              set(L_I),
            ],
          } as unknown as Instr,
        ],
        else: [
          // not leading. Trailing surrogate here is lone → U+FFFD; else verbatim.
          ...inRange(L_CH, LO_LO, LO_HI),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...writeOut([get(L_N)], [c(REPLACEMENT)])],
            else: [...writeOut([get(L_N)], [get(L_CH)])],
          } as unknown as Instr,
          // n += 1; i += 1
          get(L_N),
          c(1),
          { op: "i32.add" } as Instr,
          set(L_N),
          get(L_I),
          c(1),
          { op: "i32.add" } as Instr,
          set(L_I),
        ],
      } as unknown as Instr,
      { op: "br", depth: 0 } as Instr,
    ];

    const body: Instr[] = [
      get(0),
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 } as Instr,
      set(L_LEN),
      get(0),
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 } as Instr,
      set(L_OFF),
      get(0),
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 } as Instr,
      set(L_DATA),
      get(L_OFF),
      get(L_LEN),
      { op: "i32.add" } as Instr,
      set(L_END),
      get(L_OFF),
      set(L_I),
      // out = array.new_default $i16arr(len)  (same length — 1:1 substitution)
      get(L_LEN),
      { op: "array.new_default", typeIdx: strDataTypeIdx } as Instr,
      set(L_OUT),
      c(0),
      set(L_N),
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
      } as Instr,
      // return struct.new $NativeString(len, off=0, out)
      get(L_LEN),
      c(0),
      get(L_OUT),
      { op: "struct.new", typeIdx: strTypeIdx } as Instr,
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_toWellFormed",
      typeIdx,
      locals: [
        { name: "len", type: i32 }, // L_LEN
        { name: "off", type: i32 }, // L_OFF
        { name: "data", type: strDataRef }, // L_DATA
        { name: "end", type: i32 }, // L_END
        { name: "i", type: i32 }, // L_I
        { name: "ch", type: i32 }, // L_CH
        { name: "ch2", type: i32 }, // L_CH2
        { name: "out", type: strDataRef }, // L_OUT
        { name: "n", type: i32 }, // L_N
      ],
      body,
      exported: false,
    } as unknown as WasmFunction);
  }
}
