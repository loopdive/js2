// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — pure-WasmGC standalone regex engine (run-time half).
 *
 * Mirrors `native-strings.ts`: emits a family of hand-authored WasmGC helper
 * functions that operate directly on the `i16` `NativeString` arrays used by
 * the standalone target. No Rust, no linear memory, no `wasm-merge`, no host
 * import — the matcher reads the same `i16` arrays everything else uses.
 *
 * The compile-time half (`regex/{parse,compile}.ts`) turns a static pattern
 * into a flat `i32` bytecode program; this module emits the single generic
 * backtracking VM (`__regex_run`) that interprets it. The reference VM in
 * `regex/vm.ts` is the executable spec this Wasm function mirrors
 * opcode-for-opcode. See the issue file's "Implementation Notes (sd-1539)" for
 * the why-bytecode-not-specialised-emission rationale.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType, getOrRegisterArrayType, getOrRegisterVecType } from "./registry/types.js";
import { ReOp } from "./regex/bytecode.js";
// NOTE: `__regex_replace` / `__regex_split` (below) reuse the native string
// helpers registered by ensureNativeStringHelpers and never import a JS RegExp
// or String.prototype host shim.

/** The frame struct holds one backtrack alternative, exactly like vm.ts. */
const RE_FRAME_STRUCT = "__ReFrame";
const RE_FRAME_ARR = "__ReFrameArr";

/** i32 array type used for program, class table, and capture slots. */
export function regexI32ArrayType(ctx: CodegenContext): number {
  return getOrRegisterArrayType(ctx, "i32", { kind: "i32" });
}

/**
 * Ensure the `$__ReFrame { pc, sp, caps }` struct and its array type exist.
 * Returns `[frameTypeIdx, frameArrTypeIdx]`.
 */
function ensureFrameTypes(ctx: CodegenContext): [number, number] {
  const i32ArrIdx = regexI32ArrayType(ctx);
  let frameIdx = ctx.structMap.get(RE_FRAME_STRUCT);
  if (frameIdx === undefined) {
    frameIdx = ctx.mod.types.length;
    const fields = [
      { name: "pc", type: { kind: "i32" } as ValType, mutable: true },
      { name: "sp", type: { kind: "i32" } as ValType, mutable: true },
      { name: "caps", type: { kind: "ref", typeIdx: i32ArrIdx } as ValType, mutable: true },
    ];
    ctx.mod.types.push({ kind: "struct", name: RE_FRAME_STRUCT, fields });
    ctx.structMap.set(RE_FRAME_STRUCT, frameIdx);
    ctx.typeIdxToStructName.set(frameIdx, RE_FRAME_STRUCT);
    ctx.structFields.set(RE_FRAME_STRUCT, fields);
  }
  let frameArrIdx = ctx.arrayTypeMap.get(RE_FRAME_ARR);
  if (frameArrIdx === undefined) {
    frameArrIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "array",
      name: RE_FRAME_ARR,
      element: { kind: "ref_null", typeIdx: frameIdx },
      mutable: true,
    });
    ctx.arrayTypeMap.set(RE_FRAME_ARR, frameArrIdx);
  }
  return [frameIdx, frameArrIdx];
}

/** Step cap mirrors `REGEX_STEP_CAP` in regex/vm.ts. */
const REGEX_STEP_CAP = 1_000_000;
/** Initial backtrack-stack capacity (frames). Grows on demand. */
const INITIAL_STACK_CAP = 64;

/**
 * Emit `__regex_class_match(classTable, offset, c, negated) -> i32`.
 *
 * Walks the run-length range table for one class and returns 1/0. Mirrors
 * `classMatch` in vm.ts.
 */
