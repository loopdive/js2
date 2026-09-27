// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6677 — storage and cursor helpers of the runtime RegExp compiler: growable
 * arrays, node/bytecode/range appends, the parse cursor, and the range-set
 * algebra (sort+merge, complement, case-fold images) that class parsing needs.
 */
import {
  ERR_SYNTAX,
  ERR_UNSUPPORTED,
  F_CTAB,
  F_CLEN,
  F_NCOUNT,
  F_NODES,
  F_PC,
  F_PCI,
  F_POS,
  F_PROG,
  F_RLEN,
  F_RP,
  F_SLEN,
  F_UMODE,
  K_CHAR,
  K_CPCLASS,
  N_CHILD,
  NODE_W,
  arrRef,
  ag,
  as,
  advance,
  bail,
  defineRxFn,
  nf,
  nset,
  sg,
  src,
  ss,
  ST,
  type RxEnv,
} from "./env.js";
import {
  I32,
  add,
  allOf,
  andThen,
  anyOf,
  between,
  brk,
  c,
  call,
  eq,
  eqz,
  ge,
  get,
  gt,
  if_,
  inc,
  le,
  lt,
  mul,
  or,
  ret,
  sel,
  set,
  shrU,
  sub,
  tee,
  whileLoop,
  type X,
} from "./dsl.js";

/** Largest code point / code unit, by mode. */
export const maxUnit = (E: RxEnv): X => sel(I32, sg(E, F_UMODE), c(0x10ffff), c(0xffff));

/**
 * Code points whose case mapping the runtime compiler does NOT model. Under
 * the `i` flag a literal or range touching one of these refuses (poisoned
 * value → catchable TypeError) instead of matching with the wrong folding. The
 * rest of the BMP above U+3000 (CJK, Hangul, surrogates, private use, …) has
 * no case mapping; ASCII letters are folded exactly.
 */
export const unsafeForFold = (lo: X, hi: X): X =>
  anyOf(
    allOf(le(lo, c(0x2fff)), ge(hi, c(0x80))),
    allOf(le(lo, c(0xabff)), ge(hi, c(0xa640))),
    allOf(le(lo, c(0xffef)), ge(hi, c(0xff00))),
    ge(hi, c(0x10000)),
  );

