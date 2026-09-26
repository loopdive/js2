// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6677 — Unicode property escapes (`\p{…}` / `\P{…}`, u mode) for the runtime
 * RegExp compiler.
 *
 * The compile-time path asks the host `RegExp` for a property's members; a
 * pattern built at RUN time has no host to ask. So the General_Category
 * partition of the code space is enumerated ONCE at compile time (same host
 * oracle, same Unicode version as the static path) and linked into the module
 * as a sorted span table: one i32 per span, `start << 5 | category`, where a
 * span runs to the next span's start. Any General_Category value — a leaf
 * (`Lu`, `Po`, …) or a group (`L`, `P`, `S`, …) — is a bit mask over the 30
 * leaf categories, and its ranges fall out of one table walk. The table is
 * only linked when the program source can spell a property escape at all
 * ({@link noteRegexPropertySource}); otherwise `\p` refuses (poisoned value).
 *
 * Scripts, Script_Extensions and the binary properties other than `Any`,
 * `ASCII` and `Assigned` are out of scope and refuse the same way.
 */
import type * as ts from "typescript";
import type { CodegenContext } from "../context/types.js";
import { enumerateClassRanges } from "../regex/unicode.js";
import { F_PCI, F_POS, F_PROPS, F_RLEN, F_RP, ST, ag, as, advance, defineRxFn, sg, src, type RxEnv } from "./env.js";
import {
  I32,
  add,
  allOf,
  andThen,
  anyOf,
  and,
  cont,
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
  lt,
  ne,
  or,
  ret,
  sel,
  set,
  shrU,
  sub,
  whileLoop,
  type X,
} from "./dsl.js";
import { isAsciiLetter, isDigit, peek, syntax, unsupported } from "./core.js";

/** Leaf General_Category values; the index is the category id in the table. */
const LEAVES: ReadonlyArray<readonly [string, string, ...string[]]> = [
  ["Lu", "Uppercase_Letter"],
  ["Ll", "Lowercase_Letter"],
  ["Lt", "Titlecase_Letter"],
  ["Lm", "Modifier_Letter"],
  ["Lo", "Other_Letter"],
  ["Mn", "Nonspacing_Mark"],
  ["Mc", "Spacing_Mark"],
  ["Me", "Enclosing_Mark"],
  ["Nd", "Decimal_Number", "digit"],
  ["Nl", "Letter_Number"],
  ["No", "Other_Number"],
  ["Pc", "Connector_Punctuation"],
  ["Pd", "Dash_Punctuation"],
  ["Ps", "Open_Punctuation"],
  ["Pe", "Close_Punctuation"],
  ["Pi", "Initial_Punctuation"],
  ["Pf", "Final_Punctuation"],
  ["Po", "Other_Punctuation"],
  ["Sm", "Math_Symbol"],
  ["Sc", "Currency_Symbol"],
  ["Sk", "Modifier_Symbol"],
  ["So", "Other_Symbol"],
  ["Zs", "Space_Separator"],
  ["Zl", "Line_Separator"],
  ["Zp", "Paragraph_Separator"],
  ["Cc", "Control", "cntrl"],
  ["Cf", "Format"],
  ["Cs", "Surrogate"],
  ["Co", "Private_Use"],
  ["Cn", "Unassigned"],
];
const leafMask = (...shorts: string[]): number =>
  shorts.reduce((mask, short) => mask | (1 << LEAVES.findIndex((names) => names[0] === short)), 0);
const GROUPS: ReadonlyArray<readonly [number, ...string[]]> = [
  [leafMask("Lu", "Ll", "Lt", "Lm", "Lo"), "L", "Letter"],
  [leafMask("Lu", "Ll", "Lt"), "LC", "Cased_Letter"],
  [leafMask("Mn", "Mc", "Me"), "M", "Mark", "Combining_Mark"],
  [leafMask("Nd", "Nl", "No"), "N", "Number"],
  [leafMask("Pc", "Pd", "Ps", "Pe", "Pi", "Pf", "Po"), "P", "Punctuation", "punct"],
  [leafMask("Sm", "Sc", "Sk", "So"), "S", "Symbol"],
  [leafMask("Zs", "Zl", "Zp"), "Z", "Separator"],
  [leafMask("Cc", "Cf", "Cs", "Co", "Cn"), "C", "Other"],
];
const ALL_LEAVES = (1 << LEAVES.length) - 1;
/** Mask bit 30: the binary property ASCII (not a category union). */
const ASCII_BIT = 1 << 30;

