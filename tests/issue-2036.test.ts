import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2036 S6 step 1 — borrowed Array.prototype search/result-building methods over
// an array-like `$Object` receiver have no working native standalone path yet;
// they previously emitted invalid Wasm / leaked host imports. They must now
// REFUSE LOUDLY in standalone (never invalid Wasm, never a silent-wrong value),
// while the same calls keep compiling in host mode and real-array receivers keep
// working in standalone.
async function compileStandalone(body: string): Promise<{ success: boolean; errors: { message: string }[] }> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  return { success: r.success, errors: r.success ? [] : r.errors.map((e) => ({ message: e.message })) };
}

// #2036 PR-1 — standalone Array.prototype generics over a real array-like
// `$Object` receiver ({0:x, length:n}).
//
// The target-agnostic array-like loop in `compileArrayLikePrototypeCall`
// reads the receiver via __extern_length / __extern_get_idx / __extern_has_idx.
// In standalone those are NATIVE helpers (object-runtime.ts) that previously
// only recognised the enumeration-result `$ObjVec` and returned 0/null for a
// real array-like `$Object` — so the generic loop ran with len 0 and the
// callback methods produced wrong results / null-derefs.
//
// PR-1 teaches the three helpers an `$Object` arm: __extern_length does
// ToLength(Get(O,"length")), __extern_get_idx returns __extern_get(O,
// ToString(idx)), __extern_has_idx returns HasProperty(O, ToString(idx)) — all
// via the canonical number_toString key stringifier and the existing proto-walk
// in __extern_get/__extern_has. Gated on standalone; gc/host uses the JS import.
//
// Scope note: the SEARCH methods (indexOf/lastIndexOf/includes) and the
// result-building methods (filter/map/reduce/reduceRight) over an `$Object`
// receiver previously emitted invalid Wasm / leaked host imports in standalone.
// #2036 S6 step 1 now makes them REFUSE LOUDLY there (asserted in the second
// describe block below) until their real native generic arm lands (step 2,
// senior/infra). The callback methods that route through the generic loop
// (forEach/some/every/find/findIndex) are fixed (PR-1) and covered below.

async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2036 standalone Array.prototype generics over array-like $Object", () => {
  it("forEach reads length + elements from an array-like $Object", async () => {
    expect(
      await runStandalone(
        `function probe(o: any): number {
           let s = 0;
           Array.prototype.forEach.call(o, (x: any) => { s += x; });
           return s;
         }
         export function test(): number {
           const o: any = { 0: 5, 1: 6, length: 2 };
           return probe(o);
         }`,
      ),
    ).toBe(11);
  });

  it("some returns true when a matching element exists", async () => {
    expect(
      await runStandalone(
        `function probe(o: any): number {
           return Array.prototype.some.call(o, (x: any) => x === 6) ? 1 : 0;
         }
         export function test(): number {
           const o: any = { 0: 5, 1: 6, length: 2 };
           return probe(o);
         }`,
      ),
    ).toBe(1);
  });

  it("every checks all in-range elements", async () => {
    expect(
      await runStandalone(
        `function probe(o: any): number {
           return Array.prototype.every.call(o, (x: any) => x > 0) ? 1 : 0;
         }
         export function test(): number {
           const o: any = { 0: 5, 1: 6, length: 2 };
           return probe(o);
         }`,
      ),
    ).toBe(1);
  });

  it("findIndex returns the index of the first match", async () => {
    expect(
      await runStandalone(
        `function probe(o: any): number {
           return Array.prototype.findIndex.call(o, (x: any) => x === 6);
         }
         export function test(): number {
           const o: any = { 0: 5, 1: 6, length: 2 };
           return probe(o);
         }`,
      ),
    ).toBe(1);
  });

  it("length is read as ToLength (only in-range indices visited)", async () => {
    // length:1 means only index 0 is visited even though index 1 has a value.
    expect(
      await runStandalone(
        `function probe(o: any): number {
           let s = 0;
           Array.prototype.forEach.call(o, (x: any) => { s += x; });
           return s;
         }
         export function test(): number {
           const o: any = { 0: 5, 1: 6, length: 1 };
           return probe(o);
         }`,
      ),
    ).toBe(5);
  });

  it("hole-skipping: forEach does not visit absent indices", async () => {
    // index 1 is absent (a hole) — forEach must skip it (callback count 1).
    expect(
      await runStandalone(
        `function probe(o: any): number {
           let count = 0;
           Array.prototype.forEach.call(o, (_x: any) => { count += 1; });
           return count;
         }
         export function test(): number {
           const o: any = { 0: 5, length: 2 };
           return probe(o);
         }`,
      ),
    ).toBe(1);
  });
});

