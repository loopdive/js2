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
import { noJsHost } from "./expressions/helpers.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType, getOrRegisterArrayType, getOrRegisterVecType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { buildIndexedAnchoredLiteralAltSearch } from "./regex-anchored-alt-index.js";
import { ReOp } from "./regex/bytecode.js";
import { frameStackPushInstrs } from "./regex-scratch-pool.js";
import { REGEX_STEP_CAP, REGEX_STEP_CAP_LEN_SATURATION, REGEX_STEP_CAP_PER_UNIT } from "./regex/vm.js";

/**
 * Runtime-compiled `^(?:literal|literal|...)$` programs with no flags use this
 * compact representation: [marker, bodyLength, 0, ...UTF-16 body units]
 *
 * `__regex_search` intercepts it before the fixed-width backtracking VM. The
 * negative marker cannot collide with a ReOp. This is a representation-level
 * optimization only; every other pattern retains the normal bytecode ABI.
 */
export const REGEX_ANCHORED_LITERAL_ALTS_MARKER = -0x40000000;

/** REGEX_STEP_CAP message (§22.2.6.x — cap exhaustion → catchable RangeError). */
const REGEX_CAP_MESSAGE = "RangeError: regular expression step limit exceeded";

/**
 * (#4439) The refusal a POISONED `$NativeRegExp` raises on first use.
 *
 * `__regex_compile_dynamic_simple` builds a poisoned value — `nGroups = 0`,
 * `nScratch = 0`, zero-length `prog` — for a pattern outside its runtime
 * grammar, instead of throwing at construction (§22.2.3.1 does not fail for
 * `[z-z]` / `[0-9]` / `abc{1}`; only THIS compiler cannot run them). The
 * message is shared with the constructor so the observable text is unchanged
 * from the pre-#4439 construction-time throw.
 */
export const REGEX_UNSUPPORTED_DYNAMIC_PATTERN = "Unsupported dynamic regular expression pattern";

/**
 * (#4439) Build the throw sequence for a poisoned pattern — a catchable
 * `TypeError` through the shared `$exc` tag, never a Wasm trap.
 *
 * Same ordering contract as {@link regexCapExhaustionThrow}: call it at the TOP
 * of the helper that embeds it, BEFORE any funcIdx is captured, because
 * `ensureLateImport("__new_TypeError")` can register a host import and shift
 * every defined-function index.
 */
function regexUnsupportedPatternThrow(ctx: CodegenContext): Instr[] {
  if (noJsHost(ctx)) emitWasiErrorConstructor(ctx, "TypeError", 1);
  addStringConstantGlobal(ctx, REGEX_UNSUPPORTED_DYNAMIC_PATTERN);
  const ctorIdx = ensureLateImport(ctx, "__new_TypeError", [{ kind: "externref" }], [{ kind: "externref" }]);
  const tagIdx = ensureExnTag(ctx);
  const instrs: Instr[] = [...stringConstantExternrefInstrs(ctx, REGEX_UNSUPPORTED_DYNAMIC_PATTERN)];
  if (ctorIdx !== undefined) instrs.push({ op: "call", funcIdx: ctorIdx });
  instrs.push({ op: "throw", tagIdx });
  return instrs;
}

/**
 * (#2091) Build the instruction sequence for a regex VM step-cap-exhaustion
 * throw — a catchable `RangeError` instance (via the shared `$exc` tag), NOT a
 * silent `return 0` (which is indistinguishable from a genuine no-match).
 *
 * MUST be called at the TOP of `ensureRegexRun`, BEFORE the `__regex_run`
 * funcIdx (and `classMatchIdx`) are captured: in JS-host mode `ensureLateImport`
 * registers `__new_RangeError` as a host import, which shifts every defined
 * function index. Ensuring it first keeps the later index captures correct.
 * In no-JS-host mode the in-module `__new_RangeError` constructor is emitted
 * (also a function push) — same ordering requirement.
 */
function regexCapExhaustionThrow(ctx: CodegenContext): Instr[] {
  if (noJsHost(ctx)) emitWasiErrorConstructor(ctx, "RangeError", 1);
  addStringConstantGlobal(ctx, REGEX_CAP_MESSAGE);
  const ctorIdx = ensureLateImport(ctx, "__new_RangeError", [{ kind: "externref" }], [{ kind: "externref" }]);
  const tagIdx = ensureExnTag(ctx);
  const instrs: Instr[] = [...stringConstantExternrefInstrs(ctx, REGEX_CAP_MESSAGE)];
  if (ctorIdx !== undefined) instrs.push({ op: "call", funcIdx: ctorIdx });
  instrs.push({ op: "throw", tagIdx });
  return instrs;
}
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

// (#2091) Step cap is the single source of truth in regex/vm.ts — imported, no
// longer a drift-prone duplicate constant.
/** Initial backtrack-stack capacity (frames). Grows on demand. */
const INITIAL_STACK_CAP = 64;

/**
 * Emit `__regex_class_match(classTable, offset, c, negated) -> i32`.
 *
 * Binary-searches the sorted run-length range table for one class and returns
 * 1/0. Mirrors `classMatch` in vm.ts.
 */
