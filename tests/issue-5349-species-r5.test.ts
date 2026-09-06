import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function watFor(source: string, target: "standalone" | "wasi"): Promise<string> {
  const result = await compile(source, {
    target,
    allowJs: true,
    skipSemanticDiagnostics: true,
    emitWat: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result.wat ?? "";
}

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

  it("throws TypeError for a length-constructed Uint8Array species result (node 22: TypeError)", async () => {
    // The case round 1 could not decide. `$__vec_i8_byte` and the ArrayBuffer's
    // `$__vec_i32_byte` were canonicalized to ONE runtime type, so this
    // `ref.test` accepted the Uint8Array: the byte-copy loop wrote THROUGH the
    // caller's view and slice returned it by identity (611 on the lane). Round
    // 1 answered by declining the whole species arm in any module that could
    // build such a view (601 — main's pre-#5349 answer, but ALSO losing species
    // observation for every legitimate ArrayBuffer species in that module).
    // The round-2 brand decides it instead: 1, which is node's answer.
    expect(
      await runStandalone(
        `var made; var ab=new ArrayBuffer(8); var C={};
         C[Symbol.species]=function(n){ made=new Uint8Array(n); return made };
         ab.constructor=C; var r=ab.slice(0,4);
         return 500+(r===made?10:0)+(Number(r.length)===4?100:0)+(Number(r.byteLength)===4?1:0);`,
      ),
    ).toBe(1);
  });

  it("throws TypeError for a buffer-backed Uint8Array species result (node 22: TypeError)", async () => {
    expect(
      await runStandalone(
        `var ab=new ArrayBuffer(8); var C={};
         C[Symbol.species]=function(n){ return new Uint8Array(new ArrayBuffer(n)) };
         ab.constructor=C; ab.slice(0,4); return 500;`,
      ),
    ).toBe(1);
  });

  it("still observes @@species in a module that builds a packed-byte view (node 22: 716)", async () => {
    // The regression round 1 traded for the b15 fix: with the module-wide
    // decline in place this answered 704 — the species was never consulted and
    // slice returned an ordinary 4-byte buffer, main's pre-#5349 answer. The
    // brand restores 716 (the species-built 16-byte buffer), which is node's.
    expect(
      await runStandalone(
        `var u=new Uint8Array(2); var ab=new ArrayBuffer(8); var C={};
         C[Symbol.species]=function(n){ return new ArrayBuffer(16) };
         ab.constructor=C; var r=ab.slice(0,4); return 700+Number(r.byteLength);`,
      ),
    ).toBe(716);
  });

  it("still refuses an Int32Array species in a module that builds a packed-byte view", async () => {
    expect(
      await runStandalone(
        `var u=new Uint8Array(2); var ab=new ArrayBuffer(8); var C={};
         C[Symbol.species]=function(n){ return new Int32Array(n) };
         ab.constructor=C; ab.slice(0,4); return 500;`,
      ),
    ).toBe(1);
  });

  it("still refuses the same-object species (step 18) with a packed-byte view present", async () => {
    expect(
      await runStandalone(
        `var u=new Uint8Array(2); var ab=new ArrayBuffer(8); var C={};
         C[Symbol.species]=function(n){ return ab };
         ab.constructor=C; ab.slice(0,4); return 500;`,
      ),
    ).toBe(1);
  });

  it("still refuses a too-small species result (step 20) with a packed-byte view present", async () => {
    expect(
      await runStandalone(
        `var u=new Uint8Array(2); var ab=new ArrayBuffer(8); var C={};
         C[Symbol.species]=function(n){ return new ArrayBuffer(1) };
         ab.constructor=C; ab.slice(0,4); return 500;`,
      ),
    ).toBe(1);
  });

  it("keeps the species arm in a module with a NON-packed-byte view", async () => {
    // A Float64Array module was never ambiguous — its element array is
    // `(array (mut f64))`. Kept as the control that the brand did not move it.
    expect(
      await runStandalone(
        `var f=new Float64Array(2); f[0]=1; var ab=new ArrayBuffer(8); var C={};
         C[Symbol.species]=function(n){ return new ArrayBuffer(n) };
         ab.constructor=C; var r=ab.slice(0,4); return 700+(Number(r.byteLength)===4?1:0);`,
      ),
    ).toBe(701);
  });
});