export function defineCoreHelpers(E: RxEnv): void {
  const { fn } = E;
  const ARR = arrRef(E);

  // grow(arr, need) -> arr with length >= need (doubling).
  defineRxFn(
    E,
    "grow",
    [ARR, I32],
    [ARR],
    (L) => {
      const ARG = 0;
      const NEED = 1;
      const LEN = L.add("len");
      const OUT = L.add("out", ARR);
      return [
        ...set(LEN, [...get(ARG), { op: "array.len" }]),
        ...if_(ge(get(LEN), get(NEED)), ret(get(ARG))),
        ...set(LEN, mul(get(LEN), c(2))),
        ...if_(lt(get(LEN), get(NEED)), set(LEN, get(NEED))),
        ...set(OUT, [...get(LEN), { op: "array.new_default", typeIdx: E.arr }]),
        ...get(OUT),
        ...c(0),
        ...get(ARG),
        ...c(0),
        ...get(ARG),
        { op: "array.len" },
        { op: "array.copy", dstTypeIdx: E.arr, srcTypeIdx: E.arr },
        ...get(OUT),
      ];
    },
    true,
  );

  // node(st, kind, a, b, c) -> index
  defineRxFn(E, "node", [I32, I32, I32, I32], [I32], (L) => {
    const IDX = L.add("idx");
    const BASE = L.add("base");
    const slot = (k: number, v: X): X => as(E, sg(E, F_NODES), add(get(BASE), c(k)), v);
    return [
      ...set(IDX, sg(E, F_NCOUNT)),
      ...ss(E, F_NODES, call(fn.grow, sg(E, F_NODES), mul(add(get(IDX), c(1)), c(NODE_W)))),
      ...set(BASE, mul(get(IDX), c(NODE_W))),
      ...slot(0, get(1)),
      ...slot(1, get(2)),
      ...slot(2, get(3)),
      ...slot(3, get(4)),
      ...slot(4, c(-1)),
      ...slot(5, c(-1)),
      ...ss(E, F_NCOUNT, add(get(IDX), c(1))),
      ...get(IDX),
    ];
  });

  // emit(st, op, a, b) -> pc
  defineRxFn(E, "emit", [I32, I32, I32], [I32], (L) => {
    const PC = L.add("pc");
    const slot = (k: number, v: X): X => as(E, sg(E, F_PROG), add(mul(get(PC), c(3)), c(k)), v);
    return [
      ...set(PC, sg(E, F_PC)),
      ...ss(E, F_PROG, call(fn.grow, sg(E, F_PROG), mul(add(get(PC), c(1)), c(3)))),
      ...slot(0, get(1)),
      ...slot(1, get(2)),
      ...slot(2, get(3)),
      ...ss(E, F_PC, add(get(PC), c(1))),
      ...get(PC),
    ];
  });

  // range(st, lo, hi): append one pair to the range pool.
  defineRxFn(E, "range", [I32, I32], [], (L) => {
    const N = L.add("n");
    return [
      ...set(N, sg(E, F_RLEN)),
      ...ss(E, F_RP, call(fn.grow, sg(E, F_RP), add(get(N), c(2)))),
      ...as(E, sg(E, F_RP), get(N), get(1)),
      ...as(E, sg(E, F_RP), add(get(N), c(1)), get(2)),
      ...ss(E, F_RLEN, add(get(N), c(2))),
    ];
  });

  // peek(st) -> unit at the cursor, or -1 at the end.
  defineRxFn(E, "peek", [], [I32], () => sel(I32, lt(sg(E, F_POS), sg(E, F_SLEN)), src(E, sg(E, F_POS)), c(-1)));

  // peekAt(st, k) -> unit at cursor+k, or -1.
  defineRxFn(E, "peekAt", [I32], [I32], (L) => {
    const P = L.add("p");
    return sel(I32, lt(tee(P, add(sg(E, F_POS), get(1))), sg(E, F_SLEN)), src(E, get(P)), c(-1));
  });

  // hex(st, n) -> value of n hex digits at the cursor (not consumed), or -1.
  defineRxFn(E, "hex", [I32], [I32], (L) => {
    const I = L.add("i");
    const V = L.add("v");
    const CH = L.add("ch");
    const D = L.add("d");
    return [
      ...whileLoop("digits", lt(get(I), get(1)), [
        ...set(CH, call(fn.peekAt, ST, get(I))),
        ...set(
          D,
          sel(
            I32,
            between(get(CH), 0x30, 0x39),
            sub(get(CH), c(0x30)),
            sel(
              I32,
              between(get(CH), 0x61, 0x66),
              sub(get(CH), c(0x57)),
              sel(I32, between(get(CH), 0x41, 0x46), sub(get(CH), c(0x37)), c(-1)),
            ),
          ),
        ),
        ...if_(lt(get(D), c(0)), ret(c(-1))),
        ...set(V, add(mul(get(V), c(16)), get(D))),
        ...inc(I),
      ]),
      ...get(V),
    ];
  });

  // readCp(st) -> one source code point (u mode joins a surrogate pair).
  defineRxFn(E, "readCp", [], [I32], (L) => {
    const CH = L.add("ch");
    const T = L.add("t");
    return [
      ...set(CH, call(fn.peek, ST)),
      ...advance(E),
      ...if_(allOf(sg(E, F_UMODE), between(get(CH), 0xd800, 0xdbff)), [
        ...set(T, call(fn.peek, ST)),
        ...if_(between(get(T), 0xdc00, 0xdfff), [
          ...advance(E),
          ...ret(add(add(c(0x10000), mul(sub(get(CH), c(0xd800)), c(0x400))), sub(get(T), c(0xdc00)))),
        ]),
      ]),
      ...get(CH),
    ];
  });

  // legacyOctal(st) -> Annex B LegacyOctalEscapeSequence value (consumes).
  defineRxFn(E, "legacyOctal", [], [I32], (L) => {
    const V = L.add("v");
    const N = L.add("n");
    const CH = L.add("ch");
    const NV = L.add("nv");
    return [
      ...whileLoop("oct", lt(get(N), c(3)), [
        ...set(CH, call(fn.peek, ST)),
        ...if_(eqz(between(get(CH), 0x30, 0x37)), brk("oct")),
        ...set(NV, add(mul(get(V), c(8)), sub(get(CH), c(0x30)))),
        ...if_(gt(get(NV), c(0o377)), brk("oct")),
        ...advance(E),
        ...set(V, get(NV)),
        ...inc(N),
      ]),
      ...get(V),
    ];
  });

  defineSortMerge(E);
  defineComplement(E);

  // classNode(st, kind, start, negated) -> node over the pool pairs from
  // `start` to the pool end, canonicalised (sorted, merged).
  defineRxFn(E, "classNode", [I32, I32, I32], [I32], (L) => {
    const END = L.add("end");
    const N = L.add("n");
    return [
      ...set(END, call(fn.sortMerge, ST, get(2), sg(E, F_RLEN))),
      ...ss(E, F_RLEN, get(END)),
      ...set(N, call(fn.node, ST, get(1), get(2), shrU(sub(get(END), get(2)), c(1)), get(3))),
      ...nset(E, get(N), N_CHILD, c(-1)),
      ...get(N),
    ];
  });

  // uChar(st, cp) -> node for one u-mode literal code point. A lone
  // surrogate is a one-code-point class so the VM's pair guard applies.
  defineRxFn(E, "uChar", [I32], [I32], (L) => {
    const S = L.add("s");
    return [
      ...if_(between(get(1), 0xd800, 0xdfff), [
        ...set(S, sg(E, F_RLEN)),
        ...call(fn.range, ST, get(1), get(1)),
        ...ret(call(fn.classNode, ST, c(K_CPCLASS), get(S), c(0))),
      ]),
      ...call(fn.node, ST, c(K_CHAR), get(1), c(0), c(0)),
    ];
  });

  // foldRange(st, lo, hi): append [lo, hi] plus its case images under the
  // parse-time `i` state (ASCII exact; u mode adds U+212A/U+017F for k/s).
  defineRxFn(E, "foldRange", [I32, I32], [], (L) => {
    const LO = 1;
    const HI = 2;
    const A = L.add("a");
    const B = L.add("b");
    const contains = (cp: number): X => allOf(le(get(LO), c(cp)), ge(get(HI), c(cp)));
    return [
      ...call(fn.range, ST, get(LO), get(HI)),
      ...if_(eqz(sg(E, F_PCI)), ret()),
      ...if_(unsafeForFold(get(LO), get(HI)), bail(E, ERR_UNSUPPORTED)),
      ...set(A, sel(I32, gt(get(LO), c(0x41)), get(LO), c(0x41))),
      ...set(B, sel(I32, lt(get(HI), c(0x5a)), get(HI), c(0x5a))),
      ...if_(le(get(A), get(B)), call(fn.range, ST, add(get(A), c(0x20)), add(get(B), c(0x20)))),
      ...set(A, sel(I32, gt(get(LO), c(0x61)), get(LO), c(0x61))),
      ...set(B, sel(I32, lt(get(HI), c(0x7a)), get(HI), c(0x7a))),
      ...if_(le(get(A), get(B)), call(fn.range, ST, sub(get(A), c(0x20)), sub(get(B), c(0x20)))),
      ...if_(sg(E, F_UMODE), [
        ...if_(or(contains(0x4b), contains(0x6b)), call(fn.range, ST, c(0x212a), c(0x212a))),
        ...if_(or(contains(0x53), contains(0x73)), call(fn.range, ST, c(0x17f), c(0x17f))),
      ]),
    ];
  });

  // classOffset(st, start, count) -> class-table offset of a copy of the
  // `count` pool pairs at `start` (layout: [count, lo0, hi0, …]).
  defineRxFn(E, "classOffset", [I32, I32], [I32], (L) => {
    const OFF = L.add("off");
    const I = L.add("i");
    return [
      ...set(OFF, sg(E, F_CLEN)),
      ...ss(E, F_CTAB, call(fn.grow, sg(E, F_CTAB), add(add(get(OFF), c(1)), mul(get(2), c(2))))),
      ...as(E, sg(E, F_CTAB), get(OFF), get(2)),
      ...whileLoop("copy", lt(get(I), mul(get(2), c(2))), [
        ...as(E, sg(E, F_CTAB), add(add(get(OFF), c(1)), get(I)), ag(E, sg(E, F_RP), add(get(1), get(I)))),
        ...inc(I),
      ]),
      ...ss(E, F_CLEN, add(add(get(OFF), c(1)), mul(get(2), c(2)))),
      ...get(OFF),
    ];
  });
}

