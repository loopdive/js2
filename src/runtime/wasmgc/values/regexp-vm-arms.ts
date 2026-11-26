// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The opcode arms of `__regex_run`, the backtracking VM of the native RegExp
 * engine, together with the frame they share: the function's local indices and
 * the operands its body is parameterised over.
 *
 * Every arm leaves one VM step applied: it advances `PC` (and `SP` for a
 * consuming op), or sets `FAILED` so the loop in `regexp-vm-bodies.ts` pops a
 * backtrack frame. The reference VM in `src/codegen/regex/vm.ts` is the
 * executable specification these arms mirror opcode for opcode.
 */
import type {
  FuncHandle,
  GlobalHandle,
  Instr,
  LocalDef,
  TypeHandle,
  ValType,
} from "../../../wasm/model/instructions.js";

/** What the body of `__regex_run` needs from the module it is emitted into. */
export interface RegExpRunOperands {
  /** `array (mut i32)`: programs, class tables and capture slots. */
  i32ArrayTypeIdx: TypeHandle;
  /** `array (mut i16)`: the subject's code units. */
  strDataTypeIdx: TypeHandle;
  /** `$__ReFrame` and its array, from `regexp-carrier-layouts.ts`. */
  frameTypeIdx: TypeHandle;
  frameArrayTypeIdx: TypeHandle;
  classMatchFuncIdx: FuncHandle;
  /** `__regex_run` itself: a LOOKAROUND runs its sub-program by recursion. */
  runFuncIdx: FuncHandle;
  /** Mutable nullable `$__ReFrameArr` global: the backtrack stack kept between runs. */
  stackPoolGlobalIdx: GlobalHandle;
  /** Immutable zero-length i32 array: the snapshot of a program with no slot to restore. */
  capsDummyGlobalIdx: GlobalHandle;
  /** Rewrite a dead frame in its stack slot instead of allocating one per SPLIT. */
  reuseFrames: boolean;
  /**
   * `__regex_linear_safe`, when the target has the linear fallback: a program
   * it accepts returns `REGEXP_RUN_BUDGET_EXHAUSTED` instead of throwing.
   */
  linearSafeFuncIdx: FuncHandle | undefined;
  /** Throws the step-cap RangeError; must not fall through. */
  stepCapThrow: readonly Instr[];
}
type Operands = Readonly<RegExpRunOperands>;

// Local indices of `__regex_run`: its ten parameters, then its declared locals.
// params
export const PROG = 0;
const CTAB = 1;
const NSLOTS = 2;
export const SDATA = 3;
export const SOFF = 4;
export const SLEN = 5;
export const START = 6;
const CAPS = 7;
export const ENTRYPC = 8;
export const DIR = 9;
// locals
export const PC = 10; // i32 program counter (instruction index)
export const SP = 11; // i32 string position
export const STEPS = 12; // i32 step counter
export const STACK = 13; // ref $__ReFrameArr — backtrack stack
export const TOP = 14; // i32 stack top (count of live frames)
export const CAP_USED = 15; // i32 stack capacity
export const OP = 16; // i32 current opcode
export const A = 17; // i32 operand a
export const B = 18; // i32 operand b
export const FAILED = 19; // i32 fail flag
export const CH = 20; // i32 current code unit
export const FRAME = 21; // ref null $__ReFrame — popped/pushed frame
export const SNAP = 22; // ref array<i32> — caps snapshot
export const TMPI = 23; // i32 scratch
const NEWSTACK = 24; // ref $__ReFrameArr — grown stack
const GS = 25; // i32 backref group start (#1912)
const GE = 26; // i32 backref group end (#1912)
const BLEN = 27; // i32 backref length (#1912)
const JJ = 28; // i32 backref compare cursor (#1912)
const C1 = 29; // i32 backref left-hand unit (#1912)
export const INB = 30; // i32 direction-aware in-bounds flag (#1911)
export const BUDGET = 31; // i32 length-scaled step budget (#3549)

