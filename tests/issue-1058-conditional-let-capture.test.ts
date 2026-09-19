// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(
  (["gc", "standalone"] as const).flatMap((target) =>
    (["let", "var"] as const).map((declaration) => ({ target, declaration })),
  ),
)("keeps a $declaration capture initialized across a skipped call in $target", async ({ target, declaration }) => {
  const result = await compile(
    `export function run(take: boolean): number {
      ${declaration} calls = 0;
      function key(): void { calls++; }
      if (take) key();
      return calls;
    }
    export function runAfter(take: boolean): number {
      ${declaration} calls = 3;
      function bump(): void { calls++; }
      if (take) bump();
      calls += 2;
      bump();
      return calls;
    }
    export function runForward(take: boolean): number {
      ${declaration} calls = 3;
      function bumpAgain(): void { calls++; }
      if (take) bumpAgain();
      bumpAgain();
      return calls;
    }`,
    { target },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
  const imports = result.importObject ?? {};
  const instance = await WebAssembly.instantiate(module, imports);
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const run = instance.exports.run as (take: number) => number;
  expect(run(1)).toBe(1);
  expect(run(0)).toBe(0);
  const runAfter = instance.exports.runAfter as (take: number) => number;
  expect(runAfter(0)).toBe(6);
  expect(runAfter(1)).toBe(7);
  const runForward = instance.exports.runForward as (take: number) => number;
  expect(runForward(0)).toBe(4);
  expect(runForward(1)).toBe(5);
});
