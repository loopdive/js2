// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const unsupported = [
  ["var m=new Map();console.log(m.get({})===undefined);", true, "MAP_ABSENT_OBJECT_KEY"],
  ["class C{#x=1}var c=new C();console.log(JSON.stringify(c));", true, "PRIVATE_INSTANCE_JSON"],
  ["var a=[,undefined];console.log(0 in a);", false, "ARRAY_HOLE_PRESENCE"],
  ["var a=[,undefined];console.log(0 in a);", true, "ARRAY_HOLE_PRESENCE"],
  ["var a=[1];Object.setPrototypeOf(a,{2:7});console.log(a[2]);", false, "ARRAY_PROTOTYPE"],
  ["var a=[1];Object.setPrototypeOf(a,{2:7});console.log(a[2]);", true, "ARRAY_PROTOTYPE"],
  ["console.log(Number([]));", false, "ARRAY_TO_NUMBER"],
  ["var a=[1,2];console.log(a+4);", false, "ARRAY_TO_PRIMITIVE"],
  ["var o={x:2,f(){return this.x}};console.log(o.f.call({x:3}));", false, "METHOD_CALL_RECEIVER"],
  ["var o={x:2,f(){return this.x}};console.log(o.f.call({x:3}));", true, "METHOD_CALL_RECEIVER"],
  [
    'class A { f(x){return "hi "+x} } var a=new A();console.log(A.prototype.f.call(a,"x"));',
    true,
    "PROTOTYPE_METHOD_CALL",
  ],
  ["class A{} class B extends A {constructor(){return {x:3}}}console.log(new B().x);", false, "DERIVED_RETURN_OBJECT"],
  ["class A{} class B extends A {constructor(){return {x:3}}}console.log(new B().x);", true, "DERIVED_RETURN_OBJECT"],
  ['Promise.all([Promise.resolve(2)]).then(x=>console.log(x.join(",")));', false, "PROMISE_ALL_ARRAY"],
] as const;

describe("#5399 concrete JavaScript runtime limitations", () => {
  it.each(unsupported)("locates %s (standalone %s)", async (source, standalone, id) => {
    const result = await compile(source, {
      allowJs: true,
      fileName: "runtime.js",
      skipSemanticDiagnostics: true,
      ...(standalone ? { target: "standalone" as const } : {}),
    });
    expect(result.success).toBe(false);
    expect(result.binary.length).toBe(0);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        severity: "error",
        file: "runtime.js",
        line: 1,
        column: expect.any(Number),
        message: expect.stringContaining(id),
      }),
    );
  });
  it.each([
    "var a=[1,2];console.log(0 in a);",
    "console.log(Number([NaN]));",
    'console.log(Number(["x"]));',
    "var a=[1];Object.setPrototypeOf(a,Array.prototype);console.log(a[0]);",
    "let o={x:7,m(){return this.x}};o=o;console.log(o.m.call(o));",
    "var a=[,1];console.log(1 in a);",
    "console.log(Number([1,2]));",
    "var a=[];a=[1,2];console.log(Number(a));",
    "var o={x:2,f(){return this.x}};console.log(o.f.call(o));",
    "var o={f(){return 3}};console.log(o.f.call({}));",
    "class A{}class B extends A{constructor(){super();this.x=3}}console.log(new B().x);",
    "function Number(x){return x.length} console.log(Number([]));",
    "var Object={setPrototypeOf(a,p){return a}};Object.setPrototypeOf([1],{});",
  ])("preserves a supported neighboring operation: %s", async (source) => {
    const result = await compile(source, { allowJs: true, fileName: "control.js" });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
  });
  it("preserves standalone membership after a hole is filled", async () => {
    const result = await compile("var a=[,1];a[0]=1;console.log(0 in a);", { target: "standalone" });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
  });
  it.each([0, 2] as const)("formats BigInt exactly (opt %s)", async (optimize) => {
    const source = "var n=9007199254740993n;console.log(String(n+2n));console.log(String(-n));console.log(String(0n));";
    const result = await compile(source, { target: "standalone", hostBridge: "always", optimize });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    const length = (instance.exports.__stdout_prepare as () => number)();
    const char = instance.exports.__stdout_char as (i: number) => number;
    expect(Array.from({ length }, (_, i) => String.fromCharCode(char(i))).join("")).toBe(
      "9007199254740995\n-9007199254740993\n0\n",
    );
  });
});
