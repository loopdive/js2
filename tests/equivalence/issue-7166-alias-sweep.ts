// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7166 — generated sweep of the ways an alias of an externref-element vec can
// be used: `const r = a` / `let r = a.sort()` and friends, module-level and
// function-local, `const` and `let`, over string, number, mixed and for…in
// elements. It covers the recognised safe uses and everything the alias rule
// must decline: escapes into typed places, reassignment, closure writes,
// destructuring (as a binding and as an element target), callbacks and
// comparators that use their element, call spreads (with and without a rest
// parameter), and reads that run before the declaration. Shared by
// issue-7166-sort-reverse-identity.test.ts and the head-vs-base review probe.
// Each program exports `test()` returning a number digest of a string result.

const ENC = `function enc(s) { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;

/** Element kinds: the source fill, two present elements and a value to store. */
interface Source {
  fill: string;
  e0: string;
  e1: string;
  v: string;
}
const SOURCES: Record<string, Source> = {
  str: { fill: `const a = [];\na.push("b"); a.push("a");\n`, e0: `"b"`, e1: `"a"`, v: `"p"` },
  num: { fill: `const a = [];\na.push(2); a.push(1);\n`, e0: `2`, e1: `1`, v: `7` },
  mixed: { fill: `const a = [];\na.push("b"); a.push(1);\n`, e0: `"b"`, e1: `1`, v: `"p"` },
  forin: { fill: `const a = [];\nfor (const k in { b: 1, a: 2 }) a.push(k);\n`, e0: `"b"`, e1: `"a"`, v: `"p"` },
};

/** Initialisers of the alias `r`. */
const INITS: Record<string, string> = { plain: `a`, sort: `a.sort()`, reverse: `a.reverse()` };

interface Use {
  name: string;
  /** Statements before the alias's declaration (same scope). */
  pre?: string;
  /** Statements after it, inside `test()`. */
  stmts: string;
  /** String-valued result expression. */
  result: string;
  /** Only meaningful for `let`. */
  letOnly?: boolean;
  /** Only meaningful function-local (a hoisted nested function declaration). */
  localOnly?: boolean;
}

/** `E0` / `E1` / `V` are replaced per source; `other` is a typed `string[]`. */
const USES: Use[] = [
  { name: "element read", stmts: ``, result: `String(r[0]) + String(r[1])` },
  { name: "element write", stmts: `r[0] = V;`, result: `String(a[0]) + (r === a)` },
  { name: "element write number", stmts: `r[0] = 5;`, result: `String(a[0]) + typeof a[0]` },
  { name: "element compound", stmts: `r[0] += "";`, result: `String(a[0])` },
  { name: "length", stmts: ``, result: `String(r.length)` },
  { name: "length write", stmts: `r.length = 1;`, result: `String(a.length)` },
  { name: "push", stmts: `r.push(V);`, result: `String(a.length) + a[a.length - 1]` },
  { name: "pop", stmts: `r.pop();`, result: `String(a.length)` },
  { name: "typeof element", stmts: ``, result: `typeof r[0] + typeof r[1]` },
  { name: "typeof === element", stmts: ``, result: `String(typeof r[0] === "string") + (typeof r[1] === "number")` },
  { name: "join", stmts: ``, result: `r.join("-")` },
  { name: "indexOf", stmts: ``, result: `String(r.indexOf(E1)) + r.includes(E0)` },
  { name: "slice pushed", stmts: `const c = r.slice(); c.push(V);`, result: `String(c.length) + a.length + c[0]` },
  { name: "concat", stmts: ``, result: `r.concat([V]).join()` },
  { name: "chain sort().reverse()", stmts: `r.sort().reverse();`, result: `String(a[0]) + (r === a)` },
  { name: "chain result compared", stmts: ``, result: `String(r.sort() === a)` },
  { name: "=== source", stmts: ``, result: `String(r === a) + (r !== a)` },
  { name: "for…of", stmts: `let s = ""; for (const x of r) s += String(x) + typeof x;`, result: `s` },
  {
    name: "spread literal",
    stmts: `const c = [...r]; c.push(V);`,
    result: `String(c.length) + a.length + typeof c[1]`,
  },
  // Callbacks and comparators that use their element.
  { name: "map identity", stmts: ``, result: `r.map((x) => x).join()` },
  { name: "map typeof", stmts: ``, result: `r.map((x) => typeof x).join()` },
  { name: "filter", stmts: ``, result: `r.filter((x) => x === E0).join()` },
  { name: "forEach", stmts: `let s = ""; r.forEach((x) => { s += typeof x + String(x); });`, result: `s` },
  { name: "find", stmts: ``, result: `String(r.find((x) => x === E1))` },
  { name: "findIndex", stmts: ``, result: `String(r.findIndex((x) => x === E1))` },
  { name: "findLast", stmts: ``, result: `String(r.findLast((x) => x === E0))` },
  { name: "some", stmts: ``, result: `String(r.some((x) => typeof x === "number"))` },
  { name: "every", stmts: ``, result: `String(r.every((x) => x !== undefined))` },
  { name: "reduce", stmts: ``, result: `r.reduce((acc, x) => acc + typeof x + String(x), "")` },
  { name: "reduceRight", stmts: ``, result: `r.reduceRight((acc, x) => acc + String(x), "")` },
  { name: "flatMap", stmts: ``, result: `r.flatMap((x) => [x, x]).join()` },
  { name: "sort comparator", stmts: `r.sort((p, q) => (String(p) < String(q) ? -1 : 1));`, result: `a.join()` },
  { name: "sort numeric comparator", stmts: `r.sort((p, q) => Number(p) - Number(q));`, result: `a.join()` },
  // Call spreads.
  {
    name: "spread call",
    stmts: `function two(x, y) { return typeof x + String(x) + String(y); }`,
    result: `two(...r)`,
  },
  {
    name: "spread rest",
    stmts: `function rest(...xs) { xs.push(V); return xs.length; }`,
    result: `String(rest(...r)) + a.length`,
  },
  // Destructuring targets.
  { name: "swap", stmts: `[r[0], r[1]] = [r[1], r[0]];`, result: `a.join()` },
  { name: "object pattern target", stmts: `({ x: r[0] } = { x: V });`, result: `a.join()` },
  { name: "for…of target", stmts: `for (r[0] of [V]) {}`, result: `a.join()` },
  // Reads that can run before the declaration.
  {
    name: "TDZ read",
    pre: `let t0; try { t0 = String(r.length); } catch (e) { t0 = "tdz"; }`,
    stmts: ``,
    result: `t0 + r.length`,
    localOnly: true,
  },
  {
    name: "hoisted function read",
    pre: `function h() { return String(r.length) + typeof r[0]; }`,
    stmts: ``,
    result: `h()`,
    localOnly: true,
  },
  // Escapes: the vec reaches a place typed from the checker's `T[]`.
  { name: "const t = r", stmts: `const t = r; t.push(V);`, result: `String(a.length) + (t === r)` },
  { name: "[r]", stmts: `const box = [r]; box[0].push(V);`, result: `String(a.length) + (box[0] === r)` },
  { name: "{ v: r }", stmts: `const o = { v: r }; o.v.push(V);`, result: `String(a.length) + (o.v === r)` },
  { name: "id(r)", stmts: `const t = id(r); t.push(V);`, result: `String(a.length) + (t === r)` },
  { name: "return r", stmts: `const t = g(); t.push(V);`, result: `String(a.length) + (t === r)` },
  { name: "?: branch", stmts: `const t = flag ? r : []; t.push(V);`, result: `String(a.length) + (t === r)` },
  { name: "|| operand", stmts: `const t = r || []; t.push(V);`, result: `String(a.length) + (t === r)` },
  { name: "destructure", stmts: `const [t] = [r]; t.push(V);`, result: `String(a.length) + (t === r)` },
  { name: "r = other", stmts: `r = other; r.push("o");`, result: `other.join() + (r === other)`, letOnly: true },
  { name: "closure write", stmts: `const f = () => { r = ["q"]; }; f();`, result: `r.join()`, letOnly: true },
  {
    name: "destructuring write",
    stmts: `[r] = [other]; r.push("o");`,
    result: `other.join() + (r === other)`,
    letOnly: true,
  },
];

/**
 * The sweep. `full` runs every source × {plain, sort, reverse} × const / let;
 * the default is a strict subset: the mixed source with `a.sort()`, `const`
 * (`let` for the `let`-only uses).
 */
export function aliasSweepCases(full: boolean): [string, string][] {
  const cases: [string, string][] = [];
  const sources = full ? Object.entries(SOURCES) : [["mixed", SOURCES.mixed!] as const];
  const inits = full ? Object.entries(INITS) : [["sort", INITS.sort!] as const];
  for (const [sname, source] of sources) {
    for (const [iname, init] of inits) {
      for (const use of USES) {
        const sub = (text: string): string =>
          text.replaceAll("E0", source.e0).replaceAll("E1", source.e1).replaceAll("V", source.v);
        const kws = full ? (["const", "let"] as const) : use.letOnly ? (["let"] as const) : (["const"] as const);
        for (const kw of kws) {
          if (use.letOnly && kw === "const") continue;
          for (const where of ["module", "local"] as const) {
            if (use.localOnly && where === "module") continue;
            const decl = `${source.fill}${use.pre ? sub(use.pre) + "\n" : ""}${kw} r = ${init};\nconst other = ["m"];\nconst flag = a.length > 0;\n`;
            // `g` returns `r`, so it exists only in the row that tests that escape.
            const helpers = `function id(x) { return x; }\n${use.name === "return r" ? "function g() { return r; }\n" : ""}`;
            const body = `${sub(use.stmts)}\nreturn enc(${sub(use.result)});`;
            const src =
              where === "module"
                ? `${ENC}${decl}${helpers}export function test() {\n${body}\n}`
                : `${ENC}export function test() {\n${decl}${helpers}${body}\n}`;
            cases.push([`${where} ${kw} ${sname} r = ${iname}: ${use.name}`, src]);
          }
        }
      }
    }
  }
  return cases;
}
