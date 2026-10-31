// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7164 — `g.length = n` on an externref (`any[]`) vec grew the length field
// only, so the new indices exposed the backing array's default `null` slots:
// `g[1]` read `null` and comparator-less `sort()` moved them first (or trapped).
// Growth now reallocates the backing (up to the 16M guard) and fills the new
// slots with the canonical `undefined`. It deliberately does NOT write the
// `$Hole` marker: three review rounds found readers that passed the marker to
// user code, and `undefined` cannot leak by construction. The cost is that a
// grown index is a present `undefined` (`in` true, callbacks visit it) — the
// holes themselves are #7170, and those rows are `it.fails` with that owner.
//
// The carrier choice belongs to the binding's whole share group (#7154): the
// GUARDS below alias the grown array through a typed parameter, field, alias
// or a reassigned `let`, where switching one member alone would copy the vec
// and lose the other side's pushes (the #6937 failure class).
//
// Each program is compiled once per lane (gc native-first, standalone, wasi);
// each read is its own row, diffed against native JS. Rows that still differ
// for reasons outside this issue are `it.fails` with the issue that owns them,
// so a later fix flips the row and has to update this table.
import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";
import { readFileSync } from "node:fs";
import {
  callbackRows,
  callbackSource,
  LEAK_SETUPS,
  LEAK_SUMMARY,
  leaksIn,
  leakFns,
  SWEEP,
  SWEEP_PRELUDE,
  sweepRows,
  sweepSource,
} from "./issue-7164-length-update-sweep-cases.js";

const ENC = `function enc(s: string): number { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;

const LANES = [
  { lane: "gc", options: {} },
  { lane: "standalone", options: { target: "standalone" } },
  { lane: "wasi", options: { target: "wasi" } },
] as const;
type Lane = (typeof LANES)[number]["lane"];

const PROGRAMS: Record<string, string> = {
  // The issue's program: grow within the capacity `push` reserved.
  grow: `const g: any[] = []; g.push("y"); g.length = 3;`,
  // Shrink to zero, then grow (the shrink fill already marked the slots).
  zeroGrow: `const g: any[] = []; g.push("y"); g.push("z"); g.length = 0; g.length = 2;`,
  // Grow past the capacity, push into the grown range's end, grow again.
  growBig: `const g: any[] = []; g.push("y"); g.length = 9; g.push("z"); g.length = 12;`,
  // The append shape: an element write bumps length before the length store.
  append: `const g: any[] = ["a"]; g[1] = "b"; g.length = 2; g[g.length] = "c"; g.length = g.length;`,
  // Other hole sources the plan lists — their gaps are owned by #7169 / #7170 / #7171.
  del: `const g: any[] = []; g.push("y"); g.push("x"); g.push("z"); delete g[1];`,
  newArray: `const g: any[] = new Array(3); g[0] = "y";`,
};

const READS: Record<string, string> = {
  index: `String(g[1])`,
  in: `String(1 in g) + String(2 in g)`,
  hasOwnProperty: `String(g.hasOwnProperty(1))`,
  forIn: `(() => { let s = ""; for (const k in g) s += k + ","; return s; })()`,
  join: `g.join("|")`,
  forEach: `(() => { let n = 0; g.forEach(() => { n++; }); return String(n); })()`,
  map: `(() => { const m = g.map((x: any) => "m" + x); return m.length + ":" + (1 in m) + ":" + m.join("|"); })()`,
  objectKeys: `Object.keys(g).join(",")`,
  json: `JSON.stringify(g)`,
  spread: `(() => { const s = [...g]; return s.length + ":" + (1 in s) + ":" + String(s[1]); })()`,
  entries: `(() => { let r = ""; for (const [i, v] of g.entries()) r += i + "=" + String(v) + ","; return r; })()`,
  sort: `(() => { g.sort(); return g.join("|"); })()`,
};

const NATIVE: readonly Lane[] = ["gc", "standalone"];
const ALL: readonly Lane[] = ["gc", "standalone", "wasi"];
const WASI: readonly Lane[] = ["wasi"];

// Known gaps: program → reads → lanes, with the issue that owns the rows.
const GROWTH = "grow|zeroGrow|growBig";
const GAPS: { program: string; reads: string[]; lanes: readonly Lane[]; owner: string }[] = [
  // (#7164 r4) A grown index holds the canonical `undefined`, so it is an own,
  // present element: `in` / hasOwnProperty / for-in / Object.keys / forEach /
  // map see it. Holes are #7170. Same answers as origin/main, which held `null`.
  {
    program: GROWTH,
    reads: ["in", "hasOwnProperty", "forIn", "objectKeys", "forEach", "map"],
    lanes: NATIVE,
    owner: "#7170 (grown index is a present undefined)",
  },
  { program: GROWTH, reads: ["map", "forEach"], lanes: WASI, owner: "#7170 (grown index is a present undefined)" },
  // wasi: `in` and for-in report holes as present (#7171).
  { program: GROWTH, reads: ["in", "forIn"], lanes: WASI, owner: "#7171" },
  // wasi: Object.keys / hasOwnProperty on an `any[]` are wrong even when it is dense (untracked).
  { program: "grow|growBig|append", reads: ["objectKeys"], lanes: WASI, owner: "wasi-vec-own-keys" },
  { program: "append", reads: ["hasOwnProperty"], lanes: WASI, owner: "wasi-vec-own-keys" },
  // `delete g[1]` keeps the value in the slot; reads that skip the deleted-index record see it (#7169 / #7170 / #7171).
  {
    program: "del",
    reads: ["join", "forEach", "map", "spread", "entries", "sort"],
    lanes: NATIVE,
    owner: "#7169/#7170",
  },
  {
    program: "del",
    reads: ["index", "in", "forIn", "join", "forEach", "map", "objectKeys", "json", "spread", "entries", "sort"],
    lanes: WASI,
    owner: "#7171/#7170",
  },
  // `new Array(3)` holes on the native-first lane and the per-read gaps (#7170 / #7171).
  {
    program: "newArray",
    reads: ["in", "hasOwnProperty", "forIn", "forEach", "map", "objectKeys"],
    lanes: NATIVE,
    owner: "#7170",
  },
  { program: "newArray", reads: ["in", "forIn", "forEach", "map", "objectKeys"], lanes: WASI, owner: "#7170/#7171" },
];

function gapFor(program: string, read: string, lane: Lane): string | undefined {
  for (const gap of GAPS) {
    if (gap.program.split("|").includes(program) && gap.reads.includes(read) && gap.lanes.includes(lane)) {
      return gap.owner;
    }
  }
  return undefined;
}

function source(setup: string): string {
  const fns = Object.entries(READS).map(
    ([name, read]) => `export function r_${name}(): number { ${setup} return enc(${read}); }`,
  );
  return `${ENC}${fns.join("\n")}\n`;
}

for (const program of Object.keys(PROGRAMS)) {
  describe(`#7164 ${program}`, () => {
    const src = source(PROGRAMS[program]!);
    const expected = evaluateAsJs(src);
    for (const { lane, options } of LANES) {
      describe(lane, () => {
        let exports: Record<string, unknown> = {};
        beforeAll(async () => {
          const result = await compile(src, { fileName: "probe.ts", ...options });
          expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
          exports = (await instantiateWithRuntime(result)).exports as Record<string, unknown>;
        }, 120_000);
        for (const read of Object.keys(READS)) {
          const gap = gapFor(program, read, lane);
          const test = gap !== undefined ? it.fails : it;
          test(`${read}${gap !== undefined ? ` (known gap: ${gap})` : ""}`, () => {
            const fn = `r_${read}`;
            expect((exports[fn] as () => unknown)(), `${program}/${read}/${lane}`).toBe(expected[fn]!());
          });
        }
      });
    }
  });
}

