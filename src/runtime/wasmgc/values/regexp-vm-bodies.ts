// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Bodies of the native RegExp engine's matcher: `__regex_class_match` and the
 * backtracking VM `__regex_run`. The start-position scan that drives the VM
 * is `regexp-search-body.ts`.
 *
 * A builder takes only what the surrounding module owns (type, function and
 * global indices) and returns the locals and instructions, so the legacy
 * emitter and a Prepared-path binding register the same function.
 */
import {
  ReOp,
  REGEX_STEP_CAP,
  REGEX_STEP_CAP_LEN_SATURATION,
  REGEX_STEP_CAP_PER_UNIT,
} from "../../contracts/regexp-bytecode.js";
import type { Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import {
  type RegExpRunOperands,
  advance1,
  anchorArm,
  anyArm,
  backrefArm,
  classArm,
  clearArm,
  cpClassArm,
  foldCh,
  lookaroundArm,
  progressArm,
  restoreCaps,
  runLocals,
  saveArm,
  splitArm,
  wboundArm,
  // the frame locals the loop shares with the arms
  A,
  B,
  BUDGET,
  CAP_USED,
  CH,
  DIR,
  ENTRYPC,
  FAILED,
  FRAME,
  INB,
  OP,
  PC,
  PROG,
  SDATA,
  SLEN,
  SNAP,
  SOFF,
  SP,
  STACK,
  START,
  STEPS,
  TMPI,
  TOP,
} from "./regexp-vm-arms.js";

export interface RegExpVmBody {
  locals: LocalDef[];
  body: Instr[];
}

export interface RegExpClassMatchOperands {
  /** `array (mut i32)`: the class table. */
  i32ArrayTypeIdx: TypeHandle;
}

/**
 * `__regex_class_match(classTable, offset, c, negated) -> i32`.
 *
 * Binary-searches the sorted run-length range table for one class and returns
 * 1/0. Mirrors `classMatch` in vm.ts.
 */
export function buildRegExpClassMatchBody(operands: Readonly<RegExpClassMatchOperands>): RegExpVmBody {
  const { i32ArrayTypeIdx: i32Arr } = operands;
  // params: table(0), offset(1), c(2), negated(3)
  // locals: mid(4), loIndex(5), hiIndex(6), inside(7), lo(8), hi(9)
  const TABLE = 0,
    OFFSET = 1,
    C = 2,
    NEG = 3;
  const MID = 4,
    LO_INDEX = 5,
    HI_INDEX = 6,
    INSIDE = 7,
    LO = 8,
    HI = 9;
  const body: Instr[] = [
    // loIndex = 0; hiIndex = table[offset] - 1; inside = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: LO_INDEX },
    { op: "local.get", index: TABLE },
    { op: "local.get", index: OFFSET },
    { op: "array.get", typeIdx: i32Arr },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: HI_INDEX },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: INSIDE },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if loIndex > hiIndex: break
            { op: "local.get", index: LO_INDEX },
            { op: "local.get", index: HI_INDEX },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            // mid = loIndex + ((hiIndex - loIndex) >> 1)
            { op: "local.get", index: LO_INDEX },
            { op: "local.get", index: HI_INDEX },
            { op: "local.get", index: LO_INDEX },
            { op: "i32.sub" },
            { op: "i32.const", value: 1 },
            { op: "i32.shr_u" },
            { op: "i32.add" },
            { op: "local.set", index: MID },
            // lo/hi = table[offset + 1 + 2*mid + {0,1}]
            { op: "local.get", index: TABLE },
            { op: "local.get", index: OFFSET },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: MID },
            { op: "i32.const", value: 2 },
            { op: "i32.mul" },
            { op: "i32.add" },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: LO },
            { op: "local.get", index: TABLE },
            { op: "local.get", index: OFFSET },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: MID },
            { op: "i32.const", value: 2 },
            { op: "i32.mul" },
            { op: "i32.add" },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: HI },
            // c < lo => hiIndex = mid - 1
            { op: "local.get", index: C },
            { op: "local.get", index: LO },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: MID },
                { op: "i32.const", value: 1 },
                { op: "i32.sub" },
                { op: "local.set", index: HI_INDEX },
              ],
              else: [
                // c > hi => loIndex = mid + 1; otherwise found.
                { op: "local.get", index: C },
                { op: "local.get", index: HI },
                { op: "i32.gt_s" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: MID },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: LO_INDEX },
                  ],
                  else: [
                    { op: "i32.const", value: 1 },
                    { op: "local.set", index: INSIDE },
                    { op: "br", depth: 3 },
                  ],
                },
              ],
            },
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
  return {
    locals: [
      { name: "mid", type: { kind: "i32" } },
      { name: "loIndex", type: { kind: "i32" } },
      { name: "hiIndex", type: { kind: "i32" } },
      { name: "inside", type: { kind: "i32" } },
      { name: "lo", type: { kind: "i32" } },
      { name: "hi", type: { kind: "i32" } },
    ],
    body,
  };
}

