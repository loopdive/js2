// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const ITERATOR_HOST_IMPORT_RE = /__(?:async_)?iterator|__array_(?:entries|keys|values)/;

function importNames(result: Awaited<ReturnType<typeof compile>>): string[] {
  return result.imports.map((i) => `${i.module}::${i.name}`);
}

function expectNoIteratorHostImports(result: Awaited<ReturnType<typeof compile>>) {
  const names = importNames(result);
  expect(names.filter((name) => ITERATOR_HOST_IMPORT_RE.test(name))).toEqual([]);
  // (#3726) Scan only the WAT's IMPORT lines. The original check ran the regex
  // over the whole module, which was equivalent back when any mention of
  // `__iterator` could only be an import. Since #1320 Slice 1 the standalone
  // iterator protocol is bound to LOCALLY DEFINED Wasm functions with those same
  // names, so a whole-module match now fires on the host-free implementation
  // itself — the opposite of what this guard is for. Restricting to `(import`
  // lines keeps the teeth (a real host import is still caught) without flagging
  // the native runtime that made the module host-free in the first place.
  const importLines = (result.wat ?? "").split("\n").filter((line) => line.includes("(import "));
  expect(importLines.filter((line) => ITERATOR_HOST_IMPORT_RE.test(line))).toEqual([]);
}

async function expectIteratorRefused(src: string, target: "standalone" | "wasi" = "standalone") {
  const result = await compile(src, { target });
  expect(result.success, `expected #681 refusal, got success for:\n${src}`).toBe(false);
  expect(result.errors.some((e) => /#681/.test(e.message))).toBe(true);
  expectNoIteratorHostImports(result);
  return result;
}

describe("#681 standalone iterator protocol slice", () => {
  it("keeps direct array for-of standalone-clean", async () => {
    const result = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const value of [1, 2, 3, 4]) {
            sum = sum + value;
          }
          return sum;
        }
      `,
      { target: "standalone" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);
  });

  it("keeps array for-of destructuring standalone-clean", async () => {
    const result = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const [left, right] of [[1, 2], [3, 4]]) {
            sum = sum + left + right;
          }
          return sum;
        }
      `,
      { target: "standalone" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);
  });

  // (#3726) This case asserted a COMPILE-TIME REFUSAL for an unknown iterable.
  // That refusal was the #681-era mechanism for one goal: never leak an
  // `__iterator` HOST import into a standalone module. #1320 Slice 1 replaced the
  // mechanism — `ensureNativeIteratorRuntime` binds the iterator protocol to
  // emitted Wasm, so the module compiles with ZERO imports and a shape the native
  // `__iterator` cannot canonicalize fails LOUDLY at runtime instead ("traps
  // loudly rather than silently misbehaving", loops.ts). The goal is still met;
  // the refusal that used to enforce it is gone, so asserting the refusal was
  // asserting the mechanism instead of the invariant.
  //
  // What is pinned here now is the invariant plus the property that justifies
  // dropping the refusal: unsupported shapes must be LOUD, never a silent
  // miscount.
  it("drives unknown for-of iterables through the native runtime — no __iterator host import", async () => {
    const src = `
      export function f(xs: any): number {
        let count: number = 0;
        for (const value of xs) {
          count = count + 1;
        }
        return count;
      }
    `;
    const result = await compile(src, { target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);

    const mod = await WebAssembly.compile(result.binary as BufferSource);
    // The load-bearing #681 assertion: standalone stays fully host-free.
    expect(WebAssembly.Module.imports(mod)).toEqual([]);

    // And the shape the native iterator cannot canonicalize must FAIL, not
    // silently return a wrong count — that loudness is the entire reason a
    // compile-time refusal is no longer required here.
    const { exports } = await WebAssembly.instantiate(mod, {});
    for (const arg of [undefined, 5, [1, 2, 3]]) {
      expect(() => (exports as { f(x: unknown): number }).f(arg)).toThrow();
    }
  });

  it("keeps typed-array for-of WASI-clean", async () => {
    const result = await compile(
      `
        export function f(xs: Uint8Array): number {
          let sum: number = 0;
          for (const value of xs) {
            sum = sum + value;
          }
          return sum;
        }
      `,
      { target: "wasi" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);
  });

  it("drives Array.prototype.values() for-of natively in standalone (no host import)", async () => {
    // `for (x of arr.values())` is semantically identical to `for (x of arr)`,
    // so the array index loop drives it directly — no __array_values import.
    const result = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const value of [1, 2, 3, 4].values()) {
            sum = sum + value;
          }
          return sum;
        }
      `,
      { target: "standalone" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(10);
  });

  it("drives Array.prototype.keys() for-of natively in standalone (no host import)", async () => {
    // `.keys()` (§23.1.3.16) yields the indices 0..length-1 in order.
    const result = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const index of [10, 20, 30].keys()) {
            sum = sum + index;
          }
          return sum;
        }
      `,
      { target: "standalone" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(0 + 1 + 2);
  });

  it("drives Array.prototype.entries() destructured for-of natively in standalone (no host import)", async () => {
    // `.entries()` (§23.1.3.4) yields `[index, value]` for each element.
    const result = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const [index, value] of [10, 20, 30].entries()) {
            sum = sum + index + value;
          }
          return sum;
        }
      `,
      { target: "standalone" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(0 + 10 + (1 + 20) + (2 + 30));
  });

  it("keeps keys()/entries() for-of WASI-clean and honors break/continue", async () => {
    const keys = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const i of [9, 9, 9, 9].keys()) {
            if (i === 2) break;
            sum = sum + i;
          }
          return sum;
        }
      `,
      { target: "wasi" },
    );
    expect(keys.success, keys.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(keys);
    const keysInst = (await WebAssembly.instantiate(keys.binary, {})).instance;
    expect((keysInst.exports as { f: () => number }).f()).toBe(0 + 1);

    const entries = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const [i, v] of [5, 6, 7].entries()) {
            if (i === 1) continue;
            sum = sum + v;
          }
          return sum;
        }
      `,
      { target: "wasi" },
    );
    expect(entries.success, entries.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(entries);
    const entriesInst = (await WebAssembly.instantiate(entries.binary, {})).instance;
    expect((entriesInst.exports as { f: () => number }).f()).toBe(5 + 7);
  });
});