// (#7164 r2) Share-group guards: every alias must observe every store.
const GUARDS: Record<string, { pre?: string; body: string; gap?: string; wasiGap?: string }> = {
  paramTypedStr: {
    pre: "function f(a: string[]): void { a.push('p'); }",
    body: "const xs: any[] = []; xs.push('a'); xs.length = 3; f(xs); xs.push('c'); return xs.length+':'+JSON.stringify(xs);",
  },
  paramTypedStrBefore: {
    pre: "function f(a: string[]): void { a.push('p'); }",
    body: "const xs: any[] = []; xs.push('a'); f(xs); xs.length = 4; f(xs); return xs.length+':'+JSON.stringify(xs);",
  },
  objFieldTyped: {
    body: "const o: { items: string[] } = { items: [] }; const xs: any[] = []; xs.push('a'); o.items = xs; xs.length = 3; o.items.push('b'); return JSON.stringify(xs)+'/'+JSON.stringify(o.items);",
  },
  nestedArrAlias: {
    body: "const xs: any[] = []; xs.push([1]); const ys: number[][] = xs; xs.length = 3; ys.push([2]); return xs.length+':'+ys.length+':'+JSON.stringify(xs);",
  },
  curBPattern: {
    body: "const a: any[] = []; a.push('a'); const b: any[] = []; b.push('b'); let cur: any[] = a; cur.length = 3; cur = b; cur.length = 2; cur.push('x'); return JSON.stringify(a)+JSON.stringify(b);",
  },
  boolTypedAlias: {
    body: "const xs: any[] = []; xs.push(true); const ys: boolean[] = xs; xs.length = 3; ys.push(false); return xs.length+':'+ys.length;",
  },
  elemRefTypedAlias: {
    pre: "class P { constructor(public v: number) {} }",
    body: "const xs: any[] = []; xs.push(new P(1)); const ys: P[] = xs; xs.length = 3; ys.push(new P(2)); return xs.length+':'+ys.length;",
  },
  // The group keeps the typed string vec, which cannot grow past its
  // capacity on any lane (same on origin/main; see the issue's Resolution).
  aliasTypedStr: {
    body: "const xs: any[] = []; xs.push('a'); const ys: string[] = xs; xs.length = 5; ys.push('b'); xs.push('c'); return xs.length+':'+ys.length;",
    gap: "typed-vec-grow-past-capacity",
  },
  // (#7164 r3) A user `String` shadowing the global is not a pure read: the group keeps base's layout.
  shadowString: {
    pre: "function String(a: string[]): string { a.push('z'); return ''; }",
    body: "const xs: any[] = []; xs.push('a'); xs.length = 3; String(xs); xs.push('c'); return xs.length + ':' + JSON.stringify(xs);",
    // Traps (null dereference) exactly as on origin/main: the typed string vec meets a `string[]` callee.
    gap: "typed-vec-shadowed-string-trap",
  },
  // (#7164 r5) `++` / `--` / `+=` / `-=` share the static length store.
  spreadAfterShrinkInc: {
    body: "const g: any[] = []; g.push('y'); g.push('z'); g.length = 1; g.length++; const s = [...g]; return s.length + ':' + (1 in s) + ':' + JSON.stringify(Object.keys(s));",
    wasiGap: "#7171",
  },
  toReversedAfterShrinkInc: {
    body: "const g: any[] = []; g.push('y'); g.push('z'); g.length = 1; g.length++; g.length++; const t = g.toReversed(); let p = ''; for (let i = 0; i < t.length; i++) p += (i in t) ? 'P' : 'H'; return p + String(t[0]);",
    wasiGap: "#7171",
  },
  lengthUpdateValues: {
    body: "const g: any[] = []; g.push('y'); const a = g.length++; const b = ++g.length; const c = (g.length += 2); const d = (g.length -= 1); const e = g.length--; return [a, b, c, d, e, g.length, String(g[1])].join(',');",
    gap: "same as origin/main 2b0565cb14: update forms on a string-only any[] (#7154 string vec) emit invalid wasm",
  },
  lengthUpdateRangeError: {
    body: "const g: any[] = []; g.push('y'); try { g.length -= 5; return 'no'; } catch (e) { return (e instanceof RangeError) + ':' + g.length; }",
    gap: "same as origin/main 2b0565cb14: update forms on a string-only any[] (#7154 string vec) emit invalid wasm",
  },
  // (#7164 r6) A possibly non-writable length / non-configurable element keeps
  // the update forms on their old, descriptor-aware route (TypeError as before).
  nonWritableMinusEq: {
    body: "const g: any[] = ['a', 'b']; Object.defineProperty(g, 'length', { writable: false }); try { g.length -= 1; return 'no:' + g.length; } catch (e) { return (e instanceof TypeError) + ':' + g.length; }",
    wasiGap: "same as origin/main 2b0565cb14: wasi reads a non-writable length as undefined",
  },
  nonConfigurableElementDec: {
    body: "const g: any[] = ['a', 'b']; Object.defineProperty(g, 1, { value: 'b', configurable: false }); try { g.length--; return 'no:' + g.length; } catch (e) { return (e instanceof TypeError) + ':' + g.length; }",
    wasiGap: "wasi-nonconfigurable-length-store",
  },
  // `find` / `findLast` with no match return `undefined`, also on a mixed `any[]`.
  findNotFoundIsUndefined: {
    body: "const g: any[] = []; g.push('a'); g.length = 3; const h: any[] = ['a', 1]; return String(g.find((x: any) => x === 'zz') === undefined) + String(g.findLast((x: any) => x === 'zz') === undefined) + String(h.find(() => false) === undefined) + String(h.findLast(() => false) === undefined);",
  },
  // Update forms with no plain `length =` in the module, on every element kind.
  incOnlyAny: {
    body: "const g: any[] = ['a', 'b']; g.length++; return String(g[2]) + ':' + g.length;",
    wasiGap:
      "same as origin/main 2b0565cb14: wasi length++ on a dense any[] is lost (so `while (g.length < 5) g.length++` never terminates)",
  },
  incOnlyMixed: {
    body: "const g: any[] = []; g.push('a'); g.push(1); g.length++; return String(g[2]) + ':' + g.length + ':' + [...g].length;",
    wasiGap: "same as origin/main 2b0565cb14: wasi length++ on a dense any[] is lost",
  },
  pushPopIncSpread: {
    pre: "function fd(...r: any[]): any[] { return r; }",
    body: "const g: any[] = []; g.push('y'); g.push('z'); g.pop(); g.length++; return String(fd(...g)[1]) + ':' + g.length;",
    gap: "same as origin/main 2b0565cb14: pop() then length++ resurrects the popped value (wasi: length++ is lost)",
  },
  chainPreInc: {
    body: "const o = { p: { arr: ['a'] as any[] } }; const v = ++o.p.arr.length; return v + ':' + o.p.arr.length;",
    wasiGap: "same as origin/main 2b0565cb14: wasi ++o.p.arr.length reads NaN",
  },
  // (#7164 r6) `+=` on a binding #7164 moved to the externref carrier takes the
  // static store (origin/main emits invalid wasm here).
  plusEqSwitched: {
    body: "const g: any[] = []; g.push('y'); g.length = 2; g.length += 2; return String(g[3]) + ':' + g.length;",
  },
  // (#7164 r6) A `fromIndex` whose `valueOf` grows the array past capacity
  // reallocates the backing; indexOf / includes must scan the new one.
  fromIndexGrowsBacking: {
    body: "const g: any[] = []; g.push('a'); g.push('b'); g.length = 2; const fi: any = { valueOf(): number { g.length = 40; g[1] = 'Q'; return 0; } }; const fj: any = { valueOf(): number { g.length = 90; g[3] = 'R'; return 0; } }; return String(g.indexOf('Q', fi)) + ':' + g.includes('R', fj);",
    wasiGap: "same as origin/main 2b0565cb14: wasi indexOf / includes miss a value written by fromIndex's valueOf",
  },
  // (#7164 r7) A grow of an externref vec #7164 did not switch keeps
  // origin/main's store: mixed arrays, parameters and literal-seeded arrays.
  mixedGrowSearch: {
    body: "const g: any[] = ['a', 1]; g.length = 4; const t = (b: boolean): string => (b ? 'T' : 'F'); return [g.indexOf(undefined), g.lastIndexOf(undefined), t(g.some((x: any) => x === undefined)), t(g.every((x: any) => x !== undefined)), g.filter((x: any) => x === undefined).length].join(',');",
  },
  mixedGrowIn: {
    body: "const g: any[] = ['a', 1]; g.length = 4; return (3 in g ? 'T' : 'F') + (g.hasOwnProperty(3) ? 'T' : 'F') + g.length;",
    wasiGap: "#7171 (same as origin/main: wasi `in` is true for a grown index)",
  },
  paramGrow: {
    pre: "function p(g: any[]): string { g.length = 4; return [g.indexOf(undefined), g.some((x: any) => x === undefined) ? 'T' : 'F', 3 in g ? 'T' : 'F', g.length].join(','); }",
    body: "return p(['a', 1]);",
    wasiGap: "#7171 (same as origin/main: wasi `in` is true for a grown index)",
  },
  literalGrowIn: {
    body: "const g: any[] = ['a', 'b']; g.length = 4; return (3 in g ? 'T' : 'F') + g.filter((x: any) => x === undefined).length;",
    wasiGap: "#7171",
  },
  // (#7164 r7) The native element-equality helpers register the box types they
  // need: a search on a string-only switched vec used to fold to a constant.
  pushGrowSearch: {
    body: "const g: any[] = []; g.push('a'); g.length = 3; return (g.includes(undefined) ? 'T' : 'F') + g.indexOf('zz') + ',' + g.lastIndexOf('a') + ',' + g.indexOf('a');",
  },
  pushGrowIndexOfUndefined: {
    body: "const g: any[] = []; g.push('a'); g.length = 3; return String(g.indexOf(undefined));",
    gap: "#7170 (a grown index is a present undefined; same as origin/main: 1)",
  },
  literalGrowSearch: {
    body: "const g: any[] = ['a', 'b']; g.length = 4; return g.indexOf(undefined) + (g.includes(undefined) ? 'T' : 'F');",
    gap: "same as origin/main: a literal-seeded string vec's grown slots are null, so includes(undefined) is false",
  },
  // (#7164 r8) A callback that can see its array parameter is another name for
  // the vec: the binding is not switched, so the store through it is main's.
  cbArrayParamForEach: {
    body: "const g: any[] = []; g.push('a'); g.length = 3; g.forEach((v, i, arr) => { if (i === 0) arr.length = 5; }); return String(g[4]);",
  },
  cbArrayParamMap: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; const r = g.map((v, i, a) => { if (i === 0) a.length = 20; return String(v); }); return String(g.length) + ':' + String(g[19]) + ':' + r.length;",
    gap: "same as origin/main: a grow through the callback's array parameter is lost",
  },
  cbArrayParamFnExpr: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; g.some(function (v, i, a) { a.length = 9; return true; }); return String(g.length) + String(g[8]);",
    gap: "same as origin/main: a grow through the callback's array parameter is lost",
  },
  cbArrayParamPlusEq: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; g.forEach((v, i, a) => { if (i === 0) a.length += 7; }); return String(g.length) + String(g[8]);",
    gap: "same as origin/main: a grow through the callback's array parameter is lost",
  },
  cbArrayParamNamed: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; const cb = (v: any, i: number, a: any[]) => { if (i === 0) a.length = 9; }; g.forEach(cb); return String(g.length) + String(g[8]);",
    gap: "same as origin/main: a grow through the callback's array parameter is lost",
  },
  // (#7164 r8) A getter the callback reads can grow (and reallocate) a switched binding.
  getterGrowSome: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; const o = { get x() { g.length = 50; g[1] = 'B'; return 0; } }; return String(g.some((v, i) => o.x === 0 && v === 'B'));",
  },
  getterGrowFindIndex: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; const o = { get x() { g.length = 50; g[1] = 'B'; return 0; } }; const r = g.findIndex((v, i) => o.x + i === 1 && v === 'B'); return String(r) + ':' + g.length;",
  },
  // (#7164 r8) origin/main folded this search to a constant (0).
  closureIndexOf: {
    body: "const g: any[] = ['a', 'b']; const f = (x: any) => g.indexOf(x); return String(f('b'));",
  },
  // (#7164 r9) The array parameter behind a receiver wrapper (round-8 review shapes).
  wrapParenForEach: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; (g).forEach((v, i, a) => { if (i === 0) a.length = 9; }); return String(g[8]);",
  },
  wrapNonNullForEach: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; g!.forEach((v, i, a) => { if (i === 0) a.length = 9; }); return String(g[8]);",
  },
  wrapAsForEach: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; (g as any[]).forEach((v, i, a) => { if (i === 0) a.length = 9; }); return String(g[8]);",
  },
  wrapReverseForEach: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; g.reverse().forEach((v, i, a) => { if (i === 0) a.length = 9; }); return String(g[8]);",
  },
  wrapOrMap: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; (g || g).map((v, i, a) => { if (i === 0) a.length = 9; return v; }); return String(g[8]);",
  },
  wrapElementForEach: {
    body: "const g: any[] = []; g.push('a'); g.length = 2; g['forEach']((v: any, i: number, a: any[]) => { if (i === 0) a.length = 9; }); return String(g[8]);",
  },
  // `k in g` after a grow: true, as on origin/main (node: false).
  inAfterGrow: {
    body: "const g: any[] = []; g.push('a'); g.length = 3; return String(2 in g);",
    gap: "#7170 (same as origin/main: a grown index is present)",
  },
  spreadShrinkGrow: {
    body: "const g: any[] = []; g.push('y'); g.push('z'); g.length = 1; g.length = 3; const s = [...g]; return s.length+':'+(1 in s)+':'+String(s[1]);",
  },
};

