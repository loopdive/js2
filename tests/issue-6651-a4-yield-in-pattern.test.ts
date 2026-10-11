// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 slice A4 — a `yield` nested inside an expression the native generator
 * lowering used to treat as atomic: a destructuring-ASSIGNMENT pattern
 * (`[x = yield] = v`, `x[yield]` as a target, `{ x = yield } = o`), a `for-of`
 * pattern head, and a non-short-circuit binary with two yields.
 *
 * Before this slice every one of these generators had no native plan, so the
 * standalone / WASI lanes answered with the #680 refusal or leaked `env::__gen_*`.
 * The cases pin the properties that are easy to get wrong:
 *   - the pattern's steps happen on the right side of the suspension (a default
 *     is CONDITIONAL; a member target's Reference comes BEFORE the step);
 *   - the resumed value keeps its JS identity (a string key through `x[yield]`);
 *   - the iterator record that crosses the suspension is closed exactly once on
 *     `.return()` / `.throw()` at the yield, and not at all on normal exhaustion;
 *   - a pattern-head for-of over an ARRAY literal steps lazily.
 * The last case is a CONTROL: a yield on the RIGHT of a pattern keeps the #2864
 * continuation lowering (and its f64 carrier).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HOST_GEN_RE = /^(__gen_|__create_generator|__create_async_generator)/;

async function run(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod);
  const leaks = imports.filter((i) => HOST_GEN_RE.test(i.name)).map((i) => `${i.module}::${i.name}`);
  expect(leaks, "no __gen_* host import").toEqual([]);
  // WASI syscalls (an uncaught-error print path) are inert here.
  const wasi: Record<string, () => number> = {};
  for (const i of imports) if (i.module === "wasi_snapshot_preview1") wasi[i.name] = () => 0;
  const instance = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi });
  return (instance.exports as { test(): number }).test();
}

