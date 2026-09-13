// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const cases = [
  {
    name: "SameValue distinguishes signed zero and retains boolean results",
    source: "var x=-0; console.log(Object.is(x,-0),1/x,Object.is(0,-0));",
    output: "true -Infinity false\n",
  },
  {
    name: "Object.is scalar and short-arity paths",
    source:
      'console.log(Object.is(true,true)); console.log(Object.is("a","b")); console.log(Object.is()); console.log(Object.is(undefined)); console.log(Object.is(1));',
    output: "true\nfalse\ntrue\ntrue\nfalse\n",
  },
  {
    name: "array predicate producers",
    source:
      "console.log([1,2].some(x=>x===2)); console.log([1,2].every(x=>x===2)); console.log([1,2].includes(2)); console.log([1,2].includes(3));",
    output: "true\nfalse\ntrue\nfalse\n",
  },
  {
    name: "collection membership and deletion producers",
    source:
      'var m=new Map(); m.set("x",1); console.log(m.has("x")); console.log(m.has("y")); console.log(m.delete("x")); console.log(m.delete("x")); var s=new Set(); s.add(1); console.log(s.has(1)); console.log(s.has(2)); console.log(s.delete(1)); console.log(s.delete(1));',
    output: "true\nfalse\ntrue\nfalse\ntrue\nfalse\ntrue\nfalse\n",
  },
  {
    name: "RegExp test with and without a subject",
    source: 'console.log(/a/.test("a")); console.log(/a/.test("b")); console.log(/undefined/.test());',
    output: "true\nfalse\ntrue\n",
  },
  {
    name: "numbers retain their numeric output despite using the same bits",
    source:
      "console.log(1); console.log(0); console.log([1,2].indexOf(2)); console.log([1,2].indexOf(1)); console.log(true); console.log(false);",
    output: "1\n0\n1\n0\ntrue\nfalse\n",
  },
];

describe.each([
  { name: "default", options: {} },
  { name: "legacy", options: { experimentalIR: false } },
  { name: "optimized", options: { optimize: 2 as const } },
])("#5395: intrinsic boolean result brands ($name)", ({ options }) => {
  it.each(cases)("$name", async ({ source, output }) => {
    const result = await compile(source, { target: "standalone", hostBridge: "always", ...options });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    const prepare = instance.exports.__stdout_prepare as () => number;
    const char = instance.exports.__stdout_char as (index: number) => number;
    const length = prepare();
    let actual = "";
    for (let i = 0; i < length; i++) actual += String.fromCharCode(char(i));
    expect(actual).toBe(output);
  });
});
