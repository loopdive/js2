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
export function runCaughtThrow(): number {
  closed = 0;
  function* caught() {
    try { yield* [1, 2]; }
    catch (error) { yield error instanceof TypeError ? 7 : -1; }
    finally { closed++; }
  }
  const iterator = caught();
  if (iterator.next().value !== 1) return -1;
  const result = iterator.throw(9);
  if (result.done !== false || result.value !== 7 || closed !== 0) return -2;
  if (iterator.next().done !== true) return -3;
  return closed;
}
export function runThrowBeforeDelegate(): number {
  function* caught() {
    try { yield 0; yield* [1, 2]; }
    catch (error) { return error === 9 ? 7 : -1; }
  }
  const iterator = caught();
  if (iterator.next().value !== 0) return -1;
  const result = iterator.throw(9);
  return result.done === true && result.value === 7 ? 1 : -2;
}
export function runSuspendedCleanup(): number {
  closed = 0;
  function* cleanup() {
    try { yield* [1, 2]; }
    finally { closed++; yield 8; }
    return 0;
  }
  const iterator = cleanup();
  if (iterator.next().value !== 1) return -1;
  const result = iterator.return(9);
  if (result.done !== false || result.value !== 8 || closed !== 1) return -2;
  const end = iterator.next();
  return end.done === true && end.value === 9 ? 1 : -3;
}
`;

const objectWorklistSource = `
interface Item { value: number; }
function createElements<T extends Item>(items: Map<string, T | T[]>) {
  return elements;
  function* elements(): IterableIterator<T> {
    for (const item of items.values()) {
      if (Array.isArray(item)) yield* item;
      else yield item;
    }
  }
}
export function runObjects(): number {
  const first = { value: 1 };
  const second = { value: 2 };
  const third = { value: 3 };
  const items = new Map<string, Item | Item[]>();
  items.set("a", [first, second]);
  items.set("b", third);
  const elements = createElements(items);
  let total = 0;
  for (const item of elements()) {
    total = total * 10 + item.value;
    item.value += 10;
  }
  if (first.value !== 11 || second.value !== 12 || third.value !== 13) return -1;
  return total;
}
export function runDirectObjects(): number {
  const first = { value: 1 };
  const second = { value: 2 };
  const groups: Item[][] = [[first], [second]];
  function* elements() {
    for (const group of groups) yield* group;
  }
  let total = 0;
  for (const item of elements()) {
    total = total * 10 + item.value;
    item.value += 10;
  }
  return first.value === 11 && second.value === 12 ? total : -1;
}
`;

it.each([
  ["runAll", 123],
  ["runReturn", 1],
  ["runThrow", 1],
  ["runCaughtThrow", 1],
  ["runThrowBeforeDelegate", 1],
  ["runSuspendedCleanup", 1],
  ["runObjects", 123],
  ["runDirectObjects", 12],
] as const)("runs %s with host-free delegation and IteratorClose", async (entry, expected) => {
  const source =
    entry === "runAll"
      ? worklistSource
      : entry === "runObjects" || entry === "runDirectObjects"
        ? objectWorklistSource
        : cleanupSource;
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
