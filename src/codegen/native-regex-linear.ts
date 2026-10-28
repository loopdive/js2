// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2723 Slice A — the Wasm twin of `regex/linear.ts`: a linear PikeVM over the
 * standalone regex bytecode, taking over a search whose backtracking attempt
 * exhausted its step budget.
 *
 * Emitted helpers (standalone only — the host lane never calls them):
 *   __regex_linear_safe(prog) -> i32
 *       1 when every opcode is one the PikeVM executes (`isLinearSafe`).
 *   __regex_search_linear(prog, classTable, nSlots, strData, strOff, strLen,
 *                         startIdx, sticky, caps) -> i32
 *       `__regex_search`'s signature and contract: 1 with `caps` filled on the
 *       leftmost match at or after `startIdx` (≥ 0), else 0 (`searchLinear`).
 *   __regex_lin_add / __regex_lin_unit / __regex_lin_assert
 *       the epsilon closure, one consuming step, one zero-width assertion
 *       (`addThread`, `step`'s consumer test, `assertionHolds`).
 *
 * Threads reuse the backtracker's `$__ReFrame { pc, sp, caps }`: `pc` holds
 * the PikeVM state (see linear.ts for the `n + pc` pending-trail encoding),
 * `sp` is unused (every thread in a list sits at that list's position), and
 * `caps` is shared copy-on-write between forked threads.
 */
import type { Instr, LocalDef, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { emitClassMatch, ensureFrameTypes, regexI32ArrayType } from "./native-regex.js";
import { INSTR_WIDTH, ReOp } from "./regex/bytecode.js";
import {
  I32,
  Locals,
  add,
  andThen,
  anyOf,
  between,
  block,
  br,
  brIf,
  brk,
  c,
  call,
  cont,
  eq,
  eqz,
  ge,
  get,
  gt,
  if_,
  inc,
  loop,
  ne,
  or,
  resolveLabels,
  ret,
  sel,
  set,
  shrU,
  sub,
  whileLoop,
  and,
  type X,
} from "./regex-runtime/dsl.js";
import { addFuncType } from "./registry/types.js";

/** The opcodes `isLinearSafe` accepts, as a bitmask over `ReOp` values. */
const LINEAR_OP_MASK = [
  ReOp.CHAR,
  ReOp.CHARI,
  ReOp.ANY,
  ReOp.CLASS,
  ReOp.CPCLASS,
  ReOp.SPLIT,
  ReOp.JMP,
  ReOp.SAVE,
  ReOp.CLEAR,
  ReOp.BOL,
  ReOp.EOL,
  ReOp.WBOUND,
  ReOp.MATCH,
].reduce((mask, op) => mask | (1 << op), 0);

interface LinearTypes {
  ctx: CodegenContext;
  i32Arr: number;
  strData: number;
  frame: number;
  frameArr: number;
  classMatch: number;
}

const refOf = (typeIdx: number): ValType => ({ kind: "ref", typeIdx });
const aget = (typeIdx: number, arr: X, idx: X): X => [...arr, ...idx, { op: "array.get", typeIdx }];
const aset = (typeIdx: number, arr: X, idx: X, value: X): X => [...arr, ...idx, ...value, { op: "array.set", typeIdx }];
const alen = (arr: X): X => [...arr, { op: "array.len" }];
/** Code unit `strData[off + i]`. */
const unitAt = (T: LinearTypes, sdata: number, soff: number, i: X): X => [
  ...get(sdata),
  ...add(get(soff), i),
  { op: "array.get_u", typeIdx: T.strData },
];
const isLineTerminator = (ch: X): X => anyOf(eq(ch, c(0x0a)), eq(ch, c(0x0d)), eq(ch, c(0x2028)), eq(ch, c(0x2029)));
const isWordChar = (ch: X): X =>
  anyOf(between(ch, 0x30, 0x39), between(ch, 0x41, 0x5a), eq(ch, c(0x5f)), between(ch, 0x61, 0x7a));
/** Instruction count of `prog` (a local). */
const instrCount = (prog: number): X => [...alen(get(prog)), ...c(INSTR_WIDTH), { op: "i32.div_u" }];
const progField = (T: LinearTypes, prog: number, state: X, k: number): X =>
  aget(T.i32Arr, get(prog), add([...state, ...c(INSTR_WIDTH), { op: "i32.mul" }], c(k)));

function defineFunc(T: LinearTypes, funcIdx: number, name: string, params: ValType[], build: (L: Locals) => X): void {
  const L = new Locals(params.length);
  const body = resolveLabels(build(L));
  pushDefinedFunc(T.ctx, funcIdx, {
    name,
    typeIdx: addFuncType(T.ctx, params, [I32]),
    locals: L.defs,
    body,
    exported: false,
  });
}

/** `__regex_linear_safe(prog) -> i32`. */
function defineLinearSafe(T: LinearTypes, funcIdx: number): void {
  const PROG = 0;
  defineFunc(T, funcIdx, "__regex_linear_safe", [refOf(T.i32Arr)], (L) => {
    const I = L.add("i");
    const OP = L.add("op");
    const opSafe = andThen([...get(OP), ...c(32), { op: "i32.lt_u" }], and(shrU(c(LINEAR_OP_MASK), get(OP)), c(1)));
    return [
      ...set(I, c(0)),
      ...whileLoop(
        "scan",
        [...get(I), ...alen(get(PROG)), { op: "i32.lt_u" }],
        [
          ...set(OP, aget(T.i32Arr, get(PROG), get(I))),
          ...if_(eqz(opSafe), ret(c(0))),
          ...set(I, add(get(I), c(INSTR_WIDTH))),
        ],
      ),
      ...c(1),
    ];
  });
}

/**
 * `__regex_lin_assert(op, a, strData, strOff, strLen, sp) -> i32` — BOL / EOL /
 * WBOUND at `sp` (`assertionHolds`).
 */
function defineAssert(T: LinearTypes, funcIdx: number): void {
  const [OP, A, SDATA, SOFF, SLEN, SP] = [0, 1, 2, 3, 4, 5];
  const params = [I32, I32, refOf(T.strData), I32, I32, I32];
  defineFunc(T, funcIdx, "__regex_lin_assert", params, (L) => {
    const BEFORE = L.add("before");
    const AFTER = L.add("after");
    const prevIs = (pred: (ch: X) => X): X =>
      andThen(gt(get(SP), c(0)), pred(unitAt(T, SDATA, SOFF, sub(get(SP), c(1)))));
    const nextIs = (pred: (ch: X) => X): X =>
      andThen([...get(SP), ...get(SLEN), { op: "i32.lt_s" }], pred(unitAt(T, SDATA, SOFF, get(SP))));
    return [
      ...if_(eq(get(OP), c(ReOp.BOL)), ret(or(eqz(get(SP)), andThen(ne(get(A), c(0)), prevIs(isLineTerminator))))),
      ...if_(
        eq(get(OP), c(ReOp.EOL)),
        ret(or(eq(get(SP), get(SLEN)), andThen(ne(get(A), c(0)), nextIs(isLineTerminator)))),
      ),
      ...set(BEFORE, prevIs(isWordChar)),
      ...set(AFTER, nextIs(isWordChar)),
      // boundary = before != after; `\B` (a != 0) inverts it.
      ...ne(ne(get(BEFORE), get(AFTER)), ne(get(A), c(0))),
    ];
  });
}

/**
 * `__regex_lin_unit(classTable, strData, strOff, strLen, sp, op, a, b) -> i32`
 * — the code units a consumer at `sp < strLen` takes: 0 (no match), 1, or 2 (a
 * CPCLASS over a surrogate pair). Mirrors `unitMatches` / `forwardCodePoint`.
 */
function defineUnit(T: LinearTypes, funcIdx: number): void {
  const [CTAB, SDATA, SOFF, SLEN, SP, OP, A, B] = [0, 1, 2, 3, 4, 5, 6, 7];
  const params = [refOf(T.i32Arr), refOf(T.strData), I32, I32, I32, I32, I32, I32];
  defineFunc(T, funcIdx, "__regex_lin_unit", params, (L) => {
    const CH = L.add("ch");
    const NX = L.add("nx");
    const inClass = (cp: X): X => call(T.classMatch, get(CTAB), get(A), cp, get(B));
    const isLead = (u: X): X => between(u, 0xd800, 0xdbff);
    const isTrail = (u: X): X => between(u, 0xdc00, 0xdfff);
    const cpClass: X = [
      // A valid pair combines and consumes two units.
      ...if_(andThen(isLead(get(CH)), [...add(get(SP), c(1)), ...get(SLEN), { op: "i32.lt_s" }]), [
        ...set(NX, unitAt(T, SDATA, SOFF, add(get(SP), c(1)))),
        ...if_(
          isTrail(get(NX)),
          ret(
            sel(
              I32,
              inClass(
                add(c(0x10000 - (0xd800 << 10) - 0xdc00), add([...get(CH), ...c(10), { op: "i32.shl" }], get(NX))),
              ),
              c(2),
              c(0),
            ),
          ),
        ),
      ]),
      // The trail half of a pair is never re-read as a lone surrogate.
      ...if_(
        andThen(isTrail(get(CH)), andThen(gt(get(SP), c(0)), isLead(unitAt(T, SDATA, SOFF, sub(get(SP), c(1)))))),
        ret(c(0)),
      ),
      ...ret(inClass(get(CH))),
    ];
    return [
      ...set(CH, unitAt(T, SDATA, SOFF, get(SP))),
      ...if_(eq(get(OP), c(ReOp.CPCLASS)), cpClass),
      ...if_(eq(get(OP), c(ReOp.CHAR)), ret(eq(get(CH), get(A)))),
      ...if_(
        eq(get(OP), c(ReOp.CHARI)),
        ret(eq(sel(I32, between(get(CH), 0x41, 0x5a), add(get(CH), c(0x20)), get(CH)), get(A))),
      ),
      ...if_(eq(get(OP), c(ReOp.ANY)), ret(or(ne(get(A), c(0)), eqz(isLineTerminator(get(CH)))))),
      ...inClass(get(CH)),
    ];
  });
}

/**
 * `__regex_lin_add(prog, strData, strOff, strLen, seen, stamp, list, count,
 * stack, state, caps, sp) -> i32` — append the epsilon closure of `(state,
 * caps)` at `sp` to `list[count..]` in priority order; returns the new count
 * (`addThread`). `stack` is caller-owned scratch (capacity ≥ 4·n + 1).
 */
function defineAdd(T: LinearTypes, funcIdx: number, assertIdx: number): void {
  const [PROG, SDATA, SOFF, SLEN, SEEN, STAMP, LIST, COUNT, STACK, STATE, CAPS, SP] = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
  ];
  const params = [
    refOf(T.i32Arr),
    refOf(T.strData),
    I32,
    I32,
    refOf(T.i32Arr),
    I32,
    refOf(T.frameArr),
    I32,
    refOf(T.frameArr),
    I32,
    refOf(T.i32Arr),
    I32,
  ];
  defineFunc(T, funcIdx, "__regex_lin_add", params, (L) => {
    const TOP = L.add("top");
    const T_ = L.add("t", refOf(T.frame));
    const S = L.add("s");
    const OP = L.add("op");
    const A = L.add("a");
    const NEXT = L.add("next", refOf(T.i32Arr));
    const frameField = (k: number): X => [...get(T_), { op: "struct.get", typeIdx: T.frame, fieldIdx: k }];
    const push = (state: X, caps: X): X => [
      ...aset(T.frameArr, get(STACK), get(TOP), [...state, ...c(0), ...caps, { op: "struct.new", typeIdx: T.frame }]),
      ...inc(TOP),
    ];
    const emitThread: X = [...aset(T.frameArr, get(LIST), get(COUNT), get(T_)), ...inc(COUNT), ...cont("closure")];
    // SAVE writes caps[a] = sp, CLEAR resets caps[a..b] = -1, both on a copy.
    const copyCaps: X = [
      ...set(NEXT, [...alen(get(CAPS)), { op: "array.new_default", typeIdx: T.i32Arr }]),
      ...get(NEXT),
      ...c(0),
      ...get(CAPS),
      ...c(0),
      ...alen(get(CAPS)),
      { op: "array.copy", dstTypeIdx: T.i32Arr, srcTypeIdx: T.i32Arr },
    ];
    const writeCaps: X = sel(I32, eq(get(OP), c(ReOp.SAVE)), c(1), c(0));
    return [
      ...set(TOP, c(0)),
      ...push(get(STATE), get(CAPS)),
      ...whileLoop("closure", gt(get(TOP), c(0)), [
        ...set(TOP, sub(get(TOP), c(1))),
        ...set(T_, [...aget(T.frameArr, get(STACK), get(TOP)), { op: "ref.as_non_null" }]),
        ...set(S, frameField(0)),
        ...set(CAPS, frameField(2)),
        ...if_(eq(aget(T.i32Arr, get(SEEN), get(S)), get(STAMP)), cont("closure")),
        ...aset(T.i32Arr, get(SEEN), get(S), get(STAMP)),
        ...if_(ge(get(S), instrCount(PROG)), emitThread),
        ...set(OP, progField(T, PROG, get(S), 0)),
        ...set(A, progField(T, PROG, get(S), 1)),
        ...if_(eq(get(OP), c(ReOp.JMP)), [...push(get(A), get(CAPS)), ...cont("closure")]),
        ...if_(eq(get(OP), c(ReOp.SPLIT)), [
          ...push(progField(T, PROG, get(S), 2), get(CAPS)),
          ...push(get(A), get(CAPS)),
          ...cont("closure"),
        ]),
        ...if_(or(eq(get(OP), c(ReOp.SAVE)), eq(get(OP), c(ReOp.CLEAR))), [
          ...copyCaps,
          ...if_(writeCaps, aset(T.i32Arr, get(NEXT), get(A), get(SP)), [
            ...get(NEXT),
            ...get(A),
            ...c(-1),
            ...add(sub(progField(T, PROG, get(S), 2), get(A)), c(1)),
            { op: "array.fill", typeIdx: T.i32Arr },
          ]),
          ...push(add(get(S), c(1)), get(NEXT)),
          ...cont("closure"),
        ]),
        ...if_(anyOf(eq(get(OP), c(ReOp.BOL)), eq(get(OP), c(ReOp.EOL)), eq(get(OP), c(ReOp.WBOUND))), [
          ...if_(
            call(assertIdx, get(OP), get(A), get(SDATA), get(SOFF), get(SLEN), get(SP)),
            push(add(get(S), c(1)), get(CAPS)),
          ),
          ...cont("closure"),
        ]),
        ...emitThread,
      ]),
      ...get(COUNT),
    ];
  });
}

interface LinearCallees {
  add: number;
  unit: number;
}

/** `__regex_search_linear(...)` — the lockstep driver (`searchLinear`). */
function defineSearch(T: LinearTypes, funcIdx: number, fn: LinearCallees): void {
  const [PROG, CTAB, NSLOTS, SDATA, SOFF, SLEN, START, STICKY, CAPS] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const params = [refOf(T.i32Arr), refOf(T.i32Arr), I32, refOf(T.strData), I32, I32, I32, I32, refOf(T.i32Arr)];
  defineFunc(T, funcIdx, "__regex_search_linear", params, (L) => {
    const N = L.add("n");
    const SEEN = L.add("seen", refOf(T.i32Arr));
    const CUR = L.add("cur", refOf(T.frameArr));
    const NXT = L.add("nxt", refOf(T.frameArr));
    const SWAP = L.add("swap", refOf(T.frameArr));
    const STACK = L.add("stack", refOf(T.frameArr));
    const CUR_N = L.add("curN");
    const NXT_N = L.add("nxtN");
    const SP = L.add("sp");
    const I = L.add("i");
    const S = L.add("s");
    const W = L.add("w");
    const TCAPS = L.add("tcaps", refOf(T.i32Arr));
    const MATCHED = L.add("matched", { kind: "ref_null", typeIdx: T.i32Arr });
    const newFrames = (len: X): X => [...len, { op: "array.new_default", typeIdx: T.frameArr }];
    const addTo = (list: number, count: number, state: X, caps: X, sp: X, stamp: X): X =>
      set(
        count,
        call(
          fn.add,
          get(PROG),
          get(SDATA),
          get(SOFF),
          get(SLEN),
          get(SEEN),
          stamp,
          get(list),
          get(count),
          get(STACK),
          state,
          caps,
          sp,
        ),
      );
    const addNext = (state: X): X => addTo(NXT, NXT_N, state, get(TCAPS), add(get(SP), c(1)), add(get(SP), c(2)));
    const twoN: X = add(get(N), get(N));
    const stepThread: X = [
      ...set(S, [...aget(T.frameArr, get(CUR), get(I)), { op: "struct.get", typeIdx: T.frame, fieldIdx: 0 }]),
      ...set(TCAPS, [...aget(T.frameArr, get(CUR), get(I)), { op: "struct.get", typeIdx: T.frame, fieldIdx: 2 }]),
      ...inc(I),
      ...if_(ge(get(S), get(N)), [...addNext(add(sub(get(S), get(N)), c(1))), ...cont("threads")]),
      ...if_(eq(progField(T, PROG, get(S), 0), c(ReOp.MATCH)), [...set(MATCHED, get(TCAPS)), ...brk("threads")]),
      ...if_(ge(get(SP), get(SLEN)), cont("threads")),
      ...set(
        W,
        call(
          fn.unit,
          get(CTAB),
          get(SDATA),
          get(SOFF),
          get(SLEN),
          get(SP),
          progField(T, PROG, get(S), 0),
          progField(T, PROG, get(S), 1),
          progField(T, PROG, get(S), 2),
        ),
      ),
      ...if_(eq(get(W), c(1)), addNext(add(get(S), c(1)))),
      ...if_(eq(get(W), c(2)), addNext(add(get(N), get(S)))),
    ];
    const noMatchYet: X = [...get(MATCHED), { op: "ref.is_null" }];
    const seed: X = if_(
      andThen(noMatchYet, or(eqz(get(STICKY)), eq(get(SP), get(START)))),
      addTo(
        CUR,
        CUR_N,
        c(0),
        [...c(-1), ...get(NSLOTS), { op: "array.new", typeIdx: T.i32Arr }],
        get(SP),
        add(get(SP), c(1)),
      ),
    );
    return [
      ...set(N, instrCount(PROG)),
      ...set(SEEN, [...twoN, { op: "array.new_default", typeIdx: T.i32Arr }]),
      ...set(CUR, newFrames(twoN)),
      ...set(NXT, newFrames(twoN)),
      ...set(STACK, newFrames(add(add(twoN, twoN), c(1)))),
      ...set(CUR_N, c(0)),
      ...set(SP, get(START)),
      ...block("positions", [
        ...loop("position", [
          ...brIf("positions", gt(get(SP), get(SLEN))),
          ...seed,
          ...brIf("positions", andThen(eqz(get(CUR_N)), or(eqz(noMatchYet), ne(get(STICKY), c(0))))),
          ...set(NXT_N, c(0)),
          ...set(I, c(0)),
          ...whileLoop("threads", [...get(I), ...get(CUR_N), { op: "i32.lt_s" }], stepThread),
          ...set(SWAP, get(CUR)),
          ...set(CUR, get(NXT)),
          ...set(NXT, get(SWAP)),
          ...set(CUR_N, get(NXT_N)),
          ...inc(SP),
          ...br("position"),
        ]),
      ]),
      ...if_(noMatchYet, ret(c(0))),
      ...get(CAPS),
      ...c(0),
      ...get(MATCHED),
      { op: "ref.as_non_null" },
      ...c(0),
      ...get(NSLOTS),
      { op: "array.copy", dstTypeIdx: T.i32Arr, srcTypeIdx: T.i32Arr },
      ...c(1),
    ];
  });
}

/** `__regex_run`'s result when a linear-safe program exhausted its step budget. */
const RUN_BUDGET_EXHAUSTED = -1;

/**
 * The linear fallback is emitted only on the host-free targets (standalone,
 * WASI). The JS-host lane runs the same native engine but keeps its output
 * byte-identical while it is being sunset, so it retains the step-cap
 * RangeError.
 */
function linearFallbackEnabled(ctx: CodegenContext): boolean {
  return ctx.targetProfile.environment !== "javascript";
}

/**
 * Instrs for `__regex_run`'s budget-exhaustion branch, ahead of its RangeError
 * throw: a linear-safe program checks its backtrack stack back into the pool
 * global (as the VM's other exits do) and returns {@link RUN_BUDGET_EXHAUSTED}
 * instead. Only a top-level run can get here — a linear-safe program has no
 * LOOKAROUND, so it never recurses. Empty off the host-free targets.
 */
export function regexRunBudgetHandoff(
  ctx: CodegenContext,
  progLocal: number,
  stackLocal: number,
  stackPoolGlobal: number,
): Instr[] {
  if (!linearFallbackEnabled(ctx)) return [];
  const safeIdx = ensureRegexLinearSafe(ctx);
  return if_(call(safeIdx, get(progLocal)), [
    ...get(stackLocal),
    { op: "global.set", index: stackPoolGlobal },
    ...ret(c(RUN_BUDGET_EXHAUSTED)),
  ]);
}

/**
 * Instrs spliced right after `__regex_search`'s `__regex_run` call, whose
 * result is on the stack: on {@link RUN_BUDGET_EXHAUSTED} return the linear
 * search's answer for the rest of the scan (`searchArgs` = the
 * `__regex_search_linear` arguments, start = the failed attempt's position);
 * otherwise leave the result for the caller's match test. `resultLocal` is
 * the index of the one i32 local returned in `locals`.
 */
export function regexSearchBudgetFallback(
  ctx: CodegenContext,
  resultLocal: number,
  searchArgs: readonly number[],
): { instrs: Instr[]; locals: LocalDef[] } {
  if (!linearFallbackEnabled(ctx)) return { instrs: [], locals: [] };
  const searchIdx = ensureRegexSearchLinear(ctx);
  return {
    instrs: [
      { op: "local.tee", index: resultLocal },
      ...if_(eq(get(resultLocal), c(RUN_BUDGET_EXHAUSTED)), ret(call(searchIdx, ...searchArgs.map(get)))),
      ...get(resultLocal),
    ],
    locals: [{ name: "runResult", type: I32 }],
  };
}

function ensureRegexLinearSafe(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_linear_safe");
  if (existing !== undefined) return existing;
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set("__regex_linear_safe", funcIdx);
  defineLinearSafe(linearTypes(ctx), funcIdx);
  return funcIdx;
}

function ensureRegexSearchLinear(ctx: CodegenContext): number {
  const existing = ctx.nativeRegexHelpers.get("__regex_search_linear");
  if (existing !== undefined) return existing;
  const T = linearTypes(ctx);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set("__regex_search_linear", funcIdx);
  const assertIdx = mintDefinedFunc(ctx);
  const unitIdx = mintDefinedFunc(ctx);
  const addIdx = mintDefinedFunc(ctx);
  defineAssert(T, assertIdx);
  defineUnit(T, unitIdx);
  defineAdd(T, addIdx, assertIdx);
  defineSearch(T, funcIdx, { add: addIdx, unit: unitIdx });
  return funcIdx;
}

function linearTypes(ctx: CodegenContext): LinearTypes {
  const [frame, frameArr] = ensureFrameTypes(ctx);
  return {
    ctx,
    i32Arr: regexI32ArrayType(ctx),
    strData: ctx.nativeStrDataTypeIdx,
    frame,
    frameArr,
    classMatch: emitClassMatch(ctx),
  };
}
