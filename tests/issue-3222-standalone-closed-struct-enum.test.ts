// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3222 C1 — native closed-shape struct field ENUMERATION in standalone / WASI.
 *
 * Under `--target standalone`/`wasi` there is no JS runtime, so property
 * enumeration lowers to the native `__object_keys` / `__object_assign` /
 * `__extern_rest_object` helpers, which walk only the OPEN-`$Object` hash. A
 * statically-typed CLOSED-shape struct source (an object literal / typed local)
 * reinterpreted as externref is invisible to those helpers, so before this fix
 * `{...typedObj}` copied NOTHING and `{a, ...rest}` produced an EMPTY rest.
 *
 * C1 materializes the closed struct into a real open `$Object` (own-enumerable
 * fields only) AT THE KNOWN-TYPE SITE, so the existing open-hash enumeration
 * works. The host/gc lanes are byte-identical (they enumerate closed structs via
 * `__sget_*` reflection already) — the fix is gated on `ctx.standalone||wasi`.
 *
 * These tests instantiate with an EMPTY import object (`{}`) to prove genuine
 * host-free enumeration.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // No `string_constants` host import should be emitted (genuine standalone).
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f(): number }).f();
}

describe("#3222 C1 — standalone spread of a closed struct", () => {
  it("spread copies all own-enumerable field VALUES", async () => {
    // a+b+c = 1+2+3 = 6
    expect(
      await runStandalone(`export function f(): number {
        const s = {a:1,b:2,c:3}; const t: any = {...s};
        return (t.a||0)+(t.b||0)+(t.c||0); }`),
    ).toBe(6);
  });

  it("spread result has the right own KEYS count", async () => {
    expect(
      await runStandalone(`export function f(): number {
        const s = {a:1,b:2,c:3}; const t = {...s};
        return Object.keys(t).length; }`),
    ).toBe(3);
  });

  it("spread with a later override keeps one key per name and the override value", async () => {
    // {...s, b:9} → a1 b9 c3 = 13
    expect(
      await runStandalone(`export function f(): number {
        const s = {a:1,b:2,c:3}; const t: any = {...s, b:9};
        return (t.a||0)+(t.b||0)+(t.c||0); }`),
    ).toBe(13);
  });

  it("merging two closed structs unions their keys", async () => {
    expect(
      await runStandalone(`export function f(): number {
        const s = {a:1,b:2}; const u = {c:3}; const t = {...s, ...u};
        return Object.keys(t).length; }`),
    ).toBe(3);
  });

  // NOTE: `--target wasi` object-SPREAD has a SEPARATE pre-existing gap — this
  // handler's `__object_assign` array-builder is host-free only under
  // `ctx.standalone`, so even open-`$Object` spread is empty under wasi. That is
  // out of C1 scope (tracked as a follow-up). The object-REST path below DOES
  // work under wasi (its `__extern_rest_object` downstream is native, #3223).
});

describe("#3222 C1 — standalone object-rest of a closed struct", () => {
  it("rest excludes the named binding and keeps the remaining own keys", async () => {
    // {a, ...rest} = {a:1,b:2,c:3} → rest keys = [b,c] → length 2
    expect(
      await runStandalone(`export function f(): number {
        const {a, ...rest} = {a:1,b:2,c:3};
        return Object.keys(rest).length; }`),
    ).toBe(2);
  });

  it("rest carries the correct VALUES and drops the excluded key", async () => {
    // rest.b + rest.c = 5, rest.a absent
    expect(
      await runStandalone(`export function f(): number {
        const {a, ...rest}: any = {a:1,b:2,c:3};
        return (rest.b||0)+(rest.c||0)+(rest.a?100:0); }`),
    ).toBe(5);
  });

  it("multi-binding rest excludes every named binding", async () => {
    // {a, b, ...r2} = {a:1,b:2,c:3,d:4} → r2 keys = [c,d] → length 2
    expect(
      await runStandalone(`export function f(): number {
        const {a, b, ...r2} = {a:1,b:2,c:3,d:4};
        return Object.keys(r2).length; }`),
    ).toBe(2);
  });

  it("wasi target enumerates the rest the same way (native __extern_rest_object)", async () => {
    expect(
      await runStandalone(
        `export function f(): number {
        const {a, ...rest} = {a:1,b:2,c:3};
        return Object.keys(rest).length; }`,
        "wasi",
      ),
    ).toBe(2);
  });
});
