// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6665) `String.prototype.match` / `search` / `split` with a search value
// that is only known at RUNTIME, `--target standalone`.
//
// Before: every such call site was a COMPILE error (`#1474` "RegExp or
// symbol-protocol search value is not supported"), which failed the whole
// module -- the first npm-compat standalone-dynamic blocker for hono, marked,
// moment, lodash, lodash-es and prettier after #6662. Now
// `src/codegen/string-regexp-dynamic.ts` dispatches at runtime: a backend
// RegExp runs the generic `RegExp.prototype[@@match/@@search/@@split]` body, an
// Object with the symbol method is called, anything else is `RegExpCreate`d
// (match/search) or split as a string (split).
//
// Every case returns 1 exactly when the result equals Node's.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const OPTS = { fileName: "test.js", allowJs: true, skipSemanticDiagnostics: true, target: "standalone" } as const;

async function runCase(src: string): Promise<number> {
  const r = await compile(src, OPTS);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(r.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test: () => number }).test();
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  [
    "match_g",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { var r = mt("a1b22c333", /\\d+/g); return r.length === 3 && r[2] === "333" ? 1 : 0; }
`,
  ],
  [
    "match_ng",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { var r = mt("a1b22", /(\\d)(\\d)/); return r[0] === "22" && r[1] === "2" && r.index === 3 ? 1 : 0; }
`,
  ],
  [
    "match_null",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { return mt("abc", /\\d/) === null ? 1 : 0; }
`,
  ],
  [
    "match_str",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { var r = mt("a.b", "."); return r[0] === "a" ? 1 : 0; }
`,
  ],
  [
    "search",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { return se("abc", /c/) === 2 ? 1 : 0; }
`,
  ],
  [
    "search_str",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { return se("abc", "b") === 1 ? 1 : 0; }
`,
  ],
  [
    "split_re",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { var r = sp("a1b2c", /\\d/); return r.length === 3 && r[2] === "c" ? 1 : 0; }
`,
  ],
  [
    "split_str",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { var r = sp("a,b,c", ","); return r.length === 3 && r[1] === "b" ? 1 : 0; }
`,
  ],
  [
    "split_lim",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { var r = sp("a,b,c", ",", 2); return r.length === 2 ? 1 : 0; }
`,
  ],
  [
    "split_undef",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { var r = sp("a,b", undefined); return r.length === 1 && r[0] === "a,b" ? 1 : 0; }
`,
  ],
  [
    "split_empty",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { var r = sp("abc", ""); return r.length === 3 && r[1] === "b" ? 1 : 0; }
`,
  ],
  [
    "split_cap",
    `function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
function sp(s, a, l) { return s.split(a, l); }
export function test() { var r = sp("a1b", /(\\d)/); return r.length === 3 && r[1] === "1" ? 1 : 0; }
`,
  ],
  [
    "lsplit_join",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { return lsplit("a-b-c", "-").join("+") === "a+b+c" ? 1 : 0; }
`,
  ],
  [
    "lsplit_len",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var r = lsplit("a-b-c", /-/, 2); return r.length === 2 && r[1] === "b" ? 1 : 0; }
`,
  ],
  [
    "words_empty",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { return words("abc", /\\d/).length === 0 ? 1 : 0; }
`,
  ],
  [
    "words",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var w = words("foo bar", /\\w+/g); return w.length === 2 && w[1] === "bar" ? 1 : 0; }
`,
  ],
  [
    "ssearch_miss",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { return ssearch("abc", /z/) === -1 ? 1 : 0; }
`,
  ],
  [
    "map_match",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var m = pmatch("abbbc", "x"); return m[0] === "bbb" ? 1 : 0; }
`,
  ],
  [
    "repall_split",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { return repAll("a.b.c", ".", "-") === "a-b-c" ? 1 : 0; }
`,
  ],
  [
    "repall_re",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { return repAll("a.b.c", /\\./g, "-") === "a-b-c" ? 1 : 0; }
`,
  ],
  [
    "obj_split",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var r = sp("abc", sv, 3); return r[0] === "hit" && r[1] === "abc" && r[2] === 3 ? 1 : 0; }
`,
  ],
  [
    "obj_match",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { return mt("abc", mv) === "m:abc" ? 1 : 0; }
`,
  ],
  [
    "obj_search",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { return se("abc", qv) === 42 ? 1 : 0; }
`,
  ],
  [
    "split_lim0",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { return sp("a,b", ",", 0).length === 0 ? 1 : 0; }
`,
  ],
  [
    "split_emptysubj",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var r = sp("", ","); return r.length === 1 && r[0] === "" ? 1 : 0; }
`,
  ],
  [
    "split_emptylim",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var r = sp("abcd", "", 2); return r.length === 2 && r[1] === "b" ? 1 : 0; }
`,
  ],
  [
    "split_null",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var r = sp("anullb", null); return r.length === 2 && r[1] === "b" ? 1 : 0; }
`,
  ],
  [
    "match_undef",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var r = mt("abc", undefined); return r[0] === "" && r.index === 0 ? 1 : 0; }
