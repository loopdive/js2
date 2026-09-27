// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6677 — the recursive-descent PARSER of the runtime RegExp compiler, as Wasm.
 *
 * A line-for-line port of the grammar in `regex/parse.ts` (ES2024 §22.2.1 +
 * Annex B.1.2) that builds the flat AST described in `env.ts`. Differences
 * from the compile-time parser are deliberate and all on the refusing side:
 * anything whose answer depends on Unicode data the runtime does not carry
 * (non-ASCII case folding, properties other than General_Category, `v` mode)
 * bails with ERR_UNSUPPORTED — a catchable TypeError on first use — never a
 * wrong match. ERR_SYNTAX is reserved for patterns the spec rejects outright.
 */
import {
  F_HASNAMES,
  F_NAMES,
  F_NCAP,
  F_PCI,
  F_PDOTALL,
  F_POS,
  F_RLEN,
  F_SLEN,
  F_TCAP,
  F_T0,
  F_T1,
  F_UMODE,
  K_ALT,
  K_ANY,
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
  MAX_REPEAT,
  N_B,
  N_CHILD,
  N_NEXT,
  ST,
  ag,
  as,
  advance,
  defineRxFn,
  nf,
  nset,
  sg,
  src,
  ss,
  type RxEnv,
} from "./env.js";
import {
  I32,
  add,
  allOf,
  anyOf,
  between,
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
  le,
  lt,
  mul,
  ne,
  or,
  ret,
  sel,
  set,
  sub,
  whileLoop,
  type X,
} from "./dsl.js";
import { isAsciiLetter, isDigit, kindOf, peek, peekAt, syntax, unsupported } from "./core.js";
import { RE_FLAG_I, RE_FLAG_M, RE_FLAG_S } from "../regex/bytecode.js";

const ch = (s: string): number => s.charCodeAt(0);
const is = (v: X, ...chars: string[]): X => anyOf(...chars.map((s) => eq(v, c(ch(s)))));
const identStart = (v: X): X => anyOf(isAsciiLetter(v), eq(v, c(0x24)), eq(v, c(0x5f)));
const identPart = (v: X): X => or(identStart(v), isDigit(v));

export function defineParser(E: RxEnv): void {
  defineNames(E);
  defineStructure(E);
  defineAtom(E);
  defineGroup(E);
  defineEscape(E);
  defineEscapeUnit(E);
  defineClass(E);
}

