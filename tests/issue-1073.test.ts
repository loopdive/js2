import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runTest(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + (r.errors?.[0]?.message ?? "unknown"));
  // (#6779) These tests cover the hostEval policy (the pre-#6779 default).
  const imports = buildImports(r.imports, undefined, r.stringPool, { dynamicCode: "hostEval" });
  const { instance } = await WebAssembly.instantiate(r.binary, imports as any);
  const test = (instance.exports as any).test;
  return test();
}

describe("Issue #1073: eval scope injection — harness visibility", () => {
  it("eval'd code can call assert_sameValue (harness shim)", async () => {
    const ret = await runTest(`
let __fail: number = 0;
let __assert_count: number = 1;
function isSameValue(a: number, b: number): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}
function assert_sameValue(actual: number, expected: number): void {
  __assert_count = __assert_count + 1;
  if (!isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}
eval('assert_sameValue(42, 42);');
eval('assert_sameValue(1, 1);');
export function test(): number { return 1; }
`);
    expect(ret).toBe(1);
  });

  it("eval'd assert_sameValue failure throws to outer scope", async () => {
    const ret = await runTest(`
let __fail: number = 0;
let __assert_count: number = 1;
function isSameValue(a: number, b: number): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}
function assert_sameValue(actual: number, expected: number): void {
  __assert_count = __assert_count + 1;
  if (!isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}
let caught: number = 0;
// (#6779) Built at runtime so it reaches the host harness shim this case
// covers. A literal argument is inlined at compile time (#1163) and calls the
// module's own assert_sameValue, which records the failure without throwing.
const failing: string = ["assert_sameValue(1, ", "2);"].join("");
try {
  eval(failing);
} catch (e) {
  caught = 1;
}
export function test(): number { return caught; }
`);
    expect(ret).toBe(1);
  });

  it("eval'd code can call assert_throws (harness shim)", async () => {
    const ret = await runTest(`
let __fail: number = 0;
let __assert_count: number = 1;
function assert_throws(fn: () => void): void {
  __assert_count = __assert_count + 1;
  try { fn(); } catch (e) { return; }
  if (!__fail) __fail = __assert_count;
}
eval('assert_throws(function() { throw 1; });');
export function test(): number { return 1; }
`);
    expect(ret).toBe(1);
  });

  it("non-harness eval works without shim overhead", async () => {
    const ret = await runTest(`
let x: number = 0;
eval('x = 42;');
export function test(): number { return 1; }
`);
    // eval creates its own 'x' in JS scope — wasm x stays 0
    // but the eval should not throw (no harness shim needed)
    expect(ret).toBe(1);
  });

  it("eval with TypeScript 'as number' annotation is stripped", async () => {
    // Simulates wrapTest switch widening leaking into eval strings
    const ret = await runTest(`
let __fail: number = 0;
let __assert_count: number = 1;
eval('switch (1 as number) { case 1: break; }');
export function test(): number { return 1; }
`);
    expect(ret).toBe(1);
  });

  it("nested eval — eval inside eval", async () => {
    const ret = await runTest(`
let __fail: number = 0;
let __assert_count: number = 1;
function isSameValue(a: number, b: number): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}
function assert_sameValue(actual: number, expected: number): void {
  __assert_count = __assert_count + 1;
  if (!isSameValue(actual, expected)) {
    if (!__fail) __fail = __assert_count;
  }
}
eval('eval("assert_sameValue(7, 7);");');
export function test(): number { return 1; }
`);
    expect(ret).toBe(1);
  });
});
