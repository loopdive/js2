// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6668 — a DYNAMIC standalone construct (`new K(…)` where `K` is a runtime
// value) padded every argument the caller did not pass with the formal's zero
// value. For an untyped (`externref`) formal that zero is `ref.null.extern`,
// which the standalone value model reads as JS `null`, not `undefined`:
//
//   * a parameter default never fires (`__extern_is_undefined(null)` is 0), and
//   * a non-defaulted formal observes `null` where JS gives `undefined`.
//
// This was the whole `RangeError: value out of range: 1 <= 0 <= 31` cluster of
// the standalone Temporal lane (308 rows): the polyfill's
// `class PlainYearMonth { constructor(e, t, n = "iso8601", r = 1) … }` built
// through the linked provider as `new Temporal.PlainYearMonth(2000, 5)` got
// `r = null`, `ToIntegerWithTruncation(null)` = 0, and `RejectISODate` threw.
//
// The construct must be DYNAMIC: a direct `new C(1)` is lowered at compile time
// and never reaches the `__class_construct_<Name>` trampoline this pins.
// Base tree: the numeric-default and omitted-formal cases fail; the
// string-default (a ref formal, zero-padded + `ref.is_null` default) and
// explicit-null cases are guards that pass on both trees.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

async function runStandalone(source: string, expr: string): Promise<string> {
  const entry = "/main.js";
  const src = `${source}
let __s = "";
export function prepare() { try { __s = "" + (${expr}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
export function at(i) { return __s.charCodeAt(i); }`;
  const result = await compileMulti({ [entry]: src }, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    hostBridge: "off",
  } as never);
  if (!result.success) return `CE ${result.errors?.[0]?.message?.slice(0, 160)}`;
  const imports = (result.importObject ?? {}) as Record<string, unknown> & {
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary as Uint8Array, imports as never);
  imports.__setInstance?.(instance);
  const exports = instance.exports as Record<string, (...args: number[]) => number> & { __module_init?: () => void };
  exports.__module_init?.();
  const len = exports.prepare!();
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(exports.at!(i));
  return out;
}

const CLASSES = `
class YM { constructor(e, t, n = "iso8601", r = 1) { this.day = r; this.cal = n; } }
class Probe { constructor(a, b) { this.kind = b === undefined ? "undefined" : b === null ? "null" : "other"; this.t = typeof b; } }
function mk1(K, a) { return new K(a); }
function mk2(K, a, b) { return new K(a, b); }
`;

describe("#6668 standalone dynamic construct pads a missing externref argument with undefined", () => {
  it("runs a numeric default for an omitted trailing argument", async () => {
    expect(await runStandalone(CLASSES, "mk2(YM, 2000, 5).day")).toBe("1");
  });

  it("runs a string default for an omitted trailing argument", async () => {
    expect(await runStandalone(CLASSES, "mk2(YM, 2000, 5).cal")).toBe("iso8601");
  });

  it("a non-defaulted omitted formal reads as undefined, not null", async () => {
    expect(await runStandalone(CLASSES, "mk1(Probe, 1).kind + '/' + mk1(Probe, 1).t")).toBe("undefined/undefined");
  });

  it("an explicit null argument is still null", async () => {
    expect(await runStandalone(CLASSES, "mk2(Probe, 1, null).kind")).toBe("null");
  });
});
