import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * (#5349) ES2015 standalone species, round 5. Three independent defects, all
 * measured against node 22 as the oracle before and after:
 *
 *  1. `a.constructor = null` took ArraySpeciesCreate's DEFAULT lane instead of
 *     §10.4.2.3 step 9's TypeError. §10.4.2.3 maps null to undefined only for
 *     the *@@species* read (step 7b); a null `C` from step 5 is neither an
 *     Object nor undefined, so it falls through to the IsConstructor refusal.
 *  2. The species pre-scan (`isArraySpeciesObservable`) saw only an ASSIGNMENT
 *     to `.constructor`, so `Object.defineProperty(a, 'constructor', {get})`
 *     left the whole prologue unemitted — the getter was never read and the
 *     callback ran.
 *  3. `ArrayBuffer.prototype.slice` had NO SpeciesConstructor step at all
 *     (§25.1.5.3 steps 13-20): it went from the byte copy straight to
 *     `struct.new $vec_i32_byte`.
 *
 * Every case is compiled for `--target standalone` and asserted to carry ZERO
 * host imports, because a species protocol that only works with a JS host is
 * not what this issue is about.
 */
async function runStandalone(body: string): Promise<unknown> {
  const source = `export function run(){
    try { ${body} } catch (e) { if (e instanceof TypeError) return 1; if (e instanceof RangeError) return 2; return 3; }
  }`;
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  // Standalone means standalone: any `env::` import here would be a leak.
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => unknown>).run();
}

describe("#5349 step 1 — an explicit `constructor = null` is a TypeError", () => {
  it("throws TypeError for a null constructor (node 22: TypeError)", async () => {
    // Base returned 0 — the callback ran and `map` produced an ordinary array.
    expect(await runStandalone(`var a=[1,2]; a.constructor=null; a.map(function(x){return x}); return 0;`)).toBe(1);
  });

  it("still throws TypeError for a primitive constructor", async () => {
    expect(await runStandalone(`var a=[1,2]; a.constructor=1; a.map(function(x){return x}); return 0;`)).toBe(1);
  });

  it("keeps an ABSENT constructor on the ArrayCreate default lane", async () => {
    // The discrimination is only sound under the #2106 undefined singleton;
    // this is the case that would break if `ref.is_null` also matched "absent".
    expect(
      await runStandalone(
        `var z=[9]; z.constructor=Array; var a=[1,2]; var r=a.map(function(x){return x*2}); return 100+(r[0]===2?10:0)+(r.length===2?1:0);`,
      ),
    ).toBe(111);
  });

  it("keeps a null @@SPECIES on the default lane (create-species-null.js)", async () => {
    // §10.4.2.3 step 7b: a null *@@species* DOES become undefined. L343's
    // `defaultLaneTest` must keep its `ref.is_null` disjunct.
    expect(
      await runStandalone(
        `function C(){}; C[Symbol.species]=null; var a=[1,2]; a.constructor=C; var r=a.map(function(x){return x*2}); return 100+(r[0]===2?10:0)+(r.length===2?1:0);`,
      ),
    ).toBe(111);
  });
});

describe("#5349 step 2 — the pre-scan arms on defineProperty of `constructor`", () => {
  it("invokes a `constructor` getter installed by Object.defineProperty", async () => {
    // Base returned 0: the prologue was never emitted, so the throwing getter
    // was never read.
    expect(
      await runStandalone(
        `var a=[1,2]; Object.defineProperty(a,'constructor',{get:function(){ throw new RangeError("p") }}); a.map(function(x){return x}); return 0;`,
      ),
    ).toBe(2);
  });

  it("does not arm on defineProperty of an unrelated key", async () => {
    // The over-approximation has to stay bounded: this program must still
    // behave exactly as it did, and its binary is byte-identical to base.
    expect(await runStandalone(`var o={}; Object.defineProperty(o,'x',{value:5}); return 100+Number(o.x);`)).toBe(105);
  });
});

