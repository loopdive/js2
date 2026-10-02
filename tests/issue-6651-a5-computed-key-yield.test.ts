// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 slice A5 — two generator shapes the standalone native lowering refused
 * with the #680 diagnostic before this slice:
 *
 *   1. a `yield` inside a COMPUTED PROPERTY NAME (object literal member, class
 *      method / accessor), plus a yield in call arguments / a member target of
 *      the same generator (`check(o[yield 9], 9)`);
 *   2. a `yield*` to an inner native generator inside a native-lowered `for-of`
 *      body, including `.return()` / `.throw()` at that delegated yield.
 *
 * Every case compiles with `target: "standalone"` and asserts `imports: []` —
 * the lane has no host to fall back to. The properties pinned are the ones that
 * are easy to get wrong: the resumed value becomes the KEY; a value evaluated
 * before a later key's yield runs once, before that yield; an abrupt completion
 * at the delegated yield closes the INNER first, then the loop's iterator; a
 * throw caught inside the loop body leaves no stale inner for the next
 * iteration. The last case of each group is a CONTROL that must keep refusing.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function build(src: string) {
  return compile(src, { fileName: "test.ts", target: "standalone" });
}

async function run(src: string): Promise<number> {
  const r = await build(src);
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  expect(r.imports ?? []).toEqual([]);
  const mod = await WebAssembly.compile(r.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const instance = await WebAssembly.instantiate(mod, {});
  return (instance.exports as { test(): number }).test();
}

async function refuses(src: string): Promise<void> {
  const r = await build(src);
  expect(r.success).toBe(false);
  expect(r.errors?.map((e) => e.message).join("\n")).toMatch(/#680/);
}

describe("#6651 A5 target 1 — a yield inside a computed property name", () => {
  it("object-literal accessors are keyed by the resumed values", async () => {
    // language/expressions/object/accessor-name-computed-yield-expr.js
    const src = `let yieldSet: any = 0;
let obj: any;
function* g(): any {
  obj = {
    get [yield]() { return 7; },
    set [yield](param: any) { yieldSet = param; },
  };
}
export function test(): number {
  const it: any = g();
  it.next();
  it.next("first");
  const last: any = it.next("second");
  obj.second = 5;
  return obj.first * 100 + yieldSet * 10 + (last.done ? 1 : 0);
}`;
    expect(await run(src)).toBe(751);
  });

  it("a data member keyed by a yield, then reads keyed by later yields", async () => {
    // language/expressions/object/cpn-obj-lit-computed-property-name-from-yield-expression.js
    const src = `let fails = 0;
function check(a: any, b: any): void { if (a !== b) fails++; }
function* g(): any {
  let o: any = { [yield 9]: 9 };
  check(o[yield 9], 9);
  check(o[String(yield 9)], 9);
}
export function test(): number {
  const it: any = g();
  let n = 0;
  let r: any = it.next();
  while (!r.done && n < 10) { n++; r = it.next(r.value); }
  return n * 100 + fails;
}`;
    // Three suspensions; each resume sends the yielded 9 back, so every key is 9.
    expect(await run(src)).toBe(300);
  });

  it("an unsent key is undefined and the literal's later members still land", async () => {
    // language/expressions/object/method-definition/computed-property-name-yield-expression.js
    const src = `function* g(): any {
  let o: any = { [yield 10]: 1, a: 2 };
  yield 20;
  return o;
}
export function test(): number {
  const it: any = g();
  const a: any = it.next();
  const b: any = it.next();
  const o: any = it.next().value;
  return a.value * 1000 + b.value * 10 + o["undefined"] * 100 + o.a;
}`;
    expect(await run(src)).toBe(10302);
  });

  it("class methods and accessors, instance and static, keyed by yields", async () => {
    // cpn-class-expr-*, accessor-name-inst-computed-yield-expr
    const src = `let fails = 0;
function check(a: any, b: any): void { if (a !== b) fails++; }
function* g(): any {
  let C: any = class {
    [yield 9]() { return 9; }
    static [yield 9]() { return 9; }
    get [yield 8]() { return 8; }
  };
  let c: any = new C();
  check(c[yield 9](), 9);
  check(C[yield 9](), 9);
  check(c[String(yield 8)], 8);
}
export function test(): number {
  const it: any = g();
  let n = 0;
  let r: any = it.next();
  while (!r.done && n < 20) { n++; r = it.next(r.value); }
  return n * 100 + fails;
}`;
    expect(await run(src)).toBe(600);
  });

  it("a callee that is an expando of a module-scope function (the harness's assert.sameValue) is replayed", async () => {
    // The test262 harness shape: `assert.sameValue = function …` makes the base
    // identifier a declaration of `assert`'s symbol; it must not refuse the callee.
    const src = `let fails = 0;
function assert(ok: any): void { if (!ok) fails++; }
assert.sameValue = function (a: any, b: any): void { if (a !== b) fails++; };
function* g(): any {
  let o: any = { [yield 9]: 9 };
  assert.sameValue(o[yield 9], 9);
}
export function test(): number {
  const it: any = g();
  let n = 0;
  let r: any = it.next();
  while (!r.done && n < 10) { n++; r = it.next(r.value); }
  return n * 100 + fails;
}`;
    expect(await run(src)).toBe(200);
  });

  it("a discarded statement-level literal keyed by a yield suspends (formerly a #680 fails-closed pin)", async () => {
    const src = `function* g(): Generator<undefined, void, unknown> {
  ({ [yield]: 1 });
}
export function test(): number {
  const it = g();
  const a = it.next();
  const b = it.next("k");
  return (a.done ? 0 : 10) + (b.done ? 1 : 0);
}`;
    expect(await run(src)).toBe(11);
  });

  it("a key evaluated before a later key's yield runs once, before that yield", async () => {
    const src = `let calls = 0;
let seenAtYield = -1;
function key(): string { calls++; return "k"; }
function* g(): any {
  let o: any = { [key()]: 1, [yield 5]: 2 };
  return o;
}
export function test(): number {
  const it: any = g();
  it.next();
  seenAtYield = calls; // the first key already ran
  const o: any = it.next("m").value;
  return seenAtYield * 1000 + calls * 100 + o.k * 10 + o.m;
}`;
    expect(await run(src)).toBe(1112);
  });

  it("CONTROL: a class FIELD keyed by a yield still refuses (the class lowering skips runtime-keyed fields)", async () => {
    await refuses(`function* g(): any {
  let C: any = class { [yield 1] = 2; };
  return C;
}
export function test(): number { const it: any = g(); it.next(); return 0; }`);
  });

  it("CONTROL: a yield in call arguments alone (no computed key) still refuses", async () => {
    await refuses(`function f(a: any, b: any): any { return a; }
function* g(): any {
  const o: any = {};
  f(o, yield 1);
}
export function test(): number { const it: any = g(); it.next(); return 0; }`);
  });
});

// The loop data and the inner are native generators with finalizers, so both
// closes are observable as counters.
const PRELUDE = `let innerClosed = 0;
let loopClosed = 0;
function* inner(): any {
  try { yield 1; yield 2; } finally { innerClosed += 1; }
}
function* data() {
  try { yield 0; yield 0; } finally { loopClosed += 1; }
}
const d = data();
`;

describe("#6651 A5 target 2 — yield* to an inner native generator inside a for-of body", () => {
  it("delegates in each iteration and resumes the loop after the inner completes", async () => {
    // language/statements/for-of/yield-star.js
    const src = `function* values(): any { yield 1; yield 1; }
function* data() { yield 0; yield 0; }
const dataIterator = data();
let i = 0; let j = 0; let k = 0;
function* control(): any {
  for (var x of dataIterator) {
    i++;
    yield* values();
    j++;
  }
  k++;
}
export function test(): number {
  const it: any = control();
  let trace = 0;
  for (let n = 0; n < 5; n++) {
    it.next();
    trace = trace * 1000 + i * 100 + j * 10 + k;
  }
  return trace;
}`;
    // After each of the five next() calls: (i,j,k) = 100, 100, 210, 210, 221.
    expect(await run(src)).toBe(100100210210221);
  });

  it(".return() at the delegated yield closes the inner, then the loop iterator", async () => {
    const src = `${PRELUDE}
function* outer(): any { for (var x of d) { yield* inner(); } }
export function test(): number {
  const it: any = outer();
  const a: any = it.next();
  const r: any = it.return(5);
  const after: any = it.next();
  return a.value * 100000 + innerClosed * 10000 + loopClosed * 1000 + (r.done ? 100 : 0) + r.value + (after.done ? 10 : 0);
}`;
    expect(await run(src)).toBe(111115);
  });

  it(".throw() at the delegated yield closes the inner, then the loop iterator, and rethrows", async () => {
    const src = `${PRELUDE}
function* outer(): any { for (var x of d) { yield* inner(); } }
export function test(): number {
  const it: any = outer();
  it.next();
  let caught = 0;
  try { it.throw(new Error("boom")); } catch (e) { caught = (e as Error).message === "boom" ? 1 : 2; }
  const after: any = it.next();
  return caught * 1000 + innerClosed * 100 + loopClosed * 10 + (after.done ? 1 : 0);
}`;
    expect(await run(src)).toBe(1111);
  });

  it("a throw caught inside the loop body continues with a FRESH inner; a later .return() closes both", async () => {
    // yield-star-from-try shape, driven abruptly.
    const src = `${PRELUDE}
let caught = 0; let after = 0;
function* outer(): any {
  for (var x of d) {
    try { yield* inner(); } catch (e) { caught += 1; }
    after += 1;
  }
}
export function test(): number {
  const it: any = outer();
  const a: any = it.next();
  const b: any = it.throw(new Error("boom"));
  const s1 = innerClosed * 1000 + loopClosed * 100 + caught * 10 + after;
  const c: any = it.return(7);
  const s2 = innerClosed * 1000 + loopClosed * 100 + caught * 10 + after;
  return a.value * 1e11 + b.value * 1e10 + (b.done ? 1e9 : 0) + s1 * 1e5 + s2 * 10 + (c.done ? 1 : 0) + c.value * 0;
}`;
    // b: the second iteration's fresh inner yields 1. s1 = 1011, s2 = 2111.
    expect(await run(src)).toBe(110101121111);
  });

  it("an inner that throws on its own, caught in the loop body, is not resumed by the next iteration", async () => {
    const src = `let made = 0; let caught = 0;
function* thrower(): any { made += 1; yield 1; throw new Error("x"); }
function* data() { yield 0; yield 0; }
const d = data();
function* outer(): any {
  for (var x of d) {
    try { yield* thrower(); } catch (e) { caught += 1; }
  }
}
export function test(): number {
  const it: any = outer();
  const a: any = it.next();
  const b: any = it.next();
  const c: any = it.next();
  return a.value * 10000 + b.value * 1000 + (b.done ? 100 : 0) + made * 10 + caught + (c.done ? 100000 : 0);
}`;
    expect(await run(src)).toBe(111022);
  });

  it("CONTROL: an inner that CATCHES the forwarded throw still refuses (the close discards its answer)", async () => {
    await refuses(`function* inner(): any { try { yield 1; } catch (e) { yield 99; } }
function* data() { yield 0; yield 0; }
const d = data();
function* outer(): any { for (var x of d) { yield* inner(); } }
export function test(): number { const it: any = outer(); it.next(); return 0; }`);
  });
});
