// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";

const source = `
function createSet(): Set<number> {
  let count = 0;
  let last = 0;
  const set: Set<number> = {
    get size() { return count; },
    add(value: number): Set<number> { last = value; count++; return this; },
    has(value: number) { return count > 0 && last === value; },
    clear() { count = 0; },
    forEach(callback: (value: number, key: number, owner: Set<number>) => void, thisArg?: any) {
      if (count > 0) callback.call(thisArg, last, last, this);
    }
  };
  return set;
}
const namespace = { createSet };
export function shorthand(): number {
  const body = () => {
    const set = namespace.createSet();
    const returned = set.add(7);
    return returned === set && set.size === 1 && set.has(7) ? 1 : -1;
  };
  return body();
}
export function custom(): number {
  const set = createSet();
  if (set.size !== 0) return -1;
  if (set.add(7) !== set) return -2;
  if (set.size !== 1 || !set.has(7) || set.has(8)) return -3;
  let total = 0;
  set.forEach((value, key) => { total += value + key; });
  if (total !== 14) return -5;
  set.clear();
  return set.size === 0 && !set.has(7) ? 1 : -4;
}
export function native(): number {
  const set = new Set<number>();
  if (set.add(7) !== set) return -1;
  set.add(7);
  if (set.size !== 1 || !set.has(7)) return -2;
  set.clear();
  return set.size === 0 ? 1 : -3;
}
`;

it.each(["custom", "native", "asserted", "shorthand"])(
  "preserves %s collection storage, methods, and identity",
  async (entry) => {
    const input =
      entry === "asserted"
        ? source.replace("const set: Set<number> = {", "const set = {").replace("  };", "  } as Set<number>;")
        : source;
    const exportedEntry = entry === "asserted" ? "custom" : entry;
    const control = { exports: {} as Record<string, () => number> };
    const js = ts.transpileModule(input, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    new Function("exports", js)(control.exports);
    expect(control.exports[exportedEntry]!()).toBe(1);

    const result = await compile(input, { target: "standalone" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    expect((instance.exports[exportedEntry] as () => number)()).toBe(1);
  },
);