/** Group names: parseName, nameIndex, scanGroups. */
function defineNames(E: RxEnv): void {
  const { fn } = E;
  // parseName(st) -> start; consumes `name>`; T0 = name length.
  defineRxFn(E, "parseName", [], [I32], (L) => {
    const START = L.add("start");
    const CH = L.add("ch");
    return [
      ...set(START, sg(E, F_POS)),
      ...whileLoop("name", c(1), [
        ...set(CH, peek(E)),
        ...if_(eq(get(CH), c(0x3e)), brk("name")),
        ...if_(lt(get(CH), c(0)), syntax(E)),
        // Escaped or non-ASCII names need the ID_Start/ID_Continue tables.
        ...if_(or(eq(get(CH), c(0x5c)), ge(get(CH), c(0x80))), unsupported(E)),
        ...if_(eqz(sel(I32, eq(sg(E, F_POS), get(START)), identStart(get(CH)), identPart(get(CH)))), syntax(E)),
        ...advance(E),
      ]),
      ...if_(eq(sg(E, F_POS), get(START)), syntax(E)),
      ...ss(E, F_T0, sub(sg(E, F_POS), get(START))),
      ...advance(E),
      ...get(START),
    ];
  });

  // nameIndex(st, start, len, limit) -> capture index 1..limit named so, or -1.
  defineRxFn(E, "nameIndex", [I32, I32, I32], [I32], (L) => {
    const K = L.add("k");
    const I = L.add("i");
    const S = L.add("s");
    const names = (index: X): X => ag(E, sg(E, F_NAMES), index);
    return [
      ...set(K, c(1)),
      ...whileLoop("groups", le(get(K), get(3)), [
        ...if_(eq(names(add(mul(get(K), c(2)), c(1))), get(2)), [
          ...set(S, names(mul(get(K), c(2)))),
          ...set(I, c(0)),
          ...whileLoop("chars", lt(get(I), get(2)), [
            ...if_(ne(src(E, add(get(S), get(I))), src(E, add(get(1), get(I)))), brk("chars")),
            ...inc(I),
          ]),
          ...if_(eq(get(I), get(2)), ret(get(K))),
        ]),
        ...inc(K),
      ]),
      ...c(-1),
    ];
  });

  // scanGroups(st): total capture count + named-group table, before parsing
  // (a decimal escape is a backreference only up to the TOTAL count, and
  // `\k<name>` may reference a later group).
  defineRxFn(E, "scanGroups", [], [], (L) => {
    const COUNT = L.add("count");
    const IN_CLASS = L.add("inClass");
    const CH = L.add("ch");
    const START = L.add("start");
    return [
      ...ss(E, F_POS, c(0)),
      ...whileLoop("scan", lt(sg(E, F_POS), sg(E, F_SLEN)), [
        ...set(CH, peek(E)),
        ...if_(eq(get(CH), c(0x5c)), [...advance(E, 2), ...cont("scan")]),
        ...if_(get(IN_CLASS), [...if_(eq(get(CH), c(0x5d)), set(IN_CLASS, c(0))), ...advance(E), ...cont("scan")]),
        ...if_(eq(get(CH), c(0x5b)), set(IN_CLASS, c(1))),
        ...if_(eq(get(CH), c(0x28)), [
          ...if_(
            eq(peekAt(E, 1), c(0x3f)),
            if_(allOf(eq(peekAt(E, 2), c(0x3c)), ne(peekAt(E, 3), c(0x3d)), ne(peekAt(E, 3), c(0x21))), [
              ...inc(COUNT),
              ...advance(E, 3),
              ...set(START, call(fn.parseName, ST)),
              // Grow first: nameIndex reads every earlier slot, including the
              // zero (unnamed) slots of preceding plain groups.
              ...ss(E, F_NAMES, call(fn.grow, sg(E, F_NAMES), mul(add(get(COUNT), c(1)), c(2)))),
              // Duplicate names (ES2025, alternative-scoped) stay refused.
              ...if_(ge(call(fn.nameIndex, ST, get(START), sg(E, F_T0), sub(get(COUNT), c(1))), c(0)), unsupported(E)),
              ...as(E, sg(E, F_NAMES), mul(get(COUNT), c(2)), get(START)),
              ...as(E, sg(E, F_NAMES), add(mul(get(COUNT), c(2)), c(1)), sg(E, F_T0)),
              ...ss(E, F_HASNAMES, c(1)),
              ...cont("scan"),
            ]),
            inc(COUNT),
          ),
        ]),
        ...advance(E),
      ]),
      ...ss(E, F_TCAP, get(COUNT)),
      ...ss(E, F_NAMES, call(fn.grow, sg(E, F_NAMES), mul(add(get(COUNT), c(1)), c(2)))),
      ...ss(E, F_POS, c(0)),
    ];
  });
}

