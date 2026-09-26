// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6677 — the bytecode EMITTER of the runtime RegExp compiler, as Wasm.
 *
 * A port of `regex/compile.ts` `Emitter.compileNode` over the flat AST: the
 * same Thompson/backtracking lowering (SPLIT/JMP), the same PROGRESS guards
 * for nullable loops (#1959), CLEAR at iteration heads (#1960), lookaround
 * sub-programs appended after MATCH (#1911, lookbehind bodies emitted
 * REVERSED with swapped SAVE order), and inline modifier scoping. The output
 * is the exact `[op, a, b]` record stream `__regex_run` interprets, so no VM
 * change is involved. (The compile-time literal-alternation trie is a pure
 * speed optimisation and is not reproduced.)
 */
import { ReOp } from "../regex/bytecode.js";
import { RE_FLAG_I, RE_FLAG_M, RE_FLAG_S } from "../regex/bytecode.js";
import {
  ERR_UNSUPPORTED,
  F_CI,
  F_DOTALL,
  F_MULTI,
  F_NSCR,
  F_PC,
  F_PEND,
  F_PENDLEN,
  F_PROG,
  F_REV,
  F_RLEN,
  F_SBASE,
  F_T0,
  F_T1,
  F_UMODE,
  K_ALT,
  K_ANY,
  K_BACKREF,
  K_BOL,
  K_CAT,
  K_CHAR,
  K_CLASS,
  K_CPCLASS,
  K_EOL,
  K_GROUP,
  K_LOOK,
  K_MOD,
  K_OPT,
  K_PLUS,
  K_REP,
  K_STAR,
  K_WB,
  N_A,
  N_B,
  N_C,
  N_CHILD,
  N_NEXT,
  ST,
  ag,
  as,
  bail,
  defineRxFn,
  nf,
  nset,
  sg,
  ss,
  type RxEnv,
} from "./env.js";
import {
  I32,
  add,
  allOf,
  and,
  anyOf,
  c,
  call,
  drop,
  eq,
  eqz,
  ge,
  get,
  gt,
  if_,
  inc,
  lt,
  mul,
  or,
  ret,
  sel,
  set,
  shl,
  shrU,
  sub,
  whileLoop,
  type X,
} from "./dsl.js";
import { isAsciiLetter, unsafeForFold } from "./core.js";

const emit = (E: RxEnv, op: number, a: X = c(0), b: X = c(0)): X => call(E.fn.emit, ST, c(op), a, b);
const emitV = (E: RxEnv, op: number, a: X = c(0), b: X = c(0)): X => drop(emit(E, op, a, b));
const progSlot = (pc: X, slot: number): X => add(mul(pc, c(3)), c(slot));
const patch = (E: RxEnv, pc: X, slot: number, value: X): X => as(E, sg(E, F_PROG), progSlot(pc, slot), value);
const progGet = (E: RxEnv, pc: X, slot: number): X => ag(E, sg(E, F_PROG), progSlot(pc, slot));
/** Snapshot of the emitter's i/s/m/reversed state as one i32. */
const snapshot = (E: RxEnv): X =>
  or(or(sg(E, F_CI), shl(sg(E, F_DOTALL), c(1))), or(shl(sg(E, F_MULTI), c(2)), shl(sg(E, F_REV), c(3))));
const restore = (E: RxEnv, state: X): X => [
  ...ss(E, F_CI, and(state, c(1))),
  ...ss(E, F_DOTALL, and(shrU(state, c(1)), c(1))),
  ...ss(E, F_MULTI, and(shrU(state, c(2)), c(1))),
  ...ss(E, F_REV, and(shrU(state, c(3)), c(1))),
];

export function defineEmitter(E: RxEnv): void {
  defineEmitNode(E);
  defineLists(E);
  defineLoops(E);
  defineAnalyses(E);
  defineEmitChar(E);
  defineDrain(E);
}

function defineEmitNode(E: RxEnv): void {
  const { fn } = E;
  defineRxFn(E, "emitNode", [I32], [], (L) => {
    const N = 1;
    const K = L.add("k");
    const A = L.add("a");
    const OFF = L.add("off");
    const PC = L.add("pc");
    const SAVED = L.add("saved");
    const CHILD = nf(E, get(N), N_CHILD);
    const on = (kind: number, body: X): X => if_(eq(get(K), c(kind)), [...body, ...ret()]);
    return [
      ...set(K, nf(E, get(N), 0)),
      ...set(A, nf(E, get(N), N_A)),
      ...on(K_CHAR, call(fn.emitChar, ST, get(A))),
      ...on(K_ANY, emitV(E, ReOp.ANY, sg(E, F_DOTALL))),
      ...if_(or(eq(get(K), c(K_CLASS)), eq(get(K), c(K_CPCLASS))), [
        // The class table entry is independent of the emitter state (folding
        // happened at parse time), so cache it across re-emissions.
        ...set(OFF, CHILD),
        ...if_(lt(get(OFF), c(0)), [
          ...set(OFF, call(fn.classOffset, ST, get(A), nf(E, get(N), N_B))),
          ...nset(E, get(N), N_CHILD, get(OFF)),
        ]),
        ...drop(
          call(
            fn.emit,
            ST,
            sel(I32, eq(get(K), c(K_CLASS)), c(ReOp.CLASS), c(ReOp.CPCLASS)),
            get(OFF),
            nf(E, get(N), N_C),
          ),
        ),
        ...ret(),
      ]),
      ...on(K_BOL, emitV(E, ReOp.BOL, sg(E, F_MULTI))),
      ...on(K_EOL, emitV(E, ReOp.EOL, sg(E, F_MULTI))),
      // u+i word characters and backreference folding need Canonicalize.
      ...on(K_WB, [
        ...if_(allOf(sg(E, F_UMODE), sg(E, F_CI)), bail(E, ERR_UNSUPPORTED)),
        ...emitV(E, ReOp.WBOUND, get(A)),
      ]),
      ...on(K_BACKREF, [
        ...if_(allOf(sg(E, F_UMODE), sg(E, F_CI)), bail(E, ERR_UNSUPPORTED)),
        ...emitV(E, ReOp.BACKREF, get(A), sg(E, F_CI)),
      ]),
      ...on(K_LOOK, [
        ...set(PC, emit(E, ReOp.LOOKAROUND, c(0), or(get(A), shl(nf(E, get(N), N_B), c(1))))),
        // Queue [body, patchPc, state]; the body's reversed flag is its own
        // direction, never inherited.
        ...set(SAVED, sg(E, F_PENDLEN)),
        ...ss(E, F_PEND, call(fn.grow, sg(E, F_PEND), add(get(SAVED), c(3)))),
        ...as(E, sg(E, F_PEND), get(SAVED), CHILD),
        ...as(E, sg(E, F_PEND), add(get(SAVED), c(1)), get(PC)),
        ...as(E, sg(E, F_PEND), add(get(SAVED), c(2)), or(and(snapshot(E), c(7)), shl(nf(E, get(N), N_B), c(3)))),
        ...ss(E, F_PENDLEN, add(get(SAVED), c(3))),
      ]),
      ...on(K_MOD, [
        ...set(SAVED, snapshot(E)),
        ...if_(and(get(A), c(RE_FLAG_I)), ss(E, F_CI, c(1))),
        ...if_(and(nf(E, get(N), N_B), c(RE_FLAG_I)), ss(E, F_CI, c(0))),
        ...if_(and(get(A), c(RE_FLAG_S)), ss(E, F_DOTALL, c(1))),
        ...if_(and(nf(E, get(N), N_B), c(RE_FLAG_S)), ss(E, F_DOTALL, c(0))),
        ...if_(and(get(A), c(RE_FLAG_M)), ss(E, F_MULTI, c(1))),
        ...if_(and(nf(E, get(N), N_B), c(RE_FLAG_M)), ss(E, F_MULTI, c(0))),
        ...call(fn.emitNode, ST, CHILD),
        ...restore(E, get(SAVED)),
      ]),
      ...on(K_CAT, call(fn.emitList, ST, CHILD)),
      ...on(K_ALT, call(fn.emitAlt, ST, get(N))),
      ...on(K_STAR, call(fn.emitStar, ST, CHILD, get(A))),
      ...on(K_PLUS, call(fn.emitPlus, ST, CHILD, get(A))),
      ...on(K_OPT, call(fn.emitOpt, ST, CHILD, get(A))),
      ...on(K_REP, call(fn.emitRep, ST, get(N))),
      ...on(K_GROUP, [
        // Reversed (lookbehind) bodies record the END slot first so capture
        // spans stay [left, right] while matching right-to-left.
        ...emitV(E, ReOp.SAVE, add(mul(get(A), c(2)), sg(E, F_REV))),
        ...call(fn.emitNode, ST, CHILD),
        ...emitV(E, ReOp.SAVE, add(mul(get(A), c(2)), eqz(sg(E, F_REV)))),
      ]),
    ];
  });
}

/** emitList (CAT parts, reversed in a lookbehind body) and emitAlt. */
function defineLists(E: RxEnv): void {
  const { fn } = E;
  defineRxFn(E, "emitList", [I32], [], (L) => {
    const N = L.add("n");
    return [
      ...if_(sg(E, F_REV), [
        ...if_(lt(get(1), c(0)), ret()),
        ...call(fn.emitList, ST, nf(E, get(1), N_NEXT)),
        ...call(fn.emitNode, ST, get(1)),
        ...ret(),
      ]),
      ...set(N, get(1)),
      ...whileLoop("parts", ge(get(N), c(0)), [...call(fn.emitNode, ST, get(N)), ...set(N, nf(E, get(N), N_NEXT))]),
    ];
  });

  // For options [a,b,c]: SPLIT a,(b|c) ; a ; JMP end ; SPLIT b,c ; b ; JMP end ; c ; end.
  // The JMPs to `end` are chained through their own `a` operand and patched
  // once the end is known.
  defineRxFn(E, "emitAlt", [I32], [], (L) => {
    const OPT = L.add("opt");
    const SPLIT = L.add("split");
    const JMPS = L.add("jmps");
    const NEXT = L.add("next");
    const END = L.add("end");
    return [
      ...set(JMPS, c(-1)),
      ...set(OPT, nf(E, get(1), N_CHILD)),
      ...whileLoop("opts", ge(get(OPT), c(0)), [
        ...if_(
          ge(nf(E, get(OPT), N_NEXT), c(0)),
          [
            ...set(SPLIT, emit(E, ReOp.SPLIT)),
            ...patch(E, get(SPLIT), 1, add(get(SPLIT), c(1))),
            ...call(fn.emitNode, ST, get(OPT)),
            ...set(JMPS, emit(E, ReOp.JMP, get(JMPS))),
            ...patch(E, get(SPLIT), 2, sg(E, F_PC)),
          ],
          call(fn.emitNode, ST, get(OPT)),
        ),
        ...set(OPT, nf(E, get(OPT), N_NEXT)),
      ]),
      ...set(END, sg(E, F_PC)),
      ...whileLoop("patch", ge(get(JMPS), c(0)), [
        ...set(NEXT, progGet(E, get(JMPS), 1)),
        ...patch(E, get(JMPS), 1, get(END)),
        ...set(JMPS, get(NEXT)),
      ]),
    ];
  });
}

/** emitStar / emitPlus / emitOpt / emitRep / emitClear. */
function defineLoops(E: RxEnv): void {
  const { fn } = E;
  // Greedy: SAVE? g ; L1: SPLIT body,exit ; CLEAR? ; body ; PROGRESS? g ; JMP L1 ; exit
  defineRxFn(E, "emitStar", [I32, I32], [], (L) => {
    const CHILD = 1;
    const GREEDY = 2;
    const GUARD = L.add("guard");
    const L1 = L.add("l1");
    const BODY = L.add("body");
    const EXIT = L.add("exit");
    return [
      ...set(GUARD, c(-1)),
      ...if_(call(fn.canEmpty, ST, get(CHILD)), [
        ...set(GUARD, add(sg(E, F_SBASE), sg(E, F_NSCR))),
        ...ss(E, F_NSCR, add(sg(E, F_NSCR), c(1))),
        ...emitV(E, ReOp.SAVE, get(GUARD)),
      ]),
      ...set(L1, emit(E, ReOp.SPLIT)),
      ...set(BODY, sg(E, F_PC)),
      ...call(fn.emitClear, ST, get(CHILD)),
      ...call(fn.emitNode, ST, get(CHILD)),
      ...if_(ge(get(GUARD), c(0)), emitV(E, ReOp.PROGRESS, get(GUARD))),
      ...emitV(E, ReOp.JMP, sel(I32, ge(get(GUARD), c(0)), sub(get(L1), c(1)), get(L1))),
      ...set(EXIT, sg(E, F_PC)),
      ...patch(E, get(L1), 1, sel(I32, get(GREEDY), get(BODY), get(EXIT))),
      ...patch(E, get(L1), 2, sel(I32, get(GREEDY), get(EXIT), get(BODY))),
    ];
  });

  // Non-nullable: L1: CLEAR? ; body ; SPLIT L1,exit. Nullable: one mandatory
  // (cleared) body, then a guarded star for the remaining repetitions.
  defineRxFn(E, "emitPlus", [I32, I32], [], (L) => {
    const CHILD = 1;
    const GREEDY = 2;
    const L1 = L.add("l1");
    const SPLIT = L.add("split");
    const EXIT = L.add("exit");
    return [
      ...if_(call(fn.canEmpty, ST, get(CHILD)), [
        ...call(fn.emitClear, ST, get(CHILD)),
        ...call(fn.emitNode, ST, get(CHILD)),
        ...call(fn.emitStar, ST, get(CHILD), get(GREEDY)),
        ...ret(),
      ]),
      ...set(L1, sg(E, F_PC)),
      ...call(fn.emitClear, ST, get(CHILD)),
      ...call(fn.emitNode, ST, get(CHILD)),
      ...set(SPLIT, emit(E, ReOp.SPLIT)),
      ...set(EXIT, sg(E, F_PC)),
      ...patch(E, get(SPLIT), 1, sel(I32, get(GREEDY), get(L1), get(EXIT))),
      ...patch(E, get(SPLIT), 2, sel(I32, get(GREEDY), get(EXIT), get(L1))),
    ];
  });

  // SPLIT body,exit ; body ; exit   (lazy swaps the targets)
  defineRxFn(E, "emitOpt", [I32, I32], [], (L) => {
    const SPLIT = L.add("split");
    const BODY = L.add("body");
    const EXIT = L.add("exit");
    return [
      ...set(SPLIT, emit(E, ReOp.SPLIT)),
      ...set(BODY, sg(E, F_PC)),
      ...call(fn.emitNode, ST, get(1)),
      ...set(EXIT, sg(E, F_PC)),
      ...patch(E, get(SPLIT), 1, sel(I32, get(2), get(BODY), get(EXIT))),
      ...patch(E, get(SPLIT), 2, sel(I32, get(2), get(EXIT), get(BODY))),
    ];
  });

  // {min,max}: `min` mandatory copies, then a star (unbounded) or max-min
  // optional copies.
  defineRxFn(E, "emitRep", [I32], [], (L) => {
    const I = L.add("i");
    const MIN = L.add("min");
    const MAX = L.add("max");
    const CHILD = L.add("child");
    const GREEDY = L.add("greedy");
    return [
      ...set(MIN, nf(E, get(1), N_A)),
      ...set(MAX, nf(E, get(1), N_B)),
      ...set(GREEDY, nf(E, get(1), N_C)),
      ...set(CHILD, nf(E, get(1), N_CHILD)),
      ...whileLoop("mandatory", lt(get(I), get(MIN)), [...call(fn.emitNode, ST, get(CHILD)), ...inc(I)]),
      ...if_(lt(get(MAX), c(0)), [...call(fn.emitStar, ST, get(CHILD), get(GREEDY)), ...ret()]),
      ...whileLoop("optional", lt(get(I), get(MAX)), [...call(fn.emitOpt, ST, get(CHILD), get(GREEDY)), ...inc(I)]),
    ];
  });

  // emitClear(st, body): CLEAR over the body's capture-group slot span.
  defineRxFn(E, "emitClear", [I32], [], () => [
    ...ss(E, F_T0, c(0x7fffffff)),
    ...ss(E, F_T1, c(-1)),
    ...call(fn.capVisit, ST, get(1)),
    ...if_(
      ge(sg(E, F_T1), sg(E, F_T0)),
      emitV(E, ReOp.CLEAR, mul(sg(E, F_T0), c(2)), add(mul(sg(E, F_T1), c(2)), c(1))),
    ),
  ]);
}

/** canEmpty (nullability, conservative) and capVisit (capture span). */
function defineAnalyses(E: RxEnv): void {
  const { fn } = E;
  defineRxFn(E, "canEmpty", [I32], [I32], (L) => {
    const K = L.add("k");
    const N = L.add("n");
    const CHILD = nf(E, get(1), N_CHILD);
    return [
      ...set(K, nf(E, get(1), 0)),
      ...if_(
        anyOf(eq(get(K), c(K_CHAR)), eq(get(K), c(K_ANY)), eq(get(K), c(K_CLASS)), eq(get(K), c(K_CPCLASS))),
        ret(c(0)),
      ),
      ...if_(eq(get(K), c(K_PLUS)), ret(call(fn.canEmpty, ST, CHILD))),
      ...if_(eq(get(K), c(K_REP)), ret(or(eqz(nf(E, get(1), N_A)), call(fn.canEmpty, ST, CHILD)))),
      ...if_(or(eq(get(K), c(K_GROUP)), eq(get(K), c(K_MOD))), ret(call(fn.canEmpty, ST, CHILD))),
      ...if_(eq(get(K), c(K_CAT)), [
        ...set(N, CHILD),
        ...whileLoop("all", ge(get(N), c(0)), [
          ...if_(eqz(call(fn.canEmpty, ST, get(N))), ret(c(0))),
          ...set(N, nf(E, get(N), N_NEXT)),
        ]),
        ...ret(c(1)),
      ]),
      ...if_(eq(get(K), c(K_ALT)), [
        ...set(N, CHILD),
        ...whileLoop("some", ge(get(N), c(0)), [
          ...if_(call(fn.canEmpty, ST, get(N)), ret(c(1))),
          ...set(N, nf(E, get(N), N_NEXT)),
        ]),
        ...ret(c(0)),
      ]),
      // BACKREF, assertions, lookarounds, STAR, OPT: nullable.
      ...c(1),
    ];
  });

  // capVisit(st, node): fold the node's capture indices into T0 (min) / T1
  // (max). Lookaround bodies are separate sub-programs — not descended.
  defineRxFn(E, "capVisit", [I32], [], (L) => {
    const K = L.add("k");
    const N = L.add("n");
    const A = L.add("a");
    return [
      ...set(K, nf(E, get(1), 0)),
      ...if_(eq(get(K), c(K_GROUP)), [
        ...set(A, nf(E, get(1), N_A)),
        ...if_(lt(get(A), sg(E, F_T0)), ss(E, F_T0, get(A))),
        ...if_(gt(get(A), sg(E, F_T1)), ss(E, F_T1, get(A))),
      ]),
      ...if_(or(eq(get(K), c(K_CAT)), eq(get(K), c(K_ALT))), [
        ...set(N, nf(E, get(1), N_CHILD)),
        ...whileLoop("list", ge(get(N), c(0)), [...call(fn.capVisit, ST, get(N)), ...set(N, nf(E, get(N), N_NEXT))]),
        ...ret(),
      ]),
      ...if_(
        anyOf(
          eq(get(K), c(K_GROUP)),
          eq(get(K), c(K_STAR)),
          eq(get(K), c(K_PLUS)),
          eq(get(K), c(K_OPT)),
          eq(get(K), c(K_MOD)),
          eq(get(K), c(K_REP)),
        ),
        call(fn.capVisit, ST, nf(E, get(1), N_CHILD)),
      ),
    ];
  });
}

/** emitChar(st, cp): one literal, with the emitter's case/direction state. */
function defineEmitChar(E: RxEnv): void {
  const { fn } = E;
  defineRxFn(E, "emitChar", [I32], [], (L) => {
    const CP = 1;
    const LEAD = L.add("lead");
    const TRAIL = L.add("trail");
    const S = L.add("s");
    const LOWER = L.add("lower");
    const r = (lo: X, hi: X): X => call(fn.range, ST, lo, hi);
    return [
      ...if_(gt(get(CP), c(0xffff)), [
        ...if_(sg(E, F_CI), bail(E, ERR_UNSUPPORTED)),
        ...set(LEAD, add(c(0xd800), shrU(sub(get(CP), c(0x10000)), c(10)))),
        ...set(TRAIL, add(c(0xdc00), and(sub(get(CP), c(0x10000)), c(0x3ff)))),
        ...if_(
          sg(E, F_REV),
          [...emitV(E, ReOp.CHAR, get(TRAIL)), ...emitV(E, ReOp.CHAR, get(LEAD))],
          [...emitV(E, ReOp.CHAR, get(LEAD)), ...emitV(E, ReOp.CHAR, get(TRAIL))],
        ),
        ...ret(),
      ]),
      ...if_(eqz(sg(E, F_CI)), [...emitV(E, ReOp.CHAR, get(CP)), ...ret()]),
      ...if_(ge(get(CP), c(0x80)), [
        ...if_(unsafeForFold(get(CP), get(CP)), bail(E, ERR_UNSUPPORTED)),
        ...emitV(E, ReOp.CHAR, get(CP)),
        ...ret(),
      ]),
      // Non-u `i`: ASCII-only Canonicalize (a non-ASCII unit never folds to
      // ASCII), exactly CHARI.
      ...if_(eqz(sg(E, F_UMODE)), [...emitV(E, ReOp.CHARI, lowerAscii(get(CP))), ...ret()]),
      ...if_(eqz(isAsciiLetter(get(CP))), [...emitV(E, ReOp.CHAR, get(CP)), ...ret()]),
      // u+i ASCII letter: its simple-case-folding class ({K,k,U+212A},
      // {S,s,U+017F}, otherwise the ASCII pair) as a code-point class.
      ...set(LOWER, lowerAscii(get(CP))),
      ...set(S, sg(E, F_RLEN)),
      ...r(get(LOWER), get(LOWER)),
      ...r(sub(get(LOWER), c(0x20)), sub(get(LOWER), c(0x20))),
      ...if_(eq(get(LOWER), c(0x6b)), r(c(0x212a), c(0x212a))),
      ...if_(eq(get(LOWER), c(0x73)), r(c(0x17f), c(0x17f))),
      ...set(LEAD, call(fn.sortMerge, ST, get(S), sg(E, F_RLEN))),
      ...set(TRAIL, call(fn.classOffset, ST, get(S), shrU(sub(get(LEAD), get(S)), c(1)))),
      ...ss(E, F_RLEN, get(S)),
      ...emitV(E, ReOp.CPCLASS, get(TRAIL), c(0)),
    ];
  });
}

const lowerAscii = (v: X): X => sel(I32, and(ge(v, c(0x41)), ge(c(0x5a), v)), add(v, c(0x20)), v);

/** drain(st): emit queued lookaround bodies (each + MATCH), FIFO; bodies may
 *  queue further lookarounds. */
function defineDrain(E: RxEnv): void {
  const { fn } = E;
  defineRxFn(E, "drain", [], [], (L) => {
    const I = L.add("i");
    const SAVED = L.add("saved");
    const pend = (k: number): X => ag(E, sg(E, F_PEND), add(get(I), c(k)));
    return [
      ...whileLoop("queue", lt(get(I), sg(E, F_PENDLEN)), [
        ...patch(E, pend(1), 1, sg(E, F_PC)),
        ...set(SAVED, snapshot(E)),
        ...restore(E, pend(2)),
        ...call(fn.emitNode, ST, pend(0)),
        ...emitV(E, ReOp.MATCH),
        ...restore(E, get(SAVED)),
        ...inc(I, 3),
      ]),
    ];
  });
}
