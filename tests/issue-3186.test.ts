import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// #3186 — [SOUNDNESS] host lane: for-in string-key array element read.
//
// The Fable audit (§F3) claimed the gc/JS-host lane returns a *silent wrong
// value* for `for (var k in arr) arr[k]` where `k` is a runtime string index —
// the un-filed host sibling of #3179's standalone `illegal cast` trap.
//
// Verification (2026-07-12, dev-forin-sound) showed the premise does NOT
// reproduce: the host lane is CORRECT for reads and writes across every array
// representation. The one host-lane defect is a self-announcing TRAP on the
// rep-divergent `new Array()`+numeric case, which is the #3179 loop-header
// mechanism (shared `emitArrayForIn`), not a silent wrong value — owned by
// #3179. All *silent* wrong values live on the standalone/WASI lane
// (#3179/#3183 own that lane; see the census in plan/issues/3186-*.md).
//
// This test is the regression GUARD: it pins the correct host-lane behaviour so
// a future change cannot silently reintroduce a wrong value on this path. See
// the family census in the issue file for the full {read,write} × {array rep} ×
// {host,standalone} matrix.
async function runHost(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!();
}

describe("#3186 host-lane for-in string-key array element read is sound", () => {
  it("exact audit repro returns 6 (string values, length after concat)", async () => {
    // The literal repro from #3179's ablation / #3186's Problem section.
    expect(
      await runHost(`export function test(): number {
        var nullChars = new Array();
        nullChars[0] = '"a"';
        nullChars[1] = '"b"';
        let s = '';
        for (var index in nullChars) { s = s + nullChars[index]; }
        return s.length;
      }`),
    ).toBe(6);
  });

  it("string values: concatenated content is exactly correct, not just the length", async () => {
    // Guards against a wrong value that happens to preserve length.
    expect(
      await runHost(`export function test(): string {
        var a = new Array();
        a[0] = '"a"';
        a[1] = '"b"';
        let s = '';
        for (var i in a) { s = s + a[i]; }
        return s;
      }`),
    ).toBe('"a""b"');
  });

  it("read: numeric literal array sums correctly via string keys", async () => {
    expect(
      await runHost(`export function test(): number {
        var a = [10, 20, 30];
        let s = 0;
        for (var i in a) { s = s + a[i]; }
        return s;
      }`),
    ).toBe(60);
  });

  it("read: Object.keys(a)[i] numeric access is correct", async () => {
    expect(
      await runHost(`export function test(): number {
        var a = [10, 20, 30];
        let s = 0;
        for (var i of Object.keys(a)) { s = s + a[i]; }
        return s;
      }`),
    ).toBe(60);
  });

  it("write: assigning a[k]=v through a string key updates the element", async () => {
    expect(
      await runHost(`export function test(): number {
        var a = [0, 0, 0];
        for (var i in a) { a[i] = 5; }
        return a[0] + a[1] + a[2];
      }`),
    ).toBe(15);
  });

  it("read: TypedArray (Int32Array) string-key element read is correct", async () => {
    expect(
      await runHost(`export function test(): number {
        var a = new Int32Array(3);
        a[0] = 10; a[1] = 20; a[2] = 30;
        let s = 0;
        for (var i in a) { s = s + a[i]; }
        return s;
      }`),
    ).toBe(60);
  });

  it("read: any-typed receiver string-key element read is correct", async () => {
    expect(
      await runHost(`function get(a: any): number {
        let s = 0;
        for (var i in a) { s = s + a[i]; }
        return s;
      }
      export function test(): number { return get([10, 20, 30]); }`),
    ).toBe(60);
  });

  it("read+write roundtrip: mutate then re-read via string keys", async () => {
    expect(
      await runHost(`export function test(): number {
        var a = ['1', '2', '3'];
        let s = '';
        for (var i in a) { a[i] = a[i] + '!'; }
        for (var j in a) { s = s + a[j]; }
        return s.length;
      }`),
    ).toBe(6);
  });
});
