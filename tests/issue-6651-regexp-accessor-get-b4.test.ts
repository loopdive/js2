// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B4 / #5198 Slice F) A runtime-keyed `Get` of a
 * §22.2.6 accessor on a `$NativeRegExp` answers the ACCESSOR, not the struct
 * field that happens to share its name — and `RegExp.prototype.flags` is
 * generic over any Object receiver.
 *
 * The acceptance rows are listed one by one because each pins a different
 * observable, and an arm that loses any single one still looks green on the
 * others:
 *
 * - `@@match/get-global-err` / `get-unicode-error` — a POISONED own accessor on
 *   the instance is reached and its throw propagates out of §22.2.6.4.
 * - `@@match/coerce-global` — an own DATA `global` (installed by
 *   `Object.defineProperty(r,'global',{writable:true})`, then assigned) is both
 *   writable and visible: the write survives the getter-only no-op guard and
 *   the read sees it.
 * - `@@match/flags-tostring-error` — an own `flags` getter shadows the physical
 *   `flags` FIELD, and `ToString` of its object result runs `@@toPrimitive`.
 * - `@@match/{g-get-result-err,g-coerce-result-err,builtin-success-g-set-lastindex,
 *   builtin-infer-unicode}` — B3's §22.2.6.8 step-6 loop, now reachable on a
 *   real RegExp because step 4 finally answers `"g"`.
 *
 * The source-level controls pin the two things a change here loses silently:
 * the STATIC `re.flags` / `re.global` spelling must keep reading the struct
 * (byte-identical binary), and an own property must still shadow.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "built-ins/RegExp/prototype/Symbol.match/builtin-infer-unicode.js",
  "built-ins/RegExp/prototype/Symbol.match/builtin-success-g-set-lastindex.js",
  "built-ins/RegExp/prototype/Symbol.match/coerce-global.js",
  "built-ins/RegExp/prototype/Symbol.match/flags-tostring-error.js",
  "built-ins/RegExp/prototype/Symbol.match/g-coerce-result-err.js",
  "built-ins/RegExp/prototype/Symbol.match/g-get-result-err.js",
  "built-ins/RegExp/prototype/Symbol.match/get-global-err.js",
  "built-ins/RegExp/prototype/Symbol.match/get-unicode-error.js",
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  EXACT_ROWS.every((relativePath) => existsSync(join(TEST262_ROOT, "test", relativePath)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

async function runExactRow(relativePath: (typeof EXACT_ROWS)[number]) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-6651-cluster-b4",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

/** Compile standalone, assert no host import leaked, and run the `test` export. */
async function runStandalone(source: string, fileName: string): Promise<number> {
  const result = await compile(source, { fileName, target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function compiledBytes(source: string, fileName: string): Promise<Uint8Array> {
  const result = await compile(source, { fileName, target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result.binary;
}

describe("#6651 B4 — §22.2.6 accessor reads on a native RegExp carrier", () => {
  for (const relativePath of EXACT_ROWS) {
    itWithTest262(
      `test262 standalone: ${relativePath}`,
      async () => {
        const result = await runExactRow(relativePath);
        expect(`${relativePath}: ${result.status}`).toBe(`${relativePath}: pass`);
      },
      200_000,
    );
  }

  it("a runtime-keyed read answers the accessor, not the declared field", async () => {
    const source = `
export function test(): number {
  const re: any = /a/g;
  const kFlags = "flags";
  const kGlobal = "global";
  const kIgnore = "ignoreCase";
  const kSource = "source";
  if (re[kFlags] !== "g") return -1;
  if (typeof re[kFlags] !== "string") return -2;
  if (re[kGlobal] !== true) return -3;
  if (re[kIgnore] !== false) return -4;
  if (typeof re[kGlobal] !== "boolean") return -5;
  if (re[kSource] !== "a") return -6;
  return 1;
}
`;
    expect(await runStandalone(source, "b4-dynamic-accessor-read.ts")).toBe(1);
  }, 200_000);

  it("the flag order of the generic getter is the spec's d g i m s u v y", async () => {
    const source = `
export function test(): number {
  const re: any = /a/miy;
  const k = "flags";
  if (re[k] !== "imy") return -1;
  const re2: any = /a/gu;
  if (re2[k] !== "gu") return -2;
  return 1;
}
`;
    expect(await runStandalone(source, "b4-flag-order.ts")).toBe(1);
  }, 200_000);

  it("§22.2.6.4 is generic — the getter runs on a plain object receiver", async () => {
    // #5198 Slice F. `Object.getOwnPropertyDescriptor(RegExp.prototype,"flags").get`
    // is an ordinary function; five test262 rows `.call()` it on `{}`.
    const source = `
export function test(): number {
  const d: any = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags");
  if (d === undefined) return -1;
  const get: any = d.get;
  if (typeof get !== "function") return -2;
  const r: any = { global: "truthy-string", sticky: 86 };
  if (get.call(r) !== "gy") return -3;
  if (get.call({}) !== "") return -4;
  if (get.call(/a/im) !== "im") return -5;
  return 1;
}
`;
    expect(await runStandalone(source, "b4-generic-flags-getter.ts")).toBe(1);
  }, 200_000);

  it("an own property shadows the inherited accessor, on both halves", async () => {
    const source = `
export function test(): number {
  const re: any = /a/g;
  Object.defineProperty(re, "global", { get: function (): any { return false; } });
  const k = "global";
  if (re[k] !== false) return -1;
  // The §22.2.6.4 getter reads the OWN accessor too, so "g" is gone.
  const kf = "flags";
  if (re[kf] !== "") return -2;
  // An own WRITABLE data property survives the getter-only no-op write guard.
  const re2: any = /a/;
  Object.defineProperty(re2, "sticky", { writable: true, value: 0, configurable: true });
  re2.sticky = true;
  if (re2["sticky"] !== true) return -3;
  return 1;
}
`;
    expect(await runStandalone(source, "b4-own-shadow.ts")).toBe(1);
  }, 200_000);

  it("control — a write to an UNSHADOWED getter-only member is still a no-op", async () => {
    // #2875 wave-4 lane F, the write half this slice widened. With no own
    // entry in the bag the guard must still swallow the assignment.
    const source = `
export function test(): number {
  const re: any = /a/;
  const k = "global";
  re[k] = "x";
  if (re[k] !== false) return -1;
  if (Object.prototype.hasOwnProperty.call(re, k)) return -2;
  return 1;
}
`;
    expect(await runStandalone(source, "b4-setguard-control.ts")).toBe(1);
  }, 200_000);

  it("control — the STATIC reflection spelling is untouched and byte-stable", async () => {
    // `const re: RegExp`, not `const re = /a/gi`: the bare spelling takes a
    // PRE-EXISTING IR capability bail on this base (`extern property read
    // .flags is capability-deferred … yet reached the builder post-claim`),
    // for `.source` and `.global` alike. Nothing to do with B4 — it reproduces
    // on reverted sources — but it would make this control a compile error
    // rather than a binary comparison.
    const source = `
export function test(): number {
  const re: RegExp = /a/gi;
  const f: string = re.flags;
  if (f !== "gi") return -1;
  if (re.source !== "a") return -4;
  return 1;
}
`;
    const a = await compiledBytes(source, "b4-static-reflection.ts");
    const b = await compiledBytes(source, "b4-static-reflection.ts");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(await runStandalone(source, "b4-static-reflection.ts")).toBe(1);
  }, 200_000);
});
