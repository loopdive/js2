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
 * into a flat `i32` bytecode program; this module registers the single generic
 * backtracking VM (`__regex_run`) that interprets it. The VM's body is built by
 * `src/runtime/wasmgc/values/regexp-vm-bodies.ts`, which takes module indices
 * instead of a `CodegenContext` so the Prepared IR path can bind the same
 * function (#7369); the reference VM in `regexp-compiler/reference/vm.ts` is the executable spec it
 * mirrors opcode-for-opcode. See the issue file's "Implementation Notes
 * (sd-1539)" for the why-bytecode-not-specialised-emission rationale.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import {
  buildRegExpFrameArrayType,
  buildRegExpFrameType,
  REGEXP_FRAME_ARRAY_NAME,
  REGEXP_FRAME_STRUCT_NAME,
} from "../runtime/wasmgc/values/regexp-carrier-layouts.js";
import { buildRegExpSearchBody } from "../runtime/wasmgc/values/regexp-search-body.js";
import { buildRegExpClassMatchBody, buildRegExpRunBody } from "../runtime/wasmgc/values/regexp-vm-bodies.js";
import type { CodegenContext } from "./context/types.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType, getOrRegisterArrayType, getOrRegisterVecType, registerStructType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import { wrapRegexSearchForHost } from "./helpers/host-regexp-search.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { buildIndexedAnchoredLiteralAltSearch } from "./regex-anchored-alt-index.js";
import { regexFrameReuseEnabled } from "./regex-scratch-pool.js";
import { ensureRegexLinearSafe, ensureRegexSearchLinear } from "./regex-runtime/linear-search.js";

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
  emitWasiErrorConstructor(ctx, "TypeError", 1);
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
  emitWasiErrorConstructor(ctx, "RangeError", 1);
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

/** i32 array type used for program, class table, and capture slots. */
export function regexI32ArrayType(ctx: CodegenContext): number {
  return getOrRegisterArrayType(ctx, "i32", { kind: "i32" });
}

/**
 * Ensure the `$__ReFrame { pc, sp, caps }` struct and its array type exist.
 * Returns `[frameTypeIdx, frameArrTypeIdx]`.
 */
export function ensureFrameTypes(ctx: CodegenContext): [number, number] {
  const i32ArrIdx = regexI32ArrayType(ctx);
  let frameIdx = ctx.structMap.get(REGEXP_FRAME_STRUCT_NAME);
  if (frameIdx === undefined) {
    const frame = buildRegExpFrameType(i32ArrIdx);
    frameIdx = registerStructType(ctx, frame.name, frame.fields);
  }
  let frameArrIdx = ctx.arrayTypeMap.get(REGEXP_FRAME_ARRAY_NAME);
  if (frameArrIdx === undefined) {
    frameArrIdx = ctx.mod.types.length;
    ctx.mod.types.push(buildRegExpFrameArrayType(frameIdx));
    ctx.arrayTypeMap.set(REGEXP_FRAME_ARRAY_NAME, frameArrIdx);
  }
  return [frameIdx, frameArrIdx];
}