function emitClassMatch(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_class_match");
  if (existing !== undefined) return existing;
  const i32Arr = regexI32ArrayType(ctx);
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };
  const typeIdx = addFuncType(ctx, [i32ArrRef, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.nativeRegexHelpers.set("__regex_class_match", funcIdx);

  // params: table(0), offset(1), c(2), negated(3)
  // locals: rangeCount(4), p(5), i(6), inside(7), lo(8), hi(9)
  const TABLE = 0,
    OFFSET = 1,
    C = 2,
    NEG = 3;
  const RANGE_COUNT = 4,
    P = 5,
    I = 6,
    INSIDE = 7,
    LO = 8,
    HI = 9;
  const body: Instr[] = [
    // rangeCount = table[offset]
    { op: "local.get", index: TABLE },
    { op: "local.get", index: OFFSET },
    { op: "array.get", typeIdx: i32Arr },
    { op: "local.set", index: RANGE_COUNT },
    // p = offset + 1
    { op: "local.get", index: OFFSET },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: P },
    // inside = 0; i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: INSIDE },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i >= rangeCount: break
            { op: "local.get", index: I },
            { op: "local.get", index: RANGE_COUNT },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // lo = table[p]; hi = table[p+1]
            { op: "local.get", index: TABLE },
            { op: "local.get", index: P },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: LO },
            { op: "local.get", index: TABLE },
            { op: "local.get", index: P },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: HI },
            // if c >= lo && c <= hi: inside=1; break
            { op: "local.get", index: C },
            { op: "local.get", index: LO },
            { op: "i32.ge_s" },
            { op: "local.get", index: C },
            { op: "local.get", index: HI },
            { op: "i32.le_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "i32.const", value: 1 },
                { op: "local.set", index: INSIDE },
                { op: "br", depth: 2 },
              ],
            },
            // p += 2; i++
            { op: "local.get", index: P },
            { op: "i32.const", value: 2 },
            { op: "i32.add" },
            { op: "local.set", index: P },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // result = negated ? !inside : inside
    { op: "local.get", index: NEG },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "local.get", index: INSIDE }, { op: "i32.eqz" }],
      else: [{ op: "local.get", index: INSIDE }],
    },
  ];

  ctx.mod.functions.push({
    name: "__regex_class_match",
    typeIdx,
    locals: [
      { name: "rangeCount", type: { kind: "i32" } },
      { name: "p", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "inside", type: { kind: "i32" } },
      { name: "lo", type: { kind: "i32" } },
      { name: "hi", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Emit the backtracking VM `__regex_run` and its dependencies. Returns the
 * `__regex_run` function index.
 *
 * Signature:
 *   __regex_run(prog: ref array<i32>, classTable: ref array<i32>,
 *               nSlots: i32, strData: ref array<i16>, strOff: i32, strLen: i32,
 *               startIdx: i32, caps: ref array<i32>) -> i32
 *
 * `caps` is caller-allocated, length `nSlots`, pre-filled with -1. On a match
 * (1 returned) the slots hold `[g0s,g0e,g1s,g1e,…]`; -1 = unset. This is one
 * anchored attempt at `startIdx`; the start-position scan lives in the
 * higher-level helpers (`__regex_search`).
 */
export function ensureRegexRun(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_run");
  if (existing !== undefined) return existing;

  const classMatchIdx = emitClassMatch(ctx);
  const [frameIdx, frameArrIdx] = ensureFrameTypes(ctx);
  const i32Arr = regexI32ArrayType(ctx);
  const strDataIdx = ctx.nativeStrDataTypeIdx; // array i16
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataIdx };
  const frameArrRef: ValType = { kind: "ref", typeIdx: frameArrIdx };

  const typeIdx = addFuncType(
    ctx,
    [
      i32ArrRef, // prog
      i32ArrRef, // classTable
      { kind: "i32" }, // nSlots
      strDataRef, // strData
      { kind: "i32" }, // strOff
      { kind: "i32" }, // strLen
      { kind: "i32" }, // startIdx
      i32ArrRef, // caps
    ],
    [{ kind: "i32" }],
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.nativeRegexHelpers.set("__regex_run", funcIdx);

  // params
  const PROG = 0,
    CTAB = 1,
    NSLOTS = 2,
    SDATA = 3,
    SOFF = 4,
    SLEN = 5,
    START = 6,
    CAPS = 7;
  // locals
  const PC = 8; // i32 program counter (instruction index)
  const SP = 9; // i32 string position
  const STEPS = 10; // i32 step counter
  const STACK = 11; // ref $__ReFrameArr — backtrack stack
  const TOP = 12; // i32 stack top (count of live frames)
  const CAP_USED = 13; // i32 stack capacity
  const OP = 14; // i32 current opcode
  const A = 15; // i32 operand a
  const B = 16; // i32 operand b
  const FAILED = 17; // i32 fail flag
  const CH = 18; // i32 current code unit
  const FRAME = 19; // ref null $__ReFrame — popped/pushed frame
  const SNAP = 20; // ref array<i32> — caps snapshot
  const TMPI = 21; // i32 scratch
  const NEWSTACK = 22; // ref $__ReFrameArr — grown stack
  const GS = 23; // i32 backref group start (#1912)
  const GE = 24; // i32 backref group end (#1912)
  const BLEN = 25; // i32 backref length (#1912)
  const JJ = 26; // i32 backref compare cursor (#1912)
  const C1 = 27; // i32 backref left-hand unit (#1912)

  // Helper: read prog[pc*3 + k]
  const readProg = (k: number): Instr[] => [
    { op: "local.get", index: PROG },
    { op: "local.get", index: PC },
    { op: "i32.const", value: 3 },
    { op: "i32.mul" },
    ...(k === 0 ? [] : [{ op: "i32.const", value: k } as Instr, { op: "i32.add" } as Instr]),
    { op: "array.get", typeIdx: i32Arr },
  ];

  // Helper: copy caps -> a fresh array<i32> of length NSLOTS (snapshot).
  const snapshotCaps = (intoLocal: number): Instr[] => [
    // SNAP = array.new_default(NSLOTS)
    { op: "local.get", index: NSLOTS },
    { op: "array.new_default", typeIdx: i32Arr },
    { op: "local.set", index: intoLocal },
    // array.copy(dst=SNAP, dstIdx=0, src=CAPS, srcIdx=0, len=NSLOTS)
    { op: "local.get", index: intoLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: CAPS },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: NSLOTS },
    { op: "array.copy", dstTypeIdx: i32Arr, srcTypeIdx: i32Arr },
  ];

  // Helper: restore CAPS <- snapshot SNAP (copy back).
  const restoreCaps = (fromLocal: number): Instr[] => [
    { op: "local.get", index: CAPS },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: fromLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: NSLOTS },
    { op: "array.copy", dstTypeIdx: i32Arr, srcTypeIdx: i32Arr },
  ];

  // The dispatch switch over OP. We emit an if/else chain (op === k) … .
  // Each arm sets PC/SP/CAPS or FAILED. MATCH returns 1 directly.
  const dispatch: Instr[] = [
    // CHAR / CHARI: compare a code unit.
    // ch = (sp < slen) ? strData[soff+sp] : -1
    { op: "local.get", index: SP },
    { op: "local.get", index: SLEN },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: SDATA },
        { op: "local.get", index: SOFF },
        { op: "local.get", index: SP },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: strDataIdx },
      ],
      else: [{ op: "i32.const", value: -1 }],
    },
    { op: "local.set", index: CH },

    // if op == CHAR
    { op: "local.get", index: OP },
    { op: "i32.const", value: ReOp.CHAR },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // matched = sp<slen && ch==a
        { op: "local.get", index: SP },
        { op: "local.get", index: SLEN },
        { op: "i32.lt_s" },
        { op: "local.get", index: CH },
        { op: "local.get", index: A },
        { op: "i32.eq" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: SP },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: SP },
            { op: "local.get", index: PC },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: PC },
          ],
          else: [
            { op: "i32.const", value: 1 },
            { op: "local.set", index: FAILED },
          ],
        },
      ],
      else: [
        // if op == CHARI
        { op: "local.get", index: OP },
        { op: "i32.const", value: ReOp.CHARI },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // fold ch (A-Z -> a-z) then compare to a
            { op: "local.get", index: SP },
            { op: "local.get", index: SLEN },
            { op: "i32.lt_s" },
            { op: "local.get", index: CH },
            ...foldCh(),
            { op: "local.get", index: A },
            { op: "i32.eq" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: SP },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: SP },
                { op: "local.get", index: PC },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: PC },
              ],
              else: [
                { op: "i32.const", value: 1 },
                { op: "local.set", index: FAILED },
              ],
            },
          ],
          else: dispatchTail(),
        },
      ],
    },
  ];

  // ANY/CLASS/SPLIT/JMP/SAVE/BOL/EOL/MATCH chain — split out so the CHAR/CHARI
  // arm above stays readable. Uses the same locals.
  function foldCh(): Instr[] {
    // stack: ch ; produce fold(ch)
    // fold = (ch>=0x41 && ch<=0x5a) ? ch+0x20 : ch
    return [
      { op: "local.set", index: TMPI },
      { op: "local.get", index: TMPI },
      { op: "i32.const", value: 0x41 },
      { op: "i32.ge_s" },
      { op: "local.get", index: TMPI },
      { op: "i32.const", value: 0x5a },
      { op: "i32.le_s" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "local.get", index: TMPI }, { op: "i32.const", value: 0x20 }, { op: "i32.add" }],
        else: [{ op: "local.get", index: TMPI }],
      },
    ];
  }

  function dispatchTail(): Instr[] {
    return [
      // ANY: a = dotAll flag
      { op: "local.get", index: OP },
      { op: "i32.const", value: ReOp.ANY },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: anyArm(),
        else: [
          { op: "local.get", index: OP },
          { op: "i32.const", value: ReOp.CLASS },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: classArm(),
            else: [
              { op: "local.get", index: OP },
              { op: "i32.const", value: ReOp.SPLIT },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: splitArm(),
                else: [
                  { op: "local.get", index: OP },
                  { op: "i32.const", value: ReOp.JMP },
                  { op: "i32.eq" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: A },
                      { op: "local.set", index: PC },
                    ],
                    else: [
                      { op: "local.get", index: OP },
                      { op: "i32.const", value: ReOp.SAVE },
                      { op: "i32.eq" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: saveArm(),
                        else: [
                          { op: "local.get", index: OP },
                          { op: "i32.const", value: ReOp.BOL },
                          { op: "i32.eq" },
                          {
                            op: "if",
                            blockType: { kind: "empty" },
                            then: anchorArm(/*eol*/ false),
                            else: [
                              { op: "local.get", index: OP },
                              { op: "i32.const", value: ReOp.EOL },
                              { op: "i32.eq" },
                              {
                                op: "if",
                                blockType: { kind: "empty" },
                                then: anchorArm(/*eol*/ true),
                                else: [
                                  { op: "local.get", index: OP },
                                  { op: "i32.const", value: ReOp.WBOUND },
                                  { op: "i32.eq" },
                                  {
                                    op: "if",
                                    blockType: { kind: "empty" },
                                    then: wboundArm(),
                                    else: [
                                      { op: "local.get", index: OP },
                                      { op: "i32.const", value: ReOp.BACKREF },
                                      { op: "i32.eq" },
                                      {
                                        op: "if",
                                        blockType: { kind: "empty" },
                                        then: backrefArm(),
                                        // op == MATCH (the only remaining op): return 1
                                        else: [{ op: "i32.const", value: 1 }, { op: "return" }],
                                      },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
  }

  function anyArm(): Instr[] {
    // matched = sp<slen && (a!=0 || !isLineTerminator(ch))
    return [
      { op: "local.get", index: SP },
      { op: "local.get", index: SLEN },
      { op: "i32.lt_s" },
      // (a != 0) | (!isLineTerm(ch))
      { op: "local.get", index: A },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      ...isLineTerm(CH),
      { op: "i32.eqz" },
      { op: "i32.or" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: advance1(),
        else: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: FAILED },
        ],
      },
    ];
  }

  function classArm(): Instr[] {
    // matched = sp<slen && class_match(ctab, a, ch, b)
    return [
      { op: "local.get", index: SP },
      { op: "local.get", index: SLEN },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: CTAB },
          { op: "local.get", index: A },
          { op: "local.get", index: CH },
          { op: "local.get", index: B },
          { op: "call", funcIdx: classMatchIdx },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: advance1(),
        else: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: FAILED },
        ],
      },
    ];
  }

  function advance1(): Instr[] {
    return [
      { op: "local.get", index: SP },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: SP },
      { op: "local.get", index: PC },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: PC },
    ];
  }

  function isLineTerm(local: number): Instr[] {
    // ch==0x0a | ch==0x0d | ch==0x2028 | ch==0x2029
    return [
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x0a },
      { op: "i32.eq" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x0d },
      { op: "i32.eq" },
      { op: "i32.or" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x2028 },
      { op: "i32.eq" },
      { op: "i32.or" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x2029 },
      { op: "i32.eq" },
      { op: "i32.or" },
    ];
  }

  function splitArm(): Instr[] {
    // push frame {pc:b, sp, caps:snapshot}; pc = a
    return [
      ...growStackIfFull(),
      ...snapshotCaps(SNAP),
      // FRAME = struct.new $__ReFrame(b, sp, SNAP)
      { op: "local.get", index: B },
      { op: "local.get", index: SP },
      { op: "local.get", index: SNAP },
      { op: "struct.new", typeIdx: frameIdx },
      { op: "local.set", index: FRAME },
      // STACK[TOP] = FRAME
      { op: "local.get", index: STACK },
      { op: "local.get", index: TOP },
      { op: "local.get", index: FRAME },
      { op: "array.set", typeIdx: frameArrIdx },
      // TOP++
      { op: "local.get", index: TOP },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: TOP },
      // pc = a
      { op: "local.get", index: A },
      { op: "local.set", index: PC },
    ];
  }

  function saveArm(): Instr[] {
    // caps[a] = sp; pc++
    return [
      { op: "local.get", index: CAPS },
      { op: "local.get", index: A },
      { op: "local.get", index: SP },
      { op: "array.set", typeIdx: i32Arr },
      { op: "local.get", index: PC },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: PC },
    ];
  }

  function anchorArm(eol: boolean): Instr[] {
    // Non-multiline: BOL matches sp==0, EOL matches sp==slen.
    // Multiline (operand a != 0): BOL also matches right after a line
    // terminator (the unit at sp-1 is a LT), EOL also matches right before a
    // line terminator (the unit at sp is a LT). The neighbour read is guarded
    // by an in-bounds check so it can never trap. `\r\n` is two terminators, so
    // an anchor between them still matches. Mirrors anchorArm in regex/vm.ts.
    //
    // matched = baseEq || (a != 0 && multilineEq)
    return [
      // baseEq: sp == (eol ? slen : 0)
      { op: "local.get", index: SP },
      eol ? ({ op: "local.get", index: SLEN } as Instr) : ({ op: "i32.const", value: 0 } as Instr),
      { op: "i32.eq" },
      // | (a != 0 && multilineEq)
      { op: "local.get", index: A },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      ...multilineAnchorMatch(eol),
      { op: "i32.and" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: PC },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: PC },
        ],
        else: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: FAILED },
        ],
      },
    ];
  }

  /** Push i32 1/0: is the line-boundary neighbour a line terminator? For EOL
   *  the neighbour is the unit at sp (needs sp<slen); for BOL it is the unit at
   *  sp-1 (needs sp>0). Reads are guarded so they never trap out of bounds. */
  function multilineAnchorMatch(eol: boolean): Instr[] {
    return [
      // inBounds = eol ? (sp < slen) : (sp > 0)
      { op: "local.get", index: SP },
      eol ? ({ op: "local.get", index: SLEN } as Instr) : ({ op: "i32.const", value: 0 } as Instr),
      eol ? ({ op: "i32.lt_s" } as Instr) : ({ op: "i32.gt_s" } as Instr),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // ch = strData[soff + (eol ? sp : sp-1)]
          { op: "local.get", index: SDATA },
          { op: "local.get", index: SOFF },
          { op: "local.get", index: SP },
          { op: "i32.add" },
          ...(eol ? [] : [{ op: "i32.const", value: 1 } as Instr, { op: "i32.sub" } as Instr]),
          { op: "array.get_u", typeIdx: strDataIdx },
          { op: "local.set", index: CH },
          ...isLineTerm(CH),
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ];
  }

  /** Push i32 1/0: is the unit in `local` a word char (`[0-9A-Za-z_]`,
   *  §22.2.2.6 IsWordChar)? An out-of-bounds sentinel (-1) is non-word. */
  function isWordInstrs(local: number): Instr[] {
    return [
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x30 },
      { op: "i32.ge_s" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x39 },
      { op: "i32.le_s" },
      { op: "i32.and" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x41 },
      { op: "i32.ge_s" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x5a },
      { op: "i32.le_s" },
      { op: "i32.and" },
      { op: "i32.or" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x61 },
      { op: "i32.ge_s" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x7a },
      { op: "i32.le_s" },
      { op: "i32.and" },
      { op: "i32.or" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x5f },
      { op: "i32.eq" },
      { op: "i32.or" },
    ];
  }

  /** WBOUND (#1912): operand a = negated (`\B`). Mirrors the WBOUND arm in
   *  regex/vm.ts. CH already holds the "after" unit ((sp<slen) ? data[soff+sp]
   *  : -1, computed at dispatch entry); the "before" unit is loaded into TMPI.
   *  matched = (isWord(before) != isWord(after)) ^ negated. */
  function wboundArm(): Instr[] {
    return [
      // TMPI = sp>0 ? data[soff+sp-1] : -1
      { op: "local.get", index: SP },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: SDATA },
          { op: "local.get", index: SOFF },
          { op: "local.get", index: SP },
          { op: "i32.add" },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "array.get_u", typeIdx: strDataIdx },
        ],
        else: [{ op: "i32.const", value: -1 }],
      },
      { op: "local.set", index: TMPI },
      ...isWordInstrs(TMPI),
      ...isWordInstrs(CH),
      { op: "i32.ne" },
      { op: "local.get", index: A },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      { op: "i32.xor" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: PC },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: PC },
        ],
        else: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: FAILED },
        ],
      },
    ];
  }

  /** Conditionally ASCII-fold the i32 on the stack when the ci operand (local
   *  B) is non-zero. `foldCh` re-stages through TMPI, so staging here first is
   *  safe. Used by the BACKREF compare loop. */
  function foldChIf(): Instr[] {
    return [
      { op: "local.set", index: TMPI },
      { op: "local.get", index: B },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "local.get", index: TMPI }, ...foldCh()],
        else: [{ op: "local.get", index: TMPI }],
      },
    ];
  }

  /** BACKREF (#1912): operand a = group index, b = case-insensitive. Mirrors
   *  the BACKREF arm in regex/vm.ts: an unset group matches empty (§22.2.2.9
   *  step 3); otherwise the captured span is compared unit-by-unit at sp.
   *  FAILED doubles as the mismatch flag for the compare loop. */
  function backrefArm(): Instr[] {
    return [
      // gs = caps[2a]; ge = caps[2a+1]
      { op: "local.get", index: CAPS },
      { op: "local.get", index: A },
      { op: "i32.const", value: 2 },
      { op: "i32.mul" },
      { op: "array.get", typeIdx: i32Arr },
      { op: "local.set", index: GS },
      { op: "local.get", index: CAPS },
      { op: "local.get", index: A },
      { op: "i32.const", value: 2 },
      { op: "i32.mul" },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "array.get", typeIdx: i32Arr },
      { op: "local.set", index: GE },
      // unset group (either slot -1) matches empty: pc++
      { op: "local.get", index: GS },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: GE },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: PC },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: PC },
        ],
        else: [
          // blen = ge - gs
          { op: "local.get", index: GE },
          { op: "local.get", index: GS },
          { op: "i32.sub" },
          { op: "local.set", index: BLEN },
          // if sp + blen > slen: fail
          { op: "local.get", index: SP },
          { op: "local.get", index: BLEN },
          { op: "i32.add" },
          { op: "local.get", index: SLEN },
          { op: "i32.gt_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: 1 },
              { op: "local.set", index: FAILED },
            ],
            else: [
              // j = 0; unit-by-unit compare
              { op: "i32.const", value: 0 },
              { op: "local.set", index: JJ },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      // if j >= blen: break (all units matched)
                      { op: "local.get", index: JJ },
                      { op: "local.get", index: BLEN },
                      { op: "i32.ge_s" },
                      { op: "br_if", depth: 1 },
                      // c1 = fold?(data[soff+gs+j])
                      { op: "local.get", index: SDATA },
                      { op: "local.get", index: SOFF },
                      { op: "local.get", index: GS },
                      { op: "i32.add" },
                      { op: "local.get", index: JJ },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataIdx },
                      ...foldChIf(),
                      { op: "local.set", index: C1 },
                      // c2 = fold?(data[soff+sp+j]); mismatch → FAILED=1, break
                      { op: "local.get", index: SDATA },
                      { op: "local.get", index: SOFF },
                      { op: "local.get", index: SP },
                      { op: "i32.add" },
                      { op: "local.get", index: JJ },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataIdx },
                      ...foldChIf(),
                      { op: "local.get", index: C1 },
                      { op: "i32.ne" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "i32.const", value: 1 },
                          { op: "local.set", index: FAILED },
                          { op: "br", depth: 2 },
                        ],
                      },
                      // j++
                      { op: "local.get", index: JJ },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: JJ },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // matched: sp += blen; pc++
              { op: "local.get", index: FAILED },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: SP },
                  { op: "local.get", index: BLEN },
                  { op: "i32.add" },
                  { op: "local.set", index: SP },
                  { op: "local.get", index: PC },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: PC },
                ],
              },
            ],
          },
        ],
      },
    ];
  }

  // Grow STACK if TOP == CAP_USED: double capacity, array.copy old -> new.
  function growStackIfFull(): Instr[] {
    return [
      { op: "local.get", index: TOP },
      { op: "local.get", index: CAP_USED },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // newCap = CAP_USED * 2
          { op: "local.get", index: CAP_USED },
          { op: "i32.const", value: 2 },
          { op: "i32.mul" },
          { op: "local.set", index: CAP_USED },
          // NEWSTACK = array.new_default(newCap)
          { op: "local.get", index: CAP_USED },
          { op: "array.new_default", typeIdx: frameArrIdx },
          { op: "local.set", index: NEWSTACK },
          // copy old (TOP frames) into new
          { op: "local.get", index: NEWSTACK },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: STACK },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: TOP },
          { op: "array.copy", dstTypeIdx: frameArrIdx, srcTypeIdx: frameArrIdx },
          { op: "local.get", index: NEWSTACK },
          { op: "local.set", index: STACK },
        ],
      },
    ];
  }

  const body: Instr[] = [
    // pc = 0; sp = start; steps = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: PC },
    { op: "local.get", index: START },
    { op: "local.set", index: SP },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: STEPS },
    // stack = array.new_default(INITIAL_STACK_CAP); top=0; capUsed=INITIAL
    { op: "i32.const", value: INITIAL_STACK_CAP },
    { op: "array.new_default", typeIdx: frameArrIdx },
    { op: "local.set", index: STACK },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: TOP },
    { op: "i32.const", value: INITIAL_STACK_CAP },
    { op: "local.set", index: CAP_USED },
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        // steps++; if steps > CAP return 0
        { op: "local.get", index: STEPS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.tee", index: STEPS },
        { op: "i32.const", value: REGEX_STEP_CAP },
        { op: "i32.gt_s" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
        // failed = 0
        { op: "i32.const", value: 0 },
        { op: "local.set", index: FAILED },
        // op = prog[pc*3]; a = prog[pc*3+1]; b = prog[pc*3+2]
        ...readProg(0),
        { op: "local.set", index: OP },
        ...readProg(1),
        { op: "local.set", index: A },
        ...readProg(2),
        { op: "local.set", index: B },
        // dispatch (sets PC/SP/CAPS/FAILED or returns 1 on MATCH)
        ...dispatch,
        // if failed: pop a frame or return 0
        { op: "local.get", index: FAILED },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // if top == 0 return 0
            { op: "local.get", index: TOP },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
            // top--; frame = stack[top]
            { op: "local.get", index: TOP },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.tee", index: TOP },
            { op: "local.set", index: TMPI },
            { op: "local.get", index: STACK },
            { op: "local.get", index: TMPI },
            { op: "array.get", typeIdx: frameArrIdx },
            { op: "ref.as_non_null" },
            { op: "local.set", index: FRAME },
            // pc = frame.pc; sp = frame.sp; restore caps from frame.caps
            { op: "local.get", index: FRAME },
            { op: "struct.get", typeIdx: frameIdx, fieldIdx: 0 },
            { op: "local.set", index: PC },
            { op: "local.get", index: FRAME },
            { op: "struct.get", typeIdx: frameIdx, fieldIdx: 1 },
            { op: "local.set", index: SP },
            { op: "local.get", index: FRAME },
            { op: "struct.get", typeIdx: frameIdx, fieldIdx: 2 },
            { op: "local.set", index: SNAP },
            ...restoreCaps(SNAP),
          ],
        },
        // continue loop
        { op: "br", depth: 0 },
      ],
    },
    // unreachable fallthrough — VM always returns inside the loop. Emit 0.
    { op: "i32.const", value: 0 },
  ];

  const fn: WasmFunction = {
    name: "__regex_run",
    typeIdx,
    locals: [
      { name: "pc", type: { kind: "i32" } },
      { name: "sp", type: { kind: "i32" } },
      { name: "steps", type: { kind: "i32" } },
      { name: "stack", type: frameArrRef },
      { name: "top", type: { kind: "i32" } },
      { name: "capUsed", type: { kind: "i32" } },
      { name: "op", type: { kind: "i32" } },
      { name: "a", type: { kind: "i32" } },
      { name: "b", type: { kind: "i32" } },
      { name: "failed", type: { kind: "i32" } },
      { name: "ch", type: { kind: "i32" } },
      { name: "frame", type: { kind: "ref_null", typeIdx: frameIdx } },
      { name: "snap", type: i32ArrRef },
      { name: "tmpi", type: { kind: "i32" } },
      { name: "newstack", type: frameArrRef },
      { name: "gs", type: { kind: "i32" } },
      { name: "ge", type: { kind: "i32" } },
      { name: "blen", type: { kind: "i32" } },
      { name: "jj", type: { kind: "i32" } },
      { name: "c1", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  };
  ctx.mod.functions.push(fn);
  return funcIdx;
}

/**
 * Emit `__regex_search(prog, classTable, nSlots, strData, strOff, strLen,
 * startIdx, sticky, caps) -> i32`.
 *
 * Drives the start-position scan: tries `__regex_run` at each position from
 * `startIdx` to `strLen`; returns 1 with `caps` filled on the first match, 0
 * otherwise. When `sticky` is non-zero (the `y` flag) only `startIdx` is tried.
 * Mirrors `search` in regex/vm.ts. `caps` must be re-initialised to -1 before
 * each attempt — done inside the loop via `array.fill`.
 */
export function ensureRegexSearch(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_search");
  if (existing !== undefined) return existing;
  const runIdx = ensureRegexRun(ctx);
  const i32Arr = regexI32ArrayType(ctx);
  const strDataIdx = ctx.nativeStrDataTypeIdx;
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataIdx };

  const typeIdx = addFuncType(
    ctx,
    [
      i32ArrRef, // prog
      i32ArrRef, // classTable
      { kind: "i32" }, // nSlots
      strDataRef, // strData
      { kind: "i32" }, // strOff
      { kind: "i32" }, // strLen
      { kind: "i32" }, // startIdx
      { kind: "i32" }, // sticky
      i32ArrRef, // caps
    ],
    [{ kind: "i32" }],
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.nativeRegexHelpers.set("__regex_search", funcIdx);

  const PROG = 0,
    CTAB = 1,
    NSLOTS = 2,
    SDATA = 3,
    SOFF = 4,
    SLEN = 5,
    START = 6,
    STICKY = 7,
    CAPS = 8;
  const I = 9; // current start position

  const body: Instr[] = [
    // i = max(0, start)
    // `select` returns its 1st operand when the condition is non-zero, so to
    // compute `start < 0 ? 0 : start` the operands must be (0, start, start<0):
    // [val_if_true=0, val_if_false=start, cond=(start<0)]. (The earlier order
    // [start, 0, start<0] yielded the inverse — `start<0 ? start : 0` — which
    // returned 0 for every non-negative start, so any `__regex_search` with a
    // positive `startIdx` rescanned from 0 and global replace/match looped
    // forever re-matching the first hit. #1539 Phase 2c.)
    { op: "i32.const", value: 0 },
    { op: "local.get", index: START },
    { op: "local.get", index: START },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "select" }, // start < 0 ? 0 : start
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i > slen: break (no match)
            { op: "local.get", index: I },
            { op: "local.get", index: SLEN },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            // re-init caps to -1
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 0 },
            { op: "i32.const", value: -1 },
            { op: "local.get", index: NSLOTS },
            { op: "array.fill", typeIdx: i32Arr },
            // if __regex_run(...) at i: return 1
            { op: "local.get", index: PROG },
            { op: "local.get", index: CTAB },
            { op: "local.get", index: NSLOTS },
            { op: "local.get", index: SDATA },
            { op: "local.get", index: SOFF },
            { op: "local.get", index: SLEN },
            { op: "local.get", index: I },
            { op: "local.get", index: CAPS },
            { op: "call", funcIdx: runIdx },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
            // if sticky: break (only the start position is tried)
            { op: "local.get", index: STICKY },
            { op: "br_if", depth: 1 },
            // i++
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "i32.const", value: 0 },
  ];

  ctx.mod.functions.push({
    name: "__regex_search",
    typeIdx,
    locals: [{ name: "i", type: { kind: "i32" } }],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Emit `__regex_replace(prog, classTable, nGroups, strData, strOff, strLen,
 * subject, replacement, global) -> ref $NativeString` (#1539 Phase 2c).
 *
 * Implements `String.prototype.replace` / `replaceAll` for a backend-created
 * RegExp with a **literal** (non-`$`-pattern, non-function) replacement string
 * (ECMA-262 §22.1.3.19 / §22.2.6.11 with the `$`-substitution and function
 * replacer paths refused at the call site). Walks the subject with
 * `__regex_search`, accumulating `result = … + slice[lastEnd, matchStart) +
 * replacement` for each match and appending `slice[lastEnd, len)` at the end.
 * `global != 0` replaces every match (advancing past empty matches by 1 per
 * §22.2.6.11 AdvanceStringIndex); otherwise only the first.
 *
 * Returns a `$NativeString` — no array boundary, so no `__make_iterable` /
 * host import is pulled in standalone.
 */
export function ensureRegexReplace(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_replace");
  if (existing !== undefined) return existing;

  const searchIdx = ensureRegexSearch(ctx);
  const i32Arr = regexI32ArrayType(ctx);
  const strDataIdx = ctx.nativeStrDataTypeIdx; // array i16
  const strTypeIdx = ctx.nativeStrTypeIdx; // $NativeString (for the empty-string struct.new)
  const anyStrTypeIdx = ctx.anyStrTypeIdx; // $AnyString — the helper signature type

  const substringIdx = ctx.nativeStrHelpers.get("__str_substring");
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (substringIdx === undefined || concatIdx === undefined) {
    throw new Error("__regex_replace requires __str_substring + __str_concat (#682 native string helpers)");
  }

  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataIdx };
  // `__str_substring` / `__str_concat` take and return `$AnyString` (the base
  // type), so subject/replacement params, the result accumulator, and the
  // return type are all `$AnyString`. An empty `$NativeString` is a valid
  // subtype to seed `result` with. `strDataRef` (the i16 backing array) is the
  // concrete native-string data the call site passes split out for the matcher.
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };

  const typeIdx = addFuncType(
    ctx,
    [
      i32ArrRef, // prog
      i32ArrRef, // classTable
      { kind: "i32" }, // nGroups
      strDataRef, // strData
      { kind: "i32" }, // strOff
      { kind: "i32" }, // strLen
      strRef, // subject (flattened)
      strRef, // replacement (flattened)
      { kind: "i32" }, // global flag
    ],
    [strRef],
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.nativeRegexHelpers.set("__regex_replace", funcIdx);

  // params
  const PROG = 0,
    CTAB = 1,
    NGROUPS = 2,
    SDATA = 3,
    SOFF = 4,
    SLEN = 5,
    SUBJ = 6,
    REPL = 7,
    GLOBAL = 8;
  // locals
  const NSLOTS = 9; // 2 * nGroups
  const CAPS = 10; // ref array<i32> capture slots
  const POS = 11; // current search start
  const LASTEND = 12; // end of last replaced match (start of next kept slice)
  const RESULT = 13; // ref $NativeString accumulator
  const MSTART = 14;
  const MEND = 15;

  const body: Instr[] = [
    // nSlots = 2 * nGroups
    { op: "local.get", index: NGROUPS },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.set", index: NSLOTS },
    { op: "local.get", index: NSLOTS },
    { op: "array.new_default", typeIdx: i32Arr },
    { op: "local.set", index: CAPS },
    // result = "" (empty NativeString {len:0, off:0, data:[]}), pos = 0, lastEnd = 0
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: strDataIdx },
    { op: "struct.new", typeIdx: strTypeIdx },
    { op: "local.set", index: RESULT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: POS },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: LASTEND },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if pos > slen: break
            { op: "local.get", index: POS },
            { op: "local.get", index: SLEN },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            // if !__regex_search(... pos, sticky=0 ...): break
            { op: "local.get", index: PROG },
            { op: "local.get", index: CTAB },
            { op: "local.get", index: NSLOTS },
            { op: "local.get", index: SDATA },
            { op: "local.get", index: SOFF },
            { op: "local.get", index: SLEN },
            { op: "local.get", index: POS },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: CAPS },
            { op: "call", funcIdx: searchIdx },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // mstart = caps[0]; mend = caps[1]
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 0 },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: MSTART },
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 1 },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: MEND },
            // result = concat(concat(result, substring(subj, lastEnd, mstart)), replacement)
            { op: "local.get", index: RESULT },
            { op: "local.get", index: SUBJ },
            { op: "local.get", index: LASTEND },
            { op: "local.get", index: MSTART },
            { op: "call", funcIdx: substringIdx },
            { op: "call", funcIdx: concatIdx },
            { op: "local.get", index: REPL },
            { op: "call", funcIdx: concatIdx },
            { op: "local.set", index: RESULT },
            // lastEnd = mend
            { op: "local.get", index: MEND },
            { op: "local.set", index: LASTEND },
            // if !global: break after the first match
            { op: "local.get", index: GLOBAL },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // advance pos: pos = mend + (mend > mstart ? 0 : 1)  (empty-match guard)
            { op: "local.get", index: MEND },
            { op: "local.get", index: MEND },
            { op: "local.get", index: MSTART },
            { op: "i32.gt_s" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [{ op: "i32.const", value: 0 }],
              else: [{ op: "i32.const", value: 1 }],
            },
            { op: "i32.add" },
            { op: "local.set", index: POS },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // result = concat(result, substring(subj, lastEnd, slen))  — the tail
    { op: "local.get", index: RESULT },
    { op: "local.get", index: SUBJ },
    { op: "local.get", index: LASTEND },
    { op: "local.get", index: SLEN },
    { op: "call", funcIdx: substringIdx },
    { op: "call", funcIdx: concatIdx },
  ];

  const fn: WasmFunction = {
    name: "__regex_replace",
    typeIdx,
    locals: [
      { name: "nslots", type: { kind: "i32" } },
      { name: "caps", type: i32ArrRef },
      { name: "pos", type: { kind: "i32" } },
      { name: "lastEnd", type: { kind: "i32" } },
      { name: "result", type: strRef },
      { name: "mstart", type: { kind: "i32" } },
      { name: "mend", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  };
  ctx.mod.functions.push(fn);
  return funcIdx;
}

/**
 * Emit `__regex_capture_array(nGroups, subject, caps) -> ref $vec_nstr`
 * (#1539 Phase 2b).
 *
 * Materializes capture slots from a populated caps array as a native string
 * vec: element 0 is the full match, element N is capture N, and unmatched
 * captures are null `(ref null $AnyString)`, which the standalone compiler
 * already treats as `undefined` for native-string values.
 */
export function ensureRegexCaptureArray(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_capture_array");
  if (existing !== undefined) return existing;

  const i32Arr = regexI32ArrayType(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };

  const nstrElemKey = `ref_${anyStrTypeIdx}`;
  const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
  const nstrArrTypeIdx = getOrRegisterArrayType(ctx, nstrElemKey, nstrElemType);
  const nstrVecTypeIdx = getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);
  const nstrVecRef: ValType = { kind: "ref", typeIdx: nstrVecTypeIdx };

  const substringIdx = ctx.nativeStrHelpers.get("__str_substring");
  if (substringIdx === undefined) {
    throw new Error("__regex_capture_array requires __str_substring (#682 native string helpers)");
  }

  const typeIdx = addFuncType(
    ctx,
    [
      { kind: "i32" }, // nGroups
      strRef, // subject (flattened)
      i32ArrRef, // caps
    ],
    [nstrVecRef],
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.nativeRegexHelpers.set("__regex_capture_array", funcIdx);

  // params
  const NGROUPS = 0,
    SUBJ = 1,
    CAPS = 2;
  // locals
  const RARR = 3;
  const I = 4;
  const CSTART = 5;
  const CEND = 6;

  const body: Instr[] = [
    // result array length is nGroups (group 0 + captures).
    { op: "local.get", index: NGROUPS },
    { op: "array.new_default", typeIdx: nstrArrTypeIdx },
    { op: "local.set", index: RARR },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: NGROUPS },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // cstart = caps[2*i]; cend = caps[2*i+1]
            { op: "local.get", index: CAPS },
            { op: "local.get", index: I },
            { op: "i32.const", value: 2 },
            { op: "i32.mul" },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: CSTART },
            { op: "local.get", index: CAPS },
            { op: "local.get", index: I },
            { op: "i32.const", value: 2 },
            { op: "i32.mul" },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: CEND },
            // result[i] = cstart < 0 ? undefined : substring(subject, cstart, cend)
            { op: "local.get", index: RARR },
            { op: "local.get", index: I },
            { op: "local.get", index: CSTART },
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "val", type: nstrElemType },
              then: [{ op: "ref.null", typeIdx: anyStrTypeIdx } as Instr],
              else: [
                { op: "local.get", index: SUBJ },
                { op: "ref.cast", typeIdx: strTypeIdx } as Instr,
                { op: "local.get", index: CSTART },
                { op: "local.get", index: CEND },
                { op: "call", funcIdx: substringIdx },
              ],
            },
            { op: "array.set", typeIdx: nstrArrTypeIdx },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: NGROUPS },
    { op: "local.get", index: RARR },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: nstrVecTypeIdx },
  ];

  ctx.mod.functions.push({
    name: "__regex_capture_array",
    typeIdx,
    locals: [
      { name: "resultArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      { name: "i", type: { kind: "i32" } },
      { name: "cstart", type: { kind: "i32" } },
      { name: "cend", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Emit `__regex_split(prog, classTable, nGroups, strData, strOff, strLen,
 * subject) -> ref $vec_nstr` (#1539 Phase 2c).
 *
 * This is the non-capturing, non-empty-match split slice. The call site refuses
 * capture groups and nullable separators so this helper can use the same simple
 * boundary loop as the native string splitter: append the substring before each
 * separator match, advance past the consumed separator, then append the tail.
 */
export function ensureRegexSplit(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_split");
  if (existing !== undefined) return existing;

  const searchIdx = ensureRegexSearch(ctx);
  const i32Arr = regexI32ArrayType(ctx);
  const strDataIdx = ctx.nativeStrDataTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataIdx };
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };

  const nstrElemKey = `ref_${anyStrTypeIdx}`;
  const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
  const nstrArrTypeIdx = getOrRegisterArrayType(ctx, nstrElemKey, nstrElemType);
  const nstrVecTypeIdx = getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);
  const nstrVecRef: ValType = { kind: "ref", typeIdx: nstrVecTypeIdx };

  const substringIdx = ctx.nativeStrHelpers.get("__str_substring");
  if (substringIdx === undefined) {
    throw new Error("__regex_split requires __str_substring (#682 native string helpers)");
  }

  const typeIdx = addFuncType(
    ctx,
    [
      i32ArrRef, // prog
      i32ArrRef, // classTable
      { kind: "i32" }, // nGroups
      strDataRef, // strData
      { kind: "i32" }, // strOff
      { kind: "i32" }, // strLen
      strRef, // subject (flattened)
    ],
    [nstrVecRef],
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.nativeRegexHelpers.set("__regex_split", funcIdx);

  // params
  const PROG = 0,
    CTAB = 1,
    NGROUPS = 2,
    SDATA = 3,
    SOFF = 4,
    SLEN = 5,
    SUBJ = 6;
  // locals
  const NSLOTS = 7;
  const CAPS = 8;
  const POS = 9;
  const LASTEND = 10;
  const RARR = 11;
  const RLEN = 12;
  const RCAP = 13;
  const NEWARR = 14;
  const PART = 15;
  const MSTART = 16;
  const MEND = 17;

  const appendPart = (): Instr[] => [
    // Grow result if needed.
    { op: "local.get", index: RLEN },
    { op: "local.get", index: RCAP },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: RCAP },
        { op: "i32.const", value: 2 },
        { op: "i32.mul" },
        { op: "local.set", index: RCAP },
        { op: "local.get", index: RCAP },
        { op: "array.new_default", typeIdx: nstrArrTypeIdx },
        { op: "local.set", index: NEWARR },
        { op: "local.get", index: NEWARR },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: RARR },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: RLEN },
        {
          op: "array.copy",
          dstTypeIdx: nstrArrTypeIdx,
          srcTypeIdx: nstrArrTypeIdx,
        },
        { op: "local.get", index: NEWARR },
        { op: "local.set", index: RARR },
      ],
    } as Instr,
    // resultArr[resultLen] = part
    { op: "local.get", index: RARR },
    { op: "local.get", index: RLEN },
    { op: "local.get", index: PART },
    { op: "array.set", typeIdx: nstrArrTypeIdx },
    { op: "local.get", index: RLEN },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: RLEN },
  ];

  const body: Instr[] = [
    // nSlots = 2 * nGroups; caps = array.new_default(nSlots)
    { op: "local.get", index: NGROUPS },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.set", index: NSLOTS },
    { op: "local.get", index: NSLOTS },
    { op: "array.new_default", typeIdx: i32Arr },
    { op: "local.set", index: CAPS },
    // result array starts at cap 8; pos = lastEnd = 0.
    { op: "i32.const", value: 8 },
    { op: "array.new_default", typeIdx: nstrArrTypeIdx },
    { op: "local.set", index: RARR },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: RLEN },
    { op: "i32.const", value: 8 },
    { op: "local.set", index: RCAP },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: POS },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: LASTEND },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if pos > slen: break
            { op: "local.get", index: POS },
            { op: "local.get", index: SLEN },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            // if !__regex_search(... pos, sticky=0 ...): break
            { op: "local.get", index: PROG },
            { op: "local.get", index: CTAB },
            { op: "local.get", index: NSLOTS },
            { op: "local.get", index: SDATA },
            { op: "local.get", index: SOFF },
            { op: "local.get", index: SLEN },
            { op: "local.get", index: POS },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: CAPS },
            { op: "call", funcIdx: searchIdx },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // mstart = caps[0]; mend = caps[1]
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 0 },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: MSTART },
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 1 },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: MEND },
            // part = substring(subject, lastEnd, mstart); append(part)
            { op: "local.get", index: SUBJ },
            { op: "local.get", index: LASTEND },
            { op: "local.get", index: MSTART },
            { op: "call", funcIdx: substringIdx },
            { op: "local.set", index: PART },
            ...appendPart(),
            // lastEnd = mend; pos = mend (nullable patterns are refused at call site)
            { op: "local.get", index: MEND },
            { op: "local.set", index: LASTEND },
            { op: "local.get", index: MEND },
            { op: "local.set", index: POS },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // Append final tail: substring(subject, lastEnd, slen)
    { op: "local.get", index: SUBJ },
    { op: "local.get", index: LASTEND },
    { op: "local.get", index: SLEN },
    { op: "call", funcIdx: substringIdx },
    { op: "local.set", index: PART },
    ...appendPart(),
    // return struct.new(resultLen, resultArr)
    { op: "local.get", index: RLEN },
    { op: "local.get", index: RARR },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: nstrVecTypeIdx },
  ];

  ctx.mod.functions.push({
    name: "__regex_split",
    typeIdx,
    locals: [
      { name: "nslots", type: { kind: "i32" } },
      { name: "caps", type: i32ArrRef },
      { name: "pos", type: { kind: "i32" } },
      { name: "lastEnd", type: { kind: "i32" } },
      { name: "resultArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      { name: "resultLen", type: { kind: "i32" } },
      { name: "resultCap", type: { kind: "i32" } },
      { name: "newArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      { name: "part", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      { name: "mstart", type: { kind: "i32" } },
      { name: "mend", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/** Build inline instructions that materialize a `number[]` as a fixed
 *  `array i32` on the stack (used for prog + classTable literals). */
export function i32ArrayLiteralInstrs(ctx: CodegenContext, values: number[]): Instr[] {
  const i32Arr = regexI32ArrayType(ctx);
  const instrs: Instr[] = [];
  for (const v of values) instrs.push({ op: "i32.const", value: v | 0 });
  // array.new_fixed requires at least the length operand; empty arrays use
  // array.new_default(0).
  if (values.length === 0) {
    return [
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: i32Arr },
    ];
  }
  instrs.push({ op: "array.new_fixed", typeIdx: i32Arr, length: values.length });
  return instrs;
}