/** Initial backtrack-stack capacity (frames). Grows on demand. */
const INITIAL_STACK_CAP = 64;

/** `__regex_run`'s result when a linear-safe program exhausted its step budget. */
export const REGEXP_RUN_BUDGET_EXHAUSTED = -1;

/** `prog[pc*3 + k]`: slot `k` of the instruction at `PC`. */
function readProg(i32Arr: TypeHandle, k: number): Instr[] {
  return [
    { op: "local.get", index: PROG },
    { op: "local.get", index: PC },
    { op: "i32.const", value: 3 },
    { op: "i32.mul" },
    ...((k === 0 ? [] : [{ op: "i32.const", value: k }, { op: "i32.add" }]) satisfies Instr[]),
    { op: "array.get", typeIdx: i32Arr },
  ];
}

/**
 * The dispatch switch over OP, emitted as an if/else chain (op === k). Each arm
 * sets PC/SP/CAPS or FAILED; MATCH returns 1 directly.
 */
function dispatch(operands: Readonly<RegExpRunOperands>): Instr[] {
  const { strDataTypeIdx: strDataIdx } = operands;
  return [
    // Direction-aware bounds + unit read (#1911):
    // inb = dir>0 ? sp<slen : sp>0
    { op: "local.get", index: DIR },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "local.get", index: SP }, { op: "local.get", index: SLEN }, { op: "i32.lt_s" }],
      else: [{ op: "local.get", index: SP }, { op: "i32.const", value: 0 }, { op: "i32.gt_s" }],
    },
    { op: "local.set", index: INB },
    // ch = inb ? strData[soff + sp + (dir>0 ? 0 : -1)] : -1
    // The offset term is (dir-1)>>1: +1 → 0, -1 → -1.
    { op: "local.get", index: INB },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: SDATA },
        { op: "local.get", index: SOFF },
        { op: "local.get", index: SP },
        { op: "i32.add" },
        { op: "local.get", index: DIR },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "i32.const", value: 1 },
        { op: "i32.shr_s" },
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
        // matched = inb && ch==a
        { op: "local.get", index: INB },
        { op: "local.get", index: CH },
        { op: "local.get", index: A },
        { op: "i32.eq" },
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
            { op: "local.get", index: INB },
            { op: "local.get", index: CH },
            ...foldCh(),
            { op: "local.get", index: A },
            { op: "i32.eq" },
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
          ],
          else: dispatchTail(operands),
        },
      ],
    },
  ];
}