describe("#5349 step 5 — ArrayBuffer.prototype.slice runs SpeciesConstructor", () => {
  it("returns the constructed buffer BY IDENTITY (§25.1.5.3 step 26)", async () => {
    // Base returned 302: the right byteLength, but a freshly minted buffer —
    // the species constructor was never called.
    expect(
      await runStandalone(
        `var rb; var C={}; C[Symbol.species]=function(n){ return rb=new ArrayBuffer(n) }; var ab=new ArrayBuffer(8); ab.constructor=C; var r=ab.slice(); return 300+(r===rb?1:0)+(r.byteLength===8?2:0);`,
      ),
    ).toBe(303);
  });

  it("accepts a LARGER returned buffer and returns it as-is (step 20)", async () => {
    expect(
      await runStandalone(
        `var C={}; C[Symbol.species]=function(n){ return new ArrayBuffer(10) }; var ab=new ArrayBuffer(8); ab.constructor=C; var r=ab.slice(); return 400+(r.byteLength===10?1:0);`,
      ),
    ).toBe(401);
  });

  it("throws TypeError for a SMALLER returned buffer (step 20)", async () => {
    expect(
      await runStandalone(
        `var C={}; C[Symbol.species]=function(n){ return new ArrayBuffer(1) }; var ab=new ArrayBuffer(8); ab.constructor=C; ab.slice(); return 0;`,
      ),
    ).toBe(1);
  });

  it("throws TypeError for a non-ArrayBuffer result (step 16)", async () => {
    expect(
      await runStandalone(
        `var C={}; C[Symbol.species]=function(n){ return {} }; var ab=new ArrayBuffer(8); ab.constructor=C; ab.slice(); return 0;`,
      ),
    ).toBe(1);
  });

  it("throws TypeError when the species returns the receiver (step 18)", async () => {
    expect(
      await runStandalone(
        `var ab=new ArrayBuffer(8); var C={}; C[Symbol.species]=function(n){ return ab }; ab.constructor=C; ab.slice(); return 0;`,
      ),
    ).toBe(1);
  });

  it("throws TypeError for a non-constructor species (step 14)", async () => {
    expect(
      await runStandalone(
        `var ab=new ArrayBuffer(8); var C={}; C[Symbol.species]={}; ab.constructor=C; ab.slice(); return 0;`,
      ),
    ).toBe(1);
  });

  it("throws TypeError for a primitive species", async () => {
    expect(
      await runStandalone(
        `var ab=new ArrayBuffer(8); var C={}; C[Symbol.species]=true; ab.constructor=C; ab.slice(); return 0;`,
      ),
    ).toBe(1);
  });

  it("throws TypeError for a primitive `constructor` (step 13)", async () => {
    expect(await runStandalone(`var ab=new ArrayBuffer(8); ab.constructor=1; ab.slice(); return 0;`)).toBe(1);
  });

  it("keeps undefined / null @@species on the default lane", async () => {
    // byteLength only. `getPrototypeOf(result) === ArrayBuffer.prototype` is a
    // SEPARATE, still-open defect (the default-lane `$vec_i32_byte` carries no
    // prototype link) — see the residuals section of the issue.
    expect(
      await runStandalone(
        `var ab=new ArrayBuffer(8); var C={}; C[Symbol.species]=undefined; ab.constructor=C; var r=ab.slice(); return 600+(r.byteLength===8?1:0);`,
      ),
    ).toBe(601);
    expect(
      await runStandalone(
        `var ab=new ArrayBuffer(8); var C={}; C[Symbol.species]=null; ab.constructor=C; var r=ab.slice(); return 700+(r.byteLength===8?1:0);`,
      ),
    ).toBe(701);
  });

  it("leaves an ordinary slice in an ARMED module untouched", async () => {
    expect(
      await runStandalone(
        `var z=[9]; z.constructor=Array; var ab=new ArrayBuffer(8); var s=ab.slice(2); return 700+(Number(s.byteLength)===6?1:0);`,
      ),
    ).toBe(701);
  });
});