/** The declared locals, in index order from `PC`: the same frame as the indices above. */
export function runLocals(operands: Operands): LocalDef[] {
  const { i32ArrayTypeIdx: i32Arr, frameTypeIdx: frameIdx, frameArrayTypeIdx: frameArrIdx } = operands;
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };
  const frameArrRef: ValType = { kind: "ref", typeIdx: frameArrIdx };
  return [
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
    { name: "inb", type: { kind: "i32" } },
    { name: "budget", type: { kind: "i32" } },
  ];
}

// Copy caps -> a fresh array<i32> of length NSLOTS (snapshot).
// (#3673 round 23) Both halves are guarded on `nSlots > 2`: group-free,
// scratch-free programs (whole-match slots only) need neither the per-push
// snapshot allocation nor the restore copy — the snapshot is the shared
// `capsDummyGlobalIdx` array instead.
function snapshotCaps(operands: Operands, intoLocal: number): Instr[] {
  const { i32ArrayTypeIdx: i32Arr, capsDummyGlobalIdx } = operands;
  return [
    { op: "local.get", index: NSLOTS },
    { op: "i32.const", value: 2 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
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
      ],
      else: [
        { op: "global.get", index: capsDummyGlobalIdx },
        { op: "local.set", index: intoLocal },
      ],
    },
  ];
}

// Restore CAPS <- snapshot SNAP (copy back). No-op when nSlots <= 2
// (the snapshot was the dummy).
export function restoreCaps(operands: Operands, fromLocal: number): Instr[] {
  const { i32ArrayTypeIdx: i32Arr } = operands;
  return [
    { op: "local.get", index: NSLOTS },
    { op: "i32.const", value: 2 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: CAPS },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: fromLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: NSLOTS },
        { op: "array.copy", dstTypeIdx: i32Arr, srcTypeIdx: i32Arr },
      ],
    },
  ];
}

export function foldCh(): Instr[] {
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

export function anyArm(): Instr[] {
  // matched = inb && (a!=0 || !isLineTerminator(ch))
  return [
    { op: "local.get", index: INB },
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

export function classArm(operands: Operands): Instr[] {
  const { classMatchFuncIdx: classMatchIdx } = operands;
  // matched = inb && class_match(ctab, a, ch, b)
  return [
    { op: "local.get", index: INB },
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

export function cpClassArm(operands: Operands): Instr[] {
  const { strDataTypeIdx: strDataIdx, classMatchFuncIdx: classMatchIdx } = operands;
  const inRange = (local: number, lo: number, hi: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "i32.const", value: lo },
    { op: "i32.ge_s" },
    { op: "local.get", index: local },
    { op: "i32.const", value: hi },
    { op: "i32.le_s" },
    { op: "i32.and" },
  ];
  const combineSurrogates = (lead: number, trail: number): Instr[] => [
    { op: "local.get", index: lead },
    { op: "i32.const", value: 0xd800 },
    { op: "i32.sub" },
    { op: "i32.const", value: 10 },
    { op: "i32.shl" },
    { op: "local.get", index: trail },
    { op: "i32.const", value: 0xdc00 },
    { op: "i32.sub" },
    { op: "i32.add" },
    { op: "i32.const", value: 0x10000 },
    { op: "i32.add" },
    { op: "local.set", index: TMPI },
    { op: "i32.const", value: 2 },
    { op: "local.set", index: BLEN },
  ];
  const loadAtSpOffset = (offset: number): Instr[] => [
    { op: "local.get", index: SDATA },
    { op: "local.get", index: SOFF },
    { op: "local.get", index: SP },
    { op: "i32.add" },
    { op: "i32.const", value: Math.abs(offset) },
    { op: offset < 0 ? "i32.sub" : "i32.add" },
    { op: "array.get_u", typeIdx: strDataIdx },
    { op: "local.set", index: C1 },
  ];

  return [
    // TMPI = current code unit/code point; BLEN = consumed UTF-16 width.
    { op: "local.get", index: CH },
    { op: "local.set", index: TMPI },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: BLEN },
    // Forward combines lead+trail at [sp,sp+1]; reverse lookbehind combines
    // lead+trail ending at sp from [sp-2,sp-1]. Lone surrogates stay width 1.
    { op: "local.get", index: DIR },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...inRange(CH, 0xd800, 0xdbff),
        { op: "local.get", index: SP },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.get", index: SLEN },
        { op: "i32.lt_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...loadAtSpOffset(1),
            ...inRange(C1, 0xdc00, 0xdfff),
            { op: "if", blockType: { kind: "empty" }, then: combineSurrogates(CH, C1) },
          ],
        },
        // A forward entry at the trail half of an existing pair is not a
        // standalone code-point boundary.
        ...inRange(CH, 0xdc00, 0xdfff),
        { op: "local.get", index: SP },
        { op: "i32.const", value: 0 },
        { op: "i32.gt_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...loadAtSpOffset(-1),
            ...inRange(C1, 0xd800, 0xdbff),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "i32.const", value: 0 },
                { op: "local.set", index: INB },
              ],
            },
          ],
        },
      ],
      else: [
        ...inRange(CH, 0xdc00, 0xdfff),
        { op: "local.get", index: SP },
        { op: "i32.const", value: 1 },
        { op: "i32.gt_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...loadAtSpOffset(-2),
            ...inRange(C1, 0xd800, 0xdbff),
            { op: "if", blockType: { kind: "empty" }, then: combineSurrogates(C1, CH) },
          ],
        },
        // A reverse entry at the lead half of an existing pair is likewise
        // not a standalone code-point boundary.
        ...inRange(CH, 0xd800, 0xdbff),
        { op: "local.get", index: SP },
        { op: "local.get", index: SLEN },
        { op: "i32.lt_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...loadAtSpOffset(0),
            ...inRange(C1, 0xdc00, 0xdfff),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "i32.const", value: 0 },
                { op: "local.set", index: INB },
              ],
            },
          ],
        },
      ],
    },
    // matched = inb && class_match(ctab, a, codePoint, b)
    { op: "local.get", index: INB },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: CTAB },
        { op: "local.get", index: A },
        { op: "local.get", index: TMPI },
        { op: "local.get", index: B },
        { op: "call", funcIdx: classMatchIdx },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: SP },
        { op: "local.get", index: DIR },
        { op: "local.get", index: BLEN },
        { op: "i32.mul" },
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
  ];
}

