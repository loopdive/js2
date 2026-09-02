// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5267 — ES2015 standalone residual pass over for-of / iterator prototypes /
// collections (r2). Wave 1 (#5144/#5147/#5151) landed the mechanisms; this
// covers the follow-ups those waves left open.
//
// Step A — the keyed-collection constructors accept a GENERAL iterable. Before
//   this, `new Map(customIterable)` / `new Set(x)` / `new WeakMap([1,1])` matched
//   none of the static seeding shapes and fell through to the generic ctor path,
//   which emits `env::Map_new` / `env::Set_new` / `env::WeakMap_new` /
//   `env::WeakSet_new`. In standalone mode there is no host to satisfy those, so
//   every test here asserts the compiled module's import list is EMPTY as well
//   as asserting the value — the leak is invisible in a runner that happens to
//   instantiate against a host `env` (measured 2026-09-01, see the issue file).
//
// Step A-2 — a Symbol key/value reached the adder as its numeric id, because a
//   standalone Symbol VALUE is a bare i32 and the collection boxing path used
//   `__box_number`.
//
// Step B — `keys()/values()/entries()` returned an eager `$Vec` snapshot, so
//   `.next()` on the result read `undefined`, `Set.prototype.entries` was not
//   routed at all, and mutation during iteration was invisible. They now yield a
//   LIVE `$__IterRec` cursor over the `$Map`.
//
// Both lanes are exercised: `target: "wasi"` (the standalone lowering, plus the
// zero-host-import assertion) and the default js-host lane, whose for-of /
// collection lowering is shared and must not regress.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, buildWasiPolyfill } from "../src/runtime.js";

interface StandaloneRun {
  value: number;
  valid: boolean;
  /** Every `env::*` function import the module declares. Must be empty. */
  hostImports: string[];
}

/** Compile `source` on the standalone (wasi) lane, run `test()`, list imports. */
async function runStandalone(source: string): Promise<StandaloneRun> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const valid = WebAssembly.validate(result.binary);
  const module = await WebAssembly.compile(result.binary);
  const hostImports = WebAssembly.Module.imports(module)
    .filter((i) => i.module !== "wasi_snapshot_preview1")
    .map((i) => `${i.module}::${i.name}`);
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  const value = (exports.test as () => number)();
  return { value, valid, hostImports };
}

/** Compile `source` on the default js-host lane and run `test()`. */
async function runHost(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: object) => void }).setExports?.(instance.exports as object);
  return (instance.exports.test as () => number)();
}

// A `@@iterator` object literal is the shape every cluster-A test262 row uses.
const CUSTOM_PAIR_ITERABLE = `
  const iterable: any = {};
  let calls = 0;
  iterable[Symbol.iterator] = function () {
    return {
      next: function () {
        calls++;
        return { value: [calls, calls * 10], done: calls > 2 };
      },
    };
  };`;