describe("#5349 round 2 — the packed-byte carrier is branded by FINALITY", () => {
  // The two vec structs declare the same two fields over structurally
  // identical `(array (mut i8))` data. While BOTH are `final` they canonicalize
  // to ONE runtime type and `ref.test $__vec_i32_byte` accepts a Uint8Array.
  // The brand is the finality bit itself: `$__vec_i8_byte` is declared `final`
  // at registration (which is what reaches wasi, where `markLeafStructsFinal`
  // returns early), and `$__vec_i32_byte` is kept OPEN by
  // `finalizeLeafStructTypes` (which is what reaches standalone). Neither
  // changes a field, an instruction, or the module's byte count — the whole
  // delta is one byte in the type section (0x4f `sub final` -> 0x50 `sub`).
  const BUILDS_BOTH = `export function run(){ var u=new Uint8Array(2); var ab=new ArrayBuffer(8); return u.length + Number(ab.byteLength); }`;

  it("standalone: $__vec_i8_byte is `sub final`, $__vec_i32_byte is open", async () => {
    const wat = await watFor(BUILDS_BOTH, "standalone");
    expect(wat).toContain("(type $__vec_i8_byte (sub final ");
    expect(wat).toContain("(type $__vec_i32_byte (sub $");
    expect(wat).not.toContain("(type $__vec_i32_byte (sub final ");
  });

  it("wasi: the declared `final` brands the carrier even though finalization is skipped", async () => {
    // `markLeafStructsFinal` returns early on wasi (`skipFinal = ctx.wasi`), so
    // without the declaration-site `final` BOTH vecs would be open — identical
    // again. This is the half of the fix that step 2 cannot cover.
    const wat = await watFor(BUILDS_BOTH, "wasi");
    expect(wat).toContain("(type $__vec_i8_byte (sub final ");
    expect(wat).toContain("(type $__vec_i32_byte (sub $");
    expect(wat).not.toContain("(type $__vec_i32_byte (sub final ");
  });

  it("wasi: the b15 species program still compiles and carries the brand", async () => {
    // The species arm itself is emitted on wasi too (`noJsHost` covers both
    // targets), so the brand has to hold there. Compile-only: this lane does
    // not execute wasi modules.
    const wat = await watFor(
      `export function run(){ var ab=new ArrayBuffer(8); var C={};
         C[Symbol.species]=function(n){ return new Uint8Array(4) };
         ab.constructor=C; ab.slice(0,4); return 500; }`,
      "wasi",
    );
    expect(wat).toContain("(type $__vec_i8_byte (sub final ");
    expect(wat).toContain("(type $__vec_i32_byte (sub $");
    expect(wat).not.toContain("(type $__vec_i32_byte (sub final ");
  });

  it("keeps buffer/view sharing unchanged (new Uint8Array(ab) aliases ab)", async () => {
    expect(
      await runStandalone(
        `var ab=new ArrayBuffer(4); var u=new Uint8Array(ab); u[0]=5;
         return new Uint8Array(ab)[0] + (u.buffer===ab?10:0) + u.byteLength*100;`,
      ),
    ).toBe(415);
  });

  it("keeps copy-construction unchanged (new Uint8Array(u) copies)", async () => {
    expect(
      await runStandalone(`var u=new Uint8Array(2); u[0]=1; var c=new Uint8Array(u); c[0]=3; return u[0]*10+c[0];`),
    ).toBe(13);
  });

  it("keeps ArrayBuffer.prototype.slice over an aliased view unchanged", async () => {
    expect(
      await runStandalone(
        `var ab=new ArrayBuffer(4); var u=new Uint8Array(ab); u[2]=3; var s=ab.slice(1);
         return s.byteLength*100 + new Uint8Array(s)[1];`,
      ),
    ).toBe(303);
  });

  it("keeps the PRE-EXISTING `u.buffer` snapshot gap unchanged (320 here, 329 in node 22)", async () => {
    // NOT fixed by this round and NOT caused by it: `.buffer` of a
    // length-constructed Uint8Array is a snapshot copy rather than an alias, so
    // the write through `w` never reaches `u[1]`. Pinned at the pre-brand value
    // so a later change to that path has to move it deliberately.
    expect(
      await runStandalone(
        `var v=new Uint8Array(new ArrayBuffer(8), 2, 3); var u=new Uint8Array(2); u[0]=1;
         var w=new Uint8Array(u.buffer, 1); w[0]=9; return v.length*100 + v.byteOffset*10 + u[1];`,
      ),
    ).toBe(320);
  });
});

