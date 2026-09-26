// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6678) A Date that travels through an untyped object property must keep its
 * `Date.prototype` members under `--target standalone` — moment keeps every
 * instant in `this._d` and validates it with `this._d.getTime()`.
 *
 * (#6681) `Date.now` read as a VALUE must be callable under `--target
 * standalone` — lodash-es `_shortOut` runs `var nativeNow = Date.now;
 * nativeNow()` at module-init. The value answers what the direct `Date.now()`
 * call answers (the #2164 epoch 0, no clock import).
 *
 * Measured on the parent (5245a7716e): 8 of the 12 #6678 rows failed and the
 * #6681 module-init threw; with the fix all rows pass. The CHECKED count guards
 * against a vacuous run (a module that stops early reports 0 failures over
 * fewer rows).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runRows(body: string): Promise<{ failed: number; checked: number; firstFail: number }> {
  const src = `
var failed = 0; var checked = 0; var firstFail = -1;
function CHK(thunk, want) {
  var got;
  try { got = thunk(); } catch (e) { got = "THREW"; }
  if (got !== want) { failed++; if (firstFail < 0) firstFail = checked; }
  checked++;
}
${body}
export function getFailed() { return failed; }
export function getChecked() { return checked; }
export function getFirstFail() { return firstFail; }
`;
  const result = await compile(src, {
    allowJs: true,
    fileName: "issue-6678.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const ex = instance.exports as Record<string, () => number>;
  (ex.__module_init as () => void)();
  return { failed: ex.getFailed!(), checked: ex.getChecked!(), firstFail: ex.getFirstFail!() };
}

describe("#6678 standalone Date members through an untyped property", () => {
  it("answers every Date.prototype member off o._d", async () => {
    const r = await runRows(`
      function box(v) { var o = {}; o._d = v; return o; }
      var b = box(new Date(1577923200000));
      var a = [new Date(1577923200000)][0];
      CHK(function () { return a.getTime(); }, 1577923200000);
      CHK(function () { return b._d.getTime(); }, 1577923200000);
      CHK(function () { return b._d.getFullYear(); }, 2020);
      CHK(function () { return b._d.getUTCMonth(); }, 0);
      CHK(function () { return typeof b._d.getTime; }, "function");
      CHK(function () { return b._d.getTime === Date.prototype.getTime; }, true);
      CHK(function () { return b._d.valueOf(); }, 1577923200000);
      CHK(function () { return isNaN(b._d.getTime()); }, false);
      CHK(function () { return Object.prototype.toString.call(b._d); }, "[object Date]");
      CHK(function () { return b._d instanceof Date; }, true);
      CHK(function () { return +b._d; }, 1577923200000);
      CHK(function () { b._d.setTime(86400000); return b._d.getTime(); }, 86400000);
    `);
    expect(r.checked).toBe(12);
    expect({ failed: r.failed, firstFail: r.firstFail }).toEqual({ failed: 0, firstFail: -1 });
  });
});

describe("#6681 standalone Date.now as a value", () => {
  it("is callable at module-init and agrees with the direct call", async () => {
    const r = await runRows(`
      var nativeNow = Date.now;
      var t = nativeNow();
      CHK(function () { return typeof nativeNow; }, "function");
      CHK(function () { return t; }, Date.now());
      CHK(function () { return nativeNow() - Date.now(); }, 0);
      CHK(function () { return nativeNow.length; }, 0);
      function callIt(f) { return f(); }
      CHK(function () { return callIt(Date.now); }, 0);
      CHK(function () { var o = {}; o.now = Date.now; return typeof o.now(); }, "number");
    `);
    expect(r.checked).toBe(6);
    expect({ failed: r.failed, firstFail: r.firstFail }).toEqual({ failed: 0, firstFail: -1 });
  });
});
