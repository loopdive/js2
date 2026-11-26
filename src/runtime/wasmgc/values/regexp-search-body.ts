// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Body of `__regex_search`, the start-position scan of the native RegExp
 * engine: it tries `__regex_run` at each position from `startIdx` and returns
 * 1 with `caps` filled on the first match. Mirrors `search` in
 * `src/regexp-compiler/reference/vm.ts`.
 */
import { REGEX_ANCHORED_LITERAL_ALTS_MARKER, ReOp } from "../../contracts/regexp-bytecode.js";
import type { FuncHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import { REGEXP_RUN_BUDGET_EXHAUSTED, type RegExpVmBody } from "./regexp-vm-bodies.js";

export interface RegExpSearchOperands {
  /** `array (mut i32)`: programs, class tables and capture slots. */
  i32ArrayTypeIdx: TypeHandle;
  /** `array (mut i16)`: the subject's code units. */
  strDataTypeIdx: TypeHandle;
  runFuncIdx: FuncHandle;
  /**
   * `__regex_search_linear`, when the target has the linear fallback: it
   * finishes a scan whose `__regex_run` attempt exhausted its step budget.
   */
  linearSearchFuncIdx: FuncHandle | undefined;
  /** Throws for a poisoned program (`nSlots == 0`); must not fall through. */
  poisonThrow: readonly Instr[];
  /**
   * The matcher for the indexed literal-alternation representation, which only
   * the runtime pattern compiler produces. It runs ahead of every generic path
   * and owns the locals that follow the scan's own (`altBodyLen` is the last).
   */
  indexedLiteralAlt: { readonly locals: readonly LocalDef[]; readonly body: readonly Instr[] };
}
type Operands = Readonly<RegExpSearchOperands>;

// Local indices of `__regex_search`: its nine parameters, then its declared locals.
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
const PC = 10; // (#3673 round 20) anchored-detection scan cursor
const LEADCH = 11; // (#3673 round 29) leading literal code unit, -1 when none
const ALT_POS = 12,
  ALT_INDEX = 13,
  ALT_MATCH = 14,
  ALT_BODY_LEN = 15;
/** First local index after the scan's own: where `indexedLiteralAlt`'s locals start. */
const EXTENSION_LOCAL = ALT_BODY_LEN + 1;

/** Returns from the function when `prog` is the raw literal-alternation representation. */
function rawLiteralAltSearch(operands: Operands): Instr[] {
  const { i32ArrayTypeIdx: i32Arr, strDataTypeIdx: strDataIdx } = operands;
  return [
    // Runtime-compiled `^(?:literal|literal|...)$` with no flags. Acorn builds
    // its keyword/reserved-word predicates in this exact generic form. Compare
    // the subject directly against each literal instead of interpreting a
    // SPLIT/JMP/CHAR backtracking program for every identifier.
    { op: "local.get", index: PROG },
    { op: "array.len" },
    { op: "i32.const", value: 3 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: PROG },
        { op: "i32.const", value: 0 },
        { op: "array.get", typeIdx: i32Arr },
        { op: "i32.const", value: REGEX_ANCHORED_LITERAL_ALTS_MARKER },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // A non-multiline ^ can only match at index zero. Negative starts
            // are ToLength-clamped to zero by the ordinary search path.
            { op: "local.get", index: START },
            { op: "i32.const", value: 0 },
            { op: "i32.gt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 0 }, { op: "return" }],
            },
            { op: "local.get", index: PROG },
            { op: "i32.const", value: 1 },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: ALT_BODY_LEN },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: ALT_POS },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "i32.const", value: 0 },
                    { op: "local.set", index: ALT_INDEX },
                    { op: "i32.const", value: 1 },
                    { op: "local.set", index: ALT_MATCH },
                    {
                      op: "block",
                      blockType: { kind: "empty" },
                      body: [
                        {
                          op: "loop",
                          blockType: { kind: "empty" },
                          body: [
                            { op: "local.get", index: ALT_POS },
                            { op: "local.get", index: ALT_INDEX },
                            { op: "i32.add" },
                            { op: "local.get", index: ALT_BODY_LEN },
                            { op: "i32.ge_s" },
                            { op: "br_if", depth: 1 },
                            { op: "local.get", index: PROG },
                            { op: "i32.const", value: 3 },
                            { op: "local.get", index: ALT_POS },
                            { op: "i32.add" },
                            { op: "local.get", index: ALT_INDEX },
                            { op: "i32.add" },
                            { op: "array.get", typeIdx: i32Arr },
                            { op: "i32.const", value: 0x7c },
                            { op: "i32.eq" },
                            { op: "br_if", depth: 1 },
                            { op: "local.get", index: ALT_MATCH },
                            {
                              op: "if",
                              blockType: { kind: "empty" },
                              then: [
                                { op: "local.get", index: ALT_INDEX },
                                { op: "local.get", index: SLEN },
                                { op: "i32.ge_s" },
                                {
                                  op: "if",
                                  blockType: { kind: "empty" },
                                  then: [
                                    { op: "i32.const", value: 0 },
                                    { op: "local.set", index: ALT_MATCH },
                                  ],
                                  else: [
                                    { op: "local.get", index: SDATA },
                                    { op: "local.get", index: SOFF },
                                    { op: "local.get", index: ALT_INDEX },
                                    { op: "i32.add" },
                                    { op: "array.get_u", typeIdx: strDataIdx },
                                    { op: "local.get", index: PROG },
                                    { op: "i32.const", value: 3 },
                                    { op: "local.get", index: ALT_POS },
                                    { op: "i32.add" },
                                    { op: "local.get", index: ALT_INDEX },
                                    { op: "i32.add" },
                                    { op: "array.get", typeIdx: i32Arr },
                                    { op: "i32.ne" },
                                    {
                                      op: "if",
                                      blockType: { kind: "empty" },
                                      then: [
                                        { op: "i32.const", value: 0 },
                                        { op: "local.set", index: ALT_MATCH },
                                      ],
                                    },
                                  ],
                                },
                              ],
                            },
                            { op: "local.get", index: ALT_INDEX },
                            { op: "i32.const", value: 1 },
                            { op: "i32.add" },
                            { op: "local.set", index: ALT_INDEX },
                            { op: "br", depth: 0 },
                          ],
                        },
                      ],
                    },
                    { op: "local.get", index: ALT_MATCH },
                    { op: "local.get", index: ALT_INDEX },
                    { op: "local.get", index: SLEN },
                    { op: "i32.eq" },
                    { op: "i32.and" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: CAPS },
                        { op: "i32.const", value: 0 },
                        { op: "i32.const", value: 0 },
                        { op: "array.set", typeIdx: i32Arr },
                        { op: "local.get", index: CAPS },
                        { op: "i32.const", value: 1 },
                        { op: "local.get", index: SLEN },
                        { op: "array.set", typeIdx: i32Arr },
                        { op: "i32.const", value: 1 },
                        { op: "return" },
                      ],
                    },
                    { op: "local.get", index: ALT_POS },
                    { op: "local.get", index: ALT_INDEX },
                    { op: "i32.add" },
                    { op: "local.get", index: ALT_BODY_LEN },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: ALT_POS },
                    { op: "local.get", index: ALT_INDEX },
                    { op: "i32.add" },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: ALT_POS },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
            { op: "i32.const", value: 0 },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/** Reads the first non-SAVE instruction into `STICKY` (anchored head) and `LEADCH` (literal head). */