/** `[len, mask, isCategoryValue, ...units]` records for every accepted name. */
function propertyNameTable(): number[] {
  const out: number[] = [];
  const addName = (name: string, mask: number, isValue: boolean): void => {
    out.push(name.length, mask, isValue ? 1 : 0, ...Array.from(name, (ch) => ch.charCodeAt(0)));
  };
  LEAVES.forEach((names, index) => names.forEach((name) => addName(name, 1 << index, true)));
  for (const [mask, ...names] of GROUPS) names.forEach((name) => addName(name, mask, true));
  addName("Any", ALL_LEAVES, false);
  addName("Assigned", ALL_LEAVES & ~leafMask("Cn"), false);
  addName("ASCII", ASCII_BIT, false);
  return out;
}

let spanTable: number[] | null = null;
/** The General_Category partition as `start << 5 | category`, sorted. */
export function generalCategorySpans(): number[] {
  if (spanTable !== null) return spanTable;
  const spans: Array<[number, number]> = [];
  LEAVES.forEach(([short], index) => {
    for (const [lo] of enumerateClassRanges(`\\p{${short}}`, "u")) spans.push([lo, index]);
  });
  spans.sort((a, b) => a[0] - b[0]);
  spanTable = spans.map(([lo, cat]) => (lo << 5) | cat);
  return spanTable;
}

const propertySourceCtx = new WeakMap<CodegenContext, boolean>();
/**
 * Record whether a source file can spell a property escape (`\p{` / `\P{`,
 * in a literal, a string, or a template). Only then is the span table linked.
 */
