// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 O1 — `Object.defineProperty` and `Object.getOwnPropertyDescriptor` through the strict Prepared entry
// (src/ir/realm-static-call.ts, src/ir/program/dynamic-object-statics.ts, the realm's descriptor bodies), with the
// test262 runner's options. Each accepted program runs twice against node: its answer returns, a wrong one throws. A
// TypeError the specification demands is caught by the program itself, so it is part of node's answer.
import { afterEach, describe, it, vi } from "vitest";
import { agreesWithNode, runnerOptions } from "./helpers/prepared-node-agreement.js";
import { CATCHES, FIELDS } from "./helpers/object-static-probes.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;
const agrees = (body: string) => agreesWithNode(body, true, runnerOptions());

describe("#7354 O1 — Object.defineProperty", () => {
  it.each([
    ["(1) a value is defined", "var o = {}; Object.defineProperty(o, 'p', {value: 1}); var out = String(o.p);"],
    [
      "(2) absent attributes are false: a sloppy write is ignored",
      "var o = {}; Object.defineProperty(o, 'p', {value: 1}); o.p = 2; var out = String(o.p);",
    ],
    [
      "(2) strict: the write to a read-only property is a TypeError, the value stays",
      `'use strict'; ${CATCHES} var o = {}; Object.defineProperty(o, 'p', {value: 1});` +
        " var out = t(function(){ o.p = 2; }) + String(o.p);",
    ],
    [
      "(3) a writable property takes a write and a redefinition",
      `${FIELDS} var o = {}; Object.defineProperty(o, 'p', {value: 1, writable: true}); o.p = 2;` +
        " var out = String(o.p); Object.defineProperty(o, 'p', {value: 3});" +
        " out = out + String(o.p) + fields(Object.getOwnPropertyDescriptor(o, 'p'));",
    ],
    [
      "(4) non-configurable: the same value redefines; another value, enumerable, get, configurable, writable throw",
      `${CATCHES} ${FIELDS} var o = {}; Object.defineProperty(o, 'p', {value: 1});` +
        " var out = t(function(){ Object.defineProperty(o, 'p', {value: 1}); })" +
        " + t(function(){ Object.defineProperty(o, 'p', {value: 2}); })" +
        " + t(function(){ Object.defineProperty(o, 'p', {enumerable: true}); })" +
        " + t(function(){ Object.defineProperty(o, 'p', {get: function(){ return 5; }}); })" +
        " + t(function(){ Object.defineProperty(o, 'p', {configurable: true}); })" +
        " + t(function(){ Object.defineProperty(o, 'p', {writable: true}); }) + fields(Object.getOwnPropertyDescriptor(o, 'p'));",
    ],
    [
      "(5) a target that is no object is a TypeError, after every argument is evaluated",
      `${CATCHES} var n = 0; function d(){ n = n + 1; return {value: 1}; }` +
        " var out = t(function(){ Object.defineProperty(1, 'p', d()); }) + t(function(){ Object.defineProperty(undefined, 'p', d()); })" +
        " + t(function(){ Object.defineProperty('s', 'p', d()); }) + t(function(){ Object.defineProperty(null, 'p', d()); })" +
        " + t(function(){ Object.defineProperty(true, 'p', d()); }) + String(n);",
    ],
    [
      "(6) a descriptor that is no literal: written to after creation, and filled in by a function",
      `${FIELDS} var o = {}; var d = {value: 1}; d.enumerable = true; Object.defineProperty(o, 'p', d);` +
        " function fill(r, v){ r.value = v; r.writable = 1; r.configurable = 'yes'; } var e = {}; fill(e, 4); Object.defineProperty(o, 'q', e);" +
        " var out = fields(Object.getOwnPropertyDescriptor(o, 'p')) + '|' + fields(Object.getOwnPropertyDescriptor(o, 'q'));",
    ],
    [
      "(7) accessor and data fields together, a getter that is no function: TypeError; `set: undefined` defines",
      `${CATCHES} ${FIELDS} var o = {}; var nothing = null;` +
        " var out = t(function(){ Object.defineProperty(o, 'a', {value: 1, get: function(){}}); })" +
        " + t(function(){ Object.defineProperty(o, 'b', {get: 1}); }) + t(function(){ Object.defineProperty(o, 'c', {set: nothing}); })" +
        " + t(function(){ Object.defineProperty(o, 'd', {writable: true, set: function(v){}}); })" +
        " + t(function(){ Object.defineProperty(o, 'e', {set: undefined}); }) + fields(Object.getOwnPropertyDescriptor(o, 'e'))" +
        " + fields(Object.getOwnPropertyDescriptor(o, 'a')) + fields(Object.getOwnPropertyDescriptor(o, 'b'));",
    ],
    [
      "(8) a descriptor that is no object is a TypeError",
      `${CATCHES} var o = {}; var out = t(function(){ Object.defineProperty(o, 'p', 1); })` +
        " + t(function(){ Object.defineProperty(o, 'p', 'x'); }) + t(function(){ Object.defineProperty(o, 'p', null); })" +
        " + t(function(){ Object.defineProperty(o, 'p'); }) + String(o.p);",
    ],
    [
      "(9) the answer is the object, also for a function object",
      "var o = {}; function f(){} var out = (Object.defineProperty(o, 'p', {}) === o ? 'y' : 'n')" +
        " + (Object.defineProperty(f, 'q', {value: 2}) === f ? 'y' : 'n') + String(f.q) + String(o.p);",
    ],
  ])("%s", async (_name, body) => agrees(body), SLOW);
});

describe("#7354 O1 — Object.getOwnPropertyDescriptor", () => {
  it.each([
    [
      "(10) each define's record, an absent key, a literal's property, a function's own `length`",
      `${FIELDS} var o = {a: 1}; Object.defineProperty(o, 'p', {value: 1});` +
        " Object.defineProperty(o, 'q', {value: 2, writable: true, enumerable: true});" +
        " Object.defineProperty(o, 'r', {get: undefined, configurable: true}); function f(x, y){}" +
        " var out = fields(Object.getOwnPropertyDescriptor(o, 'p')) + '|' + fields(Object.getOwnPropertyDescriptor(o, 'q'))" +
        " + '|' + fields(Object.getOwnPropertyDescriptor(o, 'r')) + '|' + fields(Object.getOwnPropertyDescriptor(o, 'zz'))" +
        " + '|' + fields(Object.getOwnPropertyDescriptor(o, 'a')) + '|' + fields(Object.getOwnPropertyDescriptor(f, 'length'));",
    ],
    [
      "(11) the record is a fresh object: writing it changes nothing",
      "var o = {p: 1}; var d = Object.getOwnPropertyDescriptor(o, 'p'); d.value = 9;" +
        " var e = Object.getOwnPropertyDescriptor(o, 'p'); var out = String(o.p) + (d === e ? 'y' : 'n') + String(e.value);",
    ],
    [
      "a target that is no object: undefined/null throw, a number or a Boolean has no own property",
      `${CATCHES} var out = t(function(){ Object.getOwnPropertyDescriptor(undefined, 'p'); })` +
        " + t(function(){ Object.getOwnPropertyDescriptor(null, 'p'); })" +
        " + String(Object.getOwnPropertyDescriptor(1, 'p')) + String(Object.getOwnPropertyDescriptor(true, 'toString'));",
    ],
  ])("%s", async (_name, body) => agrees(body), SLOW);
});
