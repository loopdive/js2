// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3328 — standalone `+=` on a captured string inside a closure.
 *
 * The boxed-capture compound-assignment arm's string-concat gate (#795)
 * tested `boxed.valType.kind === "externref"` — host-mode strings only.
 * Under nativeStrings a captured string's ref cell holds a
 * `ref/ref_null $AnyString`, so `log += 'y'` inside a capturing
 * toString/valueOf fell to the f64 arithmetic arm whose f64→string
 * writeback emitted a `ref.null` + `ref.as_non_null` placeholder — an
 * always-trapping "dereferencing a null pointer". This killed the entire
 * test262 coercion-order class (`{toString(){ log += 'x'; return v; }}`).
 *
 * Fix: native-strings analog of the #795 arm (`__str_concat` +
 * `compileAndCoerceToAnyStr` + null-guarded cell writeback) in
 * operator-assignment.ts, plus `refCellValueType` as the authoritative
 * fallback for boxed-capture value types in closures.ts (the blind f64
 * default was the same bug class one level deeper).
 */

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envImports = (r.imports ?? []).filter((i) => i.module === "env").map((i) => i.name);
  expect(envImports, "must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports.test as () => unknown)();
}

describe("#3328 — captured-string += inside closures (standalone)", () => {
  it("capturing toString appends to a fn-scoped string (the coercion-order shape)", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  var log = '';
  var year = { toString: function() { log += 'y'; return 5; } };
  var n = +year;
  return n === 5 && log === 'y' ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("capturing valueOf appends; loose-eq and template-literal paths too", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  var log = '';
  var o = { valueOf: function() { log += 'v'; return 5; } };
  if (!((o as any) == 5)) return 10;
  var t = { toString: function() { log += 't'; return "S"; } };
  if (\`\${t}\` !== "S") return 11;
  return log === 'vt' ? 1 : 12;
}`),
    ).toBe(1);
  });

  it("new Date(y, m, d, h, min, s, ms) coercion order logs left-to-right (§20.4.2)", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  var log = '';
  var year = { toString: function() { log += 'year'; return 0; } };
  var month = { toString: function() { log += 'month'; return 0; } };
  var date = { toString: function() { log += 'date'; return 1; } };
  var hours = { toString: function() { log += 'hours'; return 0; } };
  var minutes = { toString: function() { log += 'minutes'; return 0; } };
  var seconds = { toString: function() { log += 'seconds'; return 0; } };
  var ms = { toString: function() { log += 'ms'; return 0; } };
  new Date(year, month, date, hours, minutes, seconds, ms);
  return log === 'yearmonthdatehoursminutessecondsms' ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("appending a NUMBER to a captured string coerces to string", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  var log = '';
  var o = { toString: function() { log += 1; return 0; } };
  var n = +o;
  return n === 0 && log === '1' ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("numeric captured compound (count += 1, #2120) is untouched", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  var count = 0;
  var o = { valueOf: function() { count += 1; return 5; } };
  var n = (+o) + (+o);
  return n === 10 && count === 2 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("nested closures capturing the same string (alreadyBoxed path)", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  var log = '';
  var outer = function() {
    var inner = { toString: function() { log += 'i'; return 3; } };
    return +inner;
  };
  var n = outer();
  return n === 3 && log === 'i' ? 1 : 2;
}`),
    ).toBe(1);
  });
});