describe("#2036 S6 step 1 — borrowed search/result-building methods refuse loud in standalone", () => {
  // These methods previously emitted invalid Wasm / leaked a host import over a
  // borrowed array-like `$Object` receiver in standalone. They must now refuse
  // with a `Codegen error:` naming the method + #2036 — never a broken module.
  // (#2036 S6 step 2) `filter` graduated to a native standalone arm (it builds
  // its result via the native `$ObjVec` builder) — it is asserted to WORK below,
  // not refuse. The remaining methods still refuse until their native arms land.
  for (const method of ["indexOf", "lastIndexOf", "includes", "map", "reduce", "reduceRight"]) {
    it(`${method} over an array-like $Object refuses loudly in standalone`, async () => {
      const args =
        method === "filter" || method === "map"
          ? "(x: any) => x"
          : method.startsWith("reduce")
            ? "(a: any, x: any) => a, 0"
            : "'x'";
      const r = await compileStandalone(
        `export function test(): number {
           const o: any = { 0: 5, 1: 'x', length: 2 };
           const v: any = Array.prototype.${method}.call(o, ${args});
           return 0;
         }`,
      );
      expect(r.success).toBe(false);
      expect(
        r.errors.some(
          (e) => /Codegen error:/.test(e.message) && e.message.includes(method) && e.message.includes("#2036"),
        ),
      ).toBe(true);
    });
  }

  it("callback methods (forEach) still compile over an array-like $Object in standalone", async () => {
    // Control: the #2036 PR-1 native callback path must NOT be caught by the refusal.
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { 0: 5, 1: 6, length: 2 };
           let s = 0;
           Array.prototype.forEach.call(o, (x: any) => { s += x; });
           return s;
         }`,
      ),
    ).toBe(11);
  });

  // (#2036 S6 step 2) filter over an array-like $Object now runs NATIVELY in
  // standalone (host-import-free) — builds a `$ObjVec` result via
  // __objvec_new/__objvec_push that is `[i]`/`.length`-readable.
  it("filter over an array-like $Object runs natively in standalone (length)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { 0: 1, 1: 2, 2: 3, length: 3 };
           const r: any = Array.prototype.filter.call(o, (x: number) => x > 1);
           return r.length;
         }`,
      ),
    ).toBe(2);
  });

  it("filter preserves element order + values standalone (r[0], r[1])", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { 0: 10, 1: 20, 2: 30, length: 3 };
           const r: any = Array.prototype.filter.call(o, (x: number) => x > 10);
           return r[0] * 100 + r[1];
         }`,
      ),
    ).toBe(2030);
  });

  it("filter over a sparse array-like skips holes standalone", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { 0: 1, 2: 3, length: 3 };
           const r: any = Array.prototype.filter.call(o, (x: number) => x > 0);
           return r.length;
         }`,
      ),
    ).toBe(2);
  });

  it("filter threads thisArg standalone", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           const o: any = { 0: 5, 1: 15, length: 2 };
           const r: any = Array.prototype.filter.call(
             o,
             function (this: any, x: number) { return x > this.t; },
             { t: 10 },
           );
           return r.length;
         }`,
      ),
    ).toBe(1);
  });

  it("real native array receivers still work in standalone (not refused)", async () => {
    // The refusal must be scoped to array-like $Object receivers only — a real
    // Array still takes the dedicated native path.
    expect(
      await runStandalone(
        `export function test(): number {
           const a = [10, 20, 30];
           return Array.prototype.indexOf.call(a, 20);
         }`,
      ),
    ).toBe(1);
  });

  it("host mode still compiles borrowed indexOf over an array-like $Object", async () => {
    // The refusal is standalone-only; host mode keeps the __proto_method_call path.
    const r = await compile(
      `export function test(): number {
         const o: any = { 0: 5, 1: 'x', length: 2 };
         return Array.prototype.indexOf.call(o, 'x');
       }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
  });
});

// #2036 — native-string element search equality. Under native strings
// (auto-enabled for standalone/WASI) a `string[]` element ValType is a
// `ref_null $AnyString`, so the search loops (indexOf/lastIndexOf/includes)
// took the `ref.eq` (reference-identity) arm. Every string literal/slice
// materialises a distinct $AnyString allocation, so value-equal strings never
// matched: `['a','b','c'].indexOf('c')` returned -1, and the borrowed
// `Array.prototype.indexOf.call(realArray, str)` form likewise. Strict equality
// on strings is by content (§7.2.16), so these now route to __str_equals.
describe("#2036 native-string element search equality (indexOf/includes/lastIndexOf)", () => {
  it("string[].indexOf finds a later element by content", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: string[] = ['a','b','c']; return a.indexOf('c'); }`,
      ),
    ).toBe(2);
  });

  it("string[].indexOf finds the first element", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: string[] = ['a','b','c']; return a.indexOf('a'); }`,
      ),
    ).toBe(0);
  });

  it("string[].indexOf returns -1 when absent", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: string[] = ['a','b','c']; return a.indexOf('z'); }`,
      ),
    ).toBe(-1);
  });

  it("string[].includes matches by content", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: string[] = ['a','b','c']; return a.includes('b') ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("string[].includes returns false when absent", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: string[] = ['a','b','c']; return a.includes('z') ? 1 : 0; }`,
      ),
    ).toBe(0);
  });

  it("string[].lastIndexOf finds the LAST duplicate by content", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: string[] = ['a','b','b']; return a.lastIndexOf('b'); }`,
      ),
    ).toBe(2);
  });

  it("Array.prototype.indexOf.call(realArray, str) compares by content", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: string[] = ['a','b']; return Array.prototype.indexOf.call(a, 'b'); }`,
      ),
    ).toBe(1);
  });

  it("matches a cons-string (flattened) needle", async () => {
    // The needle is built by concatenation → a cons-string; __str_equals must
    // flatten before comparing so it still matches the flat stored 'bc'.
    expect(
      await runStandalone(
        `export function test(): number {
           const a: string[] = ['ab','bc','cd'];
           const needle = 'b' + 'c';
           return a.indexOf(needle);
         }`,
      ),
    ).toBe(1);
  });

  it("number[] search is unchanged (control)", async () => {
    expect(
      await runStandalone(`export function test(): number { const a: number[] = [1,2,3]; return a.indexOf(3); }`),
    ).toBe(2);
  });
});
