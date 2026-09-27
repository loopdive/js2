// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6651 cluster C) §20.5.1.1 step 3 in `--target standalone`: an Error
// constructor defines `message` ONLY for an argument that is not `undefined`.
//
// Two mechanisms, each pinned against the answer node 22 gives for the same
// source, each with the branch-base value stated so the pin is known RED
// before the change rather than assumed to be:
//
//  1. `class Err extends TypeError {}` — `new Err()` must have NO own
//     `message`. The implicit derived forwarder has a fixed arity, so the
//     missing argument arrives as the canonical `undefined` singleton; that
//     non-null value was stored in the struct's message field and every
//     own-property surface reported the property as present.
//     (case 1: base 6, node 7 — bit 1 is the one that moves.)
//  2. With no own `message`, the read continues down the prototype chain and
//     finds `Err.prototype.message`. That edge did not exist for the
//     `$Error_struct` representation at all: an error-subclass instance
//     inherited NOTHING from its own class prototype, while a plain class
//     instance did. (case 2: base 4, node 7 — bits 1 and 2 both move.)
//
// The guards in the other direction matter as much and are green on both
// sides: `new Err("m")` still has an own `message` and still reads it, a
// direct `new TypeError()` is unchanged, and an ordinary thrown/caught error
// keeps its message.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect((result.errors ?? []).filter((e) => e.severity !== "warning")).toEqual([]);
  expect(result.imports ?? []).toEqual([]);
  const instance = await WebAssembly.instantiate(result.binary!, {});
  const exports = instance.instance.exports as { test?: () => number };
  expect(typeof exports.test).toBe("function");
  return exports.test!();
}

describe("#6651 cluster C — standalone Error `message` is absent for `undefined`", () => {
  it("a builtin-Error subclass constructed with no argument has no own `message`", async () => {
    // base 6 (bit 1 absent — `new Err()` reported an own `message`), node 7.
    expect(
      await runStandalone(`
export function test(): number {
  let s = 0;
  class Err extends TypeError {}
  const e0 = new Err();
  if (!e0.hasOwnProperty("message")) s += 1;
  const e1 = new Err("m");
  if (e1.hasOwnProperty("message")) s += 2;
  const t = new TypeError();
  if (!t.hasOwnProperty("message")) s += 4;
  return s;
}`),
    ).toBe(7);
  });

  it("an error-subclass instance inherits from its own class prototype", async () => {
    // base 4 (only the own-message read worked), node 7. Bit 1 is an ORDINARY
    // prototype property — it is in the pin because the missing edge is not
    // specific to `message`, and a `message`-shaped patch would leave it
    // failing.
    expect(
      await runStandalone(`
export function test(): number {
  let s = 0;
  class Err extends TypeError {}
  const proto = Err.prototype as unknown as Record<string, unknown>;
  proto.tagx = "T";
  proto.message = "inherited";
  const e = new Err();
  const kt = "tag" + "x";
  const km = "mess" + "age";
  if ((e as unknown as Record<string, unknown>)[kt] === "T") s += 1;
  if ((e as unknown as Record<string, unknown>)[km] === "inherited") s += 2;
  const own = new Err("own");
  if ((own as unknown as Record<string, unknown>)[km] === "own") s += 4;
  return s;
}`),
    ).toBe(7);
  });

  it("an explicit `undefined` argument defines no `message` either", async () => {
    // Green on both sides — §20.5.1.1 step 3 is about the VALUE, and the
    // zero-argument call already lowered to a null field. Here as the guard
    // that the new test does not invert the working case.
    expect(
      await runStandalone(`
export function test(): number {
  let s = 0;
  const u = undefined as unknown as string;
  const e = new TypeError(u);
  if (!e.hasOwnProperty("message")) s += 1;
  const w = new TypeError("real");
  if ((w as unknown as { message: unknown }).message === "real") s += 2;
  return s;
}`),
    ).toBe(3);
  });

  it("a plain (non-subclass) builtin error keeps its message behaviour", async () => {
    // Regression guard: green on both sides.
    expect(
      await runStandalone(`
export function test(): number {
  let s = 0;
  const e = new RangeError("boom");
  if ((e as unknown as { message: unknown }).message === "boom") s += 1;
  if ((e as unknown as { name: unknown }).name === "RangeError") s += 2;
  try {
    throw new TypeError("thrown");
  } catch (err) {
    if ((err as { message?: unknown }).message === "thrown") s += 4;
  }
  return s;
}`),
    ).toBe(7);
  });
});
