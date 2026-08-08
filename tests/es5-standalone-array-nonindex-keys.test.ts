// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4247) §10.4.2.2 — an element key on an array is an ARRAY INDEX only when
// `ToString(ToUint32(P)) === P` and `ToUint32(P) !== 2^32 − 1`. Everything else
// is an ordinary NAMED property: it must be readable back under its canonical
// key, must NOT create an element, and must leave `length` untouched.
//
// Before this change the typed vec lane compiled every element key with an i32
// hint, so `a[4294967295] = 1` saturated the key to `i32.max` and the grow
// sequence TRAPPED the whole module ("array element access out of bounds") —
// the six `built-ins/Array` OOB failures #4222 measured and deferred as a
// contained follow-up. The string spelling was broken differently and just as
// invisibly: it reached `__extern_set`, whose `$__vec_base` prologue runs
// `__unbox_number(key)` and (in standalone that parses NATIVE STRINGS) handled
// `"4294967295"` terminally as an element, silently dropping the write.
//
// Both lanes are pinned. The routing itself is lane-shared — only its target
// differs (the #3537 expando bag in standalone, the host `__extern_*` in gc,
// where JS already implements §10.4.2.2) — so a lane-specific regression in
// either target shows up here.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Lane = "standalone" | "gc";
const LANES: Lane[] = ["standalone", "gc"];

async function run(src: string, target: Lane): Promise<unknown> {
  const r = await compile(src, target === "standalone" ? { target: "standalone" as const } : {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  if (target === "standalone") {
    const leaked = (r.imports as unknown as { module?: string; name?: string }[])
      .filter((i) => i?.module === "env")
      .map((i) => `env::${i.name}`);
    expect(leaked, "standalone module must not leak host imports").toEqual([]);
  }
  const imports = target === "standalone" ? {} : buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => unknown }).test();
}

/** Assertions are made INSIDE wasm and reported as 1/0 — a standalone string
 *  result is an opaque WasmGC ref the host cannot compare. */
async function ok(src: string, target: Lane): Promise<unknown> {
  return run(src, target);
}

describe.each(LANES)("#4247 — non-array-index element keys are named properties (%s)", (lane) => {
  it("2^32-1 round-trips under its own key and does not trap", async () => {
    expect(
      await ok(
        `const a: any[] = [];
         export function test(): number { a[4294967295] = "n"; return a[4294967295] === "n" ? 1 : 0; }`,
        lane,
      ),
    ).toBe(1);
  });

  it("2^32-1 leaves length alone (15.4.5.1-5-2)", async () => {
    expect(
      await ok(
        `const a: any[] = [0, 1, 2];
         export function test(): number { a[4294967295] = "n"; return a.length; }`,
        lane,
      ),
    ).toBe(3);
  });

  it("a negative key is a named property, not an element (S15.4.5.1_A2.1_T1)", async () => {
    expect(
      await ok(
        `let x: any[] = [];
         export function test(): number { x[-1] = 1; return x.length === 0 && x[-1] === 1 ? 1 : 0; }`,
        lane,
      ),
    ).toBe(1);
  });

  it('a boolean key names "true"/"false", not index 1/0 (15.4_A1.1_T1)', async () => {
    expect(
      await ok(
        `let x: any[] = [];
         export function test(): number {
           x[true as any] = 1; x[false as any] = 0;
           return x[0] === undefined && x[1] === undefined &&
                  (x as any)["true"] === 1 && (x as any)["false"] === 0 ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("2^32 and a fractional key stay off the element lane (15.4_A1.1_T3)", async () => {
    expect(
      await ok(
        `let x: any[] = []; let y: any[] = []; let z: any[] = [];
         export function test(): number {
           x[4294967296] = 1; y[4294967297] = 1; z[1.1] = 1;
           return x[0] === undefined && (x as any)["4294967296"] === 1 &&
                  y[1] === undefined && (y as any)["4294967297"] === 1 &&
                  z[1] === undefined && (z as any)["1.1"] === 1 ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("NaN / ±Infinity key under their ToString spelling (15.4_A1.1_T2)", async () => {
    expect(
      await ok(
        `let x: any[] = []; let y: any[] = []; let z: any[] = [];
         export function test(): number {
           x[NaN] = 1; y[Number.POSITIVE_INFINITY] = 1; z[Number.NEGATIVE_INFINITY] = 1;
           return x[0] === undefined && (x as any)["NaN"] === 1 &&
                  y[0] === undefined && (y as any)["Infinity"] === 1 &&
                  z[0] === undefined && (z as any)["-Infinity"] === 1 ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("the numeric and string spellings of one key agree in both directions", async () => {
    expect(
      await ok(
        `const a: any[] = []; const b: any[] = [];
         export function test(): number {
           a[4294967295] = 7;
           (b as any)["4294967295"] = 7;
           return (a as any)["4294967295"] === 7 && b[4294967295] === 7 ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  // ── Non-regression: ordinary indices and reserved names keep their lowering ──

  it("an ordinary index still writes an element and grows length", async () => {
    expect(
      await ok(
        `const a: number[] = [];
         export function test(): number { a[3] = 9; return a.length * 10 + a[3]; }`,
        lane,
      ),
    ).toBe(49);
  });

  it("the largest real array index (2^32-2) is NOT diverted to the bag", async () => {
    // It is a genuine index, so it must keep the element lowering. The vec
    // cannot hold 4 billion slots, so the honest outcome is the pre-existing
    // grow trap — NOT a silent named-property write that would answer a bogus
    // `length`. Pinning the classification, not the trap's wording.
    const src = `const a: any[] = [];
                 export function test(): number { a[4294967294] = 1; return a.length; }`;
    await expect(run(src, lane)).rejects.toThrow();
  });

  it("`length` is never captured by the named-key routing", async () => {
    // The routing admits a string key only when `String(Number(k)) === k`, and
    // `Number("length")` is NaN whose ToString is `"NaN"` — so the whole family
    // of reserved names (`length`, `push`, `constructor`, …) is rejected by
    // construction rather than by a deny-list. Pinned via the real length after
    // a named-key write, which is what would break if `"length"` ever reached
    // the expando bag.
    //
    // NOT pinned here: `(a as any)["length"]` answers `1` (element 0) in BOTH
    // lanes. That is the pre-existing bracket-read gap for reserved names —
    // this change neither causes nor fixes it; see the issue's Leftovers.
    expect(
      await ok(
        `const a: any[] = [1, 2, 3];
         export function test(): number { a[4294967295] = 9; return a.length; }`,
        lane,
      ),
    ).toBe(3);
  });

  it("a plain name key is untouched", async () => {
    expect(
      await ok(
        `const a: any[] = [1, 2];
         export function test(): number {
           (a as any)["foo"] = 5;
           return (a as any)["foo"] === 5 && a.length === 2 ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });
});