export function advance1(): Instr[] {
  // sp += dir (#1911 — backwards in lookbehind sub-programs); pc++
  return [
    { op: "local.get", index: SP },
    { op: "local.get", index: DIR },
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

export function splitArm(operands: Operands): Instr[] {
  // push frame {pc:b, sp, caps:snapshot}; pc = a
  return [
    ...growStackIfFull(operands),
    ...snapshotCaps(operands, SNAP),
    ...pushFrame(operands),
    // pc = a
    { op: "local.get", index: A },
    { op: "local.set", index: PC },
  ];
}

export function saveArm(operands: Operands): Instr[] {
  const { i32ArrayTypeIdx: i32Arr } = operands;
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

export function progressArm(operands: Operands): Instr[] {
  const { i32ArrayTypeIdx: i32Arr } = operands;
  // Empty-iteration guard (§22.2.2.3.1, #1959): if sp == caps[a] (the loop
  // entry recorded by a preceding SAVE), the body matched empty — fail the
  // iteration so backtracking takes the quantifier's exit arm. Otherwise
  // pc++. Mirrors the PROGRESS case in regex/vm.ts.
  return [
    { op: "local.get", index: SP },
    { op: "local.get", index: CAPS },
    { op: "local.get", index: A },
    { op: "array.get", typeIdx: i32Arr },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: FAILED },
      ],
      else: [
        { op: "local.get", index: PC },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: PC },
      ],
    },
  ];
}

