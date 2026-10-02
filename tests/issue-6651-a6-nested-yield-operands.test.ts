// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 slice A6 — nested yield operands in the standalone native generator
 * lowering. Before this slice each of these shapes compiled WITHOUT an error and
 * then answered wrong: the inner yield of `yield yield 1`, `yield [...yield]` or
 * `return yield 1` was compiled as a plain expression inside the resume function
 * (read as `undefined`, no suspension), and a boolean yield rode the f64 carrier
 * (`yield true` delivered the Number 1).
 *
 *   - a yield inside a yield operand suspends FIRST; the rest of the operand runs
 *     between the two suspensions (§15.5.5: evaluate the operand, then yield);
 *   - `return <expr holding a yield>` suspends, then completes with the value;
 *   - a boolean operand keeps its JS identity (boxed-any carrier, G3a), and a
 *     value sent back into a boolean-yielding assignment is not coerced to a
 *     number (the #680 continuation under the boxed-any carrier, G3b).
 *
 * Every case compiles with `target: "standalone"` and asserts `imports: []`. The
 * CONTROL case in the return group pins the "refuse, never miscompile" rule: a
 * return-with-yield the planner cannot order (inside a loop body) must refuse
 * with the #680 diagnostic. The last group pins the order against #680's
 * comma / short-circuit statement desugar, which landed beside this slice.
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

describe("#6651 A6 — a yield inside a yield operand", () => {
  it("`yield yield 1` suspends at the inner yield, then re-yields the sent value", async () => {
    // language/expressions/yield/rhs-yield.js
    const src = `function* g(): any { yield yield 1; }
export function test(): number {
  const iter: any = g();
  const a: any = iter.next();
  const b: any = iter.next(3);
  const c: any = iter.next();
  return a.value * 1000 + (a.done ? 100 : 0) + b.value * 10 + (b.done ? 5 : 0) + (c.done && c.value === undefined ? 1 : 0);
}`;
    expect(await run(src)).toBe(1031);
  });

  it("the same shape in a class generator method", async () => {
    // language/statements/class/definition/methods-gen-yield-as-yield-operand.js
    const src = `class A { *g(): any { yield yield 1; } }
export function test(): number {
  const iter: any = A.prototype.g();
  const a: any = iter.next();
  const b: any = iter.next();
  const c: any = iter.next();
  return a.value * 100 + (b.value === undefined && !b.done ? 10 : 0) + (c.done ? 1 : 0);
}`;
    expect(await run(src)).toBe(111);
  });

  it("`yield [...yield]` spreads the SENT iterable into a new array", async () => {
    // language/expressions/generators/yield-spread-arr-single.js
    const src = `let callCount = 0;
function* gen(): any { callCount += 1; yield [...(yield)]; }
export function test(): number {
  const arr: any = ["a", "b", "c"];
  const iter: any = gen();
  iter.next(false);
  const item: any = iter.next(arr);
  const v: any = item.value;
  return callCount * 10000 + (v !== arr ? 1000 : 0) + (Array.isArray(v) ? 100 : 0) + v.length * 10 + (v[2] === "c" && !item.done ? 1 : 0);
}`;
    expect(await run(src)).toBe(11131);
  });

  it("`yield [...yield yield]` threads two sent values through three suspensions", async () => {
    // language/expressions/generators/yield-spread-arr-multiple.js
    const src = `function* gen(): any { yield [...(yield yield)]; }
export function test(): number {
  const iter: any = gen();
  iter.next(false);
  let item: any = iter.next(["a", "b", "c"]);
  const first: any = item.value;
  item = iter.next(item.value);
  const v: any = item.value;
  return (v !== first ? 1000 : 0) + v.length * 10 + (v.join("") === "abc" && !item.done ? 1 : 0);
}`;
    expect(await run(src)).toBe(1031);
  });

  it("an operand value evaluated before the inner yield runs once, before it", async () => {
    const src = `let calls = 0;
let seenAtFirst = -1;
function a(): string { calls++; return "a"; }
function* gen(): any { yield [a(), yield 1]; }
export function test(): number {
  const iter: any = gen();
  const first: any = iter.next();
  seenAtFirst = calls; // a() already ran, before the inner yield suspended
  const second: any = iter.next("b");
  const v: any = second.value;
  return first.value * 1000 + seenAtFirst * 100 + calls * 10 + (v[0] === "a" && v[1] === "b" ? 1 : 0);
}`;
    expect(await run(src)).toBe(1111);
  });
});

describe("#6651 A6 — return <expr holding a yield>", () => {
  it("`return yield 1` suspends, then completes with the sent value", async () => {
    // built-ins/GeneratorPrototype/next/return-yield-expr.js
    const src = `function* g(): any { return yield 1; }
export function test(): number {
  const iter: any = g();
  const a: any = iter.next();
  const b: any = iter.next(3);
  return a.value * 1000 + (a.done ? 100 : 0) + b.value * 10 + (b.done ? 1 : 0);
}`;
    expect(await run(src)).toBe(1031);
  });

  it("an immediately-invoked function receives the sent value", async () => {
    // language/expressions/generators/yield-identifier-non-strict.js
    const src = `let callCount = 0;
function* gen(): any {
  callCount += 1;
  return (function (arg: any) { var y = arg + 1; return y; })(yield);
}
export function test(): number {
  const iter: any = gen();
  const a: any = iter.next();
  const b: any = iter.next(42);
  return (a.done ? 100000 : 0) + (a.value === undefined ? 10000 : 0) + (b.done ? 1000 : 0) + b.value + callCount * 100;
}`;
    expect(await run(src)).toBe(11143);
  });

  it("CONTROL: a return-with-yield inside a loop body refuses (#680) instead of miscompiling", async () => {
    const r = await build(`function* g(): any { while (true) { return yield 1; } }
export function test(): number { const it: any = g(); return it.next().value; }`);
    expect(r.success).toBe(false);
    expect(r.errors?.map((e) => e.message).join("\n")).toMatch(/#680/);
  });
});

describe("#6651 A6 — booleans and sent values keep their identity", () => {
  it("`yield true` delivers the boolean, not the Number 1 (G3a)", async () => {
    const src = `function* g() { yield true; yield false; }
export function test(): number {
  const it = g();
  const a: any = it.next().value;
  const b: any = it.next().value;
  return (typeof a === "boolean" ? 100 : 0) + (a === true ? 10 : 0) + (b === false ? 1 : 0);
}`;
    expect(await run(src)).toBe(111);
  });

  it("`value = yield 'hit' in obj` yields booleans and receives strings (G3a + G3b)", async () => {
    // language/expressions/yield/in-rltn-expr.js
    const src = `const obj: any = { hit: true };
let value: any;
function* g(): any { value = yield "hit" in obj; value = yield "miss" in obj; }
export function test(): number {
  const iter: any = g();
  const r1: any = iter.next("first");
  const v1 = value;
  const r2: any = iter.next("second");
  const v2 = value;
  const r3: any = iter.next("third");
  return (r1.value === true ? 100000 : 0) + (v1 === undefined ? 10000 : 0) + (r2.value === false ? 1000 : 0) +
    (v2 === "second" ? 100 : 0) + (r3.done ? 10 : 0) + (value === "third" ? 1 : 0);
}`;
    expect(await run(src)).toBe(111111);
  });

  it("an object-yielding continuation receives the sent object by identity (G3b)", async () => {
    const src = `const sent: any = { tag: 7 };
let received: any;
let complete = false;
function* g(): any { received = yield { tag: 1 }; complete = true; }
export function test(): number {
  const iter: any = g();
  const r1: any = iter.next();
  const before = received === undefined && !complete ? 1 : 0;
  const r2: any = iter.next(sent);
  return r1.value.tag * 1000 + before * 100 + (received === sent ? 10 : 0) + (complete && r2.done ? 1 : 0);
}`;
    expect(await run(src)).toBe(1111);
  });
});

describe("#6651 A6 — beside #680's statement desugarings", () => {
  // The nested planner runs before #680's comma / `&&` / `||` / `?:` desugar. It
  // answers not-applicable for a yield in a short-circuit operand, so the
  // desugar still owns that statement in a generator a nested yield gates.
  it("a short-circuit yield before `yield yield 2`", async () => {
    const src = `function* g(): any { const o = (x: any) => x > 0; o(1) && (yield 7); yield yield 2; }
export function test(): number {
  const it: any = g();
  const a: any = it.next();
  const b: any = it.next();
  const c: any = it.next(5);
  const d: any = it.next();
  return a.value * 1000 + b.value * 100 + c.value * 10 + (d.done ? 1 : 0);
}`;
    expect(await run(src)).toBe(7251);
  });

  it("prettier's `yield n, u.push(n)` before `return yield 9`", async () => {
    const src = `function* g(u: any): any { let n = 3; yield n, u.push(n); return yield 9; }
export function test(): number {
  const u: any = [];
  const it: any = g(u);
  const a: any = it.next();
  const b: any = it.next();
  const c: any = it.next(6);
  return a.value * 1000 + b.value * 100 + c.value * 10 + u.length;
}`;
    expect(await run(src)).toBe(3961);
  });
});
