// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string): Promise<WebAssembly.Instance> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-4516-regexp.ts",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return (await WebAssembly.instantiate(result.binary, {})).instance;
}

it("matches Annex B \\c fallbacks with quantifiers and literal braces", async () => {
  const source = `
function pattern(suffix: any): any { return "\\\\c" + suffix; }
function flags(): any { return ""; }
function unsupported(): any { return "a*b"; }
export function test(): number {
  let score = 0;
  try {
    score += new RegExp(pattern("*"), flags()).exec("\\\\c") !== null ? 1 : 0;
    score += new RegExp(pattern("+"), flags()).exec("\\\\c") !== null ? 2 : 0;
    score += new RegExp(pattern("?"), flags()).exec("\\\\") !== null ? 4 : 0;
    score += new RegExp(pattern("{"), flags()).exec("\\\\c{") !== null ? 8 : 0;
    score += new RegExp(pattern("}"), flags()).exec("\\\\c}") !== null ? 16 : 0;
  } catch {
    return -1;
  }
  try {
    new RegExp(unsupported(), flags()).exec("aab");
    return score + 100;
  } catch {
    return score;
  }
}
`;
  const instance = await compileStandalone(source);
  expect((instance.exports as { test: () => number }).test()).toBe(31);
});

it("keeps eval-created escaped BMP sources on the native standalone carrier", async () => {
  const source = `
export function test(): number {
  const leading = "\\\\" + String.fromCharCode(0);
  const trailing = "a\\\\" + String.fromCharCode(0);
  const leadingPattern: any = eval("/" + leading + "/");
  const trailingPattern: any = eval("/" + trailing + "/");
  return leadingPattern.source === leading && trailingPattern.source === trailing ? 1 : 0;
}
`;
  const instance = await compileStandalone(source);
  expect((instance.exports as { test: () => number }).test()).toBe(1);
});
