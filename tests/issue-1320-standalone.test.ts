// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #1320 Slice 1 — standalone (no-JS-host) iterator bridge.
// `arr.values()`/`.keys()` reaching the generic for-of consumer (i.e. stored in
// a variable, escaping the direct #681 recognizer) now lower to a pure-Wasm
// canonical-vec iterator record + native __iterator/__iterator_next, with NO
// __iterator*/__array_* host imports. Fixed pair `.length` and tuple-boundary
// reads are covered below; other stored-pair indexed reads remain deferred.

const ITER_HOST_IMPORT_RE = /__(?:async_)?iterator|__array_(?:entries|keys|values)/;

function noIterHostImports(result: Awaited<ReturnType<typeof compile>>) {
  // Assert NO iterator-protocol *host imports* are present. The standalone
  // bridge emits NATIVE Wasm functions with the SAME names (`$__iterator` etc.),
  // so checking the WAT text would false-positive on the legitimate native fn
  // names — assert on the import list only (the meaningful "no JS host" check).
  const names = result.imports.map((i) => `${i.module}::${i.name}`);
  expect(names.filter((n) => ITER_HOST_IMPORT_RE.test(n))).toEqual([]);
}

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  noIterHostImports(r);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#1320 Slice 1 standalone iterator bridge", () => {
  it("drives a stored arr.values() through native for-of (no host import)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = [10, 20, 30].values();
          let s: number = 0;
          for (const v of it) { s = s + v; }
          return s;
        }
      `),
    ).toBe(10 + 20 + 30);
  });

  it("drives a stored arr.keys() through native for-of (yields indices)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = [10, 20, 30].keys();
          let s: number = 0;
          for (const k of it) { s = s + k; }
          return s;
        }
      `),
    ).toBe(0 + 1 + 2);
  });

  it("honors break in a native values() for-of", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = [5, 6, 7, 8].values();
          let s: number = 0;
          for (const v of it) { if (v === 7) break; s = s + v; }
          return s;
        }
      `),
    ).toBe(5 + 6);
  });

  it("honors continue in a native keys() for-of", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = [9, 9, 9, 9].keys();
          let s: number = 0;
          for (const k of it) { if (k === 1) continue; s = s + k; }
          return s;
        }
      `),
    ).toBe(0 + 2 + 3);
  });

  it("handles an empty array values() for-of", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = ([] as number[]).values();
          let s: number = 0;
          for (const v of it) { s = s + v; }
          return s;
        }
      `),
    ).toBe(0);
  });

  it("works under --target wasi too", async () => {
    const r = await compile(
      `
        export function f(): number {
          const it = [3, 4, 5].values();
          let s: number = 0;
          for (const v of it) { s = s + v; }
          return s;
        }
      `,
      { target: "wasi" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    noIterHostImports(r);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(3 + 4 + 5);
  });

  // #1320 entries() — `.entries()` reaching the generic consumer now lowers to
  // native pair vecs (each `[i, value]` slot is an `$ObjVec`), with NO host
  // imports. The producer is fully native; the pair *reads back* through the
  // consumers that route via __iterator_rest (spread) and the for-of drive.
  // (Indexed `pair[0]` read and `[k,v]` array-dstr over a *stored* entries()
  // depend on the open-any element-retrieval layer (#1888 S5/#2177) and are
  // covered there. The fixed tuple helper below additionally checks indexed
  // values after the tuple-typed boundary; the direct `for ([k,v] of
  // arr.entries())` form is native via the #681 recognizer and is exercised in
  // issue-681-standalone-iterators.)

  it("drives a stored arr.entries() through native for-of (no host import)", async () => {
    // Each yielded pair is a 2-element $ObjVec → pair.length === 2.
    expect(
      await runStandalone(`
        export function f(): number {
          const it = [10, 20, 30].entries();
          let n: number = 0;
          for (const pair of it) { n = n + pair.length; }
          return n;
        }
      `),
    ).toBe(2 + 2 + 2);
  });

  it("preserves entries pair contents and length through a tuple helper", async () => {
    // The tuple boundary must retain both values and the fixed pair arity.
    expect(
      await runStandalone(`
        export function f(): number {
          function add(pair: [number, number]): number {
            return pair[0] + pair[1] + pair.length;
          }
          const it = [10, 20, 30].entries();
          let n: number = 0;
          for (const pair of it) { n = n + add(pair); }
          return n;
        }
      `),
    ).toBe(69);
  });

  it("spreads a stored arr.entries() into an array of pairs (no host import)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = [10, 20, 30].entries();
          const arr = [...it];
          return arr.length;
        }
      `),
    ).toBe(3);
  });

  it("spreads arr.entries() with an empty receiver to a zero-length array", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          const it = ([] as number[]).entries();
          const arr = [...it];
          return arr.length;
        }
      `),
    ).toBe(0);
  });

  it("compiles arr.entries() under --target wasi with no host imports", async () => {
    const r = await compile(
      `
        export function f(): number {
          const it = [7, 8].entries();
          let n: number = 0;
          for (const pair of it) { n = n + pair.length; }
          return n;
        }
      `,
      { target: "wasi" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    noIterHostImports(r);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(2 + 2);
  });

  it("preserves entries pair contents and length through a tuple helper under --target wasi", async () => {
    const r = await compile(
      `
        export function f(): number {
          function add(pair: [number, number]): number {
            return pair[0] + pair[1] + pair.length;
          }
          const it = [10, 20].entries();
          let n: number = 0;
          for (const pair of it) { n = n + add(pair); }
          return n;
        }
      `,
      { target: "wasi" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    noIterHostImports(r);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(35);
  });
});