describe("#7164 share-group guards", () => {
  for (const [name, { pre, body, gap: allGap, wasiGap }] of Object.entries(GUARDS)) {
    const src = `${ENC}${pre ?? ""}\nfunction value(): string { ${body} }\nexport function test(): number { return enc(value()); }`;
    for (const { lane, options } of LANES) {
      const gap = allGap ?? (lane === "wasi" ? wasiGap : undefined);
      const test = gap !== undefined ? it.fails : it;
      test(`${name} / ${lane}${gap !== undefined ? ` (known gap: ${gap})` : ""}`, async () => {
        const expected = evaluateAsJs(src).test!();
        const result = await compile(src, { fileName: "probe.ts", ...options });
        expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
        const exports = (await instantiateWithRuntime(result)).exports as Record<string, unknown>;
        expect((exports.test as () => unknown)(), `${name}/${lane}`).toBe(expected);
      }, 120_000);
    }
  }
});

// (#7164 r3/r4) Reader audit: every reader of an externref vec's elements
// after a grow, on one module per lane. A grown slot reads as `undefined`;
// readers that the spec makes skip a hole are the #7170 rows.
const READER_PRELUDE = `
function f3(a: any, b: any, c: any): string { return String(a) + String(b) + String(c) + (b === undefined); }
function restIn(...r: any[]): string { let s = ""; for (let i = 0; i < r.length; i++) s += (i in r) + "=" + String(r[i]) + ","; return s; }
class C2 { s: string; constructor(a: any, b: any) { this.s = String(a) + String(b) + (b === undefined); } }
class K2 { m(a: any, b: any): string { return String(a) + String(b) + (b === undefined); } }
class D2 extends C2 { constructor(...r: any[]) { super(...r); } }
function h2(a: any, b: any): string { return String(a) + String(b) + (b === undefined); }
`;
const GROW = `const g: any[] = []; g.push("y"); g.length = 3;`;
const READERS: Record<string, string> = {
  callSpread: `f3(...g)`,
  newSpread: `new C2(...g).s`,
  methodSpread: `new K2().m(...g)`,
  superSpread: `new D2(...g).s`,
  restParam: `restIn(...g)`,
  literalMidSpread: `(() => { const s: any[] = [0, ...g, 9]; return s.length + ":" + String(s[1]) + ":" + String(s[2]) + ":" + (2 in s); })()`,
  arrayOf: `(() => { const a = Array.of(...g); return a.length + ":" + (2 in a) + ":" + String(a[2]); })()`,
  arrayFrom: `(() => { const a = Array.from(g); return a.length + ":" + (2 in a) + ":" + String(a[2]); })()`,
  apply: `(h2 as any).apply(null, g)`,
  mathMax: `String(Math.max(...g))`,
  concat: `(() => { const t = g.concat(["z"]); return t.length + ":" + (1 in t) + ":" + String(t[1]) + ":" + String(t[3]); })()`,
  slice: `(() => { const t = g.slice(); return t.length + ":" + (1 in t) + ":" + String(t[1]); })()`,
  spliceResult: `(() => { const r = g.splice(1, 2); return r.length + ":" + (0 in r) + ":" + String(r[0]) + ":" + g.length; })()`,
  destructureDefault: `(() => { const [a, b = "d", c = "e"] = g; return String(a) + String(b) + String(c); })()`,
  destructureRest: `(() => { const [a, ...rest] = g; return rest.length + ":" + (0 in rest) + ":" + String(rest[0]); })()`,
  forOf: `(() => { let s = ""; for (const v of g) s += String(v) + (v === undefined) + ","; return s; })()`,
  valuesSpread: `(() => { const t = [...g.values()]; return t.length + ":" + (1 in t) + ":" + String(t[1]); })()`,
  entriesSpread: `(() => { const t = [...g.entries()]; return t.length + ":" + String(t[1][1]); })()`,
  indexOfIncludes: `String(g.indexOf(undefined)) + String(g.includes(undefined)) + String(g.lastIndexOf(undefined))`,
  joinSep: `g.join("-")`,
  toStringCall: `g.toString()`,
  stringCall: `String(g)`,
  template: "`${g}`",
  concatString: `"" + g`,
  find: `String(g.find((v: any, i: number) => i === 1)) + ":" + g.findIndex((v: any) => v === undefined)`,
  findLast: `String(g.findLast((v: any) => true)) + ":" + g.findLastIndex((v: any) => v === undefined)`,
  filter: `(() => { const t = g.filter((v: any) => true); return t.length + ":" + t.join(","); })()`,
  reduce: `g.reduce((a: any, v: any) => a + String(v), "") + ":" + g.reduceRight((a: any, v: any) => a + String(v), "")`,
  someEvery: `String(g.some((v: any) => v === undefined)) + String(g.every((v: any) => v !== undefined))`,
  at: `String(g.at(1)) + (g.at(1) === undefined) + String(g.at(-1))`,
  pop: `(() => { const v = g.pop(); return String(v) + (v === undefined) + g.length; })()`,
  shift: `(() => { const a = g.shift(); const b = g.shift(); return String(a) + String(b) + (b === undefined) + g.length; })()`,
  objectValues: `Object.values(g).length + ":" + Object.entries(g).length`,
  elementRead: `typeof g[1] + (g[1] === undefined) + (g[1] == null) + "x" + g[2]`,
  anyJoin: `(() => { const a: any = g; return a.join("-"); })()`,
};
const READER_GAPS: Record<string, { lanes: readonly Lane[]; owner: string }> = {
  // wasi: `in` reports holes as present (#7171).
  restParam: { lanes: WASI, owner: "#7171" },
  // (#7164 r4) The grown index is a present `undefined` (#7170): copies keep it
  // own, `indexOf` finds it, callbacks visit it. `someEvery` was right on
  // origin/main only because its slot held `null` (`v === undefined` false).
  concat: { lanes: ALL, owner: "#7170 (grown index is a present undefined)" },
  slice: { lanes: ALL, owner: "#7170 (grown index is a present undefined)" },
  spliceResult: { lanes: ALL, owner: "#7170 (grown index is a present undefined)" },
  indexOfIncludes: { lanes: ALL, owner: "#7170 (grown index is a present undefined)" },
  filter: { lanes: ALL, owner: "#7170 (grown index is a present undefined)" },
  reduce: { lanes: ALL, owner: "#7170 (grown index is a present undefined)" },
  someEvery: { lanes: ALL, owner: "#7170 (grown index is a present undefined)" },
  // wasi: `super(...r)` from a rest-param constructor loses the first argument (same on origin/main; untracked).
  superSpread: { lanes: WASI, owner: "wasi-super-spread" },
  // `Array.from(anyVec)` traps "illegal cast" even when dense (same on origin/main; untracked).
  arrayFrom: { lanes: ALL, owner: "array-from-any-vec" },
  // `Function.prototype.apply` reads a hole as `null` (same on origin/main; untracked).
  apply: { lanes: ALL, owner: "apply-hole-null" },
  // Object.values / entries list holes (gc/standalone) or nothing (wasi) (same on origin/main; #7170 family).
  objectValues: { lanes: ALL, owner: "#7170" },
  // A join through an `any` receiver prints `undefined`/`null` elements verbatim, dense too (untracked).
  anyJoin: { lanes: ALL, owner: "dynamic-join-nullish" },
  // wasi: `Array.of(...g)` traps (same on origin/main; untracked).
  arrayOf: { lanes: WASI, owner: "wasi-array-of-spread" },
};