describe("#6651 A4 — yield inside a destructuring pattern (native generator)", () => {
  it("a default suspends only when the stepped value is undefined", async () => {
    // language/expressions/assignment/dstr/array-elem-init-yield-expr.js
    const src = `let x: any = 7;
function* g(): any { let vals: any = []; let result: any; result = [ x = yield ] = vals; return result === vals ? 1 : 0; }
export function test(): number {
  const it: any = g();
  const a: any = it.next();
  const beforeResume = x === 7 ? 1 : 0; // the target is untouched until the resume
  const b: any = it.next(86);
  return (a.done ? 0 : 1) * 10000 + beforeResume * 1000 + (x === 86 ? 100 : 0) + (b.done ? 10 : 0) + b.value;
}`;
    expect(await run(src)).toBe(11111);
  });

  it("a stepped value that is NOT undefined skips the yield", async () => {
    const src = `let x: any = 0;
function* g(): any { let vals: any = [5]; [ x = yield ] = vals; yield 42; }
export function test(): number {
  const it: any = g();
  const a: any = it.next();
  return a.value * 100 + x;
}`;
    expect(await run(src)).toBe(4205);
  });

  it("a member target's key comes from the resumed value, a string", async () => {
    // array-elem-target-yield-expr.js: the Reference is evaluated BEFORE the step.
    const src = `let x: any = {};
function* g(): any { let vals: any = [33]; [ x[yield] ] = vals; }
export function test(): number {
  const it: any = g();
  it.next();
  const before = x.prop === undefined ? 1 : 0;
  it.next("prop");
  return before * 100 + x.prop;
}`;
    expect(await run(src)).toBe(133);
  });

  it("an object pattern's shorthand default suspends", async () => {
    const src = `let x: any = 1;
function* g(): any { let vals: any = {}; ({ x = yield } = vals); }
export function test(): number {
  const it: any = g();
  it.next();
  it.next(3);
  return x;
}`;
    expect(await run(src)).toBe(3);
  });

  it("a typed local receives a shorthand default across the resume", async () => {
    // The shape #680's "fails closed for destructuring assignment" case used to pin.
    const src = `function* g(): Generator<undefined, number, number> {
  let value: number | undefined;
  const source: { value?: number } = {};
  ({ value = yield } = source);
  return value as number;
}
export function test(): number {
  const it = g();
  const first = it.next();
  const last = it.next(5);
  return (first.done ? 0 : 100) + (last.done ? 10 : 0) + (last.value as number);
}`;
    expect(await run(src)).toBe(115);
  });

  it(".return() at the yield closes the pattern's iterator exactly once", async () => {
    // array-elem-iter-rtrn-close.js
    const src = `let nextCount = 0; let returnCount = 0; let unreachable = 0;
const iterator: any = {
  next() { nextCount += 1; return { done: false, value: undefined }; },
  return() { returnCount += 1; return {}; },
};
const iterable: any = {};
iterable[Symbol.iterator] = function () { return iterator; };
function* g(): any { let vals: any = iterable; [ {} = yield ] = vals; unreachable += 1; }
export function test(): number {
  const it: any = g();
  it.next();
  const r: any = it.return(777);
  return nextCount * 10000 + returnCount * 1000 + unreachable * 100 + (r.done ? 10 : 0) + (r.value === 777 ? 1 : 0);
}`;
    expect(await run(src)).toBe(11011);
  });

  it(".throw() at the yield closes the iterator and rethrows the original error", async () => {
    const src = `let returnCount = 0;
const iterator: any = {
  next() { return { done: false, value: undefined }; },
  return() { returnCount += 1; throw new Error("from return"); },
};
const iterable: any = {};
iterable[Symbol.iterator] = function () { return iterator; };
function* g(): any { let vals: any = iterable; [ {} = yield ] = vals; }
export function test(): number {
  const it: any = g();
  it.next();
  let caught: any = null;
  try { it.throw("original"); } catch (e) { caught = e; }
  return returnCount * 10 + (caught === "original" ? 1 : 0);
}`;
    expect(await run(src)).toBe(11);
  });

  it("a pattern-head for-of over an array literal steps lazily", async () => {
    // language/statements/for-of/dstr/array-elem-init-yield-expr.js
    const src = `let x: any = 0; let counter = 0;
function* g(): any { for ([ x = yield ] of [[]]) { counter += 1; } }
export function test(): number {
  const it: any = g();
  const a: any = it.next();
  const c0 = counter;
  const b: any = it.next(4);
  return (a.done ? 0 : 1000) + c0 * 100 + counter * 10 + x + (b.done ? 0 : 50);
}`;
    expect(await run(src)).toBe(1014);
  });

  it("(yield a) + (yield b) suspends twice, left operand first", async () => {
    const src = `function* g() { (yield 3) + (yield 4); }
export function test(): number {
  const it: any = g();
  const a = it.next().value;
  const b = it.next().value;
  const c: any = it.next();
  return a * 100 + b * 10 + (c.done ? 1 : 0);
}`;
    expect(await run(src)).toBe(341);
  });

  it("a yield in a template substitution resumes into the string", async () => {
    // language/expressions/yield/rhs-template-middle.js
    const src = `let str: any = "unset";
function* g() { str = \`1\${ yield }3\${ 4 }5\`; }
export function test(): number {
  const it: any = g();
  it.next();
  const before = str === "unset" ? 1 : 0;
  it.next(2);
  return before * 10 + (str === "12345" ? 1 : 0);
}`;
    expect(await run(src)).toBe(11);
  });

  it("CONTROL: a yield on the RIGHT of a pattern keeps the continuation lowering", async () => {
    const src = `function* g(): Generator<number, number, number> { let a = 0; [a] = [yield 1]; return a; }
export function test(): number {
  const it = g();
  const first = it.next().value;
  const second = it.next(9).value;
  return first * 10 + second;
}`;
    expect(await run(src)).toBe(19);
  });
});