`,
  ],
  [
    "match_num",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var r = mt("a12b", 12); return r.index === 1 ? 1 : 0; }
`,
  ],
  [
    "match_g_lastindex",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var re = /a/g; re.lastIndex = 2; var r = mt("aXa", re); return r.length === 2 && re.lastIndex === 0 ? 1 : 0; }
`,
  ],
  [
    "search_lastindex",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var re = /a/g; re.lastIndex = 2; var r = se("xa", re); return r === 1 && re.lastIndex === 2 ? 1 : 0; }
`,
  ],
  [
    "dyn_re",
    `function toStr(v) { return v == null ? "" : "" + v; }
function lsplit(string, separator, limit) { string = toStr(string); return string.split(separator, limit); }
function words(string, pattern) { string = toStr(string); return string.match(pattern) || []; }
function ssearch(string, re) { string = toStr(string); return string.search(re); }
var po = new Map();
po.set("x", /b+/);
function pmatch(e, t) { return e.match(po.get(t)); }
function repAll(s, e, t) { return e.global ? s.replace(e, t) : s.split(e).join(t); }
var sv = {};
sv[Symbol.split] = function (s, l) { return ["hit", s, l]; };
var mv = {};
mv[Symbol.match] = function (s) { return "m:" + s; };
var qv = {};
qv[Symbol.search] = function (s) { return 42; };
function sp(s, a, l) { return s.split(a, l); }
function mt(s, a) { return s.match(a); }
function se(s, a) { return s.search(a); }
export function test() { var re = new RegExp("b" + "c", "g"); return mt("abcbc", re).length === 2 ? 1 : 0; }
`,
  ],
  [
    "user_match_method",
    `class Router { match(method, path) { return method + ":" + path; } }
function route(r, m, p) { return r.match(m, p); }
function strMatch2(s, a, b) { return s.match(a, b); }
function dynFlags(s, src, fl) { var re = new RegExp(src, fl); return s.match(re); }
function noArg(s) { return s.match(); }
function split3(s, a, l, x) { return s.split(a, l, x); }
export function test() { return route(new Router(), "GET", "/a") === "GET:/a" ? 1 : 0; }
`,
  ],
  [
    "string_match_extra_arg",
    `class Router { match(method, path) { return method + ":" + path; } }
function route(r, m, p) { return r.match(m, p); }
function strMatch2(s, a, b) { return s.match(a, b); }
function dynFlags(s, src, fl) { var re = new RegExp(src, fl); return s.match(re); }
function noArg(s) { return s.match(); }
function split3(s, a, l, x) { return s.split(a, l, x); }
export function test() { var r = strMatch2("a1b", /\\d/, 99); return r[0] === "1" ? 1 : 0; }
`,
  ],
  [
    "regexp_typed_dynamic_flags_g",
    `class Router { match(method, path) { return method + ":" + path; } }
function route(r, m, p) { return r.match(m, p); }
function strMatch2(s, a, b) { return s.match(a, b); }
function dynFlags(s, src, fl) { var re = new RegExp(src, fl); return s.match(re); }
function noArg(s) { return s.match(); }
function split3(s, a, l, x) { return s.split(a, l, x); }
export function test() { var r = dynFlags("aXa", "a", "g"); return r.length === 2 && r[1] === "a" ? 1 : 0; }
`,
  ],
  [
    "regexp_typed_dynamic_flags_i",
    `class Router { match(method, path) { return method + ":" + path; } }
function route(r, m, p) { return r.match(m, p); }
function strMatch2(s, a, b) { return s.match(a, b); }
function dynFlags(s, src, fl) { var re = new RegExp(src, fl); return s.match(re); }
function noArg(s) { return s.match(); }
function split3(s, a, l, x) { return s.split(a, l, x); }
export function test() { var r = dynFlags("aBc", "b", "i"); return r[0] === "B" && r.index === 1 ? 1 : 0; }
`,
  ],
  [
    "match_no_arg",
    `class Router { match(method, path) { return method + ":" + path; } }
function route(r, m, p) { return r.match(m, p); }
function strMatch2(s, a, b) { return s.match(a, b); }
function dynFlags(s, src, fl) { var re = new RegExp(src, fl); return s.match(re); }
function noArg(s) { return s.match(); }
function split3(s, a, l, x) { return s.split(a, l, x); }
export function test() { var r = noArg("abc"); return r.length === 1 && r[0] === "" ? 1 : 0; }
`,
  ],
  [
    "split_extra_arg",
    `class Router { match(method, path) { return method + ":" + path; } }
function route(r, m, p) { return r.match(m, p); }
function strMatch2(s, a, b) { return s.match(a, b); }
function dynFlags(s, src, fl) { var re = new RegExp(src, fl); return s.match(re); }
function noArg(s) { return s.match(); }
function split3(s, a, l, x) { return s.split(a, l, x); }
export function test() { var r = split3("a,b,c", ",", 2, 7); return r.length === 2 ? 1 : 0; }
`,
  ],
];

describe("#6665 standalone match/search/split with a runtime search value", () => {
  for (const [name, src] of CASES) {
    it(name, async () => {
      expect(await runCase(src)).toBe(1);
    });
  }

  it("matchAll with a runtime value still refuses (#1474)", async () => {
    const r = await compile(
      "function f(s, a) { return s.matchAll(a); }\nexport function test() { f('a', /a/g); return 0; }",
      OPTS,
    );
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toContain("#1474");
  });
});
