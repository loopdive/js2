// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice V10b (H10 singles, second group) on `--target standalone`.
//
// ## The causes
//
// 1. `arguments` had no own `@@iterator` (§10.4.4.6 step 7 / §10.4.4.7 step 20).
//    It is now seeded as a data property `{value: %Array.prototype.values%,
//    writable, !enumerable, configurable}` next to `callee`, gated on the same
//    observability proof. Three things stood between that seed and the row:
//    `[][Symbol.iterator]` read `undefined` (the vec arm of `__extern_get`
//    needs the seeded Array companion, which nothing demanded), a direct
//    `arguments[Symbol.iterator]` read ELEMENT 1 (the well-known id is an i32),
//    and `delete vec[sym]` trapped (`illegal cast` — the delete arm cast every
//    key to a string to parse an index).
// 2. A `$__dv_window` DataView carrier had no own-property storage, so
//    `Object.defineProperty(dv, 'baz', {})` landed nowhere. It now takes the
//    identity bag the instance-expando substrate already uses.
// 3. A script `var length = {valueOf…}` merged with lib.dom's
//    `declare var length: number`, so the binding became an f64 global (one
//    `valueOf` at the declaration) and a descriptor literal reading it got an
//    f64 field (another ToNumber at construction). §10.4.2.4 ArraySetLength's
//    two coercions then saw a number, not the object.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const ROWS = [
  "built-ins/Array/length/define-own-prop-length-coercion-order.js",
  "built-ins/DataView/instance-extensibility.js",
  "language/arguments-object/unmapped/Symbol.iterator.js",
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  ROWS.every((row) => existsSync(join(TEST262_ROOT, "test", row)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

/** Compile an untyped program for standalone and answer `__r`. */
async function runStandalone(body: string): Promise<number> {
  const source = `var __r = 0;\n${body}\nexport function run() { return __r; }\n`;
  const r = await compile(source, {
    target: "standalone",
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, () => number>;
  ex.__module_init?.();
  return ex.run!();
}

describe("#6651 V10b — ArraySetLength order, DataView expandos, arguments @@iterator (standalone)", () => {
  it("§10.4.4.6 — an escaped arguments object owns @@iterator = %Array.prototype.values%", async () => {
    // Base: no own property at all (-1).
    expect(
      await runStandalone(`
var probe = function () {
  'use strict';
  var d = Object.getOwnPropertyDescriptor(arguments, Symbol.iterator);
  if (d === undefined) return -1;
  var r = 0;
  if (d.value === [][Symbol.iterator]) r += 1;
  if (d.writable) r += 10;
  if (!d.enumerable) r += 100;
  if (d.configurable) r += 1000;
  if (arguments[Symbol.iterator] === d.value) r += 10000;
  return r;
};
__r = probe(1, 2);
`),
    ).toBe(11111);
  });

  it("`[][Symbol.iterator]` is %Array.prototype.values%, not undefined", async () => {
    expect(
      await runStandalone(`
var probe = function () {
  var y = [][Symbol.iterator];
  return (y === Array.prototype.values ? 1 : 0) + (y === undefined ? 10 : 0);
};
__r = probe();
`),
    ).toBe(1);
  });

  it("`delete vec[symbol]` answers true and removes the key instead of trapping", async () => {
    expect(
      await runStandalone(`
function del(o, k) { return delete o[k]; }
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
var s = Symbol("x");
var a = [1, 2];
Object.defineProperty(a, s, { value: 1, writable: true, configurable: true });
__r = (has(a, s) ? 1 : 0) + (del(a, s) ? 10 : 0) + (has(a, s) ? 0 : 100);
`),
    ).toBe(111);
  });

  it("§25.3 — a DataView instance stores, reports and deletes its own expandos", async () => {
    // Base: 1 (only the isExtensible answer).
    expect(
      await runStandalone(`
function del(o, k) { return delete o[k]; }
var sample = new DataView(new ArrayBuffer(8), 0);
if (Object.isExtensible(sample)) __r += 1;
Object.defineProperty(sample, 'baz', {});
if (sample.hasOwnProperty('baz')) __r += 10;
Object.defineProperty(sample, 'foo', { value: 'bar', writable: true, configurable: true, enumerable: false });
var d = Object.getOwnPropertyDescriptor(sample, 'foo');
if (d && d.value === 'bar' && !d.enumerable && d.writable && d.configurable) __r += 100;
if (del(sample, 'foo') && !sample.hasOwnProperty('foo')) __r += 1000;
`),
    ).toBe(1111);
  });

  for (const row of ROWS) {
    itWithTest262(
      `test262 ${row}`,
      async () => {
        const result = await runTest262File(join(TEST262_ROOT, "test", row), "issue-6651-v10b", 180_000, "standalone");
        expect(result.status, result.error).toBe("pass");
      },
      200_000,
    );
  }
});
