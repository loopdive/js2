// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7214 — `recv.f += rhs` on a native-string field went down the numeric
// property compound lowering: the field was ToNumber-ed, `f64.add`-ed, and the
// writeback stored `ref.null`, so the next read trapped ("dereferencing a null
// pointer", or "illegal cast" with chained calls). `recv.f = recv.f + rhs`
// worked. Each row is diffed against native JS on gc, standalone and wasi.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES = [
  { lane: "gc", options: {} },
  { lane: "standalone", options: { target: "standalone" } },
  { lane: "wasi", options: { target: "wasi" } },
] as const;

// A throw is reported by its constructor, so a row can assert node's TypeError / RangeError.
const READ = `export function test(i: number) { let s: string; try { s = String(run()); } catch (e) { s = "THROW:" + (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : "Other"); } return i < 0 ? s.length : s.charCodeAt(i); }`;

function decode(f: (i: number) => unknown): string {
  const n = Number(f(-1));
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(Number(f(i)));
  return out;
}

// The wasi lane stringifies an object operand as "[object Object]" and has no
// RegExp engine for `/ab/g`, under plain `+` exactly as under `+=`; and the test
// harness cannot instantiate a wasi module that imports `wasi_snapshot_preview1`
// (an uncaught user throw). Those rows run on gc and standalone.
const NO_WASI = new Set([
  "object right operand with toString",
  "throwing valueOf (any) propagates RangeError",
  "throwing valueOf (typed object) propagates RangeError",
  "RegExp right operand",
]);

async function expectSameOnLanes(body: string, lanes: readonly (typeof LANES)[number][]): Promise<void> {
  const src = `${body}\n${READ}`;
  const expected = decode(evaluateAsJs(src).test as (i: number) => unknown);
  for (const { lane, options } of lanes) {
    const result = await compile(src, { fileName: "probe.ts", ...options });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect(decode(instance.exports.test as (i: number) => unknown), lane).toBe(expected);
  }
}