describe("#7164 readers after growth", () => {
  const fns = Object.entries(READERS).map(
    ([name, read]) => `export function r_${name}(): number { ${GROW} return enc(${read}); }`,
  );
  const src = `${ENC}${READER_PRELUDE}${fns.join("\n")}\n`;
  const expected = evaluateAsJs(src);
  for (const { lane, options } of LANES) {
    describe(lane, () => {
      let exports: Record<string, unknown> = {};
      beforeAll(async () => {
        const result = await compile(src, { fileName: "probe.ts", ...options });
        expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
        exports = (await instantiateWithRuntime(result)).exports as Record<string, unknown>;
      }, 120_000);
      for (const name of Object.keys(READERS)) {
        const gap = READER_GAPS[name]?.lanes.includes(lane) ? READER_GAPS[name]!.owner : undefined;
        const test = gap !== undefined ? it.fails : it;
        test(`${name}${gap !== undefined ? ` (known gap: ${gap})` : ""}`, () => {
          const fn = `r_${name}`;
          expect((exports[fn] as () => unknown)(), `${name}/${lane}`).toBe(expected[fn]!());
        });
      }
    });
  }
});

// (#7164 r4) GENERATED leak sweep. Every array-producing method and every call
// form is applied to a grown array; each result array is summarised per index
// as presence (`P` own / `H` absent) plus value class (`u` undefined, `O` a
// non-null object, `v` anything else). A grown slot must never surface as an
// object where node has `undefined` (the internal marker). That check has no
// `it.fails` escape. Full agreement with node (presence included) may be a
// known gap with its owner.
const SWEEP_GROW = `const g: any[] = []; g.push("y"); g.length = 3;`;
// Rows where head differs from node with no marker leak. Measured head vs
// origin/main: none of them was right on origin/main. Growth fills the new
// slots with the canonical `undefined`, so a grown index is present (#7170).
const presence = (lanes: readonly Lane[]) => ({ lanes, owner: "#7170 (grown index is a present undefined)" });
const SWEEP_GAPS: Record<string, { lanes: readonly Lane[]; owner: string }> = {
  // gc/standalone: the grown index is own (`in` true) where node has a hole.
  self: presence(ALL),
  map: presence(ALL),
  filter: presence(ALL),
  slice: presence(ALL),
  concat: presence(ALL),
  flat: presence(ALL),
  flatMap: presence(ALL),
  splice: presence(ALL),
  forEachCollect: presence(ALL),
  reduceCollect: presence(ALL),
  // Same failure on origin/main (untracked): traps, compile errors, `null` reads.
  toSorted: { lanes: ALL, owner: "toSorted-any-vec-trap" },
  arrayFrom: { lanes: ALL, owner: "array-from-any-vec-trap" },
  restObjMethod: { lanes: ALL, owner: "object-literal-method-rest-invalid-wasm" },
  restSuper: { lanes: ALL, owner: "super-spread-rest-empty" },
  dynamicRead: { lanes: ALL, owner: "dynamic-index-read-null" },
  apply: { lanes: ALL, owner: "apply-reads-null" },
  // wasi: `i in r` is false even for a present index (#7171), so every other row differs there.
  toReversed: { lanes: WASI, owner: "#7171" },
  toSpliced: { lanes: WASI, owner: "#7171" },
  with: { lanes: WASI, owner: "#7171" },
  arrayOf: { lanes: WASI, owner: "wasi-array-of-host-import" },
  entries: { lanes: WASI, owner: "#7171" },
  values: { lanes: WASI, owner: "#7171" },
  spread: { lanes: WASI, owner: "#7171" },
  spreadLead: { lanes: WASI, owner: "#7171" },
  forOfCollect: { lanes: WASI, owner: "#7171" },
  indexRead: { lanes: WASI, owner: "#7171" },
  restDecl: { lanes: WASI, owner: "#7171" },
  restLead: { lanes: WASI, owner: "#7171" },
  restArrow: { lanes: WASI, owner: "#7171" },
  restExpr: { lanes: WASI, owner: "#7171" },
  restMethod: { lanes: WASI, owner: "#7171" },
  restStatic: { lanes: WASI, owner: "#7171" },
  restClosure: { lanes: WASI, owner: "#7171" },
  restNew: { lanes: WASI, owner: "#7171" },
  positionalDecl: { lanes: WASI, owner: "#7171" },
  positionalMethod: { lanes: WASI, owner: "#7171" },
  positionalNew: { lanes: WASI, owner: "#7171" },
};