/** Disjunction / alternative / quantified term. */
function defineStructure(E: RxEnv): void {
  const { fn } = E;
  // parseAlt(st) -> node (Disjunction). Each alternative is a CAT node.
  defineRxFn(E, "parseAlt", [], [I32], (L) => {
    const ALT = L.add("alt");
    const LAST_OPT = L.add("lastOpt");
    const CAT = L.add("cat");
    const LAST = L.add("last");
    const T = L.add("t");
    const P = L.add("p");
    return [
      ...set(ALT, call(fn.node, ST, c(K_ALT), c(0), c(0), c(0))),
      ...set(LAST_OPT, c(-1)),
      ...whileLoop("opts", c(1), [
        ...set(CAT, call(fn.node, ST, c(K_CAT), c(0), c(0), c(0))),
        ...set(LAST, c(-1)),
        ...whileLoop("terms", c(1), [
          ...set(P, peek(E)),
          ...if_(anyOf(lt(get(P), c(0)), eq(get(P), c(0x7c)), eq(get(P), c(0x29))), brk("terms")),
          ...set(T, call(fn.parseTerm, ST)),
          ...if_(lt(get(LAST), c(0)), nset(E, get(CAT), N_CHILD, get(T)), nset(E, get(LAST), N_NEXT, get(T))),
          ...set(LAST, get(T)),
        ]),
        ...if_(lt(get(LAST_OPT), c(0)), nset(E, get(ALT), N_CHILD, get(CAT)), nset(E, get(LAST_OPT), N_NEXT, get(CAT))),
        ...set(LAST_OPT, get(CAT)),
        ...if_(ne(peek(E), c(0x7c)), brk("opts")),
        ...advance(E),
      ]),
      ...if_(lt(nf(E, nf(E, get(ALT), N_CHILD), N_NEXT), c(0)), ret(nf(E, get(ALT), N_CHILD))),
      ...get(ALT),
    ];
  });

  // braceQuant(st) -> 1 and consumes `{n}` / `{n,}` / `{n,m}` (T0 = min,
  // T1 = max or -1); 0 without consuming when the brace is no quantifier.
  defineRxFn(E, "braceQuant", [], [I32], (L) => {
    const SAVE = L.add("save");
    const MIN = L.add("min");
    const MAX = L.add("max");
    const CH = L.add("ch");
    const N = L.add("n");
    const digits = (target: number): X => [
      ...set(target, c(0)),
      ...set(N, c(0)),
      ...whileLoop(`d${target}`, isDigit(tee_(CH, peek(E))), [
        ...if_(lt(get(target), c(100000)), set(target, add(mul(get(target), c(10)), sub(get(CH), c(0x30))))),
        ...inc(N),
        ...advance(E),
      ]),
    ];
    const fail: X = [...ss(E, F_POS, get(SAVE)), ...ret(c(0))];
    return [
      ...set(SAVE, sg(E, F_POS)),
      ...advance(E),
      ...digits(MIN),
      ...if_(eqz(get(N)), fail),
      ...set(MAX, get(MIN)),
      ...if_(eq(peek(E), c(0x2c)), [...advance(E), ...digits(MAX), ...if_(eqz(get(N)), set(MAX, c(-1)))]),
      ...if_(ne(peek(E), c(0x7d)), fail),
      ...advance(E),
      ...if_(allOf(ge(get(MAX), c(0)), lt(get(MAX), get(MIN))), syntax(E)),
      ...ss(E, F_T0, get(MIN)),
      ...ss(E, F_T1, get(MAX)),
      ...c(1),
    ];
  });

  // parseTerm(st) -> node: an atom plus its optional quantifier.
  defineRxFn(E, "parseTerm", [], [I32], (L) => {
    const ATOM = L.add("atom");
    const K = L.add("k");
    const Q = L.add("q"); // 1 * · 2 + · 3 ? · 4 {…}
    const P = L.add("p");
    const GREEDY = L.add("greedy");
    const wrap = (kind: number): X => [
      ...set(P, call(fn.node, ST, c(kind), get(GREEDY), c(0), c(0))),
      ...nset(E, get(P), N_CHILD, get(ATOM)),
      ...ret(get(P)),
    ];
    return [
      ...set(ATOM, call(fn.parseAtom, ST)),
      ...set(K, kindOf(E, get(ATOM))),
      ...set(P, peek(E)),
      ...if_(eq(get(P), c(0x2a)), set(Q, c(1))),
      ...if_(eq(get(P), c(0x2b)), set(Q, c(2))),
      ...if_(eq(get(P), c(0x3f)), set(Q, c(3))),
      ...if_(eq(get(P), c(0x7b)), if_(call(fn.braceQuant, ST), set(Q, c(4)), if_(sg(E, F_UMODE), syntax(E)))),
      ...if_(eqz(get(Q)), ret(get(ATOM))),
      ...if_(ne(get(Q), c(4)), advance(E)),
      ...set(GREEDY, c(1)),
      ...if_(eq(peek(E), c(0x3f)), [...advance(E), ...set(GREEDY, c(0))]),
      // Assertions are not quantifiable; Annex B exempts non-u lookahead only.
      ...if_(
        anyOf(
          eq(get(K), c(K_BOL)),
          eq(get(K), c(K_EOL)),
          eq(get(K), c(K_WB)),
          allOf(eq(get(K), c(K_LOOK)), or(nf(E, get(ATOM), N_B), sg(E, F_UMODE))),
        ),
        syntax(E),
      ),
      // Annex B QuantifiableAssertion: a zero-width lookahead is idempotent at
      // a position, so X* / X{0,…} ≡ X? and X+ / X{n≥1,…} ≡ X.
      ...if_(eq(get(K), c(K_LOOK)), [
        ...if_(eq(get(Q), c(2)), ret(get(ATOM))),
        ...if_(eq(get(Q), c(4)), [
          ...if_(eqz(sg(E, F_T1)), ret(call(fn.node, ST, c(K_CAT), c(0), c(0), c(0)))),
          ...if_(ge(sg(E, F_T0), c(1)), ret(get(ATOM))),
        ]),
        ...wrap(K_OPT),
      ]),
      ...if_(eq(get(Q), c(1)), wrap(K_STAR)),
      ...if_(eq(get(Q), c(2)), wrap(K_PLUS)),
      ...if_(eq(get(Q), c(3)), wrap(K_OPT)),
      ...if_(or(gt(sg(E, F_T0), c(MAX_REPEAT)), gt(sg(E, F_T1), c(MAX_REPEAT))), unsupported(E)),
      ...set(P, call(fn.node, ST, c(K_REP), sg(E, F_T0), sg(E, F_T1), get(GREEDY))),
      ...nset(E, get(P), N_CHILD, get(ATOM)),
      ...get(P),
    ];
  });
}

