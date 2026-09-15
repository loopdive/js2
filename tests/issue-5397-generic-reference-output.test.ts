// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const cases = [
  { source: 'var m=new Map(); m.set("x",1); console.log(m.get("x"));', output: "1\n" },
  { source: 'var m=new Map(); var s=Symbol("x"); m.set(s,"value"); console.log(m.get(s));', output: "value\n" },
  { source: 'var m=new Map(); console.log(m.get("missing"));', output: "undefined\n" },
  { source: 'var m=new Map(); m.set("x",true); console.log(m.get("x")); console.log(1);', output: "true\n1\n" },
];
describe.each([0, 2] as const)("#5397 standalone generic references (opt %s)", (optimize) => {
  it.each(cases)("$source", async ({ source, output }) => {
    const result = await compile(source, { target: "standalone", hostBridge: "always", optimize });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    const length = (instance.exports.__stdout_prepare as () => number)();
    const char = instance.exports.__stdout_char as (i: number) => number;
    expect(Array.from({ length }, (_, i) => String.fromCharCode(char(i))).join("")).toBe(output);
  });
});
