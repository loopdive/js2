// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5109 — ES2015 §14.7.5.9 creates a fresh lexical environment for every
// for-in iteration. A closure made in the body must therefore retain the key
// from its own iteration instead of observing the final value in a reused
// lowering local.
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, lane === "standalone" ? { target: "standalone" } : {});
  if (!result.success) throw new Error(result.errors?.map((error) => error.message).join("\n") ?? "compile failed");
  expect(WebAssembly.validate(result.binary), `${lane} module failed validation`).toBe(true);
  if (lane === "standalone") {
    expect(
      result.imports.filter((entry) => entry.module === "env"),
      "standalone module must be host-free",
    ).toEqual([]);
  }

  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return (instance.exports as { test(): number }).test();
}

const LANES: Lane[] = ["host", "standalone"];

describe("#5109 ES2015 for-in body closures", () => {
  it.each(LANES)("keeps one key per closure (%s)", async (lane) => {
    const source = `
function check(source: any): number {
  const closures: any[] = [];
  for (let p in source) {
    closures.push(function (): any { return p; });
  }
  let index = 0;
  let matches = 0;
  for (let q in source) {
    if (q === closures[index]()) matches++;
    index++;
  }
  return matches;
}
export function test(): number {
  return check({ a: 0, b: 1, c: 2 });
}`;
    expect(await run(source, lane)).toBe(3);
  });

  it.each(LANES)("matches the residual Test262 mixed-values shape (%s)", async (lane) => {
    const source = `
function check(source: any): number {
  const closures: any[] = [];
  for (let p in source) closures.push(function (): any { return p; });
  let index = 0;
  let matches = 0;
  for (let q in source) {
    if (q === closures[index]()) matches++;
    index++;
  }
  return matches;
}
export function test(): number {
  return check({ a: [0], b: 1, c: { v: 1 }, get d() {}, set e(value: any) {} });
}`;
    expect(await run(source, lane)).toBe(5);
  });

  it.each(LANES)("keeps a dynamic receiver and non-capturing control intact (%s)", async (lane) => {
    const source = `
function count(source: any): number {
  let count = 0;
  for (let key in source) count++;
  return count;
}
function check(source: any): number {
  const closures: any[] = [];
  for (let p in source) closures.push(function (): any { return p; });
  let index = 0;
  let matches = 0;
  for (let q in source) {
    if (q === closures[index]()) matches++;
    index++;
  }
  return matches + count(source);
}
export function test(): number {
  const source: any = { first: 1, second: 2 };
  source.third = 3;
  return check(source);
}`;
    expect(await run(source, lane)).toBe(6);
  });
});