/** sortMerge(st, start, end) -> new end: insertion-sort the pool pairs in
 *  [start, end) by (lo, hi) and coalesce overlapping/adjacent ranges. */
function defineSortMerge(E: RxEnv): void {
  defineRxFn(E, "sortMerge", [I32, I32], [I32], (L) => {
    const START = 1;
    const END = 2;
    const I = L.add("i");
    const J = L.add("j");
    const LO = L.add("lo");
    const HI = L.add("hi");
    const W = L.add("w");
    const rp = (index: X): X => ag(E, sg(E, F_RP), index);
    const put = (index: X, value: X): X => as(E, sg(E, F_RP), index, value);
    return [
      ...if_(le(get(END), get(START)), ret(get(START))),
      ...set(I, add(get(START), c(2))),
      ...whileLoop("outer", lt(get(I), get(END)), [
        ...set(LO, rp(get(I))),
        ...set(HI, rp(add(get(I), c(1)))),
        ...set(J, get(I)),
        ...whileLoop(
          "shift",
          andThen(
            gt(get(J), get(START)),
            or(
              gt(rp(sub(get(J), c(2))), get(LO)),
              allOf(eq(rp(sub(get(J), c(2))), get(LO)), gt(rp(sub(get(J), c(1))), get(HI))),
            ),
          ),
          [
            ...put(get(J), rp(sub(get(J), c(2)))),
            ...put(add(get(J), c(1)), rp(sub(get(J), c(1)))),
            ...set(J, sub(get(J), c(2))),
          ],
        ),
        ...put(get(J), get(LO)),
        ...put(add(get(J), c(1)), get(HI)),
        ...inc(I, 2),
      ]),
      ...set(W, get(START)),
      ...set(I, add(get(START), c(2))),
      ...whileLoop("merge", lt(get(I), get(END)), [
        ...if_(
          le(rp(get(I)), add(rp(add(get(W), c(1))), c(1))),
          if_(gt(rp(add(get(I), c(1))), rp(add(get(W), c(1)))), put(add(get(W), c(1)), rp(add(get(I), c(1))))),
          [...inc(W, 2), ...put(get(W), rp(get(I))), ...put(add(get(W), c(1)), rp(add(get(I), c(1))))],
        ),
        ...inc(I, 2),
      ]),
      ...add(get(W), c(2)),
    ];
  });
}