// `run()` builds fresh state on every call: `test(i)` calls it once per code unit.
const CASES: Record<string, string> = {
  "issue repro (untyped param, chained)": `class Acc { total = ''; add(s) { this.total += s; return this; } }
function run() { return new Acc().add('a').add('b').total; }`,
  "typed param, non-empty initial, chained": `class Acc { total = 'x'; add(s: string) { this.total += s; return this; } }
function run(): string { return new Acc().add('a').add('b').total; }`,
  "this.f += s, no return this": `class Acc { total = ''; add(s: string) { this.total += s; } }
function run(): string { const a = new Acc(); a.add('a'); a.add('b'); return a.total; }`,
  "declared string field": `class Acc { total: string = ''; add(s: string) { this.total += s; } }
function run(): string { const a = new Acc(); a.add('q'); return a.total; }`,
  "another instance (o.f += s)": `class Acc { total = '' }
function run(): string { const a = new Acc(); a.total += 'q'; a.total += 'r'; return a.total; }`,
  "static field (C.f += s)": `class C { static f = 'a'; }
function run(): string { C.f = 'a'; C.f += 'b'; C.f += 3; return C.f; }`,
  "private field (this.#f += s)": `class C { #f = 'a'; add(s: string) { this.#f += s; return this.#f; } }
function run(): string { const c = new C(); c.add('y'); return c.add('z'); }`,
  "number right operand": `class C { f = 'a'; add() { this.f += 1; this.f += 2.5; } }
function run(): string { const c = new C(); c.add(); return c.f; }`,
  "boolean right operand": `class C { f = 'a'; add() { this.f += true; } }
function run(): string { const c = new C(); c.add(); return c.f; }`,
  "object right operand with toString": `class P { toString() { return 'P'; } }
class C { f = 'a'; add() { this.f += new P(); } }
function run(): string { const c = new C(); c.add(); return c.f; }`,
  // The RHS takes `+`'s ToPrimitive(default) — valueOf first, a Symbol throws — not ToString.
  "any Symbol right operand throws TypeError": `class C { s = 'a'; }
function run(): string { const x: any = Symbol('q'); const o = new C(); o.s += x; return o.s; }`,
  "Symbol cast to any throws TypeError": `class C { s = 'a'; go() { this.s += (Symbol('x') as any); return this.s; } }
function run(): string { return new C().go(); }`,
  "static field, Symbol right operand throws": `class C { static s = 'a'; }
function run(): string { C.s = 'a'; const x: any = Symbol('q'); C.s += x; return C.s; }`,
  "untyped param holding a Symbol throws": `class C { s = 'a'; add(v) { this.s += v; return this.s; } }
function run(): string { return new C().add(Symbol('z')); }`,
  "throwing valueOf (any) propagates RangeError": `class C { s = 'a'; }
function run(): string { const x: any = { valueOf() { throw new RangeError('v'); }, toString() { return 'T'; } }; const o = new C(); o.s += x; return o.s; }`,
  "throwing valueOf (typed object) propagates RangeError": `class C { s = 'a'; }
function run(): string { const x = { valueOf(): number { throw new RangeError('v'); }, toString() { return 'T'; } }; const o = new C(); o.s += x as any; return o.s; }`,
  "valueOf (any) wins over toString": `class C { s = 'a'; }
function run(): string { const log: string[] = []; const r = { valueOf() { log.push('v'); return 1; }, toString() { log.push('t'); return 'T'; } }; const o = new C(); o.s += r as any; return o.s + '|' + log.join(','); }`,
  "valueOf returning a number (any)": `class C { s = 'a'; }
function run(): string { const x: any = { valueOf() { return 7; } }; const o = new C(); o.s += x; return o.s; }`,
  "typed valueOf object": `class C { s = 'a'; }
function run(): string { const x = { valueOf() { return 1; }, toString() { return 'T'; } }; const o = new C(); o.s += x as any; return o.s; }`,
  "RegExp right operand": `class C { s = 'a'; }
function run(): string { const o = new C(); o.s += /ab/g; return o.s; }`,
  "nullable field holding null": `class C { f: string | null = null; add() { this.f += 'x'; } }
function run(): string { const c = new C(); c.add(); return String(c.f); }`,
  "nullable field holding a string": `class C { f: string | null = 'n'; add() { this.f += 'x'; } }
function run(): string { const c = new C(); c.add(); return String(c.f); }`,
  "optional field, unset": `class C { f?: string; add() { this.f += 'x'; } }
function run(): string { const c = new C(); c.add(); return String(c.f); }`,
  "string | undefined field, twice": `class C { f: string | undefined = undefined; add() { this.f += 'x'; this.f += 'y'; } }
function run(): string { const c = new C(); c.add(); return String(c.f); }`,
  "inside a loop": `class C { f = ''; build(n: number) { for (let i = 0; i < n; i++) this.f += i; return this.f; } }
function run(): string { return new C().build(5); }`,
  "arrow functions capturing this": `class C { f = '<'; go() { const g = (s: string) => { this.f += s; }; g('a'); [1, 2].forEach((x) => { this.f += x; }); return this.f; } }
function run(): string { return new C().go(); }`,
  "expression value": `class C { f = 'a'; }
function run(): string { const c = new C(); const v = (c.f += 'b'); return v + '|' + c.f; }`,
  "receiver evaluated once": `class C { f = 'a'; }
function run(): string { let n = 0; const c = new C(); const get = (): C => { n++; return c; }; get().f += 'b'; get().f += 'c'; return c.f + n; }`,
  "object literal field": `function run(): string { const o = { s: '' }; o.s += 'x'; o.s += 'y'; return o.s; }`,
  "interface-typed field": `interface I { s: string }
function run(): string { const o: I = { s: 'a' }; o.s += 'x'; return o.s; }`,
  "explicit form still agrees": `class C { f = 'a'; add(s: string) { this.f = this.f + s; this.f += s; } }
function run(): string { const c = new C(); c.add('z'); return c.f; }`,
};

describe("#7214 compound string append on class fields", () => {
  for (const [name, body] of Object.entries(CASES)) {
    it(name, async () => {
      await expectSameOnLanes(body, NO_WASI.has(name) ? LANES.slice(0, 2) : LANES);
    });
  }
});
