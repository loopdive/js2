// (#40) Pure-Wasm Unicode case conversion for String.prototype.to{Upper,Lower}Case
// under --target standalone/wasi. Replaces the previous ASCII-only mapping with
// full Unicode simple (1:1) case mapping + unconditional special (1:N) casing
// and the locale-insensitive conditional Final_Sigma rule, driven by the
// generated tables in `case-tables.ts`.
//
// Design:
//  - (#3900) An ASCII FAST PATH runs first: a single fused scan+map loop over
//    the flattened i16 backing array. While every code unit is < 0x80 it writes
//    `A-Z <-> a-z` directly into a same-length output array and returns without
//    ever touching a Unicode table. Only a code unit >= 0x80 bails out to the
//    full path below. This is safe because ASCII has NO length-changing and NO
//    context-sensitive case mappings — verified against the generated tables:
//    the only ASCII entries in LOWER_CASE_RUNS/UPPER_CASE_RUNS are exactly the
//    `A-Z`/`a-z` +-32 runs, and the lowest source code point in either special
//    (1:N) table is U+00DF (`ß`, upper) / U+03A3 (`Σ`, lower — Final_Sigma), so
//    no ASCII input can reach a special or conditional rule.
//  - The Unicode tables live in MODULE GLOBALS built once by `array.new_fixed`
//    constant init expressions, not rebuilt into locals on every call. Before
//    #3900 each call to `__str_toLowerCase` allocated and filled a fresh 1,927-
//    element i32 array (runs + special + Cased + Case_Ignorable) before looking
//    at a single character — that per-call table materialisation, not the
//    per-character work, was the ~2.2 µs/conversion cost.
//  - `__case_simple(ch, runs)` binary-searches the [start,count,stride,delta]
//    runs for `ch` and returns the mapped code unit (or `ch` unchanged).
//  - The string-level slow path does TWO passes over the source: pass 1 sums the
//    output length (a special entry contributes its outLen, everything else 1);
//    pass 2 fills the freshly-sized output array, expanding special entries.
//
// All inputs/outputs are BMP (the generator asserts no astral special casing),
// so we operate directly on i16 code units.

import type { ArrayTypeDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import {
  CASED_RANGES,
  CASE_IGNORABLE_RANGES,
  LOWER_CASE_RUNS,
  LOWER_CASE_SPECIAL,
  UPPER_CASE_RUNS,
  UPPER_CASE_SPECIAL,
} from "./case-tables.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting

const i32: ValType = { kind: "i32" };

/** Build an i32 WasmGC array from a constant number list via array.new_fixed. */
function buildConstI32Array(table: readonly number[], arrTypeIdx: number): Instr[] {
  const out: Instr[] = [];
  for (const v of table) out.push({ op: "i32.const", value: v });
  out.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: table.length });
  return out;
}

/**
 * (#3900) Register a Unicode case table as an IMMUTABLE module global whose
 * init expression is the `array.new_fixed` sequence. `array.new_fixed` is a
 * constant instruction in the GC proposal, so the engine materialises the array
 * once at instantiation instead of once per `toLowerCase()`/`toUpperCase()`
 * call. Same total const bytes in the module, but they move out of the code
 * section (so function inlining can never duplicate them) and off the hot path.
 */
function caseTableGlobal(
  ctx: CodegenContext,
  cache: Map<readonly number[], number>,
  name: string,
  table: readonly number[],
  arrTypeIdx: number,
): number {
  const hit = cache.get(table);
  if (hit !== undefined) return hit;
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name,
    type: { kind: "ref", typeIdx: arrTypeIdx },
    mutable: false,
    init: buildConstI32Array(table, arrTypeIdx),
  });
  cache.set(table, globalIdx);
  return globalIdx;
}

/**
 * Emit the two Final_Sigma context scans used by `__str_toLowerCase_uni`.
 *
 * Final_Sigma is the one locale-insensitive conditional SpecialCasing rule:
 * `Σ` lowercases to final `ς` when it is preceded by a Cased code point and
 * NOT followed by one, skipping Case_Ignorable code points on both sides. Both
 * scans decode surrogate pairs, because Cased/Case_Ignorable are full
 * code-point properties while the backing store holds UTF-16 code units.
 */
