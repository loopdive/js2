// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1058) Inner function declarations that use each other as values.
 *
 * Each `fI` below passes every earlier `fJ` as a value. Filling the value of
 * `fI` used to fill each captured `fJ` inside `fI`'s own closure-build branch,
 * and each of those filled its captures inside its branch again, so one use
 * site emitted a copy per dependency path. The binary grew about 3x for every
 * two functions added (12 functions: 112 KB), and TypeScript's checker, whose
 * ~2,000 inner functions pass each other around this way, ran out of memory
 * while compiling. Each capture is now filled once per use site.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function chainSource(count: number): string {
  const fns: string[] = [];
  for (let i = 0; i < count; i++) {
    const refs = Array.from({ length: i }, (_, j) => `f${j}`).join(", ");
    fns.push(`  function f${i}(n: number): number { use([${refs}]); return n + ${i} + base; }`);
  }
  return `
function use(xs: ((n: number) => number)[]): void { seen += xs.length; }
let seen = 0;
export function run(): number {
  let base = 1;
${fns.join("\n")}
  base = 2;
  return f${count - 1}(1) + seen;
}
export function identity(): boolean {
  function a(): number { return 1; }
  function b(): number { return keep(a) + 1; }
  function keep(f: () => number): number { return f === a ? 10 : 0; }
  return keep(a) === 10 && b() === 11;
}
`;
}

async function build(count: number) {
  const result = await compile(chainSource(count), { fileName: "t.ts" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return { size: result.binary.length, exports: instance.exports as Record<string, () => unknown> };
}

describe("#1058 inner functions that capture each other as values", () => {
  it("emits each captured function value once per use site", async () => {
    const small = await build(8);
    const large = await build(16);
    // Linear growth is ~0.8 KB per function; the old per-path copies made 16
    // functions well over a megabyte.
    expect(large.size - small.size).toBeLessThan(20_000);
  });

  it("keeps the runtime answers", async () => {
    const { exports } = await build(16);
    // f15(1) = 1 + 15 + base(2); `seen` counts the 15 values f15 passed.
    expect(exports.run!()).toBe(33);
    expect(Boolean(exports.identity!())).toBe(true);
  });
});