const tee_ = (index: number, value: X): X => [...value, { op: "local.tee", index }];

/** parseAtom(st) -> node. */
function defineAtom(E: RxEnv): void {
  const { fn } = E;
  defineRxFn(E, "parseAtom", [], [I32], (L) => {
    const P = L.add("p");
    const S = L.add("s");
    const leaf = (kind: number): X => ret(call(fn.node, ST, c(kind), c(0), c(0), c(0)));
    return [
      ...set(P, peek(E)),
      ...if_(eq(get(P), c(0x28)), ret(call(fn.parseGroup, ST))),
      ...if_(eq(get(P), c(0x5b)), ret(call(fn.parseClass, ST))),
      ...if_(eq(get(P), c(0x2e)), [
        ...advance(E),
        ...if_(eqz(sg(E, F_UMODE)), leaf(K_ANY)),
        // u-mode `.` is one CODE POINT: a class over all code points minus
        // the line terminators (unless the parse-time dotAll state is on).
        ...set(S, sg(E, F_RLEN)),
        ...if_(sg(E, F_PDOTALL), call(fn.range, ST, c(0), c(0x10ffff)), [
          ...call(fn.range, ST, c(0), c(0x09)),
          ...call(fn.range, ST, c(0x0b), c(0x0c)),
          ...call(fn.range, ST, c(0x0e), c(0x2027)),
          ...call(fn.range, ST, c(0x202a), c(0x10ffff)),
        ]),
        ...ret(call(fn.classNode, ST, c(K_CPCLASS), get(S), c(0))),
      ]),
      ...if_(eq(get(P), c(0x5e)), [...advance(E), ...leaf(K_BOL)]),
      ...if_(eq(get(P), c(0x24)), [...advance(E), ...leaf(K_EOL)]),
      ...if_(eq(get(P), c(0x5c)), [...advance(E), ...ret(call(fn.parseEscape, ST))]),
      ...if_(is(get(P), "*", "+", "?"), syntax(E)),
      ...if_(eq(get(P), c(0x7b)), [
        ...if_(sg(E, F_UMODE), syntax(E)),
        // `{1}` with nothing before it is "nothing to repeat" even in Annex B.
        ...if_(call(fn.braceQuant, ST), syntax(E)),
      ]),
      ...if_(allOf(is(get(P), "}", "]"), sg(E, F_UMODE)), syntax(E)),
      ...if_(sg(E, F_UMODE), ret(call(fn.uChar, ST, call(fn.readCp, ST)))),
      ...advance(E),
      ...call(fn.node, ST, c(K_CHAR), get(P), c(0), c(0)),
    ];
  });
}

/** parseGroup(st) -> node for `(…)`, `(?:…)`, `(?<name>…)`, lookarounds and
 *  modifier groups. */
