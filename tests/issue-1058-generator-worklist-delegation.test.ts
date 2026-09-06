// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";

const worklistSource = `
export function runAll(): number {
  const values = new Map<string, number[]>();
  values.set("first", [1, 2]);
  values.set("second", [3]);
  function* elements() {
    for (const group of values.values()) yield* group;
  }
  let result = 0;
  for (const value of elements()) result = result * 10 + value;
  return result;
}
`;

const cleanupSource = `
let closed = 0;
function* groups() {
  try { yield [1, 2]; yield [3]; }
  finally { closed++; }
}
function* flatten() {
  for (const group of groups()) yield* group;
  return 0;
}
export function runReturn(): number {
  closed = 0;
  const iterator = flatten();
  if (iterator.next().value !== 1) return -1;
  const result = iterator.return(9);
  if (result.done !== true || result.value !== 9) return -2;
  if (iterator.next().done !== true) return -3;
  return closed;
}
export function runThrow(): number {
  closed = 0;
  const iterator = flatten();
  if (iterator.next().value !== 1) return -1;
  try { iterator.throw(9); return -2; }
  catch (error) { if (!(error instanceof TypeError)) return -3; }
  if (iterator.next().done !== true) return -4;
  return closed;
}
`;

it.each([
  ["runAll", 123],
  ["runReturn", 1],
  ["runThrow", 1],
] as const)("runs %s with host-free delegation and IteratorClose", async (entry, expected) => {
  const source = entry === "runAll" ? worklistSource : cleanupSource;
  const native = { exports: {} as Record<string, () => number> };
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", js)(native.exports);
  expect(native.exports[entry]!()).toBe(expected);

  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports[entry] as () => number)()).toBe(expected);
});