function buildFinalSigmaScans(o: {
  /** Emits the source code unit at an instruction-computed index. */
  srcCharAt: (idxInstrs: Instr[]) => Instr[];
  /** funcIdx of `__case_in_ranges(cp, ranges) -> i32`. */
  inRangesIdx: number;
  LEN: number;
  I: number;
  CTX: number;
  CP: number;
  PAIR: number;
  PREVCASED: number;
  NEXTCASED: number;
  CASED: number;
  IGNORABLE: number;
}): { scanPreviousCased: () => Instr[]; scanNextCased: () => Instr[] } {
  const get = (index: number): Instr => ({ op: "local.get", index });
  const set = (index: number): Instr => ({ op: "local.set", index });
  const c = (value: number): Instr => ({ op: "i32.const", value });
  const inRanges = (cpLocal: number, rangesLocal: number): Instr[] => [
    get(cpLocal),
    get(rangesLocal),
    { op: "call", funcIdx: o.inRangesIdx },
  ];
  const between = (local: number, lo: number, hi: number): Instr[] => [
    get(local),
    c(lo),
    { op: "i32.ge_u" },
    get(local),
    c(hi),
    { op: "i32.le_u" },
    { op: "i32.and" },
  ];
  const combineSurrogates = (highLocal: number, lowLocal: number): Instr[] => [
    get(highLocal),
    c(0xd800),
    { op: "i32.sub" },
    c(10),
    { op: "i32.shl" },
    get(lowLocal),
    c(0xdc00),
    { op: "i32.sub" },
    { op: "i32.add" },
    c(0x10000),
    { op: "i32.add" },
    set(o.CP),
  ];
  const scanPreviousCased = (): Instr[] => [
    c(0),
    set(o.PREVCASED),
    get(o.I),
    set(o.CTX),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(o.CTX),
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            get(o.CTX),
            c(1),
            { op: "i32.sub" },
            set(o.CTX),
            ...o.srcCharAt([get(o.CTX)]),
            set(o.CP),
            // Decode a preceding high+low surrogate pair while moving
            // backward. CP initially holds the low surrogate.
            ...between(o.CP, 0xdc00, 0xdfff),
            get(o.CTX),
            { op: "i32.eqz" },
            { op: "i32.eqz" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...o.srcCharAt([get(o.CTX), c(1), { op: "i32.sub" }]),
                set(o.PAIR),
                ...between(o.PAIR, 0xd800, 0xdbff),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [...combineSurrogates(o.PAIR, o.CP), get(o.CTX), c(1), { op: "i32.sub" }, set(o.CTX)],
                },
              ],
            },
            // Case_Ignorable wins when a code point has both properties
            // (for example U+0345 COMBINING GREEK YPOGEGRAMMENI).
            ...inRanges(o.CP, o.IGNORABLE),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "br", depth: 1 }],
            },
            ...inRanges(o.CP, o.CASED),
            set(o.PREVCASED),
            { op: "br", depth: 1 },
          ],
        },
      ],
    },
  ];
  const scanNextCased = (): Instr[] => [
    c(0),
    set(o.NEXTCASED),
    get(o.I),
    c(1),
    { op: "i32.add" },
    set(o.CTX),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(o.CTX),
            get(o.LEN),
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            ...o.srcCharAt([get(o.CTX)]),
            set(o.CP),
            get(o.CTX),
            c(1),
            { op: "i32.add" },
            set(o.CTX),
            // CP is a high surrogate and CTX now points at its possible low
            // surrogate. Decode it before consulting Unicode properties.
            ...between(o.CP, 0xd800, 0xdbff),
            get(o.CTX),
            get(o.LEN),
            { op: "i32.lt_u" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...o.srcCharAt([get(o.CTX)]),
                set(o.PAIR),
                ...between(o.PAIR, 0xdc00, 0xdfff),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [...combineSurrogates(o.CP, o.PAIR), get(o.CTX), c(1), { op: "i32.add" }, set(o.CTX)],
                },
              ],
            },
            ...inRanges(o.CP, o.IGNORABLE),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "br", depth: 1 }],
            },
            ...inRanges(o.CP, o.CASED),
            set(o.NEXTCASED),
            { op: "br", depth: 1 },
          ],
        },
      ],
    },
  ];
  return { scanPreviousCased, scanNextCased };
}

