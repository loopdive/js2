// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice V7 (H7) — destructuring evaluation order + for-of after
// `delete Array.prototype[Symbol.iterator]`, on `--target standalone`.
//
// ## The causes
//
// 1. An object pattern with a key only the runtime can name (`{ [k]: t } = s`,
//    `k` an object with `toString`) was SKIPPED by the struct lowering: no
//    ToPropertyKey, no GetV, no PutValue. It now takes the spec-ordered
//    externref lowering (`emitSpecOrderedObjectAssign`): PropertyName +
//    ToPropertyKey → the target Reference (base, raw key) → GetV → Initializer
//    → PutValue (§13.15.5.6 KeyedDestructuringAssignmentEvaluation).
// 2. `with (o) { var { [k]: x = d } = s; }` never consulted the with object for
//    `x`; it now resolves the binding (HasBinding) after the key and before the
//    GetV (§14.3.3.3 KeyedBindingInitialization) — `with-var-decl.ts`.
// 3. The for-of array fast path never read the #5139 delete flag, so
//    `for (… of [[1, 2, 3]])` iterated where §7.4.3 GetIterator must throw a
//    TypeError (`Array.prototype[@@iterator]` is undefined) — #5154 A(a).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const ROWS = [
  "language/destructuring/binding/keyed-destructuring-property-reference-target-evaluation-order-with-bindings.js",
  "language/expressions/assignment/destructuring/keyed-destructuring-property-reference-target-evaluation-order-with-bindings.js",
  "language/expressions/assignment/destructuring/keyed-destructuring-property-reference-target-evaluation-order.js",
  "language/statements/for-of/dstr/const-ary-init-iter-get-err-array-prototype.js",
  "language/statements/for-of/dstr/let-ary-init-iter-get-err-array-prototype.js",
  "language/statements/for-of/dstr/var-ary-init-iter-get-err-array-prototype.js",
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  ROWS.every((row) => existsSync(join(TEST262_ROOT, "test", row)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

async function runRow(relativePath: string) {
  try {
    return await runTest262File(join(TEST262_ROOT, "test", relativePath), "issue-6651-v7", 180_000, "standalone");
  } finally {
    // The for-of rows delete `Array.prototype[Symbol.iterator]` in this realm.
    restoreHostBuiltins();
  }
}

/** Compile a test262-shaped (untyped) program for standalone and answer `__r`. */
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

describe("#6651 V7 — keyed destructuring order + deleted Array @@iterator (standalone)", () => {
  it("§13.15.5.6 — key, ToPropertyKey, target reference, GetV, then the target key's ToPropertyKey and [[Set]]", async () => {
    // Base: the computed-key element was skipped outright (log `[source, source-key]`, i.e. 12).
    expect(
      await runStandalone(`
var log = [];
function source() { log.push("source"); return { get p() { log.push("get"); } }; }
function target() { log.push("target"); return { set q(v) { log.push("set"); } }; }
function sourceKey() { log.push("source-key"); return { toString: function () { log.push("source-key-tostring"); return "p"; } }; }
function targetKey() { log.push("target-key"); return { toString: function () { log.push("target-key-tostring"); return "q"; } }; }
({ [sourceKey()]: target()[targetKey()] } = source());
var names = ["source", "source-key", "source-key-tostring", "target", "target-key", "get", "target-key-tostring", "set"];
for (var i = 0; i < log.length; i++) __r = __r * 10 + (names.indexOf(log[i]) + 1);
`),
    ).toBe(12345678);
  });

  it("a runtime-keyed element binds the read value and fires its default only on undefined", async () => {
    expect(
      await runStandalone(`
var k1 = { toString: function () { return "a"; } };
var k2 = { toString: function () { return "b"; } };
var x, y;
var src = { a: 3, b: undefined };
({ [k1]: x = 7, [k2]: y = 9 } = src);
if (x === 3) __r |= 1;
if (y === 9) __r |= 2;
`),
    ).toBe(3);
  });

  it("§7.4.3 — for-of over an array after `delete Array.prototype[Symbol.iterator]` throws TypeError", async () => {
    // Base: 5 — the body ran with the deleted method.
    expect(
      await runStandalone(`
delete Array.prototype[Symbol.iterator];
try {
  for (let [x, y, z] of [[1, 2, 3]]) { __r = 5; }
  __r |= 1;
} catch (e) {
  __r |= e instanceof TypeError ? 2 : 4;
}
`),
    ).toBe(2);
  });

  it("control — without a delete, array for-of still iterates", async () => {
    expect(
      await runStandalone(`
var s = 0;
for (var [a, b] of [[1, 2], [3, 4]]) s += a * b;
__r = s;
`),
    ).toBe(14);
  });

  for (const row of ROWS) {
    itWithTest262(
      `test262 standalone: ${row}`,
      async () => {
        const result = await runRow(row);
        expect(`${row}: ${result.status}`).toBe(`${row}: pass`);
      },
      200_000,
    );
  }
});