function defineGroup(E: RxEnv): void {
  const { fn } = E;
  defineRxFn(E, "parseGroup", [], [I32], (L) => {
    const MODE = L.add("mode"); // 0 capture · 1 non-capturing · 2 lookaround · 3 modifiers
    const CAP = L.add("cap");
    const NEG = L.add("neg");
    const BEHIND = L.add("behind");
    const ADDF = L.add("addFlags");
    const REMF = L.add("removeFlags");
    const T = L.add("t");
    const BIT = L.add("bit");
    const SAVED_CI = L.add("savedCi");
    const SAVED_DOT = L.add("savedDot");
    const INNER = L.add("inner");
    const N = L.add("n");
    const flagBit = (v: X): X =>
      sel(
        I32,
        eq(v, c(ch("i"))),
        c(RE_FLAG_I),
        sel(I32, eq(v, c(ch("m"))), c(RE_FLAG_M), sel(I32, eq(v, c(ch("s"))), c(RE_FLAG_S), c(0))),
      );
    const readFlags = (target: number, forbid: X, label: string): X =>
      whileLoop(label, allOf(ne(set_t(T, peek(E)), c(0x3a)), ne(get(T), c(0x2d)), ge(get(T), c(0))), [
        ...set(BIT, flagBit(get(T))),
        ...if_(or(eqz(get(BIT)), and_(get(BIT), forbid)), syntax(E)),
        ...set(target, or(get(target), get(BIT))),
        ...advance(E),
      ]);
    return [
      ...advance(E),
      ...set(CAP, c(-1)),
      ...if_(
        eq(peek(E), c(0x3f)),
        [
          ...advance(E),
          ...set(T, peek(E)),
          ...if_(
            eq(get(T), c(0x3a)),
            [...advance(E), ...set(MODE, c(1))],
            if_(
              is(get(T), "=", "!"),
              [...advance(E), ...set(MODE, c(2)), ...set(NEG, eq(get(T), c(0x21)))],
              if_(
                eq(get(T), c(0x3c)),
                [
                  ...advance(E),
                  ...set(T, peek(E)),
                  ...if_(
                    is(get(T), "=", "!"),
                    [...advance(E), ...set(MODE, c(2)), ...set(BEHIND, c(1)), ...set(NEG, eq(get(T), c(0x21)))],
                    [
                      ...ss(E, F_NCAP, add(sg(E, F_NCAP), c(1))),
                      ...set(CAP, sg(E, F_NCAP)),
                      ...set(T, call(fn.parseName, ST)),
                    ],
                  ),
                ],
                if_(
                  is(get(T), "i", "m", "s", "-"),
                  [
                    ...set(MODE, c(3)),
                    ...readFlags(ADDF, get(ADDF), "add"),
                    ...if_(eq(peek(E), c(0x2d)), [
                      ...advance(E),
                      ...readFlags(REMF, or(get(ADDF), get(REMF)), "remove"),
                    ]),
                    ...if_(ne(peek(E), c(0x3a)), syntax(E)),
                    ...advance(E),
                    ...if_(eqz(or(get(ADDF), get(REMF))), syntax(E)),
                  ],
                  syntax(E),
                ),
              ),
            ),
          ),
        ],
        [...ss(E, F_NCAP, add(sg(E, F_NCAP), c(1))), ...set(CAP, sg(E, F_NCAP))],
      ),
      // The parse-time i/s state scopes over a modifier group's body (class
      // folding and u-mode dot are resolved while parsing).
      ...set(SAVED_CI, sg(E, F_PCI)),
      ...set(SAVED_DOT, sg(E, F_PDOTALL)),
      ...if_(eq(get(MODE), c(3)), [
        ...if_(and_(get(ADDF), c(RE_FLAG_I)), ss(E, F_PCI, c(1))),
        ...if_(and_(get(REMF), c(RE_FLAG_I)), ss(E, F_PCI, c(0))),
        ...if_(and_(get(ADDF), c(RE_FLAG_S)), ss(E, F_PDOTALL, c(1))),
        ...if_(and_(get(REMF), c(RE_FLAG_S)), ss(E, F_PDOTALL, c(0))),
      ]),
      ...set(INNER, call(fn.parseAlt, ST)),
      ...ss(E, F_PCI, get(SAVED_CI)),
      ...ss(E, F_PDOTALL, get(SAVED_DOT)),
      ...if_(ne(peek(E), c(0x29)), syntax(E)),
      ...advance(E),
      ...if_(eq(get(MODE), c(1)), ret(get(INNER))),
      ...set(
        N,
        sel(
          I32,
          eq(get(MODE), c(2)),
          call(fn.node, ST, c(K_LOOK), get(NEG), get(BEHIND), c(0)),
          sel(
            I32,
            eq(get(MODE), c(3)),
            call(fn.node, ST, c(K_MOD), get(ADDF), get(REMF), c(0)),
            call(fn.node, ST, c(K_GROUP), get(CAP), c(0), c(0)),
          ),
        ),
      ),
      ...nset(E, get(N), N_CHILD, get(INNER)),
      ...get(N),
    ];
  });
}

const set_t = (index: number, value: X): X => [...value, { op: "local.tee", index }];
const and_ = (a: X, b: X): X => [...a, ...b, { op: "i32.and" }];

