// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3119 — plain-`$Object` `@@iterator` protocol arm in the native `__iterator`
 * ladder (#3100 Design arm 3), standalone.
 *
 * The post-hoc install `o[Symbol.iterator] = fn` is a genuine `$Object`
 * symbol-keyed store (#2866 `$Symbol` carrier), but the GetIterator ladder had
 * no arm for it: `for-of` trapped "illegal cast" (the vec hard-cast tail) and
 * spread/destructuring drained EMPTY. The new OBJ arm (ITER_KIND_OBJ) reads
 * `@@iterator` via `__extern_get(obj, __box_symbol(1))`, invokes it through
 * the open-`any` closure bridge (`__apply_closure`, #1888), and steps/closes
 * through property reads — carrier-branched with the `__sget_*` field getters
 * because iterator-object/result literals pre-shape into closed structs
 * (#3117 field-stored closures).
 *
 * Every case compiles standalone and must instantiate with ZERO host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test(): number }).test();
}

const INSTALL = `
  const o: any = {};
  o[Symbol.iterator] = function () {
    let i = 0;
    return {
      next: function () {
        i += 1;
        return { value: i * 10, done: i > 3 };
      },
    };
  };
`;

describe("#3119 — post-hoc o[Symbol.iterator]=fn drives the iteration protocol (standalone)", () => {
  it("for-of yields the protocol values (was: trap 'illegal cast')", async () => {
    expect(
      await runStandalone(`export function test(): number {
        ${INSTALL}
        let sum = 0;
        for (const v of o) sum += v;
        return sum;
      }`),
    ).toBe(60);
  });

  it("spread [...o] drains the iterator (was: [])", async () => {
    expect(
      await runStandalone(`export function test(): number {
        ${INSTALL}
        const a = [...o];
        return a.length * 100 + a[2];
      }`),
    ).toBe(330);
  });

  it("array destructuring assignment [x] = o (was: undefined)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        ${INSTALL}
        let x: any;
        [x] = o;
        return x;
      }`),
    ).toBe(10);
  });

  it("const [a, b] = o binds sequential protocol steps", async () => {
    expect(
      await runStandalone(`export function test(): number {
        ${INSTALL}
        const [a, b] = o;
        return a + b;
      }`),
    ).toBe(30);
  });

  it("IteratorClose fires on break (return method, §7.4.9)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let closed = 0;
        const o: any = {};
        o[Symbol.iterator] = function () {
          let i = 0;
          return {
            next: function () {
              i += 1;
              return { value: i * 10, done: i > 3 };
            },
            return: function () {
              closed = 1;
              return { done: true };
            },
          };
        };
        let first = 0;
        for (const v of o) { first = v; break; }
        return first + closed;
      }`),
    ).toBe(11);
  });

  it("IteratorClose fires on non-exhausting destructuring (§13.15.5.2)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let closed = 0;
        const o: any = {};
        o[Symbol.iterator] = function () {
          let i = 0;
          return {
            next: function () {
              i += 1;
              return { value: i, done: i > 9 };
            },
            return: function () {
              closed = 1;
              return { done: true };
            },
          };
        };
        const [a] = o;
        return a * 10 + closed;
      }`),
    ).toBe(11);
  });

  it("no @@iterator installed → unchanged fall-through (empty drain, no trap regression on arrays)", async () => {
    // Canonical arrays must keep iterating exactly as before with the OBJ arm
    // present in the module (an installed @@iterator elsewhere).
    expect(
      await runStandalone(`export function test(): number {
        ${INSTALL}
        let sum = 0;
        for (const v of [1, 2, 3]) sum += v;
        for (const v of o) sum += v;
        return sum;
      }`),
    ).toBe(66);
  });

  it("iterator object where next returns done:true immediately → zero iterations", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o[Symbol.iterator] = function () {
          return { next: function () { return { value: 0, done: true }; } };
        };
        let n = 0;
        for (const v of o) n += 1;
        return n;
      }`),
    ).toBe(0);
  });

  it("non-callable @@iterator value degrades to the legacy path (no hang)", async () => {
    // Spec: TypeError (§7.4.3) — deferred refinement. Must not spin or yield.
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        o[Symbol.iterator] = 5;
        const a = [...o];
        return a.length;
      }`),
    ).toBe(0);
  });
});
