// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5407 — linked standalone Temporal rows were expensive because of two
// per-SITE code copies, not because of the provider link itself:
//
//  1. A standalone `new X(…)` whose target is only known at runtime INLINED
//     the whole dynamic TypedArray construct (`emitTaDynCtorConstructFromLocals`,
//     ~40 KB) at every site once the module carried typed-array machinery.
//     `new Temporal.PlainDate(…)` in a linked row cost ~40 KB per site;
//     PlainDate/limits.js (34 sites) compiled to 7.8 MB in 16 s. The construct
//     is now one shared helper per argument arity, called from each site.
//  2. An arrow passed where a host callback is expected
//     (`assert.throws(E, () => …)`) was compiled TWICE per init pass in
//     standalone: once into an exported-but-never-called `__cb_<id>` bridge
//     body, then again as the native closure the lane actually uses (there is
//     no `__make_callback` bridge host-free). The bridge compile is now skipped
//     up front.
//
// Both are size/compile-time changes. The behaviour checks below pin the
// outcomes the inline construct produced, for real TypedArray constructors and
// for non-TypedArray targets reaching the same dispatch.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const STANDALONE = {
  target: "standalone" as const,
  hostBridge: "off" as const,
  fileName: "/p.ts",
  allowJs: true,
  skipSemanticDiagnostics: true,
};

/** A module with a struct-backed class (so the dynamic-`new` class dispatch
 * runs), TypedArray machinery, and `n` dynamic-`new` sites. */
function dynamicNewModule(n: number): string {
  let src = `class Point { x: number; constructor(x: number) { this.x = x; } }
    const keep = new Uint8Array(2);
    export function touch() { return keep.length + new Point(1).x; }\n`;
  for (let i = 0; i < n; i++) src += `export function site${i}(C: any, a: any) { return new C(a, ${i}, 1); }\n`;
  return src;
}

async function instantiate(source: string): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const result = await compile(source, STANDALONE);
  if (!result.success) throw new Error(`compile failed: ${result.errors?.[0]?.message}`);
  const module = await WebAssembly.compile(result.binary as Uint8Array);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

describe("#5407 dynamic TypedArray construct is shared, not inlined per site", () => {
  it("adds a small constant per dynamic `new` site instead of the whole construct", async () => {
    const small = await compile(dynamicNewModule(2), { ...STANDALONE, emitWat: true });
    const large = await compile(dynamicNewModule(12), { ...STANDALONE, emitWat: true });
    expect(small.success).toBe(true);
    expect(large.success).toBe(true);
    const perSite = (large.binary.length - small.binary.length) / 10;
    // Inlined, each site carried the ~40 KB construct (measured 39.7 KB/site
    // on the Temporal shape). Shared, a site is its argument marshalling, the
    // class-tag dispatch and one `call`.
    expect(perSite).toBeLessThan(4096);
    // One helper per clamped arity (3 here), however many sites use it.
    const helpers = large.wat.match(/\(func \$__ta_dyn_ctor_construct_a\d+\b/g) ?? [];
    expect(helpers).toEqual(["(func $__ta_dyn_ctor_construct_a3"]);
  });

  it("keeps TypedArray construction semantics behind the shared helper", async () => {
    const exports = await instantiate(`
      class Point { x: number; constructor(x: number) { this.x = x; } }
      function make(C: any, a?: any, b?: any, c?: any): any {
        return arguments.length === 1 ? new C() : arguments.length === 2 ? new C(a) : arguments.length === 3 ? new C(a, b) : new C(a, b, c);
      }
      export function count(): number { const t = make(Float64Array, 4); return t.length * 10 + (t[3] === 0 ? 1 : 0); }
      export function fromArray(): number { const t = make(Uint8Array, [1, 2, 300]); return t.length * 1000 + t[2]; }
      export function empty(): number { return make(Int32Array).length; }
      export function buffer(): number {
        const buf = new ArrayBuffer(8);
        const t = make(Int16Array, buf, 2, 2);
        t[0] = 7;
        return t.length * 100 + new Uint8Array(buf)[2];
      }
      export function negative(): number { try { make(Uint8Array, -1); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; } }
      export function misaligned(): number { try { make(Int32Array, new ArrayBuffer(8), 1); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; } }
      export function userClass(): number { return make(Point, 5).x; }
    `);
    expect(exports.count!()).toBe(41);
    expect(exports.fromArray!()).toBe(3044);
    expect(exports.empty!()).toBe(0);
    expect(exports.buffer!()).toBe(207);
    expect(exports.negative!()).toBe(1);
    expect(exports.misaligned!()).toBe(1);
    expect(exports.userClass!()).toBe(5);
  });
});

describe("#5407 standalone host-callback arrows compile once", () => {
  const source = `
    function assert() {}
    assert.throws = function (C: any, fn: any) {
      try { return fn() + 100; } catch (e) { return 1; }
    };
    export function run(): number {
      let k = 5;
      return assert.throws(RangeError, () => { throw new RangeError("x"); }) * 1000 +
        assert.throws(TypeError, () => k * 2);
    }
  `;

  it("emits no dead `__cb_<id>` bridge body next to the closure", async () => {
    const result = await compile(source, STANDALONE);
    expect(result.success).toBe(true);
    const module = await WebAssembly.compile(result.binary as Uint8Array);
    const cbExports = WebAssembly.Module.exports(module).filter((e) => /^__cb_\d+$/.test(e.name));
    expect(cbExports).toEqual([]);
  });

  it("still runs the arrow through the native closure", async () => {
    const exports = await instantiate(source);
    expect(exports.run!()).toBe(1110);
  });
});