export function clearArm(operands: Operands): Instr[] {
  const { i32ArrayTypeIdx: i32Arr } = operands;
  // Reset capture slots a..b (inclusive) to -1 (§22.2.2.3.1, #1960). TMPI is
  // the loop cursor (general i32 scratch — does not overlap backref state).
  // Mirrors the CLEAR case in regex/vm.ts; backtrack restore is handled by
  // the enclosing SPLIT's caps snapshot.
  return [
    { op: "local.get", index: A },
    { op: "local.set", index: TMPI },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if (TMPI > B) break
            { op: "local.get", index: TMPI },
            { op: "local.get", index: B },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            // caps[TMPI] = -1
            { op: "local.get", index: CAPS },
            { op: "local.get", index: TMPI },
            { op: "i32.const", value: -1 },
            { op: "array.set", typeIdx: i32Arr },
            // TMPI++
            { op: "local.get", index: TMPI },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: TMPI },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // pc++
    { op: "local.get", index: PC },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: PC },
  ];
}

export function anchorArm(operands: Operands, eol: boolean): Instr[] {
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
    eol ? { op: "local.get", index: SLEN } : { op: "i32.const", value: 0 },
    { op: "i32.eq" },
    // | (a != 0 && multilineEq)
    { op: "local.get", index: A },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
    ...multilineAnchorMatch(operands, eol),
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
function multilineAnchorMatch(operands: Operands, eol: boolean): Instr[] {
  const { strDataTypeIdx: strDataIdx } = operands;
  return [
    // inBounds = eol ? (sp < slen) : (sp > 0)
    { op: "local.get", index: SP },
    eol ? { op: "local.get", index: SLEN } : { op: "i32.const", value: 0 },
    eol ? { op: "i32.lt_s" } : { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        // ch = strData[soff + (eol ? sp : sp-1)]
        { op: "local.get", index: SDATA },
        { op: "local.get", index: SOFF },
        { op: "local.get", index: SP },
        { op: "i32.add" },
        ...((eol ? [] : [{ op: "i32.const", value: 1 }, { op: "i32.sub" }]) satisfies Instr[]),
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
export function wboundArm(operands: Operands): Instr[] {
  const { strDataTypeIdx: strDataIdx } = operands;
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
export function backrefArm(operands: Operands): Instr[] {
  const { i32ArrayTypeIdx: i32Arr, strDataTypeIdx: strDataIdx } = operands;
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
        // out of room? dir>0: sp+blen > slen ; dir<0: sp-blen < 0 (#1911)
        { op: "local.get", index: DIR },
        { op: "i32.const", value: 0 },
        { op: "i32.gt_s" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: SP },
            { op: "local.get", index: BLEN },
            { op: "i32.add" },
            { op: "local.get", index: SLEN },
            { op: "i32.gt_s" },
          ],
          else: [
            { op: "local.get", index: SP },
            { op: "local.get", index: BLEN },
            { op: "i32.sub" },
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
          ],
        },
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
                    // c2 = fold?(data[soff+base+j]); mismatch → FAILED=1, break.
                    // base = sp + ((dir-1)>>1)*blen — sp forward, sp-blen
                    // backwards (#1911): the captured span is matched against
                    // the units ENDING at sp, compared left-to-right.
                    { op: "local.get", index: SDATA },
                    { op: "local.get", index: SOFF },
                    { op: "local.get", index: SP },
                    { op: "i32.add" },
                    { op: "local.get", index: DIR },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
                    { op: "i32.const", value: 1 },
                    { op: "i32.shr_s" },
                    { op: "local.get", index: BLEN },
                    { op: "i32.mul" },
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
            // matched: sp += dir*blen; pc++
            { op: "local.get", index: FAILED },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: SP },
                { op: "local.get", index: BLEN },
                { op: "local.get", index: DIR },
                { op: "i32.mul" },
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

/** LOOKAROUND (#1911): operand a = sub-program entry pc, b = bit0 negated |
 *  bit1 behind. Mirrors the LOOKAROUND arm in regex/vm.ts: snapshot caps,
 *  recursively run the sub-program at sp (dir = behind ? -1 : +1, same caps
 *  array — the Wasm VM mutates in place), then keep the sub's captures only
 *  on a positive success; every other outcome restores the snapshot. The
 *  recursion is what makes the assertion atomic. */
export function lookaroundArm(operands: Operands): Instr[] {
  const { runFuncIdx: funcIdx } = operands;
  return [
    ...snapshotCaps(operands, SNAP),
    // ok = __regex_run(prog, ctab, nslots, sdata, soff, slen, sp, caps,
    //                  subPc=a, dir = (b&2) ? -1 : 1)
    { op: "local.get", index: PROG },
    { op: "local.get", index: CTAB },
    { op: "local.get", index: NSLOTS },
    { op: "local.get", index: SDATA },
    { op: "local.get", index: SOFF },
    { op: "local.get", index: SLEN },
    { op: "local.get", index: SP },
    { op: "local.get", index: CAPS },
    { op: "local.get", index: A },
    { op: "local.get", index: B },
    { op: "i32.const", value: 2 },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: -1 }],
      else: [{ op: "i32.const", value: 1 }],
    },
    { op: "call", funcIdx },
    { op: "local.set", index: TMPI },
    // matched = ok ^ negated
    { op: "local.get", index: TMPI },
    { op: "local.get", index: B },
    { op: "i32.const", value: 1 },
    { op: "i32.and" },
    { op: "i32.xor" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // negated success never keeps sub-captures (§22.2.2.4).
        { op: "local.get", index: B },
        { op: "i32.const", value: 1 },
        { op: "i32.and" },
        { op: "if", blockType: { kind: "empty" }, then: restoreCaps(operands, SNAP) },
        { op: "local.get", index: PC },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: PC },
      ],
      else: [...restoreCaps(operands, SNAP), { op: "i32.const", value: 1 }, { op: "local.set", index: FAILED }],
    },
  ];
}

