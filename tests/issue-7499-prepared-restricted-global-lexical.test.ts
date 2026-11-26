// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7499 — a Script that lexically declares `undefined`, `NaN` or `Infinity` at top level throws a SyntaxError at
// GlobalDeclarationInstantiation. The Prepared path raised none and ran the Script; it now refuses it at select.
import { describe, expect, it } from "vitest";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { preparedOptions } from "./helpers/prepared-node-agreement.js";

const options = (fileName: string): Test262CompileOptions => ({
  ...preparedOptions(),
  skipSemanticDiagnostics: true,
  fileName,
});

const codes = async (source: string, unlowerableBodies: "abort" | "refuse") =>
  (await compile(source, options("test.js"), undefined, unlowerableBodies)).errors.map((error) => error.code);

describe("#7499 — Prepared path refuses restricted global lexicals", () => {
  it.each([
    ["let NaN = 1;"],
    ["const Infinity = 0;"],
    ["let undefined;"],
    ["class NaN {}"],
    ["class undefined {}"],
    ["let x; let NaN;"],
    ["let { a: NaN } = { a: 1 };"],
    ["let [Infinity] = [1];"],
    ["const { NaN } = { NaN: 1 };"],
    ["const { Infinity } = { Infinity: 1 };"],
    // Precedence: instantiation fails before the class definition would run.
    ["class C extends Object {} let NaN = 1;"],
  ])("refuses %s", async (source) => {
    for (const policy of ["abort", "refuse"] as const)
      expect(await codes(source, policy)).toEqual(["restricted-global-lexical"]);
  });

  it.each([
    ["var NaN;"],
    ["let NaN = 1; export {};"],
    ["let x = 1;"],
    ["let { a: b } = { a: 1 };"],
    ["{ let NaN = 1; }"],
    ["function f() { let NaN = 1; } f();"],
  ])("does not refuse %s by this rule", async (source) => {
    for (const policy of ["abort", "refuse"] as const)
      expect(await codes(source, policy)).not.toContain("restricted-global-lexical");
  });
});