function detectLeadingOp(operands: Operands): Instr[] {
  const { i32ArrayTypeIdx: i32Arr } = operands;
  return [
    // (#3673 round 20) Start-anchored fast-out: when the program's first
    // non-SAVE instruction is `BOL` with multiline=0, a match can only ever
    // begin where `^` holds — every later start position fails the assertion
    // immediately, so the position scan is pure overhead (acorn's anchored
    // keyword tests paid ~word-length VM attempts per `.test`). Detecting it
    // here (two or three array reads per call) needs no compile-time plumbing
    // and is conservative: any other leading op (SPLIT for `^a|b`, CHAR, …)
    // leaves the scan untouched. Equivalent by construction: with a
    // multiline=0 BOL head, run(i) for i>start fails BOL exactly as the scan
    // would discover, one attempt at `start` decides the result.
    { op: "i32.const", value: -1 },
    { op: "local.set", index: LEADCH }, // (#3673 round 29) filter disabled by default
    { op: "i32.const", value: 0 },
    { op: "local.set", index: PC },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: PC },
            { op: "i32.const", value: 2 },
            { op: "i32.add" },
            { op: "local.get", index: PROG },
            { op: "array.len" },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: PROG },
            { op: "local.get", index: PC },
            { op: "array.get", typeIdx: i32Arr },
            { op: "i32.const", value: ReOp.SAVE },
            { op: "i32.ne" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: PC },
            { op: "i32.const", value: 3 },
            { op: "i32.add" },
            { op: "local.set", index: PC },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: PC },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: PROG },
    { op: "array.len" },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: PROG },
        { op: "local.get", index: PC },
        { op: "array.get", typeIdx: i32Arr },
        { op: "i32.const", value: ReOp.BOL },
        { op: "i32.eq" },
        { op: "local.get", index: PROG },
        { op: "local.get", index: PC },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "array.get", typeIdx: i32Arr },
        { op: "i32.eqz" }, // operand a == 0 ⇒ not multiline
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 1 },
            { op: "local.set", index: STICKY },
          ],
        },
        // (#3673 round 29) UNANCHORED first-literal prefilter. When the first
        // non-SAVE op is `CHAR c`, every match MUST begin with `c`, so start
        // positions whose code unit differs cannot match — the full VM attempt
        // there is pure overhead. Record `c` in LEADCH; the scan loop below
        // advances past non-`c` positions with one `array.get` each instead of
        // a `__regex_run` call. Deliberately narrow: only plain `CHAR` (not
        // `CHARI`, whose ASCII fold would need two comparisons, and not
        // `CLASS`, which needs a table walk); `-1` disables the filter, so
        // every other program keeps the exact round-20 behavior.
        { op: "local.get", index: PROG },
        { op: "local.get", index: PC },
        { op: "array.get", typeIdx: i32Arr },
        { op: "i32.const", value: ReOp.CHAR },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: PROG },
            { op: "local.get", index: PC },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: LEADCH },
          ],
        },
      ],
    },
  ];
}

