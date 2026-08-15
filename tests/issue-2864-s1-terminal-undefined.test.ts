// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2864 wave-2 S1 — an exhausted / `done`-completing native generator must
 * deliver an observable `undefined` in `.value`, in BOTH carriers.
 *
 * Before this slice the two carriers failed differently, both host-free and
 * both silently:
 *   - f64 carrier: the `UNDEF_F64_BITS` sentinel reached an `any` consumer as
 *     the NUMBER NaN (`tryCompileNativeGeneratorResultProperty`'s
 *     `valueStaticNumeric` fast path returned a bare `f64`, and the generic
 *     f64→externref box must not resurrect the sentinel — #3315). Fixed by the
 *     `{kind:"f64", undefSentinel:true}` BRAND, consulted only at the box site.
 *   - boxed-any carrier: `defaultElemValueInstrs` minted `ref.null.extern`,
 *     which is JS **null**, not `undefined` — the standalone value model has
 *     separated the two since the tag-1 `$undefined` singleton became a
 *     per-module reservation. Fixed by `canonicalUndefinedExternInstrs`.
 *
 * The assertions below read `.value` through `typeof` on a dynamically-typed
 * receiver ON PURPOSE: that is the shape the test262 harness uses
 * (`assert.sameValue(result.value, undefined)` with `var result`), and it is
 * the shape a statically-typed probe cannot reproduce — a typed `r.value ===
 * undefined` is answered by the checker, not by the emitted module, which is
 * how this class of defect stayed invisible.
 *
 * Every case compiles standalone with ZERO host imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2864 S1 terminal {value: undefined, done: true} (standalone)", () => {
  it("f64 carrier: exhausted .value is undefined, not the NaN sentinel", async () => {
    // 1 = typeof "undefined"; 2 = typeof "number" (the pre-S1 answer);
    // 4 = typeof "object" (a null externref would report this).
    expect(
      await runStandalone(`function* g() { yield 1; yield 2; }
var it = g();
var result;
export function test(): number {
  result = it.next();
  result = it.next();
  result = it.next();
  let n = 0;
  const t = typeof result.value;
  if (t === "undefined") n += 1;
  if (t === "number") n += 2;
  if (t === "object") n += 4;
  return n;
}`),
    ).toBe(1);
  });

  it("f64 carrier: a genuine yielded NaN still reads as a NUMBER", async () => {
    // The brand must not swallow a real computed NaN — that is the #3315 case
    // the generic f64 box deliberately refuses to canonicalize.
    expect(
      await runStandalone(`function* g() { yield 0 / 0; }
var it = g();
var result;
export function test(): number {
  result = it.next();
  let n = 0;
  const t = typeof result.value;
  if (t === "number") n += 1;
  if (t === "undefined") n += 2;
  return n;
}`),
    ).toBe(1);
  });

  it("boxed-any carrier: exhausted .value is undefined, not null", async () => {
    expect(
      await runStandalone(`function* g() { yield {a:1}; yield 2; }
var it = g();
var result;
export function test(): number {
  result = it.next();
  result = it.next();
  result = it.next();
  let n = 0;
  const t = typeof result.value;
  if (t === "undefined") n += 1;
  if (t === "object") n += 2;
  if (t === "number") n += 4;
  return n;
}`),
    ).toBe(1);
  });

  it("boxed-any carrier: null vs undefined stay distinguishable", async () => {
    // A generator that genuinely yields `null` must still report an object —
    // the fix changes the ABSENT value only.
    expect(
      await runStandalone(`function* g() { yield null; yield {a:1}; }
var it = g();
var result;
export function test(): number {
  result = it.next();
  let n = 0;
  const t = typeof result.value;
  if (t === "object") n += 1;
  if (t === "undefined") n += 2;
  return n;
}`),
    ).toBe(1);
  });

  it("terminal .done is still true and the value is not a stale yield", async () => {
    expect(
      await runStandalone(`function* g() { yield 7; }
var it = g();
var result;
export function test(): number {
  result = it.next();
  const first = result.value;
  result = it.next();
  let n = 0;
  if (result.done === true) n += 1;
  if (typeof result.value === "undefined") n += 10;
  if (typeof first === "number") n += 100;
  return n;
}`),
    ).toBe(111);
  });
});