function emitClassMatch(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_class_match");
  if (existing !== undefined) return existing;
  const i32Arr = regexI32ArrayType(ctx);
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };
  const typeIdx = addFuncType(ctx, [i32ArrRef, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set("__regex_class_match", funcIdx);

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

  pushDefinedFunc(ctx, funcIdx, {
    name: "__regex_class_match",
    typeIdx,
    locals: [
      { name: "mid", type: { kind: "i32" } },
      { name: "loIndex", type: { kind: "i32" } },
      { name: "hiIndex", type: { kind: "i32" } },
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
 *               startIdx: i32, caps: ref array<i32>,
 *               entryPc: i32, dir: i32) -> i32
 *
 * `caps` is caller-allocated, length `nSlots`, pre-filled with -1. On a match
 * (1 returned) the slots hold `[g0s,g0e,g1s,g1e,…]`; -1 = unset. This is one
 * anchored attempt at `startIdx`; the start-position scan lives in the
 * higher-level helpers (`__regex_search`).
 *
 * #1911: `entryPc` selects the (sub-)program, `dir` the scan direction (+1
 * forward, -1 for lookbehind sub-programs — consuming ops read the unit at
 * sp-1 and decrement). LOOKAROUND recursively calls this function on its
 * sub-program at the current position; the recursion is what makes
 * lookarounds atomic (no backtrack entries leak into the outer attempt).
 */
export function ensureRegexRun(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_run");
  if (existing !== undefined) return existing;

  // (#2091) Build the cap-exhaustion RangeError throw FIRST — it may register
  // the `__new_RangeError` ctor (host import in JS-host mode / in-module
  // function in standalone), which shifts function indices. Doing it before the
  // funcIdx captures below keeps those indices correct.
  const capThrow = regexCapExhaustionThrow(ctx);

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
      { kind: "i32" }, // entryPc (#1911 — 0 for the main program)
      { kind: "i32" }, // dir (#1911 — +1 forward, -1 lookbehind)
    ],
    [{ kind: "i32" }],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set("__regex_run", funcIdx);

  // (#3673 round 22) Backtrack-stack POOL: `__regex_search` invokes the VM
  // once per scan position, and every invocation allocated (and zeroed) a
  // fresh 64-slot frame array. A single module-global pool slot makes the
  // top-level run REUSE the previous run's (possibly grown) stack: checkout
  // nulls the slot (a NESTED lookaround run then simply allocates fresh —
  // reentrancy-safe), and both VM exits check the stack back in. Frames above
  // `top` may retain stale snapshot refs until overwritten — bounded by the
  // deepest stack seen, the standard engine trade.
  const stackPoolGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__re_stack_pool",
    type: { kind: "ref_null", typeIdx: frameArrIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: frameArrIdx }],
  });
  // (#3673 round 23) Shared zero-length caps placeholder: a group-free,
  // scratch-free program (nSlots == 2) provably never needs its caps
  // restored on backtrack — caps[0] is set once at entry and never changes
  // within a run, caps[1] is written only at SAVE 1 immediately before MATCH
  // returns; backrefs/PROGRESS both imply nSlots > 2. So frame pushes for
  // such programs skip the per-push snapshot allocation entirely and store
  // this dummy (the restore side is guarded by the same nSlots test).
  const capsDummyGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__re_caps_dummy",
    type: { kind: "ref", typeIdx: regexI32ArrayType(ctx) },
    mutable: false,
    init: [
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: regexI32ArrayType(ctx) },
    ],
  });

  // params
  const PROG = 0,
    CTAB = 1,
    NSLOTS = 2,
    SDATA = 3,
    SOFF = 4,
    SLEN = 5,
    START = 6,
    CAPS = 7,
    ENTRYPC = 8,
    DIR = 9;
  // locals
  const PC = 10; // i32 program counter (instruction index)
  const SP = 11; // i32 string position
  const STEPS = 12; // i32 step counter
  const STACK = 13; // ref $__ReFrameArr — backtrack stack
  const TOP = 14; // i32 stack top (count of live frames)
  const CAP_USED = 15; // i32 stack capacity
  const OP = 16; // i32 current opcode
  const A = 17; // i32 operand a
  const B = 18; // i32 operand b
  const FAILED = 19; // i32 fail flag
  const CH = 20; // i32 current code unit
  const FRAME = 21; // ref null $__ReFrame — popped/pushed frame
  const SNAP = 22; // ref array<i32> — caps snapshot
  const TMPI = 23; // i32 scratch
  const NEWSTACK = 24; // ref $__ReFrameArr — grown stack
  const GS = 25; // i32 backref group start (#1912)
  const GE = 26; // i32 backref group end (#1912)
  const BLEN = 27; // i32 backref length (#1912)
  const JJ = 28; // i32 backref compare cursor (#1912)
  const C1 = 29; // i32 backref left-hand unit (#1912)
  const INB = 30; // i32 direction-aware in-bounds flag (#1911)
  const BUDGET = 31; // i32 length-scaled step budget (#3549)

  // Helper: read prog[pc*3 + k]
  const readProg = (k: number): Instr[] => [
    { op: "local.get", index: PROG },
    { op: "local.get", index: PC },
    { op: "i32.const", value: 3 },
    { op: "i32.mul" },
    ...((k === 0 ? [] : [{ op: "i32.const", value: k }, { op: "i32.add" }]) satisfies Instr[]),
    { op: "array.get", typeIdx: i32Arr },
  ];

  // Helper: copy caps -> a fresh array<i32> of length NSLOTS (snapshot).
  // (#3673 round 23) Both halves are guarded on `nSlots > 2`: group-free,
  // scratch-free programs (whole-match slots only) need neither the per-push
  // snapshot allocation nor the restore copy — see the dummy global above.
  const snapshotCaps = (intoLocal: number): Instr[] => [
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

  // Helper: restore CAPS <- snapshot SNAP (copy back). No-op when nSlots <= 2
  // (the snapshot was the dummy).
  const restoreCaps = (fromLocal: number): Instr[] => [
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

  // The dispatch switch over OP. We emit an if/else chain (op === k) … .
  // Each arm sets PC/SP/CAPS or FAILED. MATCH returns 1 directly.
  const dispatch: Instr[] = [
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
              { op: "i32.const", value: ReOp.CPCLASS },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: cpClassArm(),
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
                                            else: [
                                              { op: "local.get", index: OP },
                                              { op: "i32.const", value: ReOp.LOOKAROUND },
                                              { op: "i32.eq" },
                                              {
                                                op: "if",
                                                blockType: { kind: "empty" },
                                                then: lookaroundArm(),
                                                else: [
                                                  { op: "local.get", index: OP },
                                                  { op: "i32.const", value: ReOp.PROGRESS },
                                                  { op: "i32.eq" },
                                                  {
                                                    op: "if",
                                                    blockType: { kind: "empty" },
                                                    then: progressArm(),
                                                    else: [
                                                      { op: "local.get", index: OP },
                                                      { op: "i32.const", value: ReOp.CLEAR },
                                                      { op: "i32.eq" },
                                                      {
                                                        op: "if",
                                                        blockType: { kind: "empty" },
                                                        then: clearArm(),
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

  function anyArm(): Instr[] {
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

  function classArm(): Instr[] {
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

  function cpClassArm(): Instr[] {
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

  function advance1(): Instr[] {
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

  function splitArm(): Instr[] {
    // push frame {pc:b, sp, caps:snapshot}; pc = a
    return [
      ...growStackIfFull(),
      ...snapshotCaps(SNAP),
      ...frameStackPushInstrs({
        frameTypeIdx: frameIdx,
        frameArrTypeIdx: frameArrIdx,
        stackLocal: STACK,
        topLocal: TOP,
        frameLocal: FRAME,
        pcValueLocal: B,
        spLocal: SP,
        snapLocal: SNAP,
      }),
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

  function progressArm(): Instr[] {
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

  function clearArm(): Instr[] {
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
      eol ? { op: "local.get", index: SLEN } : { op: "i32.const", value: 0 },
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
  function lookaroundArm(): Instr[] {
    return [
      ...snapshotCaps(SNAP),
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
          { op: "if", blockType: { kind: "empty" }, then: restoreCaps(SNAP) },
          { op: "local.get", index: PC },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: PC },
        ],
        else: [...restoreCaps(SNAP), { op: "i32.const", value: 1 }, { op: "local.set", index: FAILED }],
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
        { op: "if", blockType: { kind: "empty" }, then: capThrow },
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
      { name: "inb", type: { kind: "i32" } },
      { name: "budget", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
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
  // (#4439) FIRST — before `ensureRegexRun` and before any funcIdx capture, per
  // the `regexCapExhaustionThrow` ordering contract.
  //
  // HOST-LANE GATE, and it is load-bearing rather than an optimisation: a
  // poisoned value can only be produced by `__regex_compile_dynamic_simple`,
  // which is part of the STANDALONE regexp backend (host-side a dynamic RegExp
  // goes to the host bridge). Building the throw unconditionally would call
  // `ensureLateImport("__new_TypeError")`, which host-side registers a HOST
  // IMPORT — adding one import to every gc/host module that uses a RegExp and
  // shifting its function indices. That breaks the gc/host byte-identity this
  // change is required to preserve, for a guard that can never fire there.
  const poisonThrow = noJsHost(ctx) ? regexUnsupportedPatternThrow(ctx) : null;
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
  const funcIdx = mintDefinedFunc(ctx);
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
  const PC = 10; // (#3673 round 20) anchored-detection scan cursor
  const LEADCH = 11; // (#3673 round 29) leading literal code unit, -1 when none
  const ALT_POS = 12,
    ALT_INDEX = 13,
    ALT_MATCH = 14,
    ALT_BODY_LEN = 15;
  const indexedLiteralAlt = buildIndexedAnchoredLiteralAltSearch(i32Arr, strDataIdx);
  const body: Instr[] = [
    // (#4439) POISON GUARD — must precede every read of `prog` / `caps`.
    // `nSlots == 0` is unrepresentable for a compiled program (group 0 alone
    // makes it ≥ 2), so it means `__regex_compile_dynamic_simple` deferred an
    // out-of-subset pattern to here. Throw the catchable TypeError now, before
    // the VM can index a zero-length program or capture array — that OOB trap
    // is uncatchable and is exactly what the deferral must not resurrect.
    ...(poisonThrow === null
      ? []
      : ([
          { op: "local.get", index: NSLOTS },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: poisonThrow },
        ] satisfies Instr[])),
    ...indexedLiteralAlt.body,
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
            { op: "i32.const", value: 5 }, // ReOp.SAVE
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
        { op: "i32.const", value: 7 }, // ReOp.BOL
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
        { op: "i32.const", value: 0 }, // ReOp.CHAR
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
            { op: "local.get", index: LEADCH },
            { op: "i32.const", value: 0 },
            { op: "i32.ge_s" },
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

  pushDefinedFunc(ctx, funcIdx, {
    name: "__regex_search",
    typeIdx,
    locals: [
      { name: "i", type: { kind: "i32" } },
      { name: "pc", type: { kind: "i32" } }, // (#3673 round 20)
      { name: "leadch", type: { kind: "i32" } }, // (#3673 round 29)
      { name: "altPos", type: { kind: "i32" } },
      { name: "altIndex", type: { kind: "i32" } },
      { name: "altMatch", type: { kind: "i32" } },
      { name: "altBodyLen", type: { kind: "i32" } },
      ...indexedLiteralAlt.locals,
    ],
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
  const getSubIdx = ensureRegexGetSubstitution(ctx);
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

  const i32ArrType = regexI32ArrayType(ctx);
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
      { kind: "i32" }, // nScratch (#1959 — PROGRESS guard slots)
      { kind: "ref", typeIdx: i32ArrType }, // namesTable (#2588 — $<name> map)
    ],
    [strRef],
  );
  const funcIdx = mintDefinedFunc(ctx);
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
    GLOBAL = 8,
    NSCRATCH = 9,
    NAMES = 10; // #2588 names table
  // locals
  const NSLOTS = 11; // 2 * nGroups + nScratch
  const CAPS = 12; // ref array<i32> capture slots
  const POS = 13; // current search start
  const LASTEND = 14; // end of last replaced match (start of next kept slice)
  const RESULT = 15; // ref $NativeString accumulator
  const MSTART = 16;
  const MEND = 17;

  const body: Instr[] = [
    // nSlots = 2 * nGroups + nScratch (#1959 scratch slots ride in caps)
    { op: "local.get", index: NGROUPS },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.get", index: NSCRATCH },
    { op: "i32.add" },
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
            // result = concat(concat(result, substring(subj, lastEnd, mstart)),
            //                 GetSubstitution(...)) — §22.2.6.11 (#1913): the
            // replacement is expanded against the populated caps each match,
            // so $&/$`/$'/$n/$$ work and plain text passes through unchanged.
            { op: "local.get", index: RESULT },
            { op: "local.get", index: SUBJ },
            { op: "local.get", index: LASTEND },
            { op: "local.get", index: MSTART },
            { op: "call", funcIdx: substringIdx },
            { op: "call", funcIdx: concatIdx },
            { op: "local.get", index: SUBJ },
            { op: "local.get", index: SLEN },
            { op: "local.get", index: NGROUPS },
            { op: "local.get", index: CAPS },
            { op: "local.get", index: REPL },
            { op: "local.get", index: NAMES }, // #2588 names table
            { op: "call", funcIdx: getSubIdx },
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
  pushDefinedFunc(ctx, funcIdx, fn);
  return funcIdx;
}

/** Struct name for the match-result vec subtype (#1914). */
export const REGEXP_MATCH_VEC_STRUCT = "__regexp_match_vec";

/** Field indices of `$__regexp_match_vec` (base vec prefix + result fields). */
export const MATCH_VEC_FIELD_INDEX = 2;
export const MATCH_VEC_FIELD_INPUT = 3;
// #2588 — the named-groups result object (`m.groups`), `null` (≙ `undefined`)
// when the pattern has no named captures.
export const MATCH_VEC_FIELD_GROUPS = 4;
// #2589 — the `d`-flag match-indices array (`m.indices`), `null` (≙
// `undefined`) when the pattern lacks the `d` flag.
export const MATCH_VEC_FIELD_INDICES = 5;

/**
 * Ensure the `$__regexp_match_vec` struct type (#1914) — the match-result
 * shape for standalone `exec`/`match`.
 *
 * A WasmGC **subtype** of the nullable-native-string vec (`__vec_ref_<anyStr>`,
 * fields `{length, data}`), extended with the spec result fields of
 * §22.2.7.2 RegExpBuiltinExec ("index" = match start, "input" = the subject
 * string). Subtyping (not a sibling struct) is load-bearing: every existing
 * vec consumer (element access, `.length`, iteration) keeps working on the
 * result via subsumption, and only `.index`/`.input` property reads need the
 * subtype's extra fields. Mirrors the `__template_vec_externref` precedent in
 * registry/types.ts (the base vec is flipped to a non-final root on demand).
 */
export function ensureRegexMatchVecType(ctx: CodegenContext): number {
  const existing = ctx.structMap.get(REGEXP_MATCH_VEC_STRUCT);
  if (existing !== undefined) return existing;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const nstrElemKey = `ref_${anyStrTypeIdx}`;
  const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
  const nstrArrTypeIdx = getOrRegisterArrayType(ctx, nstrElemKey, nstrElemType);
  const baseVecTypeIdx = getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);

  // The base vec must be a non-final root for the subtype to validate.
  const baseVecDef = ctx.mod.types[baseVecTypeIdx];
  if (baseVecDef && baseVecDef.kind === "struct" && baseVecDef.superTypeIdx === undefined) {
    baseVecDef.superTypeIdx = -1;
  }

  const typeIdx = ctx.mod.types.length;
  // Field mutability of the inherited prefix must match the supertype exactly
  // (mutable fields are invariant under WasmGC subtyping).
  const fields = [
    { name: "length", type: { kind: "i32" } as ValType, mutable: true },
    { name: "data", type: { kind: "ref", typeIdx: nstrArrTypeIdx } as ValType, mutable: true },
    { name: "index", type: { kind: "i32" } as ValType, mutable: false },
    { name: "input", type: { kind: "ref", typeIdx: anyStrTypeIdx } as ValType, mutable: false },
    // #2588 — named-groups result object; `externref` ($Object), null when the
    // pattern has no `(?<name>…)` groups (spec: `groups` is `undefined`). Stored
    // as externref so `m.groups.<name>` reads flow through the standalone
    // open-object (externref) property path with no extra conversion.
    { name: "groups", type: { kind: "externref" } as ValType, mutable: false },
    // #2589 — `d`-flag match-indices array; `externref` ($ObjVec), null when the
    // pattern lacks the `d` flag (spec: no `indices` property at all, surfaced
    // as `undefined`). Stored as externref so `m.indices[i][j]` are native
    // $ObjVec index reads.
    { name: "indices", type: { kind: "externref" } as ValType, mutable: false },
  ];
  ctx.mod.types.push({
    kind: "struct",
    name: REGEXP_MATCH_VEC_STRUCT,
    superTypeIdx: baseVecTypeIdx,
    fields,
  });
  ctx.structMap.set(REGEXP_MATCH_VEC_STRUCT, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, REGEXP_MATCH_VEC_STRUCT);
  ctx.structFields.set(REGEXP_MATCH_VEC_STRUCT, fields);
  return typeIdx;
}

/**
 * Emit `__regex_capture_array(nGroups, subject, caps) -> ref $__regexp_match_vec`
 * (#1539 Phase 2b, result shape per #1914).
 *
 * Materializes capture slots from a populated caps array as a native string
 * vec: element 0 is the full match, element N is capture N, and unmatched
 * captures are null `(ref null $AnyString)`, which the standalone compiler
 * already treats as `undefined` for native-string values. The returned struct
 * is the match-vec subtype carrying `index` (= caps[0], the match start) and
 * `input` (the flattened subject) per §22.2.7.2 RegExpBuiltinExec.
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
  const nstrVecTypeIdx = ensureRegexMatchVecType(ctx);
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
      { kind: "externref" }, // groups object (#2588) — null when no named groups
      { kind: "externref" }, // indices array (#2589) — null when no `d` flag
    ],
    [nstrVecRef],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set("__regex_capture_array", funcIdx);

  // params
  const NGROUPS = 0,
    SUBJ = 1,
    CAPS = 2,
    GROUPS = 3, // #2588
    INDICES = 4; // #2589
  // locals
  const RARR = 5;
  const I = 6;
  const CSTART = 7;
  const CEND = 8;

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
              then: [{ op: "ref.null", typeIdx: anyStrTypeIdx }],
              else: [
                { op: "local.get", index: SUBJ },
                { op: "ref.cast", typeIdx: strTypeIdx },
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
    // struct.new $__regexp_match_vec(length=nGroups, data=RARR,
    //                                index=caps[0], input=subject,
    //                                groups=GROUPS, indices=INDICES)
    { op: "local.get", index: NGROUPS },
    { op: "local.get", index: RARR },
    { op: "ref.as_non_null" },
    { op: "local.get", index: CAPS },
    { op: "i32.const", value: 0 },
    { op: "array.get", typeIdx: i32Arr },
    { op: "local.get", index: SUBJ },
    { op: "local.get", index: GROUPS }, // #2588
    { op: "local.get", index: INDICES }, // #2589
    { op: "struct.new", typeIdx: nstrVecTypeIdx },
  ];

  pushDefinedFunc(ctx, funcIdx, {
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
 * subject, lim) -> ref $vec_nstr` (#1913, full §22.2.6.14 semantics).
 *
 * Implements the SplitMatch walk: split points where the separator matches,
 * capture values (incl. unmatched → undefined elements) interleaved after
 * each split slice, every append capped at `lim` (ToUint32 of the limit
 * argument; compare unsigned so the spec default 2^32-1 is just -1), and the
 * empty-separator rule — a match whose END equals the last split point makes
 * no split and the scan resumes one unit further (this also covers the
 * empty-pattern "split into chars" behaviour without looping forever).
 * Empty subject: a separator match on "" yields `[]`, otherwise `[subject]`.
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
      { kind: "i32" }, // lim (u32; -1 = no limit)
      { kind: "i32" }, // nScratch (#1959 — PROGRESS guard slots)
    ],
    [nstrVecRef],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set("__regex_split", funcIdx);

  // params
  const PROG = 0,
    CTAB = 1,
    NGROUPS = 2,
    SDATA = 3,
    SOFF = 4,
    SLEN = 5,
    SUBJ = 6,
    LIM = 7,
    NSCRATCH = 8;
  // locals
  const NSLOTS = 9;
  const CAPS = 10;
  const P = 11; // last split point (spec p)
  const Q = 12; // scan cursor (spec q)
  const RARR = 13;
  const RLEN = 14;
  const RCAP = 15;
  const NEWARR = 16;
  const PART = 17;
  const MSTART = 18;
  const MEND = 19;
  const GI = 20; // capture interleave index
  const CS = 21;
  const CE = 22;

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
    },
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

  /** Return the vec built so far. */
  const returnVec = (): Instr[] => [
    { op: "local.get", index: RLEN },
    { op: "local.get", index: RARR },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: nstrVecTypeIdx },
    { op: "return" },
  ];

  /** appendPart + return-if-limit-reached (unsigned compare; lim=-1 ≈ ∞). */
  const appendCapped = (): Instr[] => [
    ...appendPart(),
    { op: "local.get", index: RLEN },
    { op: "local.get", index: LIM },
    { op: "i32.ge_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: returnVec(),
    },
  ];

  const callSearchAt = (posLocal: number): Instr[] => [
    { op: "local.get", index: PROG },
    { op: "local.get", index: CTAB },
    { op: "local.get", index: NSLOTS },
    { op: "local.get", index: SDATA },
    { op: "local.get", index: SOFF },
    { op: "local.get", index: SLEN },
    { op: "local.get", index: posLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: CAPS },
    { op: "call", funcIdx: searchIdx },
  ];

  const body: Instr[] = [
    // nSlots = 2 * nGroups + nScratch; caps = array.new_default(nSlots) (#1959)
    { op: "local.get", index: NGROUPS },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.get", index: NSCRATCH },
    { op: "i32.add" },
    { op: "local.set", index: NSLOTS },
    { op: "local.get", index: NSLOTS },
    { op: "array.new_default", typeIdx: i32Arr },
    { op: "local.set", index: CAPS },
    // result array starts at cap 8.
    { op: "i32.const", value: 8 },
    { op: "array.new_default", typeIdx: nstrArrTypeIdx },
    { op: "local.set", index: RARR },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: RLEN },
    { op: "i32.const", value: 8 },
    { op: "local.set", index: RCAP },
    // lim == 0 → []
    { op: "local.get", index: LIM },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: returnVec(),
    },
    // Empty subject (§22.2.6.14 step 14): separator matches "" → [], else [S].
    { op: "local.get", index: SLEN },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: P },
        ...callSearchAt(P),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: returnVec(),
          else: [{ op: "local.get", index: SUBJ }, { op: "local.set", index: PART }, ...appendPart(), ...returnVec()],
        },
      ],
    },
    // p = 0; q = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: P },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: Q },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if q >= slen: break
            { op: "local.get", index: Q },
            { op: "local.get", index: SLEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // if !search(q): break
            ...callSearchAt(Q),
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
            // §22.2.5.2: the SplitMatch loop only tests positions q < size, so a
            // separator match that STARTS at the end of the subject (a zero-width
            // assertion like `/$/`, `/(?=$)/`, or `/\b/` at the end) is never
            // seen — the loop exits first. Our forward `search` from q < size CAN
            // land such a match at mstart == slen; treat it as no-match and stop
            // so `"x".split(/$/)` → ["x"] (not ["x", ""]). A non-end match starts
            // at mstart < slen, so this never fires for it.
            { op: "local.get", index: MSTART },
            { op: "local.get", index: SLEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // Spec step 19.c.ii: e == p → no split; resume one unit further.
            { op: "local.get", index: MEND },
            { op: "local.get", index: P },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: MSTART },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: Q },
              ],
              else: [
                // Append S[p, mstart); cap at lim.
                { op: "local.get", index: SUBJ },
                { op: "local.get", index: P },
                { op: "local.get", index: MSTART },
                { op: "call", funcIdx: substringIdx },
                { op: "local.set", index: PART },
                ...appendCapped(),
                // Interleave captures 1..nGroups-1 (unmatched → undefined).
                { op: "i32.const", value: 1 },
                { op: "local.set", index: GI },
                {
                  op: "block",
                  blockType: { kind: "empty" },
                  body: [
                    {
                      op: "loop",
                      blockType: { kind: "empty" },
                      body: [
                        { op: "local.get", index: GI },
                        { op: "local.get", index: NGROUPS },
                        { op: "i32.ge_s" },
                        { op: "br_if", depth: 1 },
                        // cs = caps[2*gi]; ce = caps[2*gi+1]
                        { op: "local.get", index: CAPS },
                        { op: "local.get", index: GI },
                        { op: "i32.const", value: 2 },
                        { op: "i32.mul" },
                        { op: "array.get", typeIdx: i32Arr },
                        { op: "local.set", index: CS },
                        { op: "local.get", index: CAPS },
                        { op: "local.get", index: GI },
                        { op: "i32.const", value: 2 },
                        { op: "i32.mul" },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "array.get", typeIdx: i32Arr },
                        { op: "local.set", index: CE },
                        // part = cs < 0 ? undefined : substring(subject, cs, ce)
                        { op: "local.get", index: CS },
                        { op: "i32.const", value: 0 },
                        { op: "i32.lt_s" },
                        {
                          op: "if",
                          blockType: { kind: "val", type: nstrElemType },
                          then: [{ op: "ref.null", typeIdx: anyStrTypeIdx }],
                          else: [
                            { op: "local.get", index: SUBJ },
                            { op: "local.get", index: CS },
                            { op: "local.get", index: CE },
                            { op: "call", funcIdx: substringIdx },
                          ],
                        },
                        { op: "local.set", index: PART },
                        ...appendCapped(),
                        { op: "local.get", index: GI },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: GI },
                        { op: "br", depth: 0 },
                      ],
                    },
                  ],
                },
                // p = mend; q = mend (empty match: q = mstart + 1)
                { op: "local.get", index: MEND },
                { op: "local.set", index: P },
                { op: "local.get", index: MEND },
                { op: "local.get", index: MSTART },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [{ op: "local.get", index: MSTART }, { op: "i32.const", value: 1 }, { op: "i32.add" }],
                  else: [{ op: "local.get", index: MEND }],
                },
                { op: "local.set", index: Q },
              ],
            },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // Append final tail: substring(subject, p, slen) (§22.2.6.14 steps 20-22).
    { op: "local.get", index: SUBJ },
    { op: "local.get", index: P },
    { op: "local.get", index: SLEN },
    { op: "call", funcIdx: substringIdx },
    { op: "local.set", index: PART },
    ...appendPart(),
    ...returnVec(),
    // unreachable fallthrough — keep the validator happy.
    { op: "local.get", index: RLEN },
    { op: "local.get", index: RARR },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: nstrVecTypeIdx },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__regex_split",
    typeIdx,
    locals: [
      { name: "nslots", type: { kind: "i32" } },
      { name: "caps", type: i32ArrRef },
      { name: "p", type: { kind: "i32" } },
      { name: "q", type: { kind: "i32" } },
      { name: "resultArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      { name: "resultLen", type: { kind: "i32" } },
      { name: "resultCap", type: { kind: "i32" } },
      { name: "newArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      { name: "part", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      { name: "mstart", type: { kind: "i32" } },
      { name: "mend", type: { kind: "i32" } },
      { name: "gi", type: { kind: "i32" } },
      { name: "cs", type: { kind: "i32" } },
      { name: "ce", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Emit `__regex_match_all(prog, classTable, nGroups, strData, strOff, strLen,
 * subject) -> ref null $__regexp_match_vec` (#1913).
 *
 * `String.prototype.match` with a GLOBAL regex (§22.2.6.8 step 6): collect
 * every match's [0] substring, advancing past empty matches per
 * AdvanceStringIndex; null when there were no matches. The result reuses the
 * match-vec subtype for type uniformity with the non-global path —
 * `index`/`input` carry the FIRST match (a documented narrow deviation: per
 * spec a global match result is a plain Array without those properties).
 */
export function ensureRegexMatchAll(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_match_all");
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
  const matchVecTypeIdx = ensureRegexMatchVecType(ctx);

  const substringIdx = ctx.nativeStrHelpers.get("__str_substring");
  if (substringIdx === undefined) {
    throw new Error("__regex_match_all requires __str_substring (#682 native string helpers)");
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
      { kind: "i32" }, // nScratch (#1959 — PROGRESS guard slots)
    ],
    [{ kind: "ref_null", typeIdx: matchVecTypeIdx }],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set("__regex_match_all", funcIdx);

  // params
  const PROG = 0,
    CTAB = 1,
    NGROUPS = 2,
    SDATA = 3,
    SOFF = 4,
    SLEN = 5,
    SUBJ = 6,
    NSCRATCH = 7;
  // locals
  const NSLOTS = 8;
  const CAPS = 9;
  const POS = 10;
  const RARR = 11;
  const RLEN = 12;
  const RCAP = 13;
  const NEWARR = 14;
  const MSTART = 15;
  const MEND = 16;
  const FIRSTMS = 17;

  const body: Instr[] = [
    // nSlots = 2 * nGroups + nScratch (#1959 scratch slots ride in caps)
    { op: "local.get", index: NGROUPS },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.get", index: NSCRATCH },
    { op: "i32.add" },
    { op: "local.set", index: NSLOTS },
    { op: "local.get", index: NSLOTS },
    { op: "array.new_default", typeIdx: i32Arr },
    { op: "local.set", index: CAPS },
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
    { op: "local.set", index: FIRSTMS },
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
            // if !search(pos): break
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
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 0 },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: MSTART },
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 1 },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: MEND },
            // first match start → the result's index field
            { op: "local.get", index: RLEN },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: MSTART },
                { op: "local.set", index: FIRSTMS },
              ],
            },
            // Grow result if needed; append substring(subject, mstart, mend).
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
            },
            { op: "local.get", index: RARR },
            { op: "local.get", index: RLEN },
            { op: "local.get", index: SUBJ },
            { op: "local.get", index: MSTART },
            { op: "local.get", index: MEND },
            { op: "call", funcIdx: substringIdx },
            { op: "array.set", typeIdx: nstrArrTypeIdx },
            { op: "local.get", index: RLEN },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: RLEN },
            // pos = mend + (empty match ? 1 : 0) — AdvanceStringIndex
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
    // 0 matches → null (the spec's @@match-global null result).
    { op: "local.get", index: RLEN },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: matchVecTypeIdx } },
      then: [{ op: "ref.null", typeIdx: matchVecTypeIdx }],
      else: [
        { op: "local.get", index: RLEN },
        { op: "local.get", index: RARR },
        { op: "ref.as_non_null" },
        { op: "local.get", index: FIRSTMS },
        { op: "local.get", index: SUBJ },
        // groups/indices (#2588/#2589): a global `String.prototype.match`
        // result is a flat array of matched strings, not a capture object, so
        // neither named-groups nor `d`-flag indices apply per-element here.
        // The `groups`/`indices` fields are externref → push null externref.
        { op: "ref.null.extern" },
        { op: "ref.null.extern" },
        { op: "struct.new", typeIdx: matchVecTypeIdx },
      ],
    },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__regex_match_all",
    typeIdx,
    locals: [
      { name: "nslots", type: { kind: "i32" } },
      { name: "caps", type: i32ArrRef },
      { name: "pos", type: { kind: "i32" } },
      { name: "resultArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      { name: "resultLen", type: { kind: "i32" } },
      { name: "resultCap", type: { kind: "i32" } },
      { name: "newArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      { name: "mstart", type: { kind: "i32" } },
      { name: "mend", type: { kind: "i32" } },
      { name: "firstms", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/** Element type of the matchAll outer vec: each element is a full match-vec
 *  (`$__regexp_match_vec` carrying [0]+captures, index, input) — nullable so a
 *  null can never appear (matchAll yields capture-arrays, never null) but the
 *  vec/array machinery uses the same ref_null element convention as the
 *  native-string vecs. (#2161 matchAll) */
const REGEXP_MATCHALL_VEC_KEY = "ref_matchall";

/** The matchAll outer-vec type idx (`$vec<$__regexp_match_vec>`). Consumers use
 *  it as the result ValType of `__regex_match_all_arrays`. (#2161) */
export function ensureRegexMatchAllVecType(ctx: CodegenContext): number {
  const elemType: ValType = { kind: "ref_null", typeIdx: ensureRegexMatchVecType(ctx) };
  return getOrRegisterVecType(ctx, REGEXP_MATCHALL_VEC_KEY, elemType);
}

/**
 * Emit `__regex_match_all_arrays(prog, classTable, nGroups, strData, strOff,
 * strLen, subject, nScratch) -> ref $vec<$__regexp_match_vec>` (#2161).
 *
 * `String.prototype.matchAll` (§22.2.6.9 / RegExpStringIterator §22.2.9.2) must
 * yield the **full match array** for every match — each with [0], capture
 * groups, `.index`, `.input` — i.e. a sequence of capture-ARRAYS, not the [0]
 * substrings that `__regex_match_all` (the global `match` path) collects.
 *
 * This clones the eager `__regex_match_all` AdvanceStringIndex loop verbatim,
 * but per match calls `__regex_capture_array(nGroups, subject, caps)` (the same
 * builder `exec`/non-global `match` use) and pushes that match-vec ref into a
 * growable vec-of-(match-vec-refs). The result is ALWAYS a non-null vec (empty
 * when there are no matches — matchAll returns an empty iterator, never null),
 * which the native-vec for-of / spread consumers (#2169) iterate directly,
 * yielding each indexable match array.
 */
export function ensureRegexMatchAllArrays(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_match_all_arrays");
  if (existing !== undefined) return existing;

  const searchIdx = ensureRegexSearch(ctx);
  const captureArrIdx = ensureRegexCaptureArray(ctx);
  const i32Arr = regexI32ArrayType(ctx);
  const strDataIdx = ctx.nativeStrDataTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataIdx };
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };

  const matchVecTypeIdx = ensureRegexMatchVecType(ctx);
  // Outer vec element = ref null $__regexp_match_vec; data array + vec struct.
  const elemType: ValType = { kind: "ref_null", typeIdx: matchVecTypeIdx };
  const elemArrTypeIdx = getOrRegisterArrayType(ctx, REGEXP_MATCHALL_VEC_KEY, elemType);
  const outerVecTypeIdx = getOrRegisterVecType(ctx, REGEXP_MATCHALL_VEC_KEY, elemType);
  const outerVecRef: ValType = { kind: "ref", typeIdx: outerVecTypeIdx };

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
      { kind: "i32" }, // nScratch (#1959 PROGRESS guard slots)
    ],
    [outerVecRef],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set("__regex_match_all_arrays", funcIdx);

  // params
  const PROG = 0,
    CTAB = 1,
    NGROUPS = 2,
    SDATA = 3,
    SOFF = 4,
    SLEN = 5,
    SUBJ = 6,
    NSCRATCH = 7;
  // locals
  const NSLOTS = 8;
  const CAPS = 9;
  const POS = 10;
  const RARR = 11; // ref-array of match-vecs
  const RLEN = 12;
  const RCAP = 13;
  const NEWARR = 14;
  const MSTART = 15;
  const MEND = 16;

  const body: Instr[] = [
    // nSlots = 2 * nGroups + nScratch (caps carries the scratch slots).
    { op: "local.get", index: NGROUPS },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.get", index: NSCRATCH },
    { op: "i32.add" },
    { op: "local.set", index: NSLOTS },
    { op: "local.get", index: NSLOTS },
    { op: "array.new_default", typeIdx: i32Arr },
    { op: "local.set", index: CAPS },
    { op: "i32.const", value: 4 },
    { op: "array.new_default", typeIdx: elemArrTypeIdx },
    { op: "local.set", index: RARR },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: RLEN },
    { op: "i32.const", value: 4 },
    { op: "local.set", index: RCAP },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: POS },
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
            // if !search(pos): break
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
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 0 },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: MSTART },
            { op: "local.get", index: CAPS },
            { op: "i32.const", value: 1 },
            { op: "array.get", typeIdx: i32Arr },
            { op: "local.set", index: MEND },
            // Grow ref-array if needed.
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
                { op: "array.new_default", typeIdx: elemArrTypeIdx },
                { op: "local.set", index: NEWARR },
                { op: "local.get", index: NEWARR },
                { op: "i32.const", value: 0 },
                { op: "local.get", index: RARR },
                { op: "i32.const", value: 0 },
                { op: "local.get", index: RLEN },
                { op: "array.copy", dstTypeIdx: elemArrTypeIdx, srcTypeIdx: elemArrTypeIdx },
                { op: "local.get", index: NEWARR },
                { op: "local.set", index: RARR },
              ],
            },
            // result[rlen] = __regex_capture_array(nGroups, subject, caps, null, null)
            // #2588/#2589 — per-matchAll-element groups/indices are a follow-up
            // (the parser map isn't threaded into this eager walk yet); pass null
            // so each element keeps its existing capture-array shape.
            { op: "local.get", index: RARR },
            { op: "local.get", index: RLEN },
            { op: "local.get", index: NGROUPS },
            { op: "local.get", index: SUBJ },
            { op: "local.get", index: CAPS },
            { op: "ref.null.extern" },
            { op: "ref.null.extern" },
            { op: "call", funcIdx: captureArrIdx },
            { op: "array.set", typeIdx: elemArrTypeIdx },
            { op: "local.get", index: RLEN },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: RLEN },
            // pos = mend + (empty match ? 1 : 0) — AdvanceStringIndex
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
    // struct.new $vec<$matchVec>(length=rlen, data=RARR) — always non-null.
    { op: "local.get", index: RLEN },
    { op: "local.get", index: RARR },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: outerVecTypeIdx },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__regex_match_all_arrays",
    typeIdx,
    locals: [
      { name: "nslots", type: { kind: "i32" } },
      { name: "caps", type: i32ArrRef },
      { name: "pos", type: { kind: "i32" } },
      { name: "resultArr", type: { kind: "ref_null", typeIdx: elemArrTypeIdx } },
      { name: "resultLen", type: { kind: "i32" } },
      { name: "resultCap", type: { kind: "i32" } },
      { name: "newArr", type: { kind: "ref_null", typeIdx: elemArrTypeIdx } },
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

/**
 * Emit `__regex_get_substitution(subject, slen, nGroups, caps, repl)
 * -> ref $AnyString` (#1913).
 *
 * GetSubstitution (ECMA-262 §22.2.6.11): expand `$$`, `$&`, `` $` ``, `$'`,
 * and `$n`/`$nn` in the (flattened) replacement string against the populated
 * caps array. Out-of-range `$n` and `$<` (no named groups in the standalone
 * engine) pass through literally per spec. Unmatched captures expand to the
 * empty string. Builds the result with `__str_concat` over O(1)
 * `__str_substring` views.
 */
export function ensureRegexGetSubstitution(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_get_substitution");
  if (existing !== undefined) return existing;

  const i32Arr = regexI32ArrayType(ctx);
  const strDataIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };

  const substringIdxOpt = ctx.nativeStrHelpers.get("__str_substring");
  const concatIdxOpt = ctx.nativeStrHelpers.get("__str_concat");
  if (substringIdxOpt === undefined || concatIdxOpt === undefined) {
    throw new Error("__regex_get_substitution requires __str_substring + __str_concat (#682 native string helpers)");
  }
  // Non-optional bindings so hoisted helper fns below see narrowed numbers.
  const substringIdx: number = substringIdxOpt;
  const concatIdx: number = concatIdxOpt;

  const typeIdx = addFuncType(
    ctx,
    [
      strRef, // subject (flattened)
      { kind: "i32" }, // slen
      { kind: "i32" }, // nGroups (incl. group 0)
      i32ArrRef, // caps
      strRef, // repl (flattened)
      i32ArrRef, // namesTable (#2588) — [count, (idx,len,ch...)*]; empty ⇒ no named groups
    ],
    [strRef],
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set("__regex_get_substitution", funcIdx);

  // params
  const SUBJ = 0,
    SLEN = 1,
    NG = 2,
    CAPS = 3,
    REPL = 4,
    NAMES = 5; // #2588 names table
  // locals
  const RDATA = 6; // ref array<i16> — repl backing data
  const ROFF = 7;
  const RLEN = 8;
  const RESULT = 9; // ref $AnyString accumulator
  const I = 10; // scan cursor in repl
  const SEG = 11; // start of the pending literal segment
  const C = 12; // current code unit
  const D1 = 13; // unit after '$'
  const GRP = 14; // resolved capture index
  const CONSUME = 15; // chars consumed by a digit escape (0 = literal)
  const CS = 16; // capture start
  const CE = 17; // capture end
  // #2588 — `$<name>` resolution scratch
  const NAMEEND = 18; // index of the closing '>' in repl (-1 if none)
  const NLEN = 19; // length of the parsed name
  const TI = 20; // names-table cursor
  const TC = 21; // names-table entry count
  const TLEN = 22; // current table entry name length
  const TIDX = 23; // current table entry capture index
  const MATCHED = 24; // 1 when the current table entry name matches
  const K = 25; // inner char-compare loop cursor

  /** result = concat(result, substring(repl, SEG, <endInstrs>)) */
  const flush = (endInstrs: Instr[]): Instr[] => [
    { op: "local.get", index: RESULT },
    { op: "local.get", index: REPL },
    { op: "local.get", index: SEG },
    ...endInstrs,
    { op: "call", funcIdx: substringIdx },
    { op: "call", funcIdx: concatIdx },
    { op: "local.set", index: RESULT },
  ];

  /** result = concat(result, substring(subject, <startInstrs>, <endInstrs>)) */
  const appendSubject = (startInstrs: Instr[], endInstrs: Instr[]): Instr[] => [
    { op: "local.get", index: RESULT },
    { op: "local.get", index: SUBJ },
    ...startInstrs,
    ...endInstrs,
    { op: "call", funcIdx: substringIdx },
    { op: "call", funcIdx: concatIdx },
    { op: "local.set", index: RESULT },
  ];

  const capsAt = (idxInstrs: Instr[]): Instr[] => [
    { op: "local.get", index: CAPS },
    ...idxInstrs,
    { op: "array.get", typeIdx: i32Arr },
  ];

  /** i += n; seg = i */
  const advance = (n: number): Instr[] => [
    { op: "local.get", index: I },
    { op: "i32.const", value: n },
    { op: "i32.add" },
    { op: "local.tee", index: I },
    { op: "local.set", index: SEG },
  ];

  // The `$<d1>` dispatch — every arm ends with the cursor advanced past the
  // escape (or falls through to the literal `i += 1` below via CONSUME=0).
  const dollarDispatch: Instr[] = [
    // d1 == '$' → literal "$"
    { op: "local.get", index: D1 },
    { op: "i32.const", value: 0x24 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...flush([{ op: "local.get", index: I }]),
        // append the '$' itself: substring(repl, i, i+1)
        ...appendReplChar(),
        ...advance(2),
      ],
      else: [
        // d1 == '&' → matched substring
        { op: "local.get", index: D1 },
        { op: "i32.const", value: 0x26 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...flush([{ op: "local.get", index: I }]),
            ...appendSubject(capsAt([{ op: "i32.const", value: 0 }]), capsAt([{ op: "i32.const", value: 1 }])),
            ...advance(2),
          ],
          else: [
            // d1 == '`' → prefix S[0, matchStart)
            { op: "local.get", index: D1 },
            { op: "i32.const", value: 0x60 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...flush([{ op: "local.get", index: I }]),
                ...appendSubject([{ op: "i32.const", value: 0 }], capsAt([{ op: "i32.const", value: 0 }])),
                ...advance(2),
              ],
              else: [
                // d1 == "'" → suffix S[matchEnd, slen)
                { op: "local.get", index: D1 },
                { op: "i32.const", value: 0x27 },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    ...flush([{ op: "local.get", index: I }]),
                    ...appendSubject(capsAt([{ op: "i32.const", value: 1 }]), [{ op: "local.get", index: SLEN }]),
                    ...advance(2),
                  ],
                  else: digitArm(),
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  /** append repl[i..i+1] (the literal '$') */
  function appendReplChar(): Instr[] {
    return [
      { op: "local.get", index: RESULT },
      { op: "local.get", index: REPL },
      { op: "local.get", index: I },
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "call", funcIdx: substringIdx },
      { op: "call", funcIdx: concatIdx },
      { op: "local.set", index: RESULT },
    ];
  }

  /** `$n` / `$nn` — consume = 0 leaves the '$' literal (out-of-range per spec). */
  function digitArm(): Instr[] {
    const isDigit = (local: number): Instr[] => [
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x30 },
      { op: "i32.ge_s" },
      { op: "local.get", index: local },
      { op: "i32.const", value: 0x39 },
      { op: "i32.le_s" },
      { op: "i32.and" },
    ];
    return [
      { op: "i32.const", value: 0 },
      { op: "local.set", index: CONSUME },
      ...isDigit(D1),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // grp1 = d1 - '0'
          { op: "local.get", index: D1 },
          { op: "i32.const", value: 0x30 },
          { op: "i32.sub" },
          { op: "local.set", index: GRP },
          // Two-digit form: i+2 < rlen && isDigit(repl[i+2]) && 10*g1+d2 in [1, nGroups)
          { op: "local.get", index: I },
          { op: "i32.const", value: 2 },
          { op: "i32.add" },
          { op: "local.get", index: RLEN },
          { op: "i32.lt_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // c = repl[roff + i + 2]
              { op: "local.get", index: RDATA },
              { op: "local.get", index: ROFF },
              { op: "local.get", index: I },
              { op: "i32.add" },
              { op: "i32.const", value: 2 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataIdx },
              { op: "local.set", index: C },
              ...isDigit(C),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // candidate = 10*grp + (c - '0')
                  { op: "local.get", index: GRP },
                  { op: "i32.const", value: 10 },
                  { op: "i32.mul" },
                  { op: "local.get", index: C },
                  { op: "i32.const", value: 0x30 },
                  { op: "i32.sub" },
                  { op: "i32.add" },
                  { op: "local.set", index: C }, // reuse C as candidate
                  // valid: 1 <= candidate < nGroups
                  { op: "local.get", index: C },
                  { op: "i32.const", value: 1 },
                  { op: "i32.ge_s" },
                  { op: "local.get", index: C },
                  { op: "local.get", index: NG },
                  { op: "i32.lt_s" },
                  { op: "i32.and" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: C },
                      { op: "local.set", index: GRP },
                      { op: "i32.const", value: 3 },
                      { op: "local.set", index: CONSUME },
                    ],
                  },
                ],
              },
            ],
          },
          // One-digit fallback: 1 <= grp < nGroups
          { op: "local.get", index: CONSUME },
          { op: "i32.eqz" },
          { op: "local.get", index: GRP },
          { op: "i32.const", value: 1 },
          { op: "i32.ge_s" },
          { op: "i32.and" },
          { op: "local.get", index: GRP },
          { op: "local.get", index: NG },
          { op: "i32.lt_s" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: 2 },
              { op: "local.set", index: CONSUME },
            ],
          },
          // Expand when a valid group was resolved.
          { op: "local.get", index: CONSUME },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...flush([{ op: "local.get", index: I }]),
              // cs = caps[2*grp]; ce = caps[2*grp+1]
              ...capsAt([{ op: "local.get", index: GRP }, { op: "i32.const", value: 2 }, { op: "i32.mul" }]),
              { op: "local.set", index: CS },
              ...capsAt([
                { op: "local.get", index: GRP },
                { op: "i32.const", value: 2 },
                { op: "i32.mul" },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
              ]),
              { op: "local.set", index: CE },
              // Unmatched capture (cs < 0) → empty expansion.
              { op: "local.get", index: CS },
              { op: "i32.const", value: 0 },
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: appendSubject([{ op: "local.get", index: CS }], [{ op: "local.get", index: CE }]),
              },
              // i += consume; seg = i
              { op: "local.get", index: I },
              { op: "local.get", index: CONSUME },
              { op: "i32.add" },
              { op: "local.tee", index: I },
              { op: "local.set", index: SEG },
            ],
            else: [
              // Out-of-range $n is literal text — keep scanning from '$'+1.
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: I },
            ],
          },
        ],
        else: [
          // d1 == '<' → `$<name>` named-group substitution (#2588, §22.2.6.11).
          // The names table is `[count, (idx,len,ch...)*]`; count==0 means the
          // pattern has no named groups, so `$<…>` is literal (Annex B).
          { op: "local.get", index: D1 },
          { op: "i32.const", value: 0x3c },
          { op: "i32.eq" },
          { op: "local.get", index: NAMES },
          { op: "i32.const", value: 0 },
          { op: "array.get", typeIdx: i32Arr },
          { op: "i32.const", value: 0 },
          { op: "i32.gt_s" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: namedGroupArm(),
            else: [
              // Unknown '$x' (or `$<` with no named groups) → literal per spec.
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: I },
            ],
          },
        ],
      },
    ];
  }

  /**
   * `$<name>` substitution arm (#2588). Scans the replacement from `i+2` for the
   * closing `>`; if absent, `$<` is literal. Otherwise the parsed name is
   * linear-searched in the `NAMES` table (`[count, (idx,len,ch...)*]`); on a hit
   * the matched capture substring is appended (empty if the slot is unmatched or
   * the name is unknown — §22.2.6.11). The cursor advances past `>`.
   */
  function namedGroupArm(): Instr[] {
    return [
      // Flush pending literal up to the '$'.
      ...flush([{ op: "local.get", index: I }]),
      // nameEnd = indexOf('>', from = i+2)
      { op: "local.get", index: I },
      { op: "i32.const", value: 2 },
      { op: "i32.add" },
      { op: "local.set", index: NAMEEND },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if nameEnd >= rlen: not found → nameEnd = -1; break
              { op: "local.get", index: NAMEEND },
              { op: "local.get", index: RLEN },
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "i32.const", value: -1 },
                  { op: "local.set", index: NAMEEND },
                  { op: "br", depth: 2 },
                ],
              },
              // if rdata[roff + nameEnd] == '>': break (found)
              { op: "local.get", index: RDATA },
              { op: "local.get", index: ROFF },
              { op: "local.get", index: NAMEEND },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataIdx },
              { op: "i32.const", value: 0x3e },
              { op: "i32.eq" },
              { op: "br_if", depth: 1 },
              // nameEnd++
              { op: "local.get", index: NAMEEND },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: NAMEEND },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // No closing '>' → literal '$'; resume scan at i+1.
      { op: "local.get", index: NAMEEND },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // append the literal '$' (substring repl[i, i+1]) then advance i+=1.
          ...appendReplChar(),
          { op: "local.get", index: I },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.tee", index: I },
          { op: "local.set", index: SEG },
        ],
        else: [
          // nlen = nameEnd - (i+2)
          { op: "local.get", index: NAMEEND },
          { op: "local.get", index: I },
          { op: "i32.const", value: 2 },
          { op: "i32.add" },
          { op: "i32.sub" },
          { op: "local.set", index: NLEN },
          // Search the names table. tc = NAMES[0]; ti = 1; grp = -1.
          { op: "local.get", index: NAMES },
          { op: "i32.const", value: 0 },
          { op: "array.get", typeIdx: i32Arr },
          { op: "local.set", index: TC },
          { op: "i32.const", value: 1 },
          { op: "local.set", index: TI },
          { op: "i32.const", value: -1 },
          { op: "local.set", index: GRP },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // while tc-- > 0 (use TC as remaining counter)
                  { op: "local.get", index: TC },
                  { op: "i32.eqz" },
                  { op: "br_if", depth: 1 },
                  // tidx = NAMES[ti]; tlen = NAMES[ti+1]; name chars at ti+2..
                  { op: "local.get", index: NAMES },
                  { op: "local.get", index: TI },
                  { op: "array.get", typeIdx: i32Arr },
                  { op: "local.set", index: TIDX },
                  { op: "local.get", index: NAMES },
                  { op: "local.get", index: TI },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "array.get", typeIdx: i32Arr },
                  { op: "local.set", index: TLEN },
                  // if tlen == nlen: compare chars
                  { op: "local.get", index: TLEN },
                  { op: "local.get", index: NLEN },
                  { op: "i32.eq" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "i32.const", value: 1 },
                      { op: "local.set", index: MATCHED },
                      { op: "i32.const", value: 0 },
                      { op: "local.set", index: K },
                      {
                        op: "block",
                        blockType: { kind: "empty" },
                        body: [
                          {
                            op: "loop",
                            blockType: { kind: "empty" },
                            body: [
                              { op: "local.get", index: K },
                              { op: "local.get", index: NLEN },
                              { op: "i32.ge_s" },
                              { op: "br_if", depth: 1 },
                              // NAMES[ti+2+k] vs rdata[roff + i+2 + k]
                              { op: "local.get", index: NAMES },
                              { op: "local.get", index: TI },
                              { op: "i32.const", value: 2 },
                              { op: "i32.add" },
                              { op: "local.get", index: K },
                              { op: "i32.add" },
                              { op: "array.get", typeIdx: i32Arr },
                              { op: "local.get", index: RDATA },
                              { op: "local.get", index: ROFF },
                              { op: "local.get", index: I },
                              { op: "i32.const", value: 2 },
                              { op: "i32.add" },
                              { op: "local.get", index: K },
                              { op: "i32.add" },
                              { op: "i32.add" },
                              { op: "array.get_u", typeIdx: strDataIdx },
                              { op: "i32.ne" },
                              {
                                op: "if",
                                blockType: { kind: "empty" },
                                then: [
                                  { op: "i32.const", value: 0 },
                                  { op: "local.set", index: MATCHED },
                                  { op: "br", depth: 2 },
                                ],
                              },
                              { op: "local.get", index: K },
                              { op: "i32.const", value: 1 },
                              { op: "i32.add" },
                              { op: "local.set", index: K },
                              { op: "br", depth: 0 },
                            ],
                          },
                        ],
                      },
                      // if matched: grp = tidx; (break outer via tc=0)
                      { op: "local.get", index: MATCHED },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: TIDX },
                          { op: "local.set", index: GRP },
                          { op: "i32.const", value: 1 },
                          { op: "local.set", index: TC }, // becomes 0 after decrement below
                        ],
                      },
                    ],
                  },
                  // ti += 2 + tlen; tc -= 1
                  { op: "local.get", index: TI },
                  { op: "i32.const", value: 2 },
                  { op: "i32.add" },
                  { op: "local.get", index: TLEN },
                  { op: "i32.add" },
                  { op: "local.set", index: TI },
                  { op: "local.get", index: TC },
                  { op: "i32.const", value: 1 },
                  { op: "i32.sub" },
                  { op: "local.set", index: TC },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          // If grp >= 0 and caps[2*grp] >= 0: append subject[caps[2*grp], caps[2*grp+1]].
          { op: "local.get", index: GRP },
          { op: "i32.const", value: 0 },
          { op: "i32.ge_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // cs = caps[2*grp]; ce = caps[2*grp+1]
              ...capsAt([{ op: "local.get", index: GRP }, { op: "i32.const", value: 2 }, { op: "i32.mul" }]),
              { op: "local.set", index: CS },
              ...capsAt([
                { op: "local.get", index: GRP },
                { op: "i32.const", value: 2 },
                { op: "i32.mul" },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
              ]),
              { op: "local.set", index: CE },
              // if cs >= 0: append (unmatched named group → empty string).
              { op: "local.get", index: CS },
              { op: "i32.const", value: 0 },
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: appendSubject([{ op: "local.get", index: CS }], [{ op: "local.get", index: CE }]),
              },
            ],
          },
          // Advance past '>': i = nameEnd + 1; seg = i.
          { op: "local.get", index: NAMEEND },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.tee", index: I },
          { op: "local.set", index: SEG },
        ],
      },
    ];
  }

  const body: Instr[] = [
    // rdata/roff/rlen from the flattened repl ($NativeString view).
    { op: "local.get", index: REPL },
    { op: "ref.cast", typeIdx: strTypeIdx },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: RDATA },
    { op: "local.get", index: REPL },
    { op: "ref.cast", typeIdx: strTypeIdx },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: ROFF },
    { op: "local.get", index: REPL },
    { op: "ref.cast", typeIdx: strTypeIdx },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: RLEN },
    // result = ""; i = 0; seg = 0
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: strDataIdx },
    { op: "struct.new", typeIdx: strTypeIdx },
    { op: "local.set", index: RESULT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: SEG },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i >= rlen: break
            { op: "local.get", index: I },
            { op: "local.get", index: RLEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // c = rdata[roff + i]
            { op: "local.get", index: RDATA },
            { op: "local.get", index: ROFF },
            { op: "local.get", index: I },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataIdx },
            { op: "local.set", index: C },
            // '$' with at least one unit after it?
            { op: "local.get", index: C },
            { op: "i32.const", value: 0x24 },
            { op: "i32.eq" },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: RLEN },
            { op: "i32.lt_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // d1 = rdata[roff + i + 1]
                { op: "local.get", index: RDATA },
                { op: "local.get", index: ROFF },
                { op: "local.get", index: I },
                { op: "i32.add" },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "array.get_u", typeIdx: strDataIdx },
                { op: "local.set", index: D1 },
                ...dollarDispatch,
              ],
              else: [
                { op: "local.get", index: I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: I },
              ],
            },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // Flush the trailing literal segment and return.
    ...flush([{ op: "local.get", index: RLEN }]),
    { op: "local.get", index: RESULT },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__regex_get_substitution",
    typeIdx,
    locals: [
      { name: "rdata", type: { kind: "ref", typeIdx: strDataIdx } },
      { name: "roff", type: { kind: "i32" } },
      { name: "rlen", type: { kind: "i32" } },
      { name: "result", type: strRef },
      { name: "i", type: { kind: "i32" } },
      { name: "seg", type: { kind: "i32" } },
      { name: "c", type: { kind: "i32" } },
      { name: "d1", type: { kind: "i32" } },
      { name: "grp", type: { kind: "i32" } },
      { name: "consume", type: { kind: "i32" } },
      { name: "cs", type: { kind: "i32" } },
      { name: "ce", type: { kind: "i32" } },
      // #2588 — `$<name>` resolution scratch
      { name: "nameEnd", type: { kind: "i32" } },
      { name: "nlen", type: { kind: "i32" } },
      { name: "ti", type: { kind: "i32" } },
      { name: "tc", type: { kind: "i32" } },
      { name: "tlen", type: { kind: "i32" } },
      { name: "tidx", type: { kind: "i32" } },
      { name: "matched", type: { kind: "i32" } },
      { name: "k", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Emit `__regex_flags_str(flags: i32) -> ref $NativeString` (#1914).
 *
 * Builds the `RegExp.prototype.flags` string from the `$NativeRegExp` flags
 * bitfield per ECMA-262 §22.2.6.4: append one code unit per set flag in the
 * fixed spec order d, g, i, m, s, u, v, y. The 8-slot i16 buffer is the exact
 * maximum (one slot per possible flag); `len` counts only appended units.
 */
export function ensureRegexFlagsStr(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_flags_str");
  if (existing !== undefined) return existing;

  const strDataIdx = ctx.nativeStrDataTypeIdx; // array i16
  const strTypeIdx = ctx.nativeStrTypeIdx; // $NativeString
  const anyStrTypeIdx = ctx.anyStrTypeIdx;

  const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "ref", typeIdx: anyStrTypeIdx }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set("__regex_flags_str", funcIdx);

  const FLAGS = 0; // param
  const BUF = 1; // ref array<i16>
  const N = 2; // i32 — appended count

  // Spec getter order (§22.2.6.4): hasIndices, global, ignoreCase, multiline,
  // dotAll, unicode, unicodeSets, sticky. Bit values from regex/bytecode.ts.
  const SPEC_ORDER: Array<[bit: number, codeUnit: number]> = [
    [64 /* RE_FLAG_D */, 0x64], // d
    [1 /* RE_FLAG_G */, 0x67], // g
    [2 /* RE_FLAG_I */, 0x69], // i
    [4 /* RE_FLAG_M */, 0x6d], // m
    [8 /* RE_FLAG_S */, 0x73], // s
    [16 /* RE_FLAG_U */, 0x75], // u
    [128 /* RE_FLAG_V */, 0x76], // v
    [32 /* RE_FLAG_Y */, 0x79], // y
  ];

  const body: Instr[] = [
    // buf = array.new_default(8); n = 0
    { op: "i32.const", value: 8 },
    { op: "array.new_default", typeIdx: strDataIdx },
    { op: "local.set", index: BUF },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: N },
  ];
  for (const [bit, codeUnit] of SPEC_ORDER) {
    body.push(
      { op: "local.get", index: FLAGS },
      { op: "i32.const", value: bit },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: BUF },
          { op: "local.get", index: N },
          { op: "i32.const", value: codeUnit },
          { op: "array.set", typeIdx: strDataIdx },
          { op: "local.get", index: N },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: N },
        ],
      },
    );
  }
  // struct.new $NativeString(len=n, off=0, data=buf)
  body.push(
    { op: "local.get", index: N },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: BUF },
    { op: "struct.new", typeIdx: strTypeIdx },
  );

  pushDefinedFunc(ctx, funcIdx, {
    name: "__regex_flags_str",
    typeIdx,
    locals: [
      // Non-null ref local, set-before-get like __regex_replace's accumulator.
      { name: "buf", type: { kind: "ref", typeIdx: strDataIdx } },
      { name: "n", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}