export function noteRegexPropertySource(ctx: CodegenContext, sf: ts.SourceFile): void {
  if (propertySourceCtx.get(ctx) === true) return;
  const text = sf.text;
  if (/\\[pP]\{/.test(text)) propertySourceCtx.set(ctx, true);
}
export function regexPropertyTableLinked(ctx: CodegenContext): boolean {
  return propertySourceCtx.get(ctx) === true;
}

const fixedArray = (E: RxEnv, values: number[]): X => [
  ...values.map((value): X[number] => ({ op: "i32.const", value: value | 0 })),
  { op: "array.new_fixed", typeIdx: E.arr, length: values.length },
];

export function defineUnicodeProperties(E: RxEnv): void {
  const { fn } = E;
  // property(st): parse `p{Name}` / `P{Name}` (cursor on the letter) and
  // append the property's ranges to the pool.
  defineRxFn(E, "property", [], [], (L) => {
    const START = L.add("start");
    const CH = L.add("ch");
    const MASK = L.add("mask");
    return [
      ...advance(E),
      ...if_(ne(peek(E), c(0x7b)), syntax(E)),
      ...advance(E),
      ...set(START, sg(E, F_POS)),
      ...whileLoop("name", c(1), [
        ...set(CH, peek(E)),
        ...if_(lt(get(CH), c(0)), syntax(E)),
        ...if_(eq(get(CH), c(0x7d)), brk("name")),
        ...if_(
          eqz(anyOf(isAsciiLetter(get(CH)), isDigit(get(CH)), eq(get(CH), c(0x5f)), eq(get(CH), c(0x3d)))),
          syntax(E),
        ),
        ...advance(E),
      ]),
      ...if_(eq(sg(E, F_POS), get(START)), syntax(E)),
      ...set(CH, sub(sg(E, F_POS), get(START))),
      ...advance(E),
      // Without the linked table, or under `i` (the member set would need
      // case closure), refuse rather than guess.
      ...if_(or(eqz(sg(E, F_PROPS)), sg(E, F_PCI)), unsupported(E)),
      ...set(MASK, call(fn.propMask, ST, get(START), get(CH))),
      ...if_(eqz(get(MASK)), unsupported(E)),
      ...call(fn.gcRanges, ST, get(MASK)),
    ];
  });

  if (!E.withProps) {
    defineRxFn(E, "propMask", [I32, I32], [I32], () => c(0));
    defineRxFn(E, "gcRanges", [I32], [], () => []);
    return;
  }

  // propMask(st, start, len) -> category mask (bit 30 = ASCII), 0 if unknown.
  defineRxFn(E, "propMask", [I32, I32], [I32], (L) => {
    const START = 1;
    const LEN = 2;
    const TAB = L.add("tab", { kind: "ref", typeIdx: E.arr });
    const N = L.add("n");
    const P = L.add("p");
    const I = L.add("i");
    const EQ_AT = L.add("eqAt");
    const VSTART = L.add("vstart");
    const VLEN = L.add("vlen");
    const VALUE_ONLY = L.add("valueOnly");
    const RLEN_ = L.add("rlen");
    const tab = (index: X): X => ag(E, get(TAB), index);
    const prefixIs = (word: string): X =>
      allOf(
        eq(get(EQ_AT), c(word.length)),
        ...Array.from(word, (w, k) => eq(src(E, add(get(START), c(k))), c(w.charCodeAt(0)))),
      );
    return [
      ...set(TAB, fixedArray(E, propertyNameTable())),
      ...set(N, [...get(TAB), { op: "array.len" }]),
      ...set(EQ_AT, c(-1)),
      ...whileLoop("findEq", lt(get(I), get(LEN)), [
        ...if_(eq(src(E, add(get(START), get(I))), c(0x3d)), [...set(EQ_AT, get(I)), ...brk("findEq")]),
        ...inc(I),
      ]),
      ...set(VSTART, get(START)),
      ...set(VLEN, get(LEN)),
      ...if_(ge(get(EQ_AT), c(0)), [
        ...if_(eqz(or(prefixIs("General_Category"), prefixIs("gc"))), ret(c(0))),
        ...set(VSTART, add(add(get(START), get(EQ_AT)), c(1))),
        ...set(VLEN, sub(sub(get(LEN), get(EQ_AT)), c(1))),
        ...set(VALUE_ONLY, c(1)),
      ]),
      ...whileLoop("names", lt(get(P), get(N)), [
        ...set(RLEN_, tab(get(P))),
        ...if_(allOf(eq(get(RLEN_), get(VLEN)), or(tab(add(get(P), c(2))), eqz(get(VALUE_ONLY)))), [
          ...set(I, c(0)),
          ...whileLoop("chars", lt(get(I), get(VLEN)), [
            ...if_(ne(tab(add(add(get(P), c(3)), get(I))), src(E, add(get(VSTART), get(I)))), brk("chars")),
            ...inc(I),
          ]),
          ...if_(eq(get(I), get(VLEN)), ret(tab(add(get(P), c(1))))),
        ]),
        ...set(P, add(add(get(P), c(3)), get(RLEN_))),
      ]),
      ...c(0),
    ];
  });

  // gcRanges(st, mask): append the (merged) ranges of every span whose
  // category is in `mask`.
  defineRxFn(E, "gcRanges", [I32], [], (L) => {
    const MASK = 1;
    const TAB = L.add("tab", { kind: "ref", typeIdx: E.arr });
    const N = L.add("n");
    const I = L.add("i");
    const S = L.add("s");
    const LO = L.add("lo");
    const HI = L.add("hi");
    const E_ = L.add("e");
    const rp = (index: X): X => ag(E, sg(E, F_RP), index);
    return [
      ...if_(ge(get(MASK), c(ASCII_BIT)), [...call(fn.range, ST, c(0), c(0x7f)), ...ret()]),
      ...set(TAB, fixedArray(E, generalCategorySpans())),
      ...set(N, [...get(TAB), { op: "array.len" }]),
      ...set(S, sg(E, F_RLEN)),
      ...whileLoop("spans", lt(get(I), get(N)), [
        ...set(E_, ag(E, get(TAB), get(I))),
        ...inc(I),
        ...if_(eqz(and(shrU(get(MASK), and(get(E_), c(31))), c(1))), cont("spans")),
        ...set(LO, shrU(get(E_), c(5))),
        ...set(HI, sel(I32, lt(get(I), get(N)), sub(shrU(ag(E, get(TAB), get(I)), c(5)), c(1)), c(0x10ffff))),
        ...if_(
          andThen(gt(sg(E, F_RLEN), get(S)), eq(add(rp(sub(sg(E, F_RLEN), c(1))), c(1)), get(LO))),
          as(E, sg(E, F_RP), sub(sg(E, F_RLEN), c(1)), get(HI)),
          call(fn.range, ST, get(LO), get(HI)),
        ),
      ]),
    ];
  });
}