/** complementFrom(st, start): replace the pool pairs from `start` to the pool
 *  end with their complement over [0, maxUnit]. */
function defineComplement(E: RxEnv): void {
  const { fn } = E;
  defineRxFn(E, "complementFrom", [I32], [], (L) => {
    const START = 1;
    const END = L.add("end");
    const NEXT = L.add("next");
    const I = L.add("i");
    const LO = L.add("lo");
    const MAX = L.add("max");
    const rp = (index: X): X => ag(E, sg(E, F_RP), index);
    return [
      ...set(MAX, maxUnit(E)),
      ...set(END, call(fn.sortMerge, ST, get(START), sg(E, F_RLEN))),
      ...ss(E, F_RLEN, get(END)),
      ...set(I, get(START)),
      ...whileLoop("walk", lt(get(I), get(END)), [
        ...set(LO, rp(get(I))),
        ...if_(gt(get(LO), get(NEXT)), call(fn.range, ST, get(NEXT), sub(get(LO), c(1)))),
        ...set(NEXT, add(rp(add(get(I), c(1))), c(1))),
        ...inc(I, 2),
      ]),
      ...if_(le(get(NEXT), get(MAX)), call(fn.range, ST, get(NEXT), get(MAX))),
      // Move the complement (appended after END) down to START.
      ...sg(E, F_RP),
      ...get(START),
      ...sg(E, F_RP),
      ...get(END),
      ...sub(sg(E, F_RLEN), get(END)),
      { op: "array.copy", dstTypeIdx: E.arr, srcTypeIdx: E.arr },
      ...ss(E, F_RLEN, add(get(START), sub(sg(E, F_RLEN), get(END)))),
    ];
  });
}

/** `ch` is an ASCII letter. */
export const isAsciiLetter = (ch: X): X => or(between(ch, 0x41, 0x5a), between(ch, 0x61, 0x7a));
/** `ch` is an ASCII decimal digit. */
export const isDigit = (ch: X): X => between(ch, 0x30, 0x39);
/** Bail with a SyntaxError. */
export const syntax = (E: RxEnv): X => bail(E, ERR_SYNTAX);
/** Bail as unsupported. */
export const unsupported = (E: RxEnv): X => bail(E, ERR_UNSUPPORTED);
/** peek() result. */
export const peek = (E: RxEnv): X => call(E.fn.peek, ST);
export const peekAt = (E: RxEnv, k: number): X => call(E.fn.peekAt, ST, c(k));
/** Node kind read. */
export const kindOf = (E: RxEnv, node: X): X => nf(E, node, 0);
