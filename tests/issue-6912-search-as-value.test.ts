// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6912 (S3-m of #5385) — `Array.prototype.{indexOf,lastIndexOf,includes}` as
 * callable VALUES on the native regime.
 *
 * Before: every case below threw `Array.prototype.<m> is not yet callable as a
 * value in --target standalone` under both `--target standalone` and the
 * native-first regime. `lastIndexOf` is the presence-sensitive one: an explicit
 * `undefined` fromIndex is PRESENT (ToIntegerOrInfinity → 0, so only index 0 is
 * searched), an omitted one defaults to len - 1.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
export function test(): number {
  const al: any = { 0: 1, 1: 2, 2: 1, 4: 7, length: 5 };
  const indexOf: any = Array.prototype.indexOf;
  const lastIndexOf: any = Array.prototype.lastIndexOf;
  const includes: any = Array.prototype.includes;
  if (indexOf.call(al, 1) !== 0) return 10;
  if (indexOf.call(al, 1, 1) !== 2) return 11;
  if (indexOf.call(al, 1, undefined) !== 0) return 12;
  if (indexOf.call(al, 7, -1) !== 4) return 13;
  if (indexOf.call(al, 9) !== -1) return 14;
  if (indexOf.call(al, undefined) !== -1) return 15; // index 3 is a hole: skipped
  if (lastIndexOf.call(al, 1) !== 2) return 20;
  if (lastIndexOf.call(al, 1, 1) !== 0) return 21;
  // An explicit undefined fromIndex is PRESENT: n = 0, only index 0 searched.
  if (lastIndexOf.call(al, 1, undefined) !== 0) return 22;
  if (lastIndexOf.call(al, 2, undefined) !== -1) return 23;
  if (lastIndexOf.call(al, 7, -1) !== 4) return 24;
  if (lastIndexOf.call(al, 1, -10) !== -1) return 25;
  if (includes.call(al, 7) !== true) return 30;
  if (includes.call(al, 7, 5) !== false) return 31;
  if (includes.call(al, undefined) !== true) return 32; // includes visits holes
  if (includes.call({ 0: NaN, length: 1 }, NaN) !== true) return 33;
  if (indexOf.call({ 0: NaN, length: 1 }, NaN) !== -1) return 34;
  // fromIndex goes through ToNumber (observable valueOf).
  const from: any = { valueOf() { return 3; } };
  if (indexOf.call(al, 1, from) !== -1) return 40;
  // len = 0 returns before fromIndex is converted.
  let touched = false;
  const spy: any = { valueOf() { touched = true; return 0; } };
  if (indexOf.call({ length: 0 }, 1, spy) !== -1 || touched) return 41;
  if (lastIndexOf.call({ length: 0 }, 1, spy) !== -1 || touched) return 42;
  // §23.1.3 step 1: null/undefined receiver → TypeError.
  let threw = false;
  try { indexOf.call(undefined, 1); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) return 50;
  threw = false;
  try { lastIndexOf.call(null, 1); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) return 51;
  if (indexOf.length !== 1 || lastIndexOf.length !== 1 || includes.length !== 1) return 60;
  // Transferred onto an ordinary object.
  const o: any = { 0: "a", 1: "b", length: 2, find: Array.prototype.lastIndexOf };
  if (o.find("b") !== 1) return 70;
  return 1;
}`;

async function run(options: Record<string, unknown>, hostImports: boolean): Promise<unknown> {
  const result = await compile(SOURCE, { fileName: "test.ts", ...options } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.wat ?? "").not.toContain("is not yet callable as a value");
  const imports = hostImports ? buildImports(result.imports, undefined, result.stringPool) : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6912 — indexOf / lastIndexOf / includes as callable values", () => {
  it("--target standalone (no imports)", async () => {
    expect(await run({ target: "standalone" }, false)).toBe(1);
  });
  it("native-first regime", async () => {
    expect(await run({ semanticProviders: "native-first" }, true)).toBe(1);
  });
});