/** parseEscape(st) -> node for an AtomEscape (the `\` is consumed). */
function defineEscape(E: RxEnv): void {
  const { fn } = E;
  defineRxFn(E, "parseEscape", [], [I32], (L) => {
    const EC = L.add("e");
    const S = L.add("s");
    const SAVE = L.add("save");
    const V = L.add("v");
    const LOWER = L.add("lower");
    const classKind = sel(I32, sg(E, F_UMODE), c(K_CPCLASS), c(K_CLASS));
    return [
      ...set(EC, peek(E)),
      ...if_(lt(get(EC), c(0)), syntax(E)),
      ...if_(is(get(EC), "d", "D", "w", "W", "s", "S"), [
        ...advance(E),
        ...set(LOWER, or(get(EC), c(0x20))),
        ...set(S, sg(E, F_RLEN)),
        ...call(fn.shorthand, ST, get(LOWER), c(0)),
        ...ret(call(fn.classNode, ST, classKind, get(S), ne(get(EC), get(LOWER)))),
      ]),
      ...if_(is(get(EC), "b", "B"), [
        ...advance(E),
        ...ret(call(fn.node, ST, c(K_WB), eq(get(EC), c(0x42)), c(0), c(0))),
      ]),
      ...if_(between(get(EC), 0x31, 0x39), [
        ...set(SAVE, sg(E, F_POS)),
        ...whileLoop("dec", isDigit(set_t(S, peek(E))), [
          ...if_(lt(get(V), c(100000)), set(V, add(mul(get(V), c(10)), sub(get(S), c(0x30))))),
          ...advance(E),
        ]),
        ...if_(le(get(V), sg(E, F_TCAP)), ret(call(fn.node, ST, c(7 /* K_BACKREF */), get(V), c(0), c(0)))),
        ...if_(sg(E, F_UMODE), syntax(E)),
        ...ss(E, F_POS, get(SAVE)),
        ...if_(ge(get(EC), c(0x38)), [...advance(E), ...ret(call(fn.node, ST, c(K_CHAR), get(EC), c(0), c(0)))]),
        ...ret(call(fn.node, ST, c(K_CHAR), call(fn.legacyOctal, ST), c(0), c(0))),
      ]),
      ...if_(eq(get(EC), c(0x6b)), [
        ...if_(sg(E, F_HASNAMES), [
          ...advance(E),
          ...if_(ne(peek(E), c(0x3c)), syntax(E)),
          ...advance(E),
          ...set(S, call(fn.parseName, ST)),
          ...set(V, call(fn.nameIndex, ST, get(S), sg(E, F_T0), sg(E, F_TCAP))),
          ...if_(lt(get(V), c(0)), syntax(E)),
          ...ret(call(fn.node, ST, c(7 /* K_BACKREF */), get(V), c(0), c(0))),
        ]),
        ...if_(sg(E, F_UMODE), syntax(E)),
        ...advance(E),
        ...ret(call(fn.node, ST, c(K_CHAR), c(0x6b), c(0), c(0))),
      ]),
      ...if_(is(get(EC), "p", "P"), [
        ...if_(sg(E, F_UMODE), [
          ...set(S, sg(E, F_RLEN)),
          ...call(fn.property, ST),
          ...ret(call(fn.classNode, ST, c(K_CPCLASS), get(S), eq(get(EC), c(0x50)))),
        ]),
        // Annex B: `\p` outside u mode is the identity escape `p`.
        ...advance(E),
        ...ret(call(fn.node, ST, c(K_CHAR), get(EC), c(0), c(0))),
      ]),
      ...set(V, call(fn.escapeUnit, ST, c(0))),
      ...if_(sg(E, F_UMODE), ret(call(fn.uChar, ST, get(V)))),
      ...call(fn.node, ST, c(K_CHAR), get(V), c(0), c(0)),
    ];
  });
}

/** escapeUnit(st, inClass) -> the character value of a CharacterEscape (the
 *  cursor sits on the escape letter; consumes it). */