describe("#5349 step 4 — DECLINED, with the measurement that declined it", () => {
  it("keeps Set(A,'length') in map's species epilogue", async () => {
    // The plan proposed dropping the `Set(A, "length", n)` from `map`/`filter`
    // (they have no such spec step). Measured: dropping it ALSO breaks the
    // element reads — `r[0]` and `r[1]` both stop resolving on a plain-object
    // species, because the `$Object` carrier's indexed read lane keys off a
    // present `length`. node 22 wants 701/801/901 here; base gives 701/802/901
    // and the change gave 700/800/900. Zero rows either way, so the step was
    // declined and this pins the state it was declined to.
    const body = `function C(){}; function S(){ return {} }; C[Symbol.species]=S; var a=[1,2]; a.constructor=C; var r=a.map(function(x){return x*2}); return 700+(r[0]===2?1:0);`;
    expect(await runStandalone(body)).toBe(701);
  });
});

describe("#5349 review r1 — step 16 must not accept a TypedArray as an ArrayBuffer", () => {
  it("throws TypeError for an Int32Array species result (node 22: TypeError)", async () => {
    // §25.1.5.3 step 16: the constructed value must have an [[ArrayBufferData]]
    // slot. `$__vec_i32_elem` is `(array (mut i32))`-backed, so it is a
    // DISTINCT canonical type from the ArrayBuffer's `$__vec_i32_byte` and the
    // `ref.test` decides it correctly. Base returned 501 (species never
    // invoked); node 22 throws.
    expect(
      await runStandalone(
        `var ab=new ArrayBuffer(8); var C={}; C[Symbol.species]=function(n){ return new Int32Array(n) };
         ab.constructor=C; var r=ab.slice(0,4); return 500+(Number(r.byteLength)===4?1:0);`,
      ),
    ).toBe(1);
  });

  it("throws TypeError for a DataView species result (node 22: TypeError)", async () => {
    expect(
      await runStandalone(
        `var ab=new ArrayBuffer(8); var C={}; C[Symbol.species]=function(n){ return new DataView(new ArrayBuffer(n)) };
         ab.constructor=C; var r=ab.slice(0,4); return 500+(Number(r.byteLength)===4?1:0);`,
      ),
    ).toBe(1);
  });

  it("throws TypeError for a plain-object species result (species-returns-not-arraybuffer.js)", async () => {
    expect(
      await runStandalone(
        `var ab=new ArrayBuffer(8); var C={}; C[Symbol.species]=function(n){ return {} };
         ab.constructor=C; ab.slice(0,4); return 500;`,
      ),
    ).toBe(1);
  });

  it("RESIDUAL: a packed-byte-TypedArray module declines the species arm entirely", async () => {
    // `$__vec_i8_byte` (Int8Array/Uint8Array/Uint8ClampedArray) and the
    // ArrayBuffer's `$__vec_i32_byte` are STRUCTURALLY IDENTICAL since #2835
    // packed the byte buffer to `(array (mut i8))`, so Wasm GC canonicalizes
    // them to ONE runtime type and no `ref.test` can separate them. Before this
    // gate the probe returned 611: the byte-copy loop wrote THROUGH the
    // caller's Uint8Array and slice returned it by identity. node 22 throws
    // TypeError; the gate returns the module to main's pre-#5349 emission
    // (601), which is still not node but neither aliases nor mutates the
    // caller's view.
    //
    // Owner of the residual: the typed-array construction path
    // (`emitDynamicUint8ArrayBufferAlias` + `TYPED_ARRAY_PACKED_STORAGE`) —
    // until the packed-byte view carries a brand, step 16 is undecidable here.
    expect(
      await runStandalone(
        `var made; var ab=new ArrayBuffer(8); var C={};
         C[Symbol.species]=function(n){ made=new Uint8Array(n); return made };
         ab.constructor=C; var r=ab.slice(0,4);
         return 500+(r===made?10:0)+(Number(r.length)===4?100:0)+(Number(r.byteLength)===4?1:0);`,
      ),
    ).toBe(601);
  });

  it("keeps the species arm in a module with a NON-packed-byte view", async () => {
    // The gate is keyed on the three packed-byte names only; a Float64Array
    // module keeps the full ladder, so a genuine ArrayBuffer species still
    // constructs and is returned.
    expect(
      await runStandalone(
        `var f=new Float64Array(2); f[0]=1; var ab=new ArrayBuffer(8); var C={};
         C[Symbol.species]=function(n){ return new ArrayBuffer(n) };
         ab.constructor=C; var r=ab.slice(0,4); return 700+(Number(r.byteLength)===4?1:0);`,
      ),
    ).toBe(701);
  });
});
