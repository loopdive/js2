// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 O1 — `Object.defineProperties`, `Object.create`, keys, positions, OrdinarySet over defined attributes, and
// what stays refused or aborts, through the strict Prepared entry with the test262 runner's options. Accepted programs
// run twice against node (its answer returns, a wrong one throws); aborts and refusals are asserted exactly.
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortsAtRunTime, agreesWithNode, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";
import { CATCHES, FIELDS } from "./helpers/object-static-probes.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;
const agrees = (body: string) => agreesWithNode(body, true, runnerOptions());

describe("#7354 O1 — Object.defineProperties and Object.create", () => {
  it.each([
    [
      "(12) two descriptors; a bad second one defines neither",
      `${CATCHES} ${FIELDS} var o = {}; Object.defineProperties(o, {a: {value: 1}, b: {value: 2, enumerable: true}});` +
        " var out = fields(Object.getOwnPropertyDescriptor(o, 'a')) + '|' + fields(Object.getOwnPropertyDescriptor(o, 'b'));" +
        " var p = {}; out = out + t(function(){ Object.defineProperties(p, {a: {value: 1}, b: 1}); }) + String(p.a);" +
        " out = out + t(function(){ Object.defineProperties(p, undefined); }) + t(function(){ Object.defineProperties(1, {}); });" +
        " out = out + (Object.defineProperties(p, 5) === p ? 'y' : 'n');",
    ],
    [
      "(12) only own enumerable properties of the map count; the map may be a function",
      `${FIELDS} var m = {x: {value: 1}}; Object.defineProperty(m, 'y', {value: {value: 2}}); var o = {};` +
        " Object.defineProperties(o, m); var out = fields(Object.getOwnPropertyDescriptor(o, 'x')) + fields(Object.getOwnPropertyDescriptor(o, 'y'));" +
        " function f(){} f.z = {value: 3, writable: true}; Object.defineProperties(o, f); out = out + fields(Object.getOwnPropertyDescriptor(o, 'z'));",
    ],
    [
      "(13) Object.create(p): reads through p, a write lands on the child, a second argument defines",
      `${CATCHES} var p = {k: 1}; var c = Object.create(p); var out = String(c.k); c.k = 2; out = out + String(p.k) + String(c.k);` +
        " var d = Object.create(p, {a: {value: 5, enumerable: true}}); out = out + String(d.a) + String(d.k);" +
        " out = out + t(function(){ Object.create(1); }) + t(function(){ Object.create(undefined); })" +
        " + t(function(){ Object.create('s'); }) + t(function(){ Object.create(p, null); });" +
        " var n = Object.create(null); n.v = 3; out = out + String(n.v) + String(Object.getOwnPropertyDescriptor(n, 'v').enumerable);",
    ],
    [
      "(14) a key that is a number, a Boolean, undefined, or an object with toString",
      `${FIELDS} var o = {}; Object.defineProperty(o, 1, {value: 'a'}); Object.defineProperty(o, true, {value: 'b'});` +
        " Object.defineProperty(o, undefined, {value: 'c'}); var k = {toString: function(){ return 'kk'; }};" +
        " Object.defineProperty(o, k, {value: 'd'}); var out = String(o['1']) + String(o['true']) + String(o['undefined']) + String(o.kk)" +
        " + fields(Object.getOwnPropertyDescriptor(o, 1.0)) + String(Object.getOwnPropertyDescriptor(o, k).value);",
    ],
    [
      "(15) a missing descriptor is a TypeError; an extra argument is evaluated and ignored",
      `${CATCHES} var o = {}; var n = 0; function bump(){ n = n + 1; return n; }` +
        " var out = t(function(){ Object.defineProperty(o); }) + t(function(){ Object.defineProperty(); });" +
        " Object.defineProperty(o, 'p', {value: 1}, bump()); out = out + String(o.p) + String(n);",
    ],
    [
      "(16) unused results, in a loop observed across iterations, in try/finally, in a function",
      "var o = {}; var out = ''; for (var i = 0; i < 3; i++) { Object.defineProperty(o, 'p', {value: i, writable: true, configurable: true});" +
        " out = out + String(o.p); } try { Object.defineProperty(o, 'q', {value: 7}); } finally { out = out + String(o.q); }" +
        " function g(x){ Object.defineProperties(x, {r: {value: 8}}); return x.r; } out = out + String(g(o)) + String(o.r);",
    ],
    [
      "(17) an inherited read-only property: the write is ignored and makes no own property",
      `${FIELDS} var p = {}; Object.defineProperty(p, 'k', {value: 1}); var c = Object.create(p); c.k = 2;` +
        " var out = String(c.k) + fields(Object.getOwnPropertyDescriptor(c, 'k'));",
    ],
    [
      "(17) strict: the write to an inherited read-only property is a TypeError",
      `'use strict'; ${CATCHES} var p = {}; Object.defineProperty(p, 'k', {value: 1}); var c = Object.create(p);` +
        " var out = t(function(){ c.k = 2; }) + String(c.k);",
    ],
    [
      "OrdinarySet over defined attributes: an own writable property keeps them, an inherited one makes an own property",
      `${FIELDS} var o = {}; Object.defineProperty(o, 'p', {value: 1, writable: true}); o.p = 2;` +
        " var out = fields(Object.getOwnPropertyDescriptor(o, 'p')); var p = {}; Object.defineProperty(p, 'k', {value: 1, writable: true});" +
        " var c = Object.create(p); c.k = 2; out = out + String(p.k) + fields(Object.getOwnPropertyDescriptor(c, 'k'));",
    ],
    [
      "a setter-less accessor: a sloppy write is ignored, a strict one is a TypeError",
      `${CATCHES} var o = {}; Object.defineProperty(o, 'g', {get: undefined}); o.g = 1;` +
        " var out = String(o.g) + t(function(){ 'use strict'; o.g = 2; });",
    ],
  ])("%s", async (_name, body) => agrees(body), SLOW);
});

describe("#7354 O1 — what stays a refusal or the run-time abort", () => {
  it(
    "(18) a spread argument and a computed static refuse by name",
    async () => {
      expect(await refusal("var o = {}; var a = ['p', {}]; Object.defineProperty(o, ...a);", runnerOptions())).toMatch(
        /spread|array/,
      );
      expect(await refusal("var o = {}; Object['defineProperty'](o, 'p', {value: 1});", runnerOptions())).toMatch(
        /Object/,
      );
    },
    SLOW,
  );
  it.each([
    [
      "(19) a getter read before slice O2",
      "var o = {}; Object.defineProperty(o, 'g', {get: function(){ return 1; }}); o.g;",
    ],
    ["a setter call before slice O2", "var o = {}; Object.defineProperty(o, 'g', {set: function(v){}}); o.g = 1;"],
    [
      "a descriptor field read through a getter",
      "var d = {}; Object.defineProperty(d, 'value', {get: function(){ return 1; }}); Object.defineProperty({}, 'p', d);",
    ],
    [
      "a target that is the realm's error",
      "var n = null; try { n.x; } catch (e) { Object.defineProperty(e, 'p', {value: 1}); }",
    ],
    ["a prototype that is a function", "function F(){} Object.create(F);"],
    ["a string's own properties", "Object.getOwnPropertyDescriptor('ab', 'length');"],
  ])("%s", async (_name, source) => abortsAtRunTime(source, runnerOptions()), SLOW);
});