describe("#5349 round 3 — every site that relied on the two byte vecs being ONE type", () => {
  // Round 2's brand made `$__vec_i8_byte` and `$__vec_i32_byte` distinct
  // canonical types. Three emitters had been written against their identity: a
  // `ref.cast $__vec_i32_byte` on a Uint8Array used to succeed (aliasing the
  // view's bytes as a buffer) and a `ref.test $__vec_i32_byte` on one used to
  // answer TRUE. With the brand the first TRAPS and the second misdispatches.
  // Each case below names node 22's answer, main's, and round 2's.

  it("X1 a reassigned binding: `new Uint8Array(b).length` (node 4, main 0, r2 TRAP)", async () => {
    // `nativeBufferBuiltinOf` reads only the declaration initializer, so it
    // still answers "ArrayBuffer" after `b = new Uint8Array(4)`.
    expect(await runStandalone(`var b=new ArrayBuffer(4); b=new Uint8Array(4); return new Uint8Array(b).length;`)).toBe(
      4,
    );
  });

  it("X1 a rewritten array element (node 4, main 0, r2 TRAP)", async () => {
    // Here the wrong provenance comes from the checker's ELEMENT type, which no
    // binding-level value-set analysis could have caught.
    expect(
      await runStandalone(`var xs=[new ArrayBuffer(4)]; xs[0]=new Uint8Array(4); return new Uint8Array(xs[0]).length;`),
    ).toBe(4);
  });

  it("X1 reassign then write through the view (node 49, main 49, r2 TRAP)", async () => {
    expect(
      await runStandalone(
        `var b=new ArrayBuffer(4); b=new Uint8Array(4); b[0]=9; var v=new Uint8Array(b); return v.length*10+v[0];`,
      ),
    ).toBe(49);
  });

  it("X3 an erased typed-array source through a helper (node 3, main 3, r2 0)", async () => {
    expect(await runStandalone(`function mk(x){ return new Uint8Array(x) } return mk(new Uint8Array(3)).length;`)).toBe(
      3,
    );
  });

  it("X3 one helper called with BOTH a buffer and a view (node 442, main 442, r2 400)", async () => {
    expect(
      await runStandalone(
        `function mk(buf){ return new Uint8Array(buf) }
         var ab=new ArrayBuffer(4); var a=mk(ab); a[0]=1;
         var u=new Uint8Array(4); u[1]=2; var b=mk(u);
         return a.length*100+b.length*10+b[1];`,
      ),
    ).toBe(442);
  });

  it("X3 the erased view keeps its elements (node 33, main 33, r2 0)", async () => {
    expect(
      await runStandalone(
        `function mk(x){ return new Uint8Array(x) }
         var u=new Uint8Array(3); u[0]=1;u[1]=2;u[2]=3; var c=mk(u); return c.length*10+c[2];`,
      ),
    ).toBe(33);
  });

  it("X3 the erased source is COPIED, not aliased (node 313, main 393, r2 110)", async () => {
    // main's 393 is the masked bug: the write through `v` reached `u`.
    expect(
      await runStandalone(
        `function id(x){ return x }
         var u=new Uint8Array(3); u[0]=1;u[1]=2;u[2]=3;
         var x=id(u); var v=new Uint8Array(x); v[0]=9;
         return v.length*100+u[0]*10+v[2];`,
      ),
    ).toBe(313);
  });

  it("X3 copy-not-alias, minimal (node 1)", async () => {
    expect(await runStandalone(`var u=new Uint8Array([1,2]); var c=new Uint8Array(u); c[0]=9; return u[0];`)).toBe(1);
  });

  it("X3 `new Int32Array(u8)` copies ELEMENT-wise (node 8, main 2, r2 0)", async () => {
    // main's 2 came from reinterpreting the 8 bytes as a buffer.
    expect(
      await runStandalone(`function id(x){ return x } var u=new Uint8Array(8); return new Int32Array(id(u)).length;`),
    ).toBe(8);
  });

  it("X3 the testWithTypedArrayConstructors harness idiom (node 333, main 331, r2 0)", async () => {
    expect(
      await runStandalone(
        `function testWithTypedArrayConstructors(f){ var cs=[Uint8Array, Int8Array, Int16Array]; var r=0;
           for(var i=0;i<cs.length;i++){ r=r*10+f(cs[i]); } return r; }
         return testWithTypedArrayConstructors(function(TA){ var s=new Uint8Array([1,2,3]); return new TA(s).length; });`,
      ),
    ).toBe(333);
  });

  for (const kind of [
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
  ]) {
    it(`X3 \`new ${kind}(u8)\` through an erased binding copies all 3 elements (node 3)`, async () => {
      expect(
        await runStandalone(
          `function id(x){ return x } var u=new Uint8Array([1,2,3]); return new ${kind}(id(u)).length;`,
        ),
      ).toBe(3);
    });
  }

  it("keeps the buffer arm an ALIAS: `new Uint8Array(ab)` still shares ab's bytes", async () => {
    // The i32_byte arm must NOT become a copy — this is the case the erased
    // path was originally written for (#5194 copyIntoArrayBuffer).
    expect(
      await runStandalone(
        `function id(x){ return x }
         var ab=new ArrayBuffer(4); var d=new Uint8Array(ab); d[0]=7;
         var v=new Uint8Array(id(ab)); v[1]=5;
         return v.length*100 + v[0]*10 + d[1];`,
      ),
    ).toBe(475);
  });

  it("X2 wasi: process.stdout.write through a reassigned binding writes the bytes", async () => {
    // Round 2 trapped here (`ref.cast $__vec_i32_byte` on a Uint8Array) BEFORE
    // fd_write ran; main wrote ABC. Executed against a minimal
    // wasi_snapshot_preview1 shim that captures fd_write.
    const result = await compile(
      `export function run(){ var b=new ArrayBuffer(3); b=new Uint8Array(3);
         b[0]=65;b[1]=66;b[2]=67; process.stdout.write(b); return 1; }`,
      { target: "wasi", allowJs: true, skipSemanticDiagnostics: true } as never,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const written: number[] = [];
    const cell: { memory?: WebAssembly.Memory } = {};
    const noop = (): number => 0;
    const imports = {
      wasi_snapshot_preview1: {
        fd_write: (_fd: number, iovs: number, n: number, nwritten: number): number => {
          const view = new DataView(cell.memory!.buffer);
          const bytes = new Uint8Array(cell.memory!.buffer);
          let total = 0;
          for (let i = 0; i < n; i++) {
            const ptr = view.getUint32(iovs + i * 8, true);
            const len = view.getUint32(iovs + i * 8 + 4, true);
            for (let j = 0; j < len; j++) written.push(bytes[ptr + j]!);
            total += len;
          }
          view.setUint32(nwritten, total, true);
          return 0;
        },
        proc_exit: (code: number): never => {
          throw new Error(`exit ${code}`);
        },
        fd_close: noop,
        fd_seek: noop,
        fd_read: noop,
        environ_get: noop,
        environ_sizes_get: noop,
        args_get: noop,
        args_sizes_get: noop,
        clock_time_get: noop,
        random_get: noop,
        path_open: noop,
        fd_prestat_get: (): number => 8,
        fd_prestat_dir_name: noop,
        fd_fdstat_get: noop,
      },
    };
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    cell.memory = (instance.exports as { memory: WebAssembly.Memory }).memory;
    expect((instance.exports as Record<string, () => unknown>).run()).toBe(1);
    expect(written).toEqual([65, 66, 67]);
  });

  it("host emission is untouched: the keep-open is gated on the host-free lanes", async () => {
    // `$__vec_i8_byte` never exists on the JS-host lane, so there is nothing for
    // `$__vec_i32_byte` to canonicalize against and dropping its `final` bit
    // only changed bytes. Measured over 102 probes: round 2 moved 70 host
    // modules, this tree moves 0.
    const result = await compile(`export function run(){ var ab=new ArrayBuffer(8); return ab.byteLength; }`, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      emitWat: true,
    } as never);
    expect(result.success).toBe(true);
    expect(result.wat ?? "").toContain("(type $__vec_i32_byte (sub final ");
  });

  it("X3 a BigInt destination from a non-BigInt source is a TypeError (§23.2.5.1.2 step 5; node TypeError, main 0, r2 0)", async () => {
    // Before this arm the value fell to the count form (0). With the copy arm
    // and no refusal it produced a length-3 BigInt64Array of numeric bits.
    expect(
      await runStandalone(
        `function id(x){ return x } var u=new Uint8Array([1,2,3]); new BigInt64Array(id(u)); return 0;`,
      ),
    ).toBe(1);
    expect(
      await runStandalone(
        `function id(x){ return x } var u=new Uint8Array([1,2,3]); new BigUint64Array(id(u)); return 0;`,
      ),
    ).toBe(1);
  });

  it("X4 `ab.slice` on a reassigned binding (node 4, main 4, r2 TRAP)", async () => {
    // `emitArrayBufferSlice` recovers its RECEIVER with the same static-provenance
    // cast. Node runs %TypedArray%.prototype.slice here and returns a Uint8Array;
    // this emitter can only return a byte buffer, so the shape is still wrong —
    // but the length matches and it no longer traps.
    expect(
      await runStandalone(`var b=new ArrayBuffer(8); b=new Uint8Array(8); var s=b.slice(0,4); return s.length;`),
    ).toBe(4);
  });

  it("X4 `.byteLength` on a reassigned binding (node 8, main 8, r2 0)", async () => {
    // The byteLength probe already had a `ref.test` with a 0 fallback, so the
    // brand turned it from a right answer into a wrong one rather than a trap.
    expect(await runStandalone(`var b=new ArrayBuffer(8); b=new Uint8Array(8); return b.byteLength;`)).toBe(8);
  });

  it("X4 a DataView over a reassigned binding is a TypeError (node TypeError, main 8)", async () => {
    // The brand IMPROVED this one and round 3 keeps it: main built a DataView
    // over the Uint8Array's bytes and reported 8.
    expect(await runStandalone(`var b=new ArrayBuffer(8); b=new Uint8Array(8); new DataView(b); return 0;`)).toBe(1);
  });
});