/**
 * (#3900) The ASCII fast path of a string-level case-conversion helper.
 *
 * A single fused scan+map loop over the flattened i16 backing array: while
 * every code unit is < 0x80 it writes the ASCII-folded unit straight into a
 * same-length output array and returns; the first unit >= 0x80 branches out of
 * the emitted block so the caller's full Unicode path runs instead (discarding
 * the partial output array — one wasted allocation on the rare path).
 *
 * Correctness: ASCII has no length-changing (`ß` → `SS`) and no
 * context-sensitive (Final_Sigma) case mappings, and the generated tables hold
 * no ASCII entry other than the `A-Z`/`a-z` +-32 runs (the lowest special-table
 * source code point is U+00DF), so for an all-ASCII input this loop is exactly
 * equivalent to the two-pass Unicode path — at a few instructions per character
 * instead of a per-call table build plus a binary search plus a linear scan of
 * the special table.
 */
function buildAsciiFastPath(o: {
  strTypeIdx: number;
  strDataTypeIdx: number;
  /** true for `toLowerCase` (fold `A-Z` +32), false for `toUpperCase` (fold `a-z` -32). */
  toLower: boolean;
  /** Emits the source code unit at an instruction-computed index. */
  srcChar: (idxLocal: number) => Instr[];
  LEN: number;
  I: number;
  CH: number;
  OUTARR: number;
}): Instr[] {
  const get = (index: number): Instr => ({ op: "local.get", index });
  const set = (index: number): Instr => ({ op: "local.set", index });
  const c = (value: number): Instr => ({ op: "i32.const", value });
  const lo = o.toLower ? 65 : 97;
  const hi = o.toLower ? 90 : 122;
  const delta = o.toLower ? 32 : -32;
  return [
    {
      // Branch depth 2 from inside the loop — the non-ASCII bail-out target.
      op: "block",
      blockType: { kind: "empty" },
      body: [
        get(o.LEN),
        { op: "array.new_default", typeIdx: o.strDataTypeIdx },
        set(o.OUTARR),
        c(0),
        set(o.I),
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                get(o.I),
                get(o.LEN),
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                ...o.srcChar(o.I),
                { op: "local.tee", index: o.CH },
                c(0x80),
                { op: "i32.ge_u" },
                { op: "br_if", depth: 2 }, // non-ASCII → fall through to the Unicode path
                get(o.OUTARR),
                get(o.I),
                // `(ch - lo) <= (hi - lo)` is the same unsigned interval
                // test as `ch >= lo && ch <= hi`, with one comparison and no
                // boolean combine on the per-code-unit ASCII hot path.
                get(o.CH),
                c(lo),
                { op: "i32.sub" },
                c(hi - lo),
                { op: "i32.le_u" },
                {
                  op: "if",
                  blockType: { kind: "val", type: i32 },
                  then: [get(o.CH), c(delta), { op: "i32.add" }],
                  else: [get(o.CH)],
                },
                { op: "array.set", typeIdx: o.strDataTypeIdx },
                get(o.I),
                c(1),
                { op: "i32.add" },
                set(o.I),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // Every code unit was ASCII — return the folded copy directly.
        get(o.LEN),
        c(0),
        get(o.OUTARR),
        { op: "struct.new", typeIdx: o.strTypeIdx },
        { op: "return" },
      ],
    },
  ];
}

/**
 * Ensure the per-character simple-case mapper `__case_simple_{upper,lower}` and
 * the string-level `__str_toUpperCase`/`__str_toLowerCase` rewrites are emitted.
 * Idempotent. Requires an i32 array type (the same `array (mut i32)` the runtime
 * uses for vectors) — we register a dedicated immutable i32 array type for the
 * tables.
 *
 * Called from ensureNativeStringHelpers; `strTypeIdx`/`strDataTypeIdx` are the
 * NativeString struct + its i16 backing-array type indices.
 */
