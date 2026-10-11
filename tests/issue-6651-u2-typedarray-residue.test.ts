// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice U2 — ES2015 standalone TypedArray residue. Two kinds of pin:
//
//  - EXACT ROWS: the five test262 rows this slice flips, run through the real
//    runner (`runTest262File`, standalone). None of them needs a runtime eval
//    engine.
//  - INLINE PROGRAMS: the mechanism behind each row in its smallest shape, so a
//    regression names the step that broke:
//      * a script-level `var` nested in a loop that shares a lib.dom global's
//        name (`name`) is read back as that `var`, not as `globalThis.name`;
//      * `%TypedArray%.prototype.join` / `toLocaleString` on a dynamic view read
//        the INTERNAL length, never an own `length` accessor (§23.2.3.18/.32);
//      * `%TypedArray%.from(array)` and `new TA(array)` drain the source BEFORE
//        any element's ToNumber (§23.2.2.1 step 5, §23.2.5.1.1 step 6.a).
//
// Every pin below fails on the pre-U2 tree except the last inline case, a guard
// that answers the same on both trees (recorded in the #6651 plan entry).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "harness/testTypedArray.js",
  "built-ins/TypedArray/prototype/join/get-length-uses-internal-arraylength.js",
  "built-ins/TypedArray/prototype/toLocaleString/get-length-uses-internal-arraylength.js",
  "built-ins/TypedArray/from/iterated-array-changed-by-tonumber.js",
  "built-ins/TypedArrayConstructors/ctors/object-arg/iterated-array-changed-by-tonumber.js",
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  EXACT_ROWS.every((row) => existsSync(join(TEST262_ROOT, "test", row)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

async function runModule(source: string): Promise<number> {
  const r = await compile(source, {
    target: "standalone",
    fileName: "p.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as Parameters<typeof compile>[1]);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(
    r.binary,
    (r as { importObject?: WebAssembly.Imports }).importObject ?? {},
  );
  const ex = instance.exports as { __module_init?: () => void; readResult: () => number };
  ex.__module_init?.();
  return ex.readResult();
}

describe("#6651 U2 — exact test262 rows (standalone)", () => {
  for (const row of EXACT_ROWS) {
    itWithTest262(
      row,
      async () => {
        try {
          const r = await runTest262File(join(TEST262_ROOT, "test", row), "issue-6651-u2", 180_000, "standalone");
          expect(r.status, (r as { error?: string }).error ?? "").toBe("pass");
        } finally {
          restoreHostBuiltins();
        }
      },
      240_000,
    );
  }
});

describe("#6651 U2 — inline mechanisms (standalone)", () => {
  it("join / toLocaleString on a dynamic view ignore an own `length` accessor", async () => {
    const result = await runModule(`
var __r = 0;
var getCalls = 0;
var desc = { get: function getLen() { getCalls++; return 0; } };
function body(TA) {
  var sample = new TA([42, 43]);
  Object.defineProperty(sample, "length", desc);
  if (sample.join() === "42,43") __r |= 1;
  if (sample.toLocaleString() === "42,43") __r |= 2;
}
body(Int8Array);
if (getCalls === 0) __r |= 4;
export function readResult() { return __r; }
`);
    expect(result).toBe(7);
  }, 120_000);

  it("static %TypedArray%.from drains an array source before ToNumber", async () => {
    const result = await runModule(`
var __r = 0;
let values = [0, { valueOf() { values.length = 0; return 100; } }, 2];
let ta = Int32Array.from(values);
if (ta.length === 3) __r |= 1;
if (ta[1] === 100) __r |= 2;
if (ta[2] === 2) __r |= 4;
export function readResult() { return __r; }
`);
    expect(result).toBe(7);
  }, 120_000);

  it("new TA(array) through a dynamic constructor drains the source before ToNumber", async () => {
    const result = await runModule(`
var __r = 0;
function body(TA) {
  var values = [0, { valueOf() { values.length = 0; return 100; } }, 2];
  var ta = new TA(values);
  if (ta.length === 3) __r |= 1;
  if (ta[1] === 100) __r |= 2;
  if (ta[2] === 2) __r |= 4;
}
body(Int8Array);
export function readResult() { return __r; }
`);
    expect(result).toBe(7);
  }, 120_000);

  it("guard: a primitive-element source keeps its values (no snapshot needed)", async () => {
    const result = await runModule(`
var __r = 0;
var ta = Int16Array.from([1, 2, 3]);
if (ta.length === 3 && ta[0] === 1 && ta[2] === 3) __r |= 1;
function body(TA) { var t = new TA([4, 5]); if (t.length === 2 && t[1] === 5) __r |= 2; }
body(Uint8Array);
export function readResult() { return __r; }
`);
    expect(result).toBe(3);
  }, 120_000);
});