/**
 * Spliced right after the `__regex_run` call, whose result is on the stack:
 * on {@link REGEXP_RUN_BUDGET_EXHAUSTED} return the linear search's answer for
 * the rest of the scan (start = the failed attempt's position); otherwise leave
 * the result for the match test.
 */
function linearFallback(operands: Operands, runResult: number): Instr[] {
  const { linearSearchFuncIdx } = operands;
  if (linearSearchFuncIdx === undefined) return [];
  return [
    { op: "local.tee", index: runResult },
    { op: "local.get", index: runResult },
    { op: "i32.const", value: REGEXP_RUN_BUDGET_EXHAUSTED },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...[PROG, CTAB, NSLOTS, SDATA, SOFF, SLEN, I, STICKY, CAPS].map((index): Instr => ({ op: "local.get", index })),
        { op: "call", funcIdx: linearSearchFuncIdx },
        { op: "return" },
      ],
    },
    { op: "local.get", index: runResult },
  ];
}

/** One `__regex_run` attempt per start position, returning 1 on the first match. */
function scanPositions(operands: Operands, runResult: number): Instr[] {
  const { i32ArrayTypeIdx: i32Arr, strDataTypeIdx: strDataIdx, runFuncIdx: runIdx } = operands;
  return [
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
            // (#3673 round 29) leading-literal prefilter: advance `i` past any
            // position whose code unit cannot start a match. Bounds: stops at
            // `i == slen` so the final empty-tail position still gets its
            // regular attempt (a CHAR program fails there anyway, but keeping
            // the loop shape identical avoids reasoning about EOL/lookaround
            // interactions).
            // A sticky search has exactly one permitted start position.  The
            // leading-literal filter advances `I` over non-matching code
            // units, which would silently turn `/b/y` at lastIndex 0 on
            // `"ab"` into a match at index 1.  Keep the filter on the
            // ordinary (non-sticky) scan only; the VM attempt itself must
            // decide the sticky result at the requested position.
            { op: "local.get", index: STICKY },
            { op: "i32.eqz" },
            { op: "local.get", index: LEADCH },
            { op: "i32.const", value: 0 },
            { op: "i32.ge_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                {
                  op: "block",
                  blockType: { kind: "empty" },
                  body: [
                    {
                      op: "loop",
                      blockType: { kind: "empty" },
                      body: [
                        { op: "local.get", index: I },
                        { op: "local.get", index: SLEN },
                        { op: "i32.ge_s" },
                        { op: "br_if", depth: 1 },
                        { op: "local.get", index: SDATA },
                        { op: "local.get", index: SOFF },
                        { op: "local.get", index: I },
                        { op: "i32.add" },
                        { op: "array.get_u", typeIdx: strDataIdx },
                        { op: "local.get", index: LEADCH },
                        { op: "i32.eq" },
                        { op: "br_if", depth: 1 },
                        { op: "local.get", index: I },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: I },
                        { op: "br", depth: 0 },
                      ],
                    },
                  ],
                },
              ],
            },
            // re-init caps to -1
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 0 },
            { op: "i32.const", value: -1 },
            { op: "local.get", index: NSLOTS },
            { op: "array.fill", typeIdx: i32Arr },
            // if __regex_run(... entryPc=0, dir=+1) at i: return 1
            { op: "local.get", index: PROG },
            { op: "local.get", index: CTAB },
            { op: "local.get", index: NSLOTS },
            { op: "local.get", index: SDATA },
            { op: "local.get", index: SOFF },
            { op: "local.get", index: SLEN },
            { op: "local.get", index: I },
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 0 },
            { op: "i32.const", value: 1 },
            { op: "call", funcIdx: runIdx },
            ...linearFallback(operands, runResult),
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
  ];
}

