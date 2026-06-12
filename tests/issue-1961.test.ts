// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1961 — in nativeStrings mode, `===` on a `string | undefined` value compared
// by reference (struct identity) instead of by content.
//
// Any API producing `string | undefined` (`.at()`, optional chains, optional
// params) lowers to a NULLABLE `$AnyString` ref. `isStringType` returns false
// for the union, so the comparison fell through to generic struct ref-equality
// — always false for equal content.
//
// Fix: route an equality with a nullable-string operand to the native string
// content comparison (`emitNullableStringEquals`), which null-guards first
// (both-null → equal, one-null → unequal) then compares via `__str_equals`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(src: string, fn: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", nativeStrings: true, skipDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const io = r.importObject;
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  (io as { __setExports?: (e: WebAssembly.Exports) => void }).__setExports?.(instance.exports);
  return (instance.exports as Record<string, () => number>)[fn]!();
}

describe("#1961 nativeStrings: string|undefined === compares by content", () => {
  it('the repro: "hello".at(1) === "e" is true', async () => {
    expect(await run(`export function t(): number { return "hello".at(1) === "e" ? 1 : 0; }`, "t")).toBe(1);
  });

  it("!== negates correctly", async () => {
    expect(await run(`export function t(): number { return "hello".at(1) !== "e" ? 1 : 0; }`, "t")).toBe(0);
  });

  it("loose == and != also compare by content", async () => {
    expect(await run(`export function t(): number { return "hello".at(1) == "e" ? 1 : 0; }`, "t")).toBe(1);
    expect(await run(`export function t(): number { return "hello".at(1) != "e" ? 1 : 0; }`, "t")).toBe(0);
  });

  it("unequal content is false", async () => {
    expect(await run(`export function t(): number { return "hello".at(1) === "z" ? 1 : 0; }`, "t")).toBe(0);
  });

  it("x === undefined for an out-of-range .at() is true (both operand orders)", async () => {
    expect(await run(`export function t(): number { return "hello".at(99) === undefined ? 1 : 0; }`, "t")).toBe(1);
    expect(await run(`export function t(): number { return undefined === "hello".at(99) ? 1 : 0; }`, "t")).toBe(1);
  });

  it("an undefined (null) value compared to a string does not trap and is false", async () => {
    expect(await run(`export function t(): number { return "hello".at(99) === "e" ? 1 : 0; }`, "t")).toBe(0);
  });

  it("two union-typed values with equal content compare equal", async () => {
    const src = `export function t(): number { const a = "ab".at(0); const b = "ab".at(0); return a === b ? 1 : 0; }`;
    expect(await run(src, "t")).toBe(1);
  });

  it("plain string === string (control) still works", async () => {
    expect(await run(`export function t(): number { return "hello".charAt(1) === "e" ? 1 : 0; }`, "t")).toBe(1);
  });
});