describe("#5267 Step A — collection constructors drive a general iterable", () => {
  it("new Map(customIterable) seeds every entry — standalone, host-import-free", async () => {
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         ${CUSTOM_PAIR_ITERABLE}
         const m = new Map<number, number>(iterable);
         return m.size * 100 + (m.get(1) as number) + (m.get(2) as number);
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(2 * 100 + 10 + 20);
  });

  it("the js-host lane is unchanged — the literal seeding path still works", async () => {
    // The drive is `nativeStrings`-gated, so the js-host lane keeps the host
    // `Map_new` constructor. This is the no-regression check for that lane; the
    // custom-iterable form is deliberately NOT asserted here because js-host
    // `new Map(customIterable)` hands the host constructor a compiled `$Object`
    // whose `@@iterator` the host bridge does not expose — a pre-existing gap
    // this issue does not touch.
    const value = await runHost(
      `export function test(): number {
         const m = new Map<number, number>([[1, 10], [2, 20]]);
         return m.size * 100 + (m.get(1) as number) + (m.get(2) as number);
       }`,
    );
    expect(value).toBe(2 * 100 + 10 + 20);
  });

  it("new Set(iterator) drains it — standalone, host-import-free", async () => {
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         const s = new Set<number>([1, 2, 3, 2].values());
         return s.size;
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(3);
  });

  it("a non-Object entry throws TypeError and closes the iterator once", async () => {
    // §24.1.1.2 step 4f: IteratorClose(iter, TypeError). `return()` runs EXACTLY
    // once (`Map/iterator-items-are-not-object-close-iterator.js`).
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         const iterable: any = {};
         let closes = 0;
         iterable[Symbol.iterator] = function () {
           return {
             next: function () { return { value: 1, done: false }; },
             return: function () { closes++; },
           };
         };
         let typeErrors = 0;
         try { new Map<number, number>(iterable); } catch (e) { if (e instanceof TypeError) typeErrors++; }
         return typeErrors * 10 + closes;
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(11);
  });

  it("an abrupt next() propagates WITHOUT calling return()", async () => {
    // §7.4.5/§7.4.6: IteratorStep abrupt returns without IteratorClose
    // (`Map/iterator-next-failure.js`, `Set/set-iterator-next-failure.js`).
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         const iterable: any = {};
         let closes = 0;
         iterable[Symbol.iterator] = function () {
           return {
             next: function () { throw new RangeError("boom"); },
             return: function () { closes++; },
           };
         };
         let caught = 0;
         try { new Set<number>(iterable); } catch (e) { if (e instanceof RangeError) caught = 1; }
         return caught * 10 + closes;
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(10);
  });

  it("new WeakMap([1, 1]) rejects the non-entry item with a TypeError", async () => {
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         let n = 0;
         try { new WeakMap<object, number>([1, 1] as any); } catch (e) { if (e instanceof TypeError) n = 1; }
         return n;
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(1);
  });

  it("a WeakMap key that cannot be held weakly is a TypeError", async () => {
    const { value, valid } = await runStandalone(
      `export function test(): number {
         let n = 0;
         try { new WeakMap<object, number>([["a", 1]] as any); } catch (e) { if (e instanceof TypeError) n = 1; }
         return n;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });

  it("a nullish iterable is spec-empty even behind a variable", async () => {
    // The static `nullishArg` test only covers literals; §24.1.1.1 steps 5-6
    // apply to any runtime nullish value.
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         const it: any = undefined;
         const m = new Map<number, number>(it);
         return m.size;
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(0);
  });
});

describe("#5267 Step A-2 — Symbol keys/values box as symbols, not as their id", () => {
  it("two same-description symbols stay distinct WeakSet members — standalone", async () => {
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         const a = Symbol("d");
         const b = Symbol("d");
         const s = new WeakSet<any>([a, b]);
         return (s.has(a) ? 1 : 0) + (s.has(b) ? 2 : 0);
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(3);
  });

  it("a symbol key is not confused with the number of the same id — standalone", async () => {
    const { value, valid } = await runStandalone(
      `export function test(): number {
         const a = Symbol("d");
         const m = new WeakMap<any, number>([[a, 7]]);
         return m.get(a) as number;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(7);
  });
});

describe("#5267 Step B — live collection iterator records", () => {
  it("map.entries().next() yields a [key, value] pair — standalone", async () => {
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         const m = new Map<number, number>([[1, 10], [2, 20]]);
         const it = m.entries();
         const r: any = it.next();
         return (r.done === false ? 100 : 0) + (r.value[0] as number) + (r.value[1] as number);
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(111);
  });

  it("map.entries().next() yields a [key, value] pair — js-host lane", async () => {
    const value = await runHost(
      `export function test(): number {
         const m = new Map<number, number>([[1, 10], [2, 20]]);
         const it = m.entries();
         const r: any = it.next();
         return (r.done === false ? 100 : 0) + (r.value[0] as number) + (r.value[1] as number);
       }`,
    );
    expect(value).toBe(111);
  });

  it("an exhausted record reports done:true with value undefined — standalone", async () => {
    const { value, valid } = await runStandalone(
      `export function test(): number {
         const m = new Map<number, number>([[1, 10]]);
         const it = m.keys();
         it.next();
         const r: any = it.next();
         return (r.done === true ? 1 : 0) + (r.value === undefined ? 2 : 0);
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(3);
  });

  it("the record is LIVE: a delete between steps skips the removed entry", async () => {
    // Read the step results through the dynamic channel (`r: any`), the shape
    // every test262 row uses. A statically `number`-typed `.value` read still
    // goes through the IteratorResult f64 fast path and answers NaN — a
    // separate, pre-existing gap (`__gen_result_value_f64` has no `$Object`
    // arm) that this step does not close.
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         const m = new Map<number, number>([[1, 1], [2, 2], [3, 3]]);
         const it = m.keys();
         const r1: any = it.next();
         const first = r1.value as number;
         m.delete(2);
         const r2: any = it.next();
         const second = r2.value as number;
         return first * 10 + second;
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(13);
  });

  it("set.entries() is routed and yields [v, v] — standalone", async () => {
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         const s = new Set<number>([5, 6]);
         const r: any = s.entries().next();
         return (r.value[0] as number) * 10 + (r.value[1] as number);
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(55);
  });

  it("for-of over a Map still yields [k, v] pairs — standalone", async () => {
    const { value, valid } = await runStandalone(
      `export function test(): number {
         const m = new Map<number, number>([[1, 10], [2, 20]]);
         let sum = 0;
         for (const e of m) { sum += (e[0] as number) * 100 + (e[1] as number); }
         return sum;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(330);
  });

  it("spreading a live record still materializes every element — standalone", async () => {
    const { value, valid } = await runStandalone(
      `export function test(): number {
         const m = new Map<number, number>([[1, 10], [2, 20]]);
         const ks = [...m.keys()];
         return ks.length * 10 + (ks[0] as number) + (ks[1] as number);
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(23);
  });
});