/**
 * `__regex_search(prog, classTable, nSlots, strData, strOff, strLen, startIdx,
 * sticky, caps) -> i32`.
 *
 * Returns 1 with `caps` filled on the first match at or after `startIdx`, 0
 * otherwise. When `sticky` is non-zero (the `y` flag) only `startIdx` is
 * tried. `caps` is re-initialised to -1 before each attempt.
 */
export function buildRegExpSearchBody(operands: Readonly<RegExpSearchOperands>): RegExpVmBody {
  const { poisonThrow, indexedLiteralAlt, linearSearchFuncIdx } = operands;
  const runResult = EXTENSION_LOCAL + indexedLiteralAlt.locals.length;
  const fallbackLocals: LocalDef[] =
    linearSearchFuncIdx === undefined ? [] : [{ name: "runResult", type: { kind: "i32" } }];
  return {
    locals: [
      { name: "i", type: { kind: "i32" } },
      { name: "pc", type: { kind: "i32" } }, // (#3673 round 20)
      { name: "leadch", type: { kind: "i32" } }, // (#3673 round 29)
      { name: "altPos", type: { kind: "i32" } },
      { name: "altIndex", type: { kind: "i32" } },
      { name: "altMatch", type: { kind: "i32" } },
      { name: "altBodyLen", type: { kind: "i32" } },
      ...indexedLiteralAlt.locals,
      ...fallbackLocals,
    ],
    body: [
      // (#4439) POISON GUARD — must precede every read of `prog` / `caps`.
      // `nSlots == 0` is unrepresentable for a compiled program (group 0 alone
      // makes it ≥ 2), so it means `__regex_compile_dynamic_simple` deferred an
      // out-of-subset pattern to here. Throw the catchable TypeError now, before
      // the VM can index a zero-length program or capture array — that OOB trap
      // is uncatchable and is exactly what the deferral must not resurrect.
      { op: "local.get", index: NSLOTS },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [...poisonThrow] },
      ...indexedLiteralAlt.body,
      ...rawLiteralAltSearch(operands),
      ...detectLeadingOp(operands),
      ...scanPositions(operands, runResult),
      { op: "i32.const", value: 0 },
    ],
  };
}
