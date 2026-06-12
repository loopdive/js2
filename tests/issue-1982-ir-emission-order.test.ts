// #1982 — IR lazy use-site emission must not reorder memory reads past writes.
//
// The lowerer defers result-bearing instruction trees to their use site
// (single-use inline, multi-use tee-at-first-use). A deferred tree containing
// an order-sensitive read (slot.read, class.get, …) or an effect (call) must
// be anchored at its def position when an instruction with a conflicting
// write effect executes between def and use — otherwise the read observes
// future mutations (e.g. `const t = b.v + 0; b.v *= 10; return t + b.v`
// returned 20·a instead of 11·a).
//
// Each case compiles legacy and IR and asserts both match the expected
// JS-semantics value.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runOne(source: string, experimentalIR: boolean, args: number[]): Promise<unknown> {
  const result = await compile(source, { nativeStrings: true, experimentalIR });
  if (!result.success) {
    throw new Error(`compile failed (ir=${experimentalIR}):\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env);
  return (instance.exports.f as (...a: number[]) => unknown)(...args);
}

async function expectBoth(source: string, args: number[], expected: unknown): Promise<void> {
  expect(await runOne(source, false, args), "legacy").toBe(expected);
  expect(await runOne(source, true, args), "ir").toBe(expected);
}

describe("#1982 — IR emission scheduling preserves read/write order", () => {
  it("class-field read before straight-line writes (repro A)", async () => {
    await expectBoth(
      `class Box { v: number = 1; }
export function f(a: number): number {
  const b = new Box();
  b.v = a;
  const t = b.v + 0;
  b.v = b.v * 10;
  return t + b.v;
}`,
      [1],
      11,
    );
  });

  it("slot read snapshot across a while loop (repro B)", async () => {
    await expectBoth(
      `export function f(a: number): number {
  let x0 = a;
  const x1 = x0 + 5;
  let i = 0;
  while (i < 2) { x0 = x0 * 10; i = i + 1; }
  return x1;
}`,
      [1],
      6,
    );
  });

  it("slot read snapshot across a for loop", async () => {
    await expectBoth(
      `export function f(a: number): number {
  let x0 = a;
  const x1 = x0 + 5;
  for (let i = 0; i < 2; i = i + 1) { x0 = x0 * 10; }
  return x1;
}`,
      [1],
      6,
    );
  });

  it("class-field read snapshot across a loop that mutates the field", async () => {
    await expectBoth(
      `class Box { v: number = 1; }
export function f(a: number): number {
  const b = new Box();
  b.v = a;
  const t = b.v + 0;
  let i = 0;
  while (i < 2) { b.v = b.v * 10; i = i + 1; }
  return t + b.v;
}`,
      [1],
      101,
    );
  });

  it("call result defined before a later field read keeps call-then-read order", async () => {
    // c = g() runs FIRST (mutating the field), then t reads. The return
    // expression references them in the opposite operand order (t + c), so a
    // lazily-collapsed tree would emit the read before the call.
    await expectBoth(
      `class Box { v: number = 1; }
function g(b: Box): number { b.v = b.v + 100; return 7; }
export function f(a: number): number {
  const b = new Box();
  b.v = a;
  const c = g(b);
  const t = b.v + 1;
  return t + c;
}`,
      [1],
      109,
    );
  });

  it("field read before an intervening call used in read-then-call operand order", async () => {
    // Operand order matches def order here — the in-order lazy collapse is
    // correct and must stay correct.
    await expectBoth(
      `class Box { v: number = 1; }
function g(b: Box): number { b.v = b.v + 100; return 7; }
export function f(a: number): number {
  const b = new Box();
  b.v = a;
  const t = b.v + 1;
  const c = g(b);
  return t + c;
}`,
      [1],
      9,
    );
  });

  it("nested pure-ish calls stay correct (lazy chain preserved)", async () => {
    await expectBoth(
      `function g(x: number): number { return x + 1; }
function h(x: number): number { return x * 2; }
export function f(a: number): number {
  return h(g(a));
}`,
      [3],
      8,
    );
  });

  it("multi-use snapshot across a loop (tee path)", async () => {
    await expectBoth(
      `export function f(a: number): number {
  let x0 = a;
  const x1 = x0 + 5;
  let i = 0;
  while (i < 2) { x0 = x0 + x1; i = i + 1; }
  return x1 + x1 + x0;
}`,
      [1],
      // x1 = 6; loop: x0 = 1+6=7, then 7+6=13; return 6+6+13
      25,
    );
  });

  it("read of one slot is not perturbed by writes to a different slot", async () => {
    await expectBoth(
      `export function f(a: number): number {
  let x0 = a;
  let y = 0;
  const x1 = x0 + 5;
  let i = 0;
  while (i < 2) { y = y + 1; i = i + 1; }
  return x1 + y;
}`,
      [1],
      8,
    );
  });
});
