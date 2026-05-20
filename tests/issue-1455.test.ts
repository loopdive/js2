// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1455 — Subclasses of builtins must satisfy both `instance instanceof Sub`
 * and `instance instanceof Parent`, per §10.2.1 / §22.1.2.1 etc.
 *
 * The pre-#1455 behaviour:
 *   - `class Sub extends Map` was externref-backed (the constructor returned a
 *     real JS Map instance), so `instance instanceof Map` worked, but the
 *     instance had `Map.prototype` as its `[[Prototype]]` — never
 *     `Sub.prototype` — and `instance instanceof Sub` returned false.
 *   - `class Sub extends WeakRef / DataView / Float32Array / ...` was not
 *     even host-constructible (those parents were missing from the
 *     `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE` set), so the instance was a plain
 *     WasmGC struct and `instance instanceof Parent` returned false.
 *
 * Fix:
 *   - Added WeakRef, DataView and all the concrete TypedArrays to the
 *     host-constructible set + builtin tag registry, so subclasses are
 *     externref-backed and instances satisfy `instanceof Parent` naturally.
 *   - Implicit constructors on externref-backed subclasses now synthesize a
 *     single-arg forwarder so `new Sub(arg)` reaches the parent.
 *   - Every externref-backed user-class constructor now tags its instance
 *     with the user-class name via the new `__tag_user_class` host import.
 *     The runtime's `__instanceof` walks this tag chain so
 *     `instance instanceof Sub` returns true even though the JS-side
 *     `[[Prototype]]` chain doesn't include `Sub.prototype`.
 *   - The `compileHostInstanceOf` fast-path canonicalises class-expression
 *     aliases (`const Sub = class extends Map {}`) through
 *     `classExprNameMap` so the binding name matches the synthetic name.
 */
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const exports = await compileAndInstantiate(src);
  return ((exports as any).test as () => number)();
}

describe("#1455 — subclass of builtins instanceof checks", () => {
  it("class statement extends Map — both instanceof checks pass", async () => {
    const src = `
class Subclass extends Map {}
const sub = new Subclass();
export function test(): number {
  const a: number = sub instanceof Subclass ? 1 : 0;
  const b: number = sub instanceof Map ? 1 : 0;
  return (a << 1) | b;
}`;
    expect(await run(src)).toBe(3);
  });

  it("class expression extends Map — both instanceof checks pass", async () => {
    const src = `
const Subclass = class extends Map {}
const sub = new Subclass();
export function test(): number {
  const a: number = sub instanceof Subclass ? 1 : 0;
  const b: number = sub instanceof Map ? 1 : 0;
  return (a << 1) | b;
}`;
    expect(await run(src)).toBe(3);
  });

  it("class extends Float32Array — both instanceof checks pass", async () => {
    const src = `
class Subclass extends Float32Array {}
const sub = new Subclass();
export function test(): number {
  const a: number = sub instanceof Subclass ? 1 : 0;
  const b: number = sub instanceof Float32Array ? 1 : 0;
  return (a << 1) | b;
}`;
    expect(await run(src)).toBe(3);
  });

  it("class extends Uint8ClampedArray — both instanceof checks pass", async () => {
    const src = `
class Subclass extends Uint8ClampedArray {}
const sub = new Subclass();
export function test(): number {
  const a: number = sub instanceof Subclass ? 1 : 0;
  const b: number = sub instanceof Uint8ClampedArray ? 1 : 0;
  return (a << 1) | b;
}`;
    expect(await run(src)).toBe(3);
  });

  it("class extends WeakRef — both instanceof checks pass (single-arg forwarder)", async () => {
    const src = `
class Subclass extends WeakRef {}
const sub = new Subclass({});
export function test(): number {
  const a: number = sub instanceof Subclass ? 1 : 0;
  const b: number = sub instanceof WeakRef ? 1 : 0;
  return (a << 1) | b;
}`;
    expect(await run(src)).toBe(3);
  });

  it("class extends Set — both instanceof checks pass", async () => {
    const src = `
class Subclass extends Set {}
const sub = new Subclass();
export function test(): number {
  const a: number = sub instanceof Subclass ? 1 : 0;
  const b: number = sub instanceof Set ? 1 : 0;
  return (a << 1) | b;
}`;
    expect(await run(src)).toBe(3);
  });

  it("regression: TypeError subclass instanceof chain still works (#1366a)", async () => {
    const src = `
class MyErr extends TypeError {}
let r: number = 0;
try { throw new MyErr('msg'); } catch (e) {
  if (e instanceof MyErr) r = r + 1;
  if (e instanceof TypeError) r = r + 2;
  if (e instanceof Error) r = r + 4;
}
export function test(): number { return r; }`;
    expect(await run(src)).toBe(7);
  });

  it("regression: direct typed array instanceof still works", async () => {
    const src = `
const arr = new Float32Array(4);
arr[0] = 3.14;
export function test(): number {
  return (arr[0] > 3 && arr instanceof Float32Array) ? 1 : 0;
}`;
    expect(await run(src)).toBe(1);
  });

  it("regression: plain user-class hierarchy instanceof still works", async () => {
    const src = `
class A {}
class B extends A {}
const b = new B();
export function test(): number {
  return ((b instanceof A) && (b instanceof B)) ? 1 : 0;
}`;
    expect(await run(src)).toBe(1);
  });
});