/** Register `__regex_class_match(classTable, offset, c, negated) -> i32`. */
export function emitClassMatch(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_class_match");
  if (existing !== undefined) return existing;
  const i32Arr = regexI32ArrayType(ctx);
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32Arr };
  const typeIdx = addFuncType(ctx, [i32ArrRef, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set("__regex_class_match", funcIdx);
  const { locals, body } = buildRegExpClassMatchBody({ i32ArrayTypeIdx: i32Arr });
  pushDefinedFunc(ctx, funcIdx, { name: "__regex_class_match", typeIdx, locals, body, exported: false });
  return funcIdx;
}

/**
 * Register the backtracking VM `__regex_run` and its dependencies. Returns the
 * `__regex_run` function index; `buildRegExpRunBody` documents its contract.
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

  const { locals, body } = buildRegExpRunBody({
    i32ArrayTypeIdx: i32Arr,
    strDataTypeIdx: strDataIdx,
    frameTypeIdx: frameIdx,
    frameArrayTypeIdx: frameArrIdx,
    classMatchFuncIdx: classMatchIdx,
    runFuncIdx: funcIdx,
    stackPoolGlobalIdx,
    capsDummyGlobalIdx,
    reuseFrames: regexFrameReuseEnabled(),
    // (#2723) Host-free targets: a linear-safe program hands the search to the linear PikeVM.
    linearSafeFuncIdx: ensureRegexLinearSafe(ctx, { ensureFrameTypes, regexI32ArrayType, emitClassMatch }),
    stepCapThrow: capThrow,
  });
  pushDefinedFunc(ctx, funcIdx, { name: "__regex_run", typeIdx, locals, body, exported: false });
  return funcIdx;
}

/**
 * Register `__regex_search`, the start-position scan over `__regex_run`.
 * Returns the index callers must use; `buildRegExpSearchBody` documents its
 * contract.
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
  const poisonThrow = regexUnsupportedPatternThrow(ctx);
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
  const { locals, body } = buildRegExpSearchBody({
    i32ArrayTypeIdx: i32Arr,
    strDataTypeIdx: strDataIdx,
    runFuncIdx: runIdx,
    linearSearchFuncIdx: ensureRegexSearchLinear(ctx, { ensureFrameTypes, regexI32ArrayType, emitClassMatch }),
    poisonThrow,
    indexedLiteralAlt: buildIndexedAnchoredLiteralAltSearch(i32Arr, strDataIdx),
  });
  pushDefinedFunc(ctx, funcIdx, { name: "__regex_search", typeIdx, locals, body, exported: false });
  return wrapRegexSearchForHost(ctx, funcIdx, typeIdx, i32Arr); // (#6978) host engine when accelerated
}

/**
 * Emit `__regex_replace(prog, classTable, nGroups, strData, strOff, strLen,
 * subject, replacement, global, nScratch, names, startIdx, sticky, unicode)
 * -> (ref $NativeString, i32 finalLastIndex)` (#1539 Phase 2c).
 *
 * Implements `String.prototype.replace` / `replaceAll` for a backend-created
 * RegExp with a **literal** (non-`$`-pattern, non-function) replacement string
 * (ECMA-262 §22.1.3.19 / §22.2.6.11 with the `$`-substitution and function
 * replacer paths refused at the call site). Walks the subject with
 * `__regex_search`, accumulating `result = … + slice[lastEnd, matchStart) +
 * replacement` for each match and appending `slice[lastEnd, len)` at the end.
 * `global != 0` replaces every match; `startIdx` / `sticky` select the static
 * RegExp cursor mode used by `RegExp.prototype[@@replace]`. The helper returns
 * the final `RegExpBuiltinExec` lastIndex: the successful match end for one
 * sticky execution, or zero after the terminating global failure. Closed
 * string-receiver callers pass zero for the cursor arguments and discard that
 * second result, preserving their ordinary scan.
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
      { kind: "i32" }, // startIdx — current RegExp lastIndex for y operations
      { kind: "i32" }, // sticky bit
      { kind: "i32" }, // fullUnicode bit for AdvanceStringIndex
    ],
    [strRef, { kind: "i32" }],
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
    NAMES = 10,
    START = 11,
    STICKY = 12,
    UNICODE = 13;
  // locals
  const NSLOTS = 14; // 2 * nGroups + nScratch
  const CAPS = 15; // ref array<i32> capture slots
  const POS = 16; // current search start
  const LASTEND = 17; // end of last replaced match (start of next kept slice)
  const RESULT = 18; // ref $NativeString accumulator
  const MSTART = 19;
  const MEND = 20;

  // AdvanceStringIndex(S, mend, fullUnicode) for an empty match. Under u/v,
  // a lead+trail surrogate pair advances by two UTF-16 code units; lone halves
  // and non-Unicode patterns advance by one. Keep this inline: it is part of
  // the existing closed replacement helper rather than a second regex engine.
  const advanceEmptyMatch: Instr[] = [
    { op: "local.get", index: MEND },
    { op: "local.get", index: UNICODE },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: MEND },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.get", index: SLEN },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            // S[mend] is a high surrogate and S[mend + 1] is a low surrogate.
            { op: "local.get", index: SDATA },
            { op: "local.get", index: SOFF },
            { op: "local.get", index: MEND },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataIdx },
            { op: "i32.const", value: 0xd800 },
            { op: "i32.ge_s" },
            { op: "local.get", index: SDATA },
            { op: "local.get", index: SOFF },
            { op: "local.get", index: MEND },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataIdx },
            { op: "i32.const", value: 0xdbff },
            { op: "i32.le_s" },
            { op: "i32.and" },
            { op: "local.get", index: SDATA },
            { op: "local.get", index: SOFF },
            { op: "local.get", index: MEND },
            { op: "i32.add" },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataIdx },
            { op: "i32.const", value: 0xdc00 },
            { op: "i32.ge_s" },
            { op: "i32.and" },
            { op: "local.get", index: SDATA },
            { op: "local.get", index: SOFF },
            { op: "local.get", index: MEND },
            { op: "i32.add" },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataIdx },
            { op: "i32.const", value: 0xdfff },
            { op: "i32.le_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [{ op: "i32.const", value: 2 }],
              else: [{ op: "i32.const", value: 1 }],
            },
          ],
          else: [{ op: "i32.const", value: 1 }],
        },
      ],
      else: [{ op: "i32.const", value: 1 }],
    },
    { op: "i32.add" },
    { op: "local.set", index: POS },
  ];

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
    // result = "" (empty NativeString {len:0, off:0, data:[]}), pos =
    // startIdx, lastEnd = 0. Ordinary callers pass startIdx=0.
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: strDataIdx },
    { op: "struct.new", typeIdx: strTypeIdx },
    { op: "local.set", index: RESULT },
    { op: "local.get", index: START },
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
            // if !__regex_search(... pos, sticky ...): break
            { op: "local.get", index: PROG },
            { op: "local.get", index: CTAB },
            { op: "local.get", index: NSLOTS },
            { op: "local.get", index: SDATA },
            { op: "local.get", index: SOFF },
            { op: "local.get", index: SLEN },
            { op: "local.get", index: POS },
            { op: "local.get", index: STICKY },
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
            // AdvanceStringIndex after an empty match. A non-empty match begins
            // the next search at its end as before.
            { op: "local.get", index: MEND },
            { op: "local.get", index: MSTART },
            { op: "i32.gt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: MEND },
                { op: "local.set", index: POS },
              ],
              else: advanceEmptyMatch,
            },
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
    // The final global RegExpBuiltinExec is the terminating failure and sets
    // lastIndex to zero. A single non-global sticky execution instead leaves
    // the successful match end (or zero on failure) in lastEnd.
    { op: "local.get", index: GLOBAL },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [{ op: "local.get", index: LASTEND }],
    },
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
 * Ensure the ordinary native-string vector used by a global `@@match` result.
 *
 * A global match returns an Array of full-match strings, not a
 * `RegExpExecArray`. Keep this carrier separate from
 * `$__regexp_match_vec`, whose additional fields are only valid for the
 * single capture result produced by `exec` / non-global `match`.
 */
export function ensureRegexMatchFlatVecType(ctx: CodegenContext): number {
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const nstrElemKey = `ref_${anyStrTypeIdx}`;
  const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
  return getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);
}

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
  const baseVecTypeIdx = ensureRegexMatchFlatVecType(ctx);

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
 * subject, nScratch, sticky) -> ref null $__vec_ref_<AnyString>` (#1913).
 *
 * `String.prototype.match` with a GLOBAL regex (§22.2.6.8 step 6): collect
 * every match's [0] substring, advancing past empty matches per
 * AdvanceStringIndex; null when there were no matches. The result is the
 * ordinary native-string vec: §22.2.6.8 global matching returns a plain Array
 * without `index`, `input`, `groups`, or `indices` metadata.
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
  const flatVecTypeIdx = ensureRegexMatchFlatVecType(ctx);

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
      { kind: "i32" }, // sticky — anchor every search for a /gy/ walk
    ],
    [{ kind: "ref_null", typeIdx: flatVecTypeIdx }],
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
    NSCRATCH = 7,
    STICKY = 8;
  // locals
  const NSLOTS = 9;
  const CAPS = 10;
  const POS = 11;
  const RARR = 12;
  const RLEN = 13;
  const RCAP = 14;
  const NEWARR = 15;
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
    { op: "i32.const", value: 8 },
    { op: "array.new_default", typeIdx: nstrArrTypeIdx },
    { op: "local.set", index: RARR },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: RLEN },
    { op: "i32.const", value: 8 },
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
            { op: "local.get", index: STICKY },
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
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: flatVecTypeIdx } },
      then: [{ op: "ref.null", typeIdx: flatVecTypeIdx }],
      else: [
        { op: "local.get", index: RLEN },
        { op: "local.get", index: RARR },
        { op: "ref.as_non_null" },
        { op: "struct.new", typeIdx: flatVecTypeIdx },
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
  // dotAll, unicode, unicodeSets, sticky. Bit values from regexp-compiler/bytecode.ts.
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
