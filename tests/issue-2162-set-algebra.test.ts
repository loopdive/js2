// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2162 — ES2025 Set set-algebra, Wasm-native for standalone / WASI (spec 24.2.4.x).
//
// union/intersection/difference/symmetricDifference return a new Set;
// isSubsetOf/isSupersetOf/isDisjointFrom return a boolean. All leaked `Set_*`
// host imports standalone before this slice. Each builds on the shared `$Map`
// backing store: walk one set's entries (insertion-ordered, tombstone-skipping)
// and consult the other via `__map_has`, accumulating into a fresh Set
// (`__map_new` + `__set_add`) or an i32 flag — no host import, no iterator.
//
// Operands are built with `.add()` (not array literals) so the test is
// self-contained — it does not depend on the `new Set([...])` constructor slice.
// Each test compiles `target: "wasi"` and asserts valid Wasm, ZERO
// `Set_*`/`Map_*` host imports, and the expected value.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function run(source: string): Promise<{ value: number; collImports: number; valid: boolean }> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const valid = WebAssembly.validate(result.binary);
  const module = await WebAssembly.compile(result.binary);
  const collImports = WebAssembly.Module.imports(module).filter((i) => /^(Set|Map)_/.test(i.name)).length;
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  const value = (exports.test as () => number)();
  return { value, collImports, valid };
}

const mkAB = (aElems: number[], bElems: number[]): string =>
  `const a = new Set<number>(); ${aElems.map((v) => `a.add(${v});`).join(" ")} ` +
  `const b = new Set<number>(); ${bElems.map((v) => `b.add(${v});`).join(" ")}`;

describe("#2162 ES2025 Set set-algebra (standalone)", () => {
  it("union — size, host-import-free", async () => {
    const { value, collImports, valid } = await run(
      `export function test(): number { ${mkAB([1, 2], [2, 3])} return a.union(b).size; }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(3);
  });

  it("union — contains both operands' elements", async () => {
    const { value } = await run(
      `export function test(): number { ${mkAB([1], [2])} const u = a.union(b); return u.has(1) && u.has(2) ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("intersection — size + content", async () => {
    const { value } = await run(
      `export function test(): number { ${mkAB([1, 2, 3], [2, 3, 4])} const i = a.intersection(b); return i.size === 2 && i.has(2) && i.has(3) && !i.has(1) ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("difference — a minus b", async () => {
    const { value } = await run(
      `export function test(): number { ${mkAB([1, 2, 3], [2])} const d = a.difference(b); return d.size === 2 && d.has(1) && d.has(3) && !d.has(2) ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("difference — disjoint subtract leaves a unchanged in size", async () => {
    const { value } = await run(`export function test(): number { ${mkAB([1, 2], [9])} return a.difference(b).size; }`);
    expect(value).toBe(2);
  });

  it("symmetricDifference — elements in exactly one set", async () => {
    const { value } = await run(
      `export function test(): number { ${mkAB([1, 2, 3], [3, 4])} const s = a.symmetricDifference(b); return s.size === 3 && s.has(1) && s.has(2) && s.has(4) && !s.has(3) ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("isSubsetOf — true and false", async () => {
    const t = await run(
      `export function test(): number { ${mkAB([1, 2], [1, 2, 3])} return a.isSubsetOf(b) ? 1 : 0; }`,
    );
    expect(t.value).toBe(1);
    const f = await run(
      `export function test(): number { ${mkAB([1, 5], [1, 2, 3])} return a.isSubsetOf(b) ? 1 : 0; }`,
    );
    expect(f.value).toBe(0);
  });

  it("isSupersetOf — true and false", async () => {
    const t = await run(
      `export function test(): number { ${mkAB([1, 2, 3], [1, 2])} return a.isSupersetOf(b) ? 1 : 0; }`,
    );
    expect(t.value).toBe(1);
    const f = await run(
      `export function test(): number { ${mkAB([1, 2], [1, 2, 3])} return a.isSupersetOf(b) ? 1 : 0; }`,
    );
    expect(f.value).toBe(0);
  });

  it("isDisjointFrom — true and false", async () => {
    const t = await run(
      `export function test(): number { ${mkAB([1, 2], [3, 4])} return a.isDisjointFrom(b) ? 1 : 0; }`,
    );
    expect(t.value).toBe(1);
    const f = await run(
      `export function test(): number { ${mkAB([1, 2], [2, 3])} return a.isDisjointFrom(b) ? 1 : 0; }`,
    );
    expect(f.value).toBe(0);
  });

  it("operations are host-import-free across the board", async () => {
    const { collImports, valid } = await run(
      `export function test(): number {
         ${mkAB([1, 2, 3], [2, 3, 4])}
         const u = a.union(b).size;
         const i = a.intersection(b).size;
         const d = a.difference(b).size;
         const s = a.symmetricDifference(b).size;
         const sub = a.isSubsetOf(b) ? 1 : 0;
         const sup = a.isSupersetOf(b) ? 1 : 0;
         const dis = a.isDisjointFrom(b) ? 1 : 0;
         return u + i + d + s + sub + sup + dis;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
  });
});