export function emitNativeCaseConversion(
  ctx: CodegenContext,
  strTypeIdx: number,
  strDataTypeIdx: number,
  anyStrTypeIdx: number,
): void {
  if (ctx.funcMap.has("__str_toUpperCase_uni")) return;

  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  // Immutable i32 array type for the case tables. Reuse if already registered.
  let i32ArrTypeIdx = ctx.caseTableArrTypeIdx;
  if (i32ArrTypeIdx === undefined) {
    i32ArrTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "array",
      name: "CaseTableI32",
      element: { kind: "i32" },
      mutable: false,
    } as ArrayTypeDef);
    ctx.caseTableArrTypeIdx = i32ArrTypeIdx;
  }
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32ArrTypeIdx };
  // (#3900) One immutable global per distinct Unicode table, created on demand.
  const tableGlobals = new Map<readonly number[], number>();

  // ── __case_simple(ch: i32, runs: ref $i32arr) -> i32 ──────────────────────
  // Binary-search the [start,count,stride,delta] runs (sorted by start) for the
  // run whose span contains `ch`; return ch+delta, else ch unchanged.
  //   lo=0, hi=runs.len/4
  //   while lo<hi: mid=(lo+hi)/2; start=runs[mid*4]
  //     if ch<start: hi=mid
  //     elif ch>=start: (candidate) check membership at the largest start<=ch
  // We binary-search for the greatest run start <= ch, then verify membership:
  //   off = ch-start; within = off>=0 && (stride==1 ? off<count
  //                                                  : (off%2==0 && off/2<count))
  const makeSimple = (name: string): void => {
    const typeIdx = addFuncType(ctx, [i32, i32ArrRef], [i32]);
    const funcIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
    ctx.funcMap.set(name, funcIdx);
    // params: ch(0), runs(1)
    // locals: lo(2), hi(3), mid(4), midBase(5), start(6), count(7), stride(8),
    //         delta(9), off(10), n(11 = runs.len)
    const CH = 0,
      RUNS = 1,
      LO = 2,
      HI = 3,
      MID = 4,
      BASE = 5,
      START = 6,
      COUNT = 7,
      STRIDE = 8,
      DELTA = 9,
      OFF = 10,
      N = 11;
    const get = (i: number): Instr => ({ op: "local.get", index: i });
    const set = (i: number): Instr => ({ op: "local.set", index: i });
    const c = (value: number): Instr => ({ op: "i32.const", value });
    const runsGet = (idxInstrs: Instr[]): Instr[] => [
      get(RUNS),
      ...idxInstrs,
      { op: "array.get", typeIdx: i32ArrTypeIdx },
    ];
    const body: Instr[] = [
      // n = runs.len / 4
      get(RUNS),
      { op: "array.len" },
      c(2),
      { op: "i32.shr_u" }, // /4 via >>2
      set(N),
      // lo=0; hi = tupleCount = runs.len/4
      c(0),
      set(LO),
      get(N),
      set(HI),
      // binary search for greatest start <= ch  → result tuple index in LO-1 region.
      // Standard upper_bound: find first start > ch, then candidate = that-1.
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if lo>=hi break
              get(LO),
              get(HI),
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // mid=(lo+hi)/2 ; midBase=mid*4
              get(LO),
              get(HI),
              { op: "i32.add" },
              c(1),
              { op: "i32.shr_u" },
              set(MID),
              get(MID),
              c(2),
              { op: "i32.shl" }, // *4
              set(BASE),
              // start = runs[midBase]
              ...runsGet([get(BASE)]),
              set(START),
              // if start > ch: hi=mid else lo=mid+1
              get(START),
              get(CH),
              { op: "i32.gt_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [get(MID), set(HI)],
                else: [get(MID), c(1), { op: "i32.add" }, set(LO)],
              },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // candidate tuple index = lo-1. If lo==0 → no run → return ch.
      get(LO),
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [get(CH), { op: "return" }],
      },
      // base = (lo-1)*4
      get(LO),
      c(1),
      { op: "i32.sub" },
      c(2),
      { op: "i32.shl" },
      set(BASE),
      // load start,count,stride,delta
      ...runsGet([get(BASE)]),
      set(START),
      ...runsGet([get(BASE), c(1), { op: "i32.add" }]),
      set(COUNT),
      ...runsGet([get(BASE), c(2), { op: "i32.add" }]),
      set(STRIDE),
      ...runsGet([get(BASE), c(3), { op: "i32.add" }]),
      set(DELTA),
      // off = ch - start
      get(CH),
      get(START),
      { op: "i32.sub" },
      set(OFF),
      // membership: off>=0 always (start<=ch). stride==1 → off<count;
      // stride==2 → off even && off/2<count.
      get(STRIDE),
      c(1),
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // off < count ?
          get(OFF),
          get(COUNT),
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [get(CH), get(DELTA), { op: "i32.add" }, { op: "return" }],
          },
        ],
        else: [
          // stride 2: off even and (off>>1)<count
          get(OFF),
          c(1),
          { op: "i32.and" },
          { op: "i32.eqz" },
          get(OFF),
          c(1),
          { op: "i32.shr_u" },
          get(COUNT),
          { op: "i32.lt_u" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [get(CH), get(DELTA), { op: "i32.add" }, { op: "return" }],
          },
        ],
      },
      // no mapping
      get(CH),
    ];
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: [
        { type: i32 }, // LO
        { type: i32 }, // HI
        { type: i32 }, // MID
        { type: i32 }, // BASE
        { type: i32 }, // START
        { type: i32 }, // COUNT
        { type: i32 }, // STRIDE
        { type: i32 }, // DELTA
        { type: i32 }, // OFF
        { type: i32 }, // N
      ],
      body,
      exported: false,
    } as unknown as WasmFunction);
  };
  makeSimple("__case_simple_upper");
  makeSimple("__case_simple_lower");

  // ── __case_in_ranges(ch: i32, ranges: ref $i32arr) -> i32 ────────────────
  // Binary-search sorted inclusive [start,end] tuples. The full-code-point
  // `Cased` and `Case_Ignorable` tables use this predicate for Final_Sigma.
  {
    const name = "__case_in_ranges";
    const typeIdx = addFuncType(ctx, [i32, i32ArrRef], [i32]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(name, funcIdx);
    // params: ch(0), ranges(1); locals: lo(2), hi(3), mid(4), base(5),
    // start(6), end(7)
    const CH = 0,
      RANGES = 1,
      LO = 2,
      HI = 3,
      MID = 4,
      BASE = 5,
      START = 6,
      END = 7;
    const get = (i: number): Instr => ({ op: "local.get", index: i });
    const set = (i: number): Instr => ({ op: "local.set", index: i });
    const c = (value: number): Instr => ({ op: "i32.const", value });
    const rangeGet = (idxInstrs: Instr[]): Instr[] => [
      get(RANGES),
      ...idxInstrs,
      { op: "array.get", typeIdx: i32ArrTypeIdx },
    ];
    const body: Instr[] = [
      c(0),
      set(LO),
      get(RANGES),
      { op: "array.len" },
      c(1),
      { op: "i32.shr_u" },
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
              c(1),
              { op: "i32.shl" },
              set(BASE),
              ...rangeGet([get(BASE)]),
              set(START),
              get(CH),
              get(START),
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [get(MID), set(HI)],
                else: [
                  ...rangeGet([get(BASE), c(1), { op: "i32.add" }]),
                  set(END),
                  get(CH),
                  get(END),
                  { op: "i32.le_u" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [c(1), { op: "return" }],
                  },
                  get(MID),
                  c(1),
                  { op: "i32.add" },
                  set(LO),
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
      name,
      typeIdx,
      locals: [{ type: i32 }, { type: i32 }, { type: i32 }, { type: i32 }, { type: i32 }, { type: i32 }],
      body,
      exported: false,
    } as unknown as WasmFunction);
  }

  // ── __str_toUpperCase_uni / _lower_uni(s) -> ref $NativeString ────────────
  // Two-pass full case conversion. Builds the runs + special tables into locals
  // once, then: pass 1 computes output length (special entry → its outLen, else
  // 1); allocate; pass 2 fills, expanding special entries.
  const makeStr = (
    name: string,
    simpleName: string,
    runsTable: readonly number[],
    specialTable: readonly number[],
  ): void => {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
    ctx.funcMap.set(name, funcIdx);
    // (#40) Re-point the PUBLIC helper name (used by string-ops.ts toUpperCase/
    // toLowerCase routing) at this Unicode implementation, replacing the
    // ASCII-only block emitted earlier in ensureNativeStringHelpers. The old
    // block becomes dead code (unreferenced; wasm-opt drops it).
    const publicName = name === "__str_toUpperCase_uni" ? "__str_toUpperCase" : "__str_toLowerCase";
    ctx.nativeStrHelpers.set(publicName, funcIdx);
    const simpleIdx = ctx.funcMap.get(simpleName)!;
    const inRangesIdx = ctx.funcMap.get("__case_in_ranges")!;
    const finalSigma = name === "__str_toLowerCase_uni";
    // (#3900) Unicode tables as module globals, materialised once per module.
    const tag = finalSigma ? "lower" : "upper";
    const runsGlobal = caseTableGlobal(ctx, tableGlobals, `__case_${tag}_runs`, runsTable, i32ArrTypeIdx);
    const specGlobal = caseTableGlobal(ctx, tableGlobals, `__case_${tag}_special`, specialTable, i32ArrTypeIdx);
    const casedGlobal = finalSigma
      ? caseTableGlobal(ctx, tableGlobals, "__case_cased", CASED_RANGES, i32ArrTypeIdx)
      : undefined;
    const ignorableGlobal = finalSigma
      ? caseTableGlobal(ctx, tableGlobals, "__case_ignorable", CASE_IGNORABLE_RANGES, i32ArrTypeIdx)
      : undefined;
    // params: s(0)
    // locals: len(1) srcData(2) sOff(3) runs(4) spec(5) specN(6), source/
    // destination indices and scratch through scan(15), then Final_Sigma
    // code-point context scratch (16..20) and property tables (21..22).
    const S = 0,
      LEN = 1,
      DATA = 2,
      OFF = 3,
      RUNS = 4,
      SPEC = 5,
      SPECN = 6,
      I = 7,
      CH = 8,
      OUTLEN = 9,
      OUTARR = 10,
      SPECHIT = 11,
      SPECBASE = 12,
      M = 13,
      FS = 14, // flattened input as the concrete $NativeString struct ref
      SCAN = 15, // findSpecial's scan index (distinct from M, the dest write idx)
      CTX = 16,
      CP = 17,
      PAIR = 18,
      PREVCASED = 19,
      NEXTCASED = 20,
      CASED = 21,
      IGNORABLE = 22;
    const get = (i: number): Instr => ({ op: "local.get", index: i });
    const set = (i: number): Instr => ({ op: "local.set", index: i });
    const tee = (i: number): Instr => ({ op: "local.tee", index: i });
    const c = (value: number): Instr => ({ op: "i32.const", value });
    const specGet = (idxInstrs: Instr[]): Instr[] => [
      get(SPEC),
      ...idxInstrs,
      { op: "array.get", typeIdx: i32ArrTypeIdx },
    ];
    // Source code unit at an instruction-computed index (i16, unsigned).
    const srcCharAt = (idxInstrs: Instr[]): Instr[] => [
      get(DATA),
      get(OFF),
      ...idxInstrs,
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
    ];
    const srcChar = (idxLocal: number): Instr[] => srcCharAt([get(idxLocal)]);
    const inRanges = (cpLocal: number, rangesLocal: number): Instr[] => [
      get(cpLocal),
      get(rangesLocal),
      { op: "call", funcIdx: inRangesIdx },
    ];
    const { scanPreviousCased, scanNextCased } = buildFinalSigmaScans({
      srcCharAt,
      inRangesIdx,
      LEN,
      I,
      CTX,
      CP,
      PAIR,
      PREVCASED,
      NEXTCASED,
      CASED,
      IGNORABLE,
    });
    const simpleMapped = (): Instr[] => [get(CH), get(RUNS), { op: "call", funcIdx: simpleIdx }];
    const finalSigmaMapped = (): Instr[] => [
      ...scanPreviousCased(),
      ...scanNextCased(),
      get(PREVCASED),
      get(NEXTCASED),
      { op: "i32.eqz" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [c(0x03c2)],
        else: simpleMapped(),
      },
    ];
    // Find special entry index for ch (linear scan over specN entries of 5 i32);
    // sets SPECHIT = base index (entry*5) or -1. Special tables are tiny
    // (≤102), a linear scan is fine and avoids a second binary search.
    const findSpecial = (): Instr[] => [
      c(-1),
      set(SPECHIT),
      c(0),
      set(SCAN),
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              get(SCAN),
              get(SPECN),
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // if spec[scan*5] == ch → hit
              ...specGet([get(SCAN), c(5), { op: "i32.mul" }]),
              get(CH),
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  get(SCAN),
                  c(5),
                  { op: "i32.mul" },
                  set(SPECHIT),
                  { op: "br", depth: 2 }, // break out
                ],
              },
              get(SCAN),
              c(1),
              { op: "i32.add" },
              set(SCAN),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ];

    // (#40) The input may be a cons-string/rope; flatten to a concrete
    // $NativeString first (into FS) so the field reads below see a contiguous
    // i16 backing array. __str_flatten is registered in nativeStrHelpers by the
    // time string-level helpers emit; it returns the supertype $AnyString, so we
    // ref.cast to the concrete struct before reading fields.
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
    const flattenPrelude: Instr[] =
      flattenIdx === undefined
        ? [get(S), { op: "ref.cast", typeIdx: strTypeIdx }, set(FS)]
        : [get(S), { op: "call", funcIdx: flattenIdx }, { op: "ref.cast", typeIdx: strTypeIdx }, set(FS)];

    // (#3900) ASCII fast path. One fused scan+map pass over the flattened
    // backing array: while every code unit is < 0x80 we write the ASCII-folded
    // unit straight into a same-length output array; the first unit >= 0x80
    // branches out to the full Unicode path below (discarding the partial
    // output array — a single wasted allocation on the rare path).
    //
    // Correctness: ASCII has no length-changing (`ß`→`SS`) and no
    // context-sensitive (Final_Sigma) mappings, and the generated tables
    // contain no ASCII entry other than the `A-Z`/`a-z` +-32 runs, so for an
    // all-ASCII input this loop is exactly equivalent to the two-pass Unicode
    // path — at a few instructions per character instead of a per-call table
    // build plus a binary search plus a linear special-table scan.
    const asciiFastPath = buildAsciiFastPath({
      strTypeIdx,
      strDataTypeIdx,
      toLower: finalSigma, // only __str_toLowerCase_uni carries the Final_Sigma rule
      srcChar,
      LEN,
      I,
      CH,
      OUTARR,
    });

    const body: Instr[] = [
      ...flattenPrelude,
      // len = fs.len ; sOff = fs.off ; srcData = fs.data
      get(FS),
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      set(LEN),
      get(FS),
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      set(OFF),
      get(FS),
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      set(DATA),
      ...asciiFastPath,
      // ── full Unicode path ──
      // (#3900) The tables are module globals built once at instantiation, not
      // ~1.9k `array.new_fixed` operands re-materialised on every call.
      { op: "global.get", index: runsGlobal },
      set(RUNS),
      { op: "global.get", index: specGlobal },
      tee(SPEC),
      { op: "array.len" },
      c(5),
      { op: "i32.div_u" },
      set(SPECN),
      ...(finalSigma
        ? ([
            { op: "global.get", index: casedGlobal! },
            set(CASED),
            { op: "global.get", index: ignorableGlobal! },
            set(IGNORABLE),
          ] as Instr[])
        : []),
      // ── pass 1: outLen ──
      c(0),
      set(OUTLEN),
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
              get(LEN),
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              ...srcChar(I),
              set(CH),
              ...findSpecial(),
              // outLen += specHit>=0 ? spec[specHit+1] : 1
              get(OUTLEN),
              get(SPECHIT),
              c(0),
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "val", type: i32 },
                then: [...specGet([get(SPECHIT), c(1), { op: "i32.add" }])],
                else: [c(1)],
              },
              { op: "i32.add" },
              set(OUTLEN),
              get(I),
              c(1),
              { op: "i32.add" },
              set(I),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // outArr = array.new_default(outLen)
      get(OUTLEN),
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      set(OUTARR),
      // ── pass 2: fill ──  i=src idx, reuse M as dest idx
      c(0),
      set(I),
      c(0),
      set(M), // dest write index
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
              ...srcChar(I),
              set(CH),
              ...findSpecial(),
              get(SPECHIT),
              c(0),
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // special: write spec[base+2 .. base+2+outLen)
                  get(SPECHIT),
                  set(SPECBASE),
                  // count = spec[base+1]
                  ...specGet([get(SPECBASE), c(1), { op: "i32.add" }]),
                  set(CH), // reuse CH as a small loop bound (outLen)
                  c(0),
                  set(OUTLEN), // reuse OUTLEN as inner index
                  {
                    op: "block",
                    blockType: { kind: "empty" },
                    body: [
                      {
                        op: "loop",
                        blockType: { kind: "empty" },
                        body: [
                          get(OUTLEN),
                          get(CH),
                          { op: "i32.ge_u" },
                          { op: "br_if", depth: 1 },
                          // outArr[M] = spec[base+2+outLen]
                          get(OUTARR),
                          get(M),
                          ...specGet([get(SPECBASE), c(2), { op: "i32.add" }, get(OUTLEN), { op: "i32.add" }]),
                          { op: "array.set", typeIdx: strDataTypeIdx },
                          get(M),
                          c(1),
                          { op: "i32.add" },
                          set(M),
                          get(OUTLEN),
                          c(1),
                          { op: "i32.add" },
                          set(OUTLEN),
                          { op: "br", depth: 0 },
                        ],
                      },
                    ],
                  },
                ],
                else: [
                  // Simple mapping, except for the one language-insensitive
                  // conditional SpecialCasing rule: Final_Sigma.
                  get(OUTARR),
                  get(M),
                  ...(finalSigma
                    ? [
                        get(CH),
                        c(0x03a3),
                        { op: "i32.eq" } as Instr,
                        {
                          op: "if",
                          blockType: { kind: "val", type: i32 },
                          then: finalSigmaMapped(),
                          else: simpleMapped(),
                        } as Instr,
                      ]
                    : simpleMapped()),
                  { op: "array.set", typeIdx: strDataTypeIdx },
                  get(M),
                  c(1),
                  { op: "i32.add" },
                  set(M),
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
      // return struct.new(outLen=M, off=0, outArr)
      get(M),
      c(0),
      get(OUTARR),
      { op: "struct.new", typeIdx: strTypeIdx },
    ];
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: [
        { name: "len", type: i32 }, // 1 LEN
        { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } }, // 2 DATA
        { name: "off", type: i32 }, // 3 OFF
        { name: "runs", type: i32ArrRef }, // 4 RUNS
        { name: "spec", type: i32ArrRef }, // 5 SPEC
        { name: "specN", type: i32 }, // 6 SPECN
        { name: "i", type: i32 }, // 7 I
        { name: "ch", type: i32 }, // 8 CH
        { name: "outLen", type: i32 }, // 9 OUTLEN
        { name: "outArr", type: { kind: "ref", typeIdx: strDataTypeIdx } }, // 10 OUTARR
        { name: "specHit", type: i32 }, // 11 SPECHIT
        { name: "specBase", type: i32 }, // 12 SPECBASE
        { name: "m", type: i32 }, // 13 M
        { name: "fs", type: { kind: "ref", typeIdx: strTypeIdx } }, // 14 FS
        { name: "scan", type: i32 }, // 15 SCAN
        { name: "ctx", type: i32 }, // 16 CTX
        { name: "cp", type: i32 }, // 17 CP
        { name: "pair", type: i32 }, // 18 PAIR
        { name: "prevCased", type: i32 }, // 19 PREVCASED
        { name: "nextCased", type: i32 }, // 20 NEXTCASED
        ...(finalSigma
          ? [
              { name: "cased", type: i32ArrRef }, // 21 CASED
              { name: "ignorable", type: i32ArrRef }, // 22 IGNORABLE
            ]
          : []),
      ],
      body,
      exported: false,
    } as unknown as WasmFunction);
  };

  makeStr("__str_toUpperCase_uni", "__case_simple_upper", UPPER_CASE_RUNS, UPPER_CASE_SPECIAL);
  makeStr("__str_toLowerCase_uni", "__case_simple_lower", LOWER_CASE_RUNS, LOWER_CASE_SPECIAL);

  // (#40 / #2191) Re-point the PUBLIC `__str_toUpperCase` / `__str_toLowerCase`
  // helper names directly at the Unicode `_uni` funcIdx in BOTH resolution maps
  // (`nativeStrHelpers` AND `funcMap`) so EVERY caller — direct-codegen string
  // ops, the IR string-method path, `charCodeAt`, `===`, etc. — dispatches to
  // the Unicode body. The old ASCII body becomes unreferenced dead code
  // (wasm-opt drops it).
  //
  // Why NOT the previous in-place body copy: it located the ascii fn via
  // `ctx.mod.functions[asciiIdx - ctx.numImportFuncs]`, where `asciiIdx` was
  // captured in `nativeStrHelpers` BEFORE this point. If ANY late import was
  // added between the ascii registration (native-strings.ts) and this re-point,
  // `ctx.numImportFuncs` grew, so `asciiIdx - numImportFuncs` indexed the WRONG
  // function — it patched some other fn and left the real ascii
  // `__str_toUpperCase` un-patched. That produced the #2191 intransitivity:
  // `"à".toUpperCase()` via the `===` call site resolved to the un-patched ascii
  // body (à = 0xE0 left unchanged, ∉ [a-z]) while `charCodeAt` resolved to the
  // Unicode body (à→À, 0xC0) — two different functions for the "same" call, so
  // `"à".toUpperCase() === "À"` was false while `.charCodeAt(0)` was 0xC0.
  // Re-pointing the NAME (not patching a body by a shift-sensitive index) is
  // immune to the funcIdx shift and routes ALL resolvers identically.
  for (const [publicName, uniName] of [
    ["__str_toUpperCase", "__str_toUpperCase_uni"],
    ["__str_toLowerCase", "__str_toLowerCase_uni"],
  ] as const) {
    const uniIdx = ctx.funcMap.get(uniName);
    if (uniIdx === undefined) continue;
    ctx.nativeStrHelpers.set(publicName, uniIdx);
    ctx.funcMap.set(publicName, uniIdx);
  }
}