/** The rest of the chain after CHAR/CHARI, split out so that arm stays readable. */
function dispatchTail(operands: Readonly<RegExpRunOperands>): Instr[] {
  const { stackPoolGlobalIdx } = operands;
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
          then: classArm(operands),
          else: [
            { op: "local.get", index: OP },
            { op: "i32.const", value: ReOp.CPCLASS },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: cpClassArm(operands),
              else: [
                { op: "local.get", index: OP },
                { op: "i32.const", value: ReOp.SPLIT },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: splitArm(operands),
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
                          then: saveArm(operands),
                          else: [
                            { op: "local.get", index: OP },
                            { op: "i32.const", value: ReOp.BOL },
                            { op: "i32.eq" },
                            {
                              op: "if",
                              blockType: { kind: "empty" },
                              then: anchorArm(operands, /*eol*/ false),
                              else: [
                                { op: "local.get", index: OP },
                                { op: "i32.const", value: ReOp.EOL },
                                { op: "i32.eq" },
                                {
                                  op: "if",
                                  blockType: { kind: "empty" },
                                  then: anchorArm(operands, /*eol*/ true),
                                  else: [
                                    { op: "local.get", index: OP },
                                    { op: "i32.const", value: ReOp.WBOUND },
                                    { op: "i32.eq" },
                                    {
                                      op: "if",
                                      blockType: { kind: "empty" },
                                      then: wboundArm(operands),
                                      else: [
                                        { op: "local.get", index: OP },
                                        { op: "i32.const", value: ReOp.BACKREF },
                                        { op: "i32.eq" },
                                        {
                                          op: "if",
                                          blockType: { kind: "empty" },
                                          then: backrefArm(operands),
                                          else: [
                                            { op: "local.get", index: OP },
                                            { op: "i32.const", value: ReOp.LOOKAROUND },
                                            { op: "i32.eq" },
                                            {
                                              op: "if",
                                              blockType: { kind: "empty" },
                                              then: lookaroundArm(operands),
                                              else: [
                                                { op: "local.get", index: OP },
                                                { op: "i32.const", value: ReOp.PROGRESS },
                                                { op: "i32.eq" },
                                                {
                                                  op: "if",
                                                  blockType: { kind: "empty" },
                                                  then: progressArm(operands),
                                                  else: [
                                                    { op: "local.get", index: OP },
                                                    { op: "i32.const", value: ReOp.CLEAR },
                                                    { op: "i32.eq" },
                                                    {
                                                      op: "if",
                                                      blockType: { kind: "empty" },
                                                      then: clearArm(operands),
                                                      // op == MATCH (the only remaining op): return 1
                                                      else: [
                                                        { op: "local.get", index: STACK },
                                                        { op: "global.set", index: stackPoolGlobalIdx }, // (#3673 r22) pool check-in
                                                        { op: "i32.const", value: 1 },
                                                        { op: "return" },
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

/**
 * Ahead of the step-cap throw: a linear-safe program checks its backtrack stack
 * back into the pool (as the VM's other exits do) and returns
 * {@link REGEXP_RUN_BUDGET_EXHAUSTED}, which hands the search to the linear
 * PikeVM. Only a top-level run can get here: a linear-safe program has no
 * LOOKAROUND, so it never recurses.
 */
function linearHandoff(operands: Readonly<RegExpRunOperands>): Instr[] {
  const { linearSafeFuncIdx, stackPoolGlobalIdx } = operands;
  if (linearSafeFuncIdx === undefined) return [];
  return [
    { op: "local.get", index: PROG },
    { op: "call", funcIdx: linearSafeFuncIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: STACK },
        { op: "global.set", index: stackPoolGlobalIdx },
        { op: "i32.const", value: REGEXP_RUN_BUDGET_EXHAUSTED },
        { op: "return" },
      ],
    },
  ];
}

/**
 * `__regex_run(prog, classTable, nSlots, strData, strOff, strLen, startIdx,
 * caps, entryPc, dir) -> i32`: one anchored attempt at `startIdx`.
 *
 * `caps` is caller-allocated, length `nSlots`, pre-filled with -1. On a match
 * (1 returned) the slots hold `[g0s,g0e,g1s,g1e,…]`; -1 = unset.
 *
 * #1911: `entryPc` selects the (sub-)program, `dir` the scan direction (+1
 * forward, -1 for lookbehind sub-programs — consuming ops read the unit at
 * sp-1 and decrement). LOOKAROUND recursively calls this function on its
 * sub-program at the current position; the recursion is what makes
 * lookarounds atomic (no backtrack entries leak into the outer attempt).
 */
export function buildRegExpRunBody(operands: Readonly<RegExpRunOperands>): RegExpVmBody {
  const {
    i32ArrayTypeIdx: i32Arr,
    frameTypeIdx: frameIdx,
    frameArrayTypeIdx: frameArrIdx,
    stackPoolGlobalIdx,
    stepCapThrow,
  } = operands;
  const body: Instr[] = [
    // pc = entryPc (#1911 — 0 for the main program); sp = start; steps = 0
    { op: "local.get", index: ENTRYPC },
    { op: "local.set", index: PC },
    { op: "local.get", index: START },
    { op: "local.set", index: SP },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: STEPS },
    // (#3549) budget = CAP + PER_UNIT * min(slen, SATURATION) — length-scaled
    // so legitimate LINEAR matches over long subjects (measured ~5 steps/unit
    // for `^\p{L}+$`(u); the property-escapes complement subjects are ~1.1M
    // units) fit, while runaway backtracking (Ω(n²)/Ω(2ⁿ)) still exceeds it.
    // Mirrors regexStepBudget in regex/vm.ts — keep the two in lockstep.
    { op: "local.get", index: SLEN },
    { op: "i32.const", value: REGEX_STEP_CAP_LEN_SATURATION },
    { op: "local.get", index: SLEN },
    { op: "i32.const", value: REGEX_STEP_CAP_LEN_SATURATION },
    { op: "i32.lt_s" },
    { op: "select" },
    { op: "i32.const", value: REGEX_STEP_CAP_PER_UNIT },
    { op: "i32.mul" },
    { op: "i32.const", value: REGEX_STEP_CAP },
    { op: "i32.add" },
    { op: "local.set", index: BUDGET },
    // stack = pool checkout ?? array.new_default(INITIAL_STACK_CAP); top=0
    { op: "global.get", index: stackPoolGlobalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: INITIAL_STACK_CAP },
        { op: "array.new_default", typeIdx: frameArrIdx },
        { op: "local.set", index: STACK },
        { op: "i32.const", value: INITIAL_STACK_CAP },
        { op: "local.set", index: CAP_USED },
      ],
      else: [
        { op: "global.get", index: stackPoolGlobalIdx },
        { op: "ref.as_non_null" },
        { op: "local.set", index: STACK },
        { op: "local.get", index: STACK },
        { op: "array.len" },
        { op: "local.set", index: CAP_USED },
        { op: "ref.null", typeIdx: frameArrIdx },
        { op: "global.set", index: stackPoolGlobalIdx },
      ],
    },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: TOP },
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        // steps++; if steps > budget throw RangeError (#2091 — was a silent
        // `return 0`, indistinguishable from a genuine no-match; #3549 — the
        // flat cap became the length-scaled BUDGET local computed at entry).
        { op: "local.get", index: STEPS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.tee", index: STEPS },
        { op: "local.get", index: BUDGET },
        { op: "i32.gt_s" },
        { op: "if", blockType: { kind: "empty" }, then: [...linearHandoff(operands), ...stepCapThrow] },
        // failed = 0
        { op: "i32.const", value: 0 },
        { op: "local.set", index: FAILED },
        // op = prog[pc*3]; a = prog[pc*3+1]; b = prog[pc*3+2]
        ...readProg(i32Arr, 0),
        { op: "local.set", index: OP },
        ...readProg(i32Arr, 1),
        { op: "local.set", index: A },
        ...readProg(i32Arr, 2),
        { op: "local.set", index: B },
        // dispatch (sets PC/SP/CAPS/FAILED or returns 1 on MATCH)
        ...dispatch(operands),
        // if failed: pop a frame or return 0
        { op: "local.get", index: FAILED },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // if top == 0 return 0
            { op: "local.get", index: TOP },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: STACK },
                { op: "global.set", index: stackPoolGlobalIdx }, // (#3673 r22) pool check-in
                { op: "i32.const", value: 0 },
                { op: "return" },
              ],
            },
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
            ...restoreCaps(operands, SNAP),
          ],
        },
        // continue loop
        { op: "br", depth: 0 },
      ],
    },
    // unreachable fallthrough — VM always returns inside the loop. Emit 0.
    { op: "i32.const", value: 0 },
  ];
  return { locals: runLocals(operands), body };
}