function defineEscapeUnit(E: RxEnv): void {
  const { fn } = E;
  defineRxFn(E, "escapeUnit", [I32], [I32], (L) => {
    const IN_CLASS = 1;
    const EC = L.add("e");
    const V = L.add("v");
    const T = L.add("t");
    const N = L.add("n");
    const D = L.add("d");
    const U = sg(E, F_UMODE);
    const simple = (from: string, value: number): X => if_(eq(get(EC), c(ch(from))), ret(c(value)));
    return [
      ...set(EC, peek(E)),
      ...advance(E),
      ...simple("n", 0x0a),
      ...simple("r", 0x0d),
      ...simple("t", 0x09),
      ...simple("f", 0x0c),
      ...simple("v", 0x0b),
      ...if_(eq(get(EC), c(0x30)), [
        ...if_(U, [...if_(isDigit(peek(E)), syntax(E)), ...ret(c(0))]),
        ...ss(E, F_POS, sub(sg(E, F_POS), c(1))),
        ...ret(call(fn.legacyOctal, ST)),
      ]),
      ...if_(between(get(EC), 0x31, 0x37), [
        ...if_(U, syntax(E)),
        ...ss(E, F_POS, sub(sg(E, F_POS), c(1))),
        ...ret(call(fn.legacyOctal, ST)),
      ]),
      ...if_(between(get(EC), 0x38, 0x39), [...if_(U, syntax(E)), ...ret(get(EC))]),
      ...if_(eq(get(EC), c(0x63)), [
        ...set(T, peek(E)),
        ...if_(isAsciiLetter(get(T)), [...advance(E), ...ret(and_(get(T), c(31)))]),
        ...if_(allOf(get(IN_CLASS), eqz(U), or(isDigit(get(T)), eq(get(T), c(0x5f)))), [
          ...advance(E),
          ...ret(and_(get(T), c(31))),
        ]),
        ...if_(U, syntax(E)),
        // Annex B: `\c` without a control letter is a literal backslash; the
        // `c` is re-read as an ordinary atom.
        ...ss(E, F_POS, sub(sg(E, F_POS), c(1))),
        ...ret(c(0x5c)),
      ]),
      ...if_(eq(get(EC), c(0x78)), [
        ...set(V, call(fn.hex, ST, c(2))),
        ...if_(ge(get(V), c(0)), [...ss(E, F_POS, add(sg(E, F_POS), c(2))), ...ret(get(V))]),
        ...if_(U, syntax(E)),
        ...ret(c(0x78)),
      ]),
      ...if_(eq(get(EC), c(0x75)), [
        ...if_(allOf(U, eq(peek(E), c(0x7b))), [
          ...advance(E),
          ...whileLoop("cp", ge(set_t(D, call(fn.hex, ST, c(1))), c(0)), [
            ...set(V, add(mul(get(V), c(16)), get(D))),
            ...if_(gt(get(V), c(0x10ffff)), syntax(E)),
            ...advance(E),
            ...inc(N),
          ]),
          ...if_(or(eqz(get(N)), ne(peek(E), c(0x7d))), syntax(E)),
          ...advance(E),
          ...ret(get(V)),
        ]),
        ...set(V, call(fn.hex, ST, c(4))),
        ...if_(lt(get(V), c(0)), [...if_(U, syntax(E)), ...ret(c(0x75))]),
        ...ss(E, F_POS, add(sg(E, F_POS), c(4))),
        // u mode: an escaped lead surrogate followed by an escaped trail
        // surrogate is ONE code point.
        ...if_(allOf(U, between(get(V), 0xd800, 0xdbff), eq(peek(E), c(0x5c)), eq(peekAt(E, 1), c(0x75))), [
          ...ss(E, F_POS, add(sg(E, F_POS), c(2))),
          ...set(T, call(fn.hex, ST, c(4))),
          ...if_(between(get(T), 0xdc00, 0xdfff), [
            ...ss(E, F_POS, add(sg(E, F_POS), c(4))),
            ...ret(add(add(c(0x10000), mul(sub(get(V), c(0xd800)), c(0x400))), sub(get(T), c(0xdc00)))),
          ]),
          ...ss(E, F_POS, sub(sg(E, F_POS), c(2))),
        ]),
        ...ret(get(V)),
      ]),
      ...if_(eq(get(EC), c(0x2d)), [...if_(allOf(U, eqz(get(IN_CLASS))), syntax(E)), ...ret(c(0x2d))]),
      ...if_(U, [
        ...if_(is(get(EC), "^", "$", "\\", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "/"), ret(get(EC))),
        ...syntax(E),
      ]),
      // Annex B IdentityEscape excludes `k` when the pattern has named groups.
      ...if_(allOf(eq(get(EC), c(0x6b)), sg(E, F_HASNAMES)), syntax(E)),
      ...get(EC),
    ];
  });
}

