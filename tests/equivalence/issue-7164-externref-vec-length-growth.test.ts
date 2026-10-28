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
const GUARDS: Record<string, { pre?: string; body: string; gap?: string }> = {
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
  spreadShrinkGrow: {
    body: "const g: any[] = []; g.push('y'); g.push('z'); g.length = 1; g.length = 3; const s = [...g]; return s.length+':'+(1 in s)+':'+String(s[1]);",
  },
};

describe("#7164 share-group guards", () => {
  for (const [name, { pre, body, gap }] of Object.entries(GUARDS)) {
    const src = `${ENC}${pre ?? ""}\nfunction value(): string { ${body} }\nexport function test(): number { return enc(value()); }`;
    for (const { lane, options } of LANES) {
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
const SWEEP_PRELUDE = `
function sum(r: any[]): string { let s = r.length + ":"; for (let i = 0; i < r.length; i++) { const v = r[i]; s += (i in r ? "P" : "H") + (v === undefined ? "u" : typeof v === "object" && v !== null ? "O" : "v"); } return s; }
function fd(...r: any[]): any[] { return r; }
function fdLead(a: any, ...r: any[]): any[] { return r; }
function f3(a: any, b: any, c: any): any[] { return [a, b, c]; }
const fArrow = (...r: any[]): any[] => r;
const fExpr = function (...r: any[]): any[] { return r; };
class KR { m(...r: any[]): any[] { return r; } static s(...r: any[]): any[] { return r; } p(a: any, b: any, c: any): any[] { return [a, b, c]; } }
class CR { r: any[]; constructor(...r: any[]) { this.r = r; } }
class DR extends CR { constructor(...r: any[]) { super(...r); } }
class CP { r: any[]; constructor(a: any, b: any, c: any) { this.r = [a, b, c]; } }
const objM = { m(...r: any[]): any[] { return r; } };
`;
const SWEEP_GROW = `const g: any[] = []; g.push("y"); g.length = 3;`;
const SWEEP: Record<string, string> = {
  self: `g`,
  map: `g.map((x: any) => x)`,
  filter: `g.filter(() => true)`,
  slice: `g.slice()`,
  concat: `g.concat([])`,
  flat: `g.flat()`,
  flatMap: `g.flatMap((x: any) => [x])`,
  toReversed: `g.toReversed()`,
  toSorted: `g.toSorted()`,
  toSpliced: `g.toSpliced(0, 0)`,
  with: `g.with(0, "w")`,
  splice: `g.splice(0)`,
  arrayFrom: `Array.from(g)`,
  arrayOf: `Array.of(...g)`,
  entries: `[...g.entries()].map((e: any) => e[1])`,
  values: `[...g.values()]`,
  spread: `[...g]`,
  spreadLead: `[0, ...g]`,
  forEachCollect: `(() => { const o: any[] = []; g.forEach((v: any) => { o.push(v); }); return o; })()`,
  forOfCollect: `(() => { const o: any[] = []; for (const v of g) o.push(v); return o; })()`,
  reduceCollect: `g.reduce((o: any[], v: any) => { o.push(v); return o; }, [] as any[])`,
  indexRead: `[g[0], g[1], g[2]]`,
  dynamicRead: `(() => { const a: any = g; const o: any[] = []; for (let i = 0; i < 3; i++) o.push(a[i]); return o; })()`,
  restDecl: `fd(...g)`,
  restLead: `fdLead(0, ...g)`,
  restArrow: `fArrow(...g)`,
  restExpr: `fExpr(...g)`,
  restMethod: `new KR().m(...g)`,
  restStatic: `KR.s(...g)`,
  restObjMethod: `objM.m(...g)`,
  restClosure: `(() => { const c = "c"; const f = (...r: any[]): any[] => (c ? r : r); return f(...g); })()`,
  restNew: `new CR(...g).r`,
  restSuper: `new DR(...g).r`,
  apply: `(fd as any).apply(null, g)`,
  positionalDecl: `f3(...g)`,
  positionalMethod: `new KR().p(...g)`,
  positionalNew: `new CP(...g).r`,
};
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

describe("#7164 generated leak sweep", () => {
  for (const [name, expr] of Object.entries(SWEEP)) {
    const src = `${ENC}${SWEEP_PRELUDE}\nexport function test(): number { ${SWEEP_GROW} return enc(sum(${expr})); }\nexport function leak(): number { ${SWEEP_GROW} const r: any[] = ${expr}; for (let i = 0; i < r.length; i++) { const v = r[i]; if (typeof v === "object" && v !== null && String(v) === "[object Object]") return 1; } return 0; }`;
    for (const { lane, options } of LANES) {
      describe(`${name} / ${lane}`, () => {
        let exports: Record<string, unknown> | undefined;
        let failure = "";
        beforeAll(async () => {
          const result = await compile(src, { fileName: "probe.ts", ...options });
          if (!result.success) {
            failure = result.errors.map((e) => e.message).join("\n");
            return;
          }
          try {
            exports = (await instantiateWithRuntime(result)).exports as Record<string, unknown>;
          } catch (e) {
            failure = String(e);
          }
        }, 120_000);
        it("no marker leaks", () => {
          if (exports === undefined) return; // a compile/instantiate failure cannot leak; the node row reports it
          let leaked: unknown;
          try {
            leaked = (exports.leak as () => unknown)();
          } catch {
            return; // a trap is not a leak; the node row reports it
          }
          expect(leaked, `${name}/${lane}`).toBe(0);
        });
        const gap = SWEEP_GAPS[name]?.lanes.includes(lane) ? SWEEP_GAPS[name]!.owner : undefined;
        (gap !== undefined ? it.fails : it)(`matches node${gap !== undefined ? ` (known gap: ${gap})` : ""}`, () => {
          expect(failure, `${name}/${lane}`).toBe("");
          expect((exports!.test as () => unknown)(), `${name}/${lane}`).toBe(evaluateAsJs(src).test!());
        });
      });
    }
  }
});
