import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1901 — closed-struct → externref string-key member read (the post-S2
 * standalone plateau-breaker).
 *
 * Under `--target standalone`, reading a string property off an `externref`
 * whose underlying value is a compiled closed-struct object literal returned 0
 * AND produced invalid Wasm: `function g(o:any){return o.x}` ← `g({x:9})` = 0.
 * Two compounding defects (see plan/issues/1901): (1) the native object runtime
 * was never emitted for a closed-struct-only program → `env::__extern_get` left
 * unbound → module invalid; (2) `__extern_get`'s `ref.test $Object` arm could
 * not match a closed-struct ref.
 *
 * These tests assert the BEHAVIOR (correct value + zero host imports + valid
 * module), independent of the fix mechanism (construction-time `$Object`
 * routing). They double as the focused validator + the #124 ToPrimitive-on-
 * objects unification check.
 */

// Mirror issue-1472.test.ts: any leaked env::__extern_*/__object_*/__new_plain_object
// /__get_builtin/__proto_method_call/__to_primitive under standalone is a failure.
const BANNED = [
  /^env::__extern_/,
  /^env::__object_/,
  /^env::__new_plain_object/,
  /^env::__get_builtin/,
  /^env::__proto_method_call/,
  /^env::__to_primitive/,
  /^env::__hasOwnProperty/,
];
function assertNoHostObjectImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED) {
    const hits = labels.filter((l) => re.test(l));
    expect(hits, `--target standalone leaked ${re} (got ${hits.join(", ")})`).toEqual([]);
  }
}
type NumExports = Record<string, () => number>;

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoHostObjectImports(r.imports);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as NumExports).run();
}

describe("#1901 — closed-struct → externref string-key member read (standalone)", () => {
  it("untyped-param object arg: g({x:9}).x reads 9 (headline symptom)", async () => {
    const v = await runStandalone(
      `function g(o: any): number { return o.x as number; }
       export function run(): number { return g({ x: 9 }); }`,
    );
    expect(v).toBe(9);
  });

  it("inline any-typed object literal: const o:any={x:9}; o.x reads 9", async () => {
    const v = await runStandalone(`export function run(): number { const o: any = { x: 9 }; return o.x as number; }`);
    expect(v).toBe(9);
  });

  it("multiple props read correctly", async () => {
    const v = await runStandalone(
      `function g(o: any): number { return (o.a as number) * 100 + (o.b as number); }
       export function run(): number { return g({ a: 3, b: 7 }); }`,
    );
    expect(v).toBe(307);
  });

  it("nested object: g({x:{y:5}}).x.y reads 5", async () => {
    const v = await runStandalone(
      `function g(o: any): number { return o.x.y as number; }
       export function run(): number { return g({ x: { y: 5 } }); }`,
    );
    expect(v).toBe(5);
  });

  it("absent property reads undefined (→ 0 in numeric coercion), not a trap", async () => {
    const v = await runStandalone(
      `function g(o: any): number { return (o.missing as number) | 0; }
       export function run(): number { return g({ x: 9 }); }`,
    );
    expect(v).toBe(0);
  });

  // #124 sibling (ToPrimitive reads valueOf/toString off a boxed object literal)
  // is a SEPARATE lever and is NOT closed by #1901. #1901 fixes the data-property
  // string-key MEMBER READ at construction (`{x:9}` → $Object → `o.x` reads 9).
  // ToPrimitive's `(o as number)` must additionally LOCATE the stored
  // valueOf/toString closure on the $Object and invoke it via __apply_closure;
  // that dispatch path (whether the property is a method shorthand
  // `{valueOf(){…}}` or a closure-valued data prop `{valueOf:()=>…}`) is the
  // tracked follow-on, depends on S6b method-as-value wrapping, and currently
  // still yields NaN. We pin the construction half here: a literal carrying a
  // valueOf method must still compile to VALID standalone Wasm with no host
  // object-import leak — i.e. #1901 routing neither fixes nor regresses #124.
  it("#124 sibling (construction half): valueOf-method literal compiles valid + leak-free under standalone", async () => {
    const r = await compile(
      `export function run(): number {
         const o: any = { valueOf() { return 7; } };
         return (o as number) + 0;
       }`,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
    // NOTE: run() === NaN today (ToPrimitive dispatch is the #124 follow-on).
  });

  it("typed-struct fast path is preserved (regression guard): typed Point still reads natively", async () => {
    const v = await runStandalone(
      `interface Point { x: number; y: number; }
       export function run(): number { const p: Point = { x: 3, y: 4 }; return p.x * p.x + p.y * p.y; }`,
    );
    expect(v).toBe(25);
  });
});