/** parseClass / classAtom / shorthand. */
function defineClass(E: RxEnv): void {
  const { fn } = E;
  const U = sg(E, F_UMODE);
  // parseClass(st) -> CLASS/CPCLASS node for `[…]`.
  defineRxFn(E, "parseClass", [], [I32], (L) => {
    const NEG = L.add("neg");
    const START = L.add("start");
    const LO = L.add("lo");
    const HI = L.add("hi");
    const P = L.add("p");
    const dashRange: X = allOf(eq(peek(E), c(0x2d)), ne(peekAt(E, 1), c(0x5d)), ge(peekAt(E, 1), c(0)));
    return [
      ...advance(E),
      ...if_(eq(peek(E), c(0x5e)), [...advance(E), ...set(NEG, c(1))]),
      ...set(START, sg(E, F_RLEN)),
      ...whileLoop("members", c(1), [
        ...set(P, peek(E)),
        ...if_(lt(get(P), c(0)), syntax(E)),
        ...if_(eq(get(P), c(0x5d)), [...advance(E), ...brk("members")]),
        ...set(LO, call(fn.classAtom, ST)),
        ...if_(lt(get(LO), c(0)), [
          // Annex B: a `-` after a class escape is a literal `-`.
          ...if_(dashRange, [...if_(U, syntax(E)), ...advance(E), ...call(fn.range, ST, c(0x2d), c(0x2d))]),
          ...cont("members"),
        ]),
        ...if_(
          dashRange,
          [
            ...advance(E),
            ...set(HI, call(fn.classAtom, ST)),
            ...if_(lt(get(HI), c(0)), [
              ...if_(U, syntax(E)),
              ...call(fn.foldRange, ST, get(LO), get(LO)),
              ...call(fn.range, ST, c(0x2d), c(0x2d)),
              ...cont("members"),
            ]),
            ...if_(lt(get(HI), get(LO)), syntax(E)),
            ...call(fn.foldRange, ST, get(LO), get(HI)),
          ],
          call(fn.foldRange, ST, get(LO), get(LO)),
        ),
      ]),
      ...call(fn.classNode, ST, sel(I32, U, c(K_CPCLASS), c(K_CLASS)), get(START), get(NEG)),
    ];
  });

  // classAtom(st) -> a ClassAtom's code point, or -1 when it was a class
  // escape whose ranges were appended to the pool directly.
  defineRxFn(E, "classAtom", [], [I32], (L) => {
    const P = L.add("p");
    const EC = L.add("e");
    const S = L.add("s");
    return [
      ...set(P, peek(E)),
      ...if_(eq(get(P), c(0x5c)), [
        ...advance(E),
        ...set(EC, peek(E)),
        ...if_(lt(get(EC), c(0)), syntax(E)),
        ...if_(is(get(EC), "d", "D", "w", "W", "s", "S"), [
          ...advance(E),
          ...call(fn.shorthand, ST, or(get(EC), c(0x20)), ne(get(EC), or(get(EC), c(0x20)))),
          ...ret(c(-1)),
        ]),
        ...if_(eq(get(EC), c(0x62)), [...advance(E), ...ret(c(0x08))]),
        ...if_(allOf(is(get(EC), "p", "P"), U), [
          ...set(S, sg(E, F_RLEN)),
          ...call(fn.property, ST),
          ...if_(eq(get(EC), c(0x50)), call(fn.complementFrom, ST, get(S))),
          ...ret(c(-1)),
        ]),
        ...if_(allOf(eq(get(EC), c(0x6b)), U), syntax(E)),
        ...ret(call(fn.escapeUnit, ST, c(1))),
      ]),
      ...if_(U, ret(call(fn.readCp, ST))),
      ...advance(E),
      ...get(P),
    ];
  });

  // shorthand(st, letter, complement): append \d \w \s (lower-case letter)
  // ranges, complemented over the unit/code-point space when asked.
  defineRxFn(E, "shorthand", [I32, I32], [], (L) => {
    const S = L.add("s");
    const r = (lo: number, hi: number): X => call(fn.range, ST, c(lo), c(hi));
    return [
      ...set(S, sg(E, F_RLEN)),
      ...if_(eq(get(1), c(0x64)), r(0x30, 0x39)),
      ...if_(eq(get(1), c(0x77)), [
        ...r(0x30, 0x39),
        ...r(0x41, 0x5a),
        ...r(0x5f, 0x5f),
        ...r(0x61, 0x7a),
        // u+i IsWordChar adds the two non-ASCII code points that fold into it.
        ...if_(allOf(U, sg(E, F_PCI)), [...r(0x17f, 0x17f), ...r(0x212a, 0x212a)]),
      ]),
      ...if_(eq(get(1), c(0x73)), [
        ...r(0x09, 0x0d),
        ...r(0x20, 0x20),
        ...r(0xa0, 0xa0),
        ...r(0x1680, 0x1680),
        ...r(0x2000, 0x200a),
        ...r(0x2028, 0x2029),
        ...r(0x202f, 0x202f),
        ...r(0x205f, 0x205f),
        ...r(0x3000, 0x3000),
        ...r(0xfeff, 0xfeff),
      ]),
      ...if_(get(2), call(fn.complementFrom, ST, get(S))),
    ];
  });
}