// Grow STACK if TOP == CAP_USED: double capacity, array.copy old -> new.
function growStackIfFull(operands: Operands): Instr[] {
  const { frameArrayTypeIdx: frameArrIdx } = operands;
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

/**
 * The `__regex_run` SPLIT push: store `{pc: b, sp, caps: snap}` at `stack[top]`
 * and bump `top`.
 *
 * With frame reuse on, a slot that already holds a frame from an earlier push
 * — of this run OR, thanks to the #3673 round 22 stack pool, of a previous one
 * — is written in place instead of being replaced. A frame at or above `top` is
 * dead by definition (it was popped, and the pop copies all three fields into
 * locals before anything can push again), and a frame is only ever stored back
 * at the index it was read from, so no two stack slots can alias. `array.copy`
 * on growth preserves index identity; the freshly grown tail is null and falls
 * to the allocating arm.
 */
function pushFrame(operands: Operands): Instr[] {
  const { frameTypeIdx: frameIdx, frameArrayTypeIdx: frameArrIdx, reuseFrames } = operands;
  const allocate: Instr[] = [
    { op: "local.get", index: B },
    { op: "local.get", index: SP },
    { op: "local.get", index: SNAP },
    { op: "struct.new", typeIdx: frameIdx },
    { op: "local.set", index: FRAME },
    { op: "local.get", index: STACK },
    { op: "local.get", index: TOP },
    { op: "local.get", index: FRAME },
    { op: "array.set", typeIdx: frameArrIdx },
  ];
  const bump: Instr[] = [
    { op: "local.get", index: TOP },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: TOP },
  ];
  if (!reuseFrames) return [...allocate, ...bump];
  return [
    { op: "local.get", index: STACK },
    { op: "local.get", index: TOP },
    { op: "array.get", typeIdx: frameArrIdx },
    { op: "local.tee", index: FRAME },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: allocate,
      else: [
        // Already in the slot at this index — rewrite the three fields.
        { op: "local.get", index: FRAME },
        { op: "ref.as_non_null" },
        { op: "local.get", index: B },
        { op: "struct.set", typeIdx: frameIdx, fieldIdx: 0 },
        { op: "local.get", index: FRAME },
        { op: "ref.as_non_null" },
        { op: "local.get", index: SP },
        { op: "struct.set", typeIdx: frameIdx, fieldIdx: 1 },
        { op: "local.get", index: FRAME },
        { op: "ref.as_non_null" },
        { op: "local.get", index: SNAP },
        { op: "struct.set", typeIdx: frameIdx, fieldIdx: 2 },
      ],
    },
    ...bump,
  ];
}