describe("#7164 generated sweep: matches node", () => {
  for (const [name, expr] of Object.entries(SWEEP)) {
    const src = `${ENC}${SWEEP_PRELUDE}\nexport function test(): number { ${SWEEP_GROW} return enc(sum(${expr})); }`;
    for (const { lane, options } of LANES) {
      const gap = SWEEP_GAPS[name]?.lanes.includes(lane) ? SWEEP_GAPS[name]!.owner : undefined;
      (gap !== undefined ? it.fails : it)(
        `${name} / ${lane}${gap !== undefined ? ` (known gap: ${gap})` : ""}`,
        async () => {
          const result = await compile(src, { fileName: "probe.ts", ...options });
          expect(result.success, `${name}/${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
          const exports = (await instantiateWithRuntime(result)).exports as Record<string, unknown>;
          expect((exports.test as () => unknown)(), `${name}/${lane}`).toBe(evaluateAsJs(src).test!());
        },
        120_000,
      );
    }
  }
});

// (#7164 r5/r6) Marker-leak detector. `$Hole` reads back as `undefined` through
// `r[i]`, so a leak shows as an index node reports PRESENT that head reports
// absent: `i in r` false, or skipped by `forEach`. Each result index is
// summarised as presence (P/H), forEach visit (V/S) and value class (u
// undefined / n null / O object / v other). A leak is node P → head H, node V
// → head S, or node u → head anything but u — so a `null` fill where node has
// `undefined` is a leak. Present-where-node-has-a-hole (H → P) is the accepted
// #7170 gap. On wasi `i in r` is false even for dense arrays (#7171), so only
// the visit and value columns count there. Setups cover every grow form and
// the reallocation path.
//
// r6: the detector is relative to origin/main. issue-7164-leak-base.json lists,
// per setup/case/lane, the leaks this branch still shares with origin/main at
// the same index and of the same kind (recorded by running the same modules on
// both trees; a leak head has that base lacks was never recorded, because the
// recorder refuses it). Any other leak fails. A cell #7164 fixed is not in the
// list, so regressing it — e.g. filling `null` again — fails.
const LEAK_BASE = JSON.parse(readFileSync(new URL("./issue-7164-leak-base.json", import.meta.url), "utf8")) as Record<
  string,
  Partial<Record<Lane, string[]>>
>;
function readSummary(fn: (i: number) => number): string {
  const n = fn(-1);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(fn(i));
  return s;
}

describe("#7164 generated sweep: no marker leaks", () => {
  const cases = Object.keys(SWEEP);
  for (const [setupName, setup] of Object.entries(LEAK_SETUPS)) {
    const nodeSrc = `${SWEEP_PRELUDE}${LEAK_SUMMARY}\n${leakFns(setup, cases)}`;
    for (const { lane, options } of LANES) {
      describe(`${setupName} / ${lane}`, () => {
        const perCase = new Map<string, ((i: number) => number) | string>();
        beforeAll(async () => {
          // One module per setup; when it does not compile on this lane (known
          // compile gaps), bisect so the failing cases are found in a few compiles.
          const build = async (names: readonly string[]): Promise<void> => {
            const result = await compile(`${SWEEP_PRELUDE}${LEAK_SUMMARY}\n${leakFns(setup, names)}`, {
              fileName: "probe.ts",
              ...options,
            });
            if (result.success) {
              const exports = (await instantiateWithRuntime(result)).exports as Record<string, unknown>;
              for (const name of names) perCase.set(name, exports[`at_${name}`] as (i: number) => number);
            } else if (names.length === 1) {
              perCase.set(names[0]!, result.errors[0]?.message ?? "compile error");
            } else {
              const mid = names.length >> 1;
              await build(names.slice(0, mid));
              await build(names.slice(mid));
            }
          };
          // `restObjMethod` emits invalid wasm on every lane (as on origin/main): its own module.
          await build(cases.filter((name) => name !== "restObjMethod"));
          await build(["restObjMethod"]);
        }, 600_000);
        it("every case", () => {
          const node = evaluateAsJs(nodeSrc);
          const leaks: string[] = [];
          for (const name of cases) {
            const fn = perCase.get(name);
            if (typeof fn !== "function") continue; // does not compile: cannot leak
            let head: string;
            try {
              head = readSummary(fn);
            } catch {
              continue; // a trap is not a leak
            }
            const expected = readSummary(node[`at_${name}`] as (i: number) => number);
            const shared = new Set(LEAK_BASE[`${setupName}/${name}`]?.[lane] ?? []);
            for (const leak of leaksIn(expected, head, lane))
              if (!shared.has(leak)) leaks.push(`${name} ${leak} (node ${expected}, head ${head})`);
          }
          expect(leaks).toEqual([]);
        });
      });
    }
  }
});

// (#7164 r5) A callback that grows the receiver — by `length =` (which can
// now reallocate the backing) or by `push` (which always could) — must have
// the loop see its later writes: the callback loops re-read the backing array
// every iteration.
const CB_GROW: Record<string, readonly [string, string]> = {
  len: ["g.length = 6; g[1] = 'q';", "g.length = 6; g[0] = 'q';"],
  push: [
    "g.push(1); g.push(2); g.push(3); g.push(4); g.push(5); g[1] = 'q';",
    "g.push(1); g.push(2); g.push(3); g.push(4); g.push(5); g[0] = 'q';",
  ],
};
const CB_SETUP = "const g: any[] = []; g.push('y'); g.push('z');";
const cbCases = (m: string, r: string): Record<string, string> => ({
  map: `const t = g.map((v: any, i: number) => { if (i === 0) { ${m} } return String(v); }); return t.slice(0, 2).join('|');`,
  forEach: `let s = ''; g.forEach((v: any, i: number) => { if (i === 0) { ${m} } if (i < 2) s += String(v) + ','; }); return s;`,
  filter: `const t = g.filter((v: any, i: number) => { if (i === 0) { ${m} } return i < 2; }); return t.join('|');`,
  reduce: `return g.reduce((a: string, v: any, i: number) => { if (i === 0) { ${m} } return i < 2 ? a + String(v) : a; }, '');`,
  reduceRight: `return g.reduceRight((a: string, v: any, i: number) => { if (i === 1) { ${r} } return i < 2 ? a + String(v) : a; }, '');`,
  find: `return String(g.find((v: any, i: number) => { if (i === 0) { ${m} } return i === 1; }));`,
  findIndex: `return String(g.findIndex((v: any, i: number) => { if (i === 0) { ${m} } return v === 'q'; }));`,
  findLast: `return String(g.findLast((v: any, i: number) => { if (i === 1) { ${r} } return i === 0; }));`,
  findLastIndex: `return String(g.findLastIndex((v: any, i: number) => { if (i === 1) { ${r} } return v === 'q'; }));`,
  some: `let s = ''; g.some((v: any, i: number) => { if (i === 0) { ${m} } if (i < 2) s += String(v); return i >= 1; }); return s;`,
  every: `let s = ''; g.every((v: any, i: number) => { if (i === 0) { ${m} } s += String(v); return i < 1; }); return s;`,
  flatMap: `const t = g.flatMap((v: any, i: number) => { if (i === 0) { ${m} } return [String(v)]; }); return t.slice(0, 2).join('|');`,
  sort: `let once = true; g.sort((a: any, b: any) => { if (once) { once = false; ${m} } return 0; }); return g.slice(0, 2).join('|') + g.length;`,
  join: `const o = { toString(): string { ${m} return 'o'; } }; g[0] = o; return g.join('|').slice(0, 5);`,
});
// Same answer on origin/main (untracked): node sorts a copy and writes it
// back over the comparator's writes; the in-place sort keeps them.
const CB_GAPS: Record<string, { lanes: readonly Lane[]; owner: string }> = {
  sort: { lanes: ALL, owner: "sort-comparator-mutation" },
};

describe("#7164 callbacks that grow the array", () => {
  for (const [form, [m, r]] of Object.entries(CB_GROW)) {
    for (const [method, body] of Object.entries(cbCases(m, r))) {
      const src = `${ENC}function value(): string { ${CB_SETUP} ${body} }\nexport function test(): number { return enc(value()); }`;
      for (const { lane, options } of LANES) {
        const gap = CB_GAPS[method]?.lanes.includes(lane) ? CB_GAPS[method]!.owner : undefined;
        (gap !== undefined ? it.fails : it)(
          `${method} / grow by ${form} / ${lane}${gap ? ` (known gap: ${gap})` : ""}`,
          async () => {
            const result = await compile(src, { fileName: "probe.ts", ...options });
            expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
            const exports = (await instantiateWithRuntime(result)).exports as Record<string, unknown>;
            expect((exports.test as () => unknown)(), `${method}/${form}/${lane}`).toBe(evaluateAsJs(src).test!());
          },
          120_000,
        );
      }
    }
  }
});

// (#7164 r6) Generated length-update sweep: every form (`= n`, `++`, `--`,
// prefix forms, `+= k`, `-= k`) × element type × setup (with and without a
// plain `length =` elsewhere; after push / pop / shrink) × receiver (local,
// parameter, property chain) × lane. It asserts "never worse than
// origin/main": where origin/main matched node, head must match node; where
// origin/main was wrong, head must not trap or fail to compile. The recorded
// origin/main outcomes (rows that did not match node) are in
// issue-7164-length-update-sweep-base.json. By default every 23rd row runs
// (44 rows, covering every form × element pair); JS2WASM_FULL_SWEEP=1 runs all
// 1,008 rows.
const SWEEP_BASE = JSON.parse(
  readFileSync(new URL("./issue-7164-length-update-sweep-base.json", import.meta.url), "utf8"),
) as Record<string, Partial<Record<Lane, "wrong" | "trap">>>;
const FULL_LENGTH_SWEEP = process.env.JS2WASM_FULL_SWEEP === "1";

describe("#7164 length-update sweep: never worse than origin/main", () => {
  const rows = sweepRows().filter((_, i) => FULL_LENGTH_SWEEP || i % 23 === 0);
  for (const row of rows) {
    const src = `${sweepSource(row.form, row.element, row.setup, row.eqElsewhere, row.receiver)}\nexport function at(i: number): number { const s = value(); return i < 0 ? s.length : s.charCodeAt(i); }`;
    for (const { lane, options } of LANES) {
      it(`${row.key} / ${lane}`, async () => {
        const read = (at: (i: number) => number): string => {
          const n = at(-1);
          let out = "";
          for (let i = 0; i < n; i++) out += String.fromCharCode(at(i));
          return out;
        };
        const node = read(evaluateAsJs(src).at as (i: number) => number);
        let head: string;
        try {
          const result = await compile(src, { fileName: "probe.ts", ...options });
          if (!result.success) head = `CE ${result.errors[0]?.message}`;
          else head = read((await instantiateWithRuntime(result)).exports.at as (i: number) => number);
        } catch (e) {
          head = `TRAP ${String(e)}`;
        }
        const base = SWEEP_BASE[row.key]?.[lane] ?? "ok";
        if (base === "ok") expect(head, `${row.key}/${lane}`).toBe(node);
        else if (base === "wrong") expect(head, `${row.key}/${lane}`).not.toMatch(/^(TRAP|CE) /);
      }, 120_000);
    }
  }
});

// (#7164 r9) Callback-array escape sweep: a switched binding behind every
// receiver shape (`(g)`, `g!`, `as`, `satisfies`, `.reverse()` / `.fill()` /
// `.copyWithin()`, `?:`, `||`, `??`, `&&`, comma, `h = g`, `g['m']`), handed to
// every callback method whose callback updates `length` through its array
// parameter (behind any of those shapes the binding is not switched, so the
// store through the parameter is origin/main's). None of these may trap where
// origin/main does not. Same contract as the
// length-update sweep; origin/main's outcomes are in
// issue-7164-callback-sweep-base.json (scripts/record-7164-bases.mts). By
// default every 29th row runs (32 of 900); JS2WASM_FULL_SWEEP=1 runs all.
const CALLBACK_BASE = JSON.parse(
  readFileSync(new URL("./issue-7164-callback-sweep-base.json", import.meta.url), "utf8"),
) as Record<string, Partial<Record<Lane, "wrong" | "trap">>>;
describe("#7164 callback-array escape sweep: never worse than origin/main", () => {
  const rows = callbackRows().filter((_, i) => FULL_LENGTH_SWEEP || i % 29 === 0);
  for (const row of rows) {
    const src = callbackSource(row.wrapper, row.method, row.form);
    for (const { lane, options } of LANES) {
      it(`${row.key} / ${lane}`, async () => {
        const read = (at: (i: number) => number): string => {
          const n = at(-1);
          let out = "";
          for (let i = 0; i < n; i++) out += String.fromCharCode(at(i));
          return out;
        };
        const node = read(evaluateAsJs(src).at as (i: number) => number);
        let head: string;
        try {
          const result = await compile(src, { fileName: "probe.ts", ...options });
          if (!result.success) head = `CE ${result.errors[0]?.message}`;
          else head = read((await instantiateWithRuntime(result)).exports.at as (i: number) => number);
        } catch (e) {
          head = `TRAP ${String(e)}`;
        }
        const base = CALLBACK_BASE[row.key]?.[lane] ?? "ok";
        if (base === "ok") expect(head, `${row.key}/${lane}`).toBe(node);
        else if (base === "wrong") expect(head, `${row.key}/${lane}`).not.toMatch(/^(TRAP|CE) /);
      }, 120_000);
    }
  }
});
