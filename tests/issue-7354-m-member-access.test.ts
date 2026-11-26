// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 M1 — member access on the Prepared dynamic value (src/ir/program/dynamic-member-access.ts, plan slice M §8).
// Groups A and B: object and primitive receivers. Each program computes `out` from guarded sub-checks and
// asserts node's `out` (it must return) and a wrong one (it must throw), through the strict Prepared entry
// (tests/helpers/prepared-node-agreement.ts). A sub-check whose receiver may be nullish runs in a `catch` that does
// not read its binding: such a catch catches the synthesized TypeError (one exception tag).
import { afterEach, describe, it, vi } from "vitest";
import { agreesWithNode } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const PROGRAMS: readonly (readonly [string, string])[] = [
  [
    'A1-15: own, absent, nested and odd keys of an object receiver, read with . and ["k"]',
    `function f(v){ return v.a; }
function g(v){ return v["a"]; }
function h(v){ return v.b; }
function nm(v){ return v.name; }
function f4(v){ return v.a === undefined && v.b === undefined; }
function f5(v){ return v.p.q; }
function f15(v){ return String(v[""]) + String(v["a b"]) + String(v["ü"]); }
function fb(v){ return String(v.k0) + String(v.k39); }
var out = String(f({a:1})) + "," + String(g({a:"s"})) + "," + String(h({a:1})) + "," + String(nm({name:"x"}));
out = out + "," + String(f4({a:undefined}));
out = out + "," + String(f5({p:{q:3}}));
out = out + "," + f15({"":1,"a b":2,"ü":3});
out = out + "," + fb({k0:0,k1:1,k2:2,k3:3,k4:4,k5:5,k6:6,k7:7,k8:8,k9:9,k10:10,k11:11,k12:12,k13:13,k14:14,k15:15,k16:16,k17:17,k18:18,k19:19,k20:20,k21:21,k22:22,k23:23,k24:24,k25:25,k26:26,k27:27,k28:28,k29:29,k30:30,k31:31,k32:32,k33:33,k34:34,k35:35,k36:36,k37:37,k38:38,k39:39});`,
  ],
  [
    "A7-13: writes: create, overwrite, as a value, evaluation order, per-iteration objects, try/finally",
    `function f8(v){ v.a = 5; return v.a; }
function r(s, o){ s.log = String(s.log) + "r"; return o; }
function g(s){ s.log = String(s.log) + "g"; return 1; }
function w(o, c){ if (c) o.k = 1; else o.k = 2; try { o.t = 3; } finally { o.f = 4; } }
var out = "";
var o7 = {a:1}; o7.b = 2; out = out + String(o7.b);
out = out + "," + String(f8({a:1}));
var o9 = {}; out = out + "," + String(o9.x); o9.x = "s"; out = out + "," + String(o9.x);
var o10 = {}; var x10 = (o10.a = 5); out = out + "," + String(x10) + String(o10.a);
var s = {log:""}; var o11 = {}; r(s, o11).a = g(s); out = out + "," + String(s.log) + String(o11.a);
var p, q; for (var i = 0; i < 2; i++) { var o = {n:i}; if (i === 0) p = o; else q = o; }
out = out + "," + (p === q ? "t" : "f") + String(p.n) + String(q.n);
var o13 = {}; w(o13, false); out = out + "," + String(o13.k) + String(o13.t) + String(o13.f);`,
  ],
  [
    "A14, A18, A19: unused read, typeof, ToBoolean, identity, ToPrimitive",
    `function g14(s){ s.n = 1; return {a:1}; }
function ty(v){ return typeof v; }
function nt(v){ return !v; }
function id(v, o){ return v === o; }
function cat(v){ return "" + v; }
function num(v){ return +v; }
var out = "";
var s = {n:0}; g14(s).a; out = out + String(s.n);
out = out + "," + ty({}) + "," + String(nt({}));
var oi = {}; out = out + "," + String(id(oi, oi)) + String(id({}, oi));
out = out + "," + cat({}) + "," + String(num({}) === num({}));
try { cat({toString: 1}); out = out + "n"; } catch (e) { out = out + "T"; }`,
  ],
  [
    "B20-22, B25: a primitive's absent member, a sloppy write ignored",
    `function fo(v){ return v.foo; }
function sw(v){ v.k = 1; return v.k; }
var out = String(fo(1)) + "," + String(fo(true)) + "," + String(fo("abc")) + "," + String(sw(1)) + String(sw(true)) + String(sw("s"));`,
  ],
  [
    "B26: strict writes to primitives throw, catchably",
    `"use strict";
function f(v){ v.k = 1; return v.k; }
var out = "";
try { f(1); out = out + "n"; } catch (e) { out = out + "T"; }
try { f(true); out = out + "n"; } catch (e) { out = out + "T"; }
try { f("s"); out = out + "n"; } catch (e) { out = out + "T"; }
out = out + String(f({k:0}));`,
  ],
];

describe("#7354 M1 — member read and write by receiver kind", () => {
  it.each(PROGRAMS)("%s", async (_name, body) => agreesWithNode(body), 300_000);
});
