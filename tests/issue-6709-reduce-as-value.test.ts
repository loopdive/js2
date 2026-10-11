// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6709 (S3-b of #5385) — `Array.prototype.reduce` / `reduceRight` as callable
 * VALUES on the native regime.
 *
 * Before: the reflective form (`Array.prototype.reduce.call(arrayLike, cb)`, or
 * the method transferred onto an ordinary object) threw
 * `Array.prototype.reduce is not yet callable as a value in --target standalone`
 * under both `--target standalone` and the native-first regime (~243 test262
 * rows). The reduce family now takes the packed variadic closure ABI so its body
 * can see the argument COUNT: §23.1.3.24/.25 step 5 test whether
 * `initialValue` is PRESENT, so an explicit `undefined` must seed the
 * accumulator while an omitted one must not.
 *
 * Measured on base (file-copy revert of src/codegen/array-object-proto.ts):
 * every case below throws the refusal TypeError under both lanes.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
export function test(): number {
  const al: any = { 0: 1, 1: 2, 2: 3, length: 3 };
  const add = (a: any, b: any) => a + b;
  const reduce: any = Array.prototype.reduce;
  const reduceRight: any = Array.prototype.reduceRight;
  if (reduce.call(al, add) !== 6) return 10;
  if (reduce.call(al, add, 10) !== 16) return 11;
  if (reduceRight.call(al, (a: any, b: any) => a + "" + b, "x") !== "x321") return 12;
  if (reduceRight.call(al, (a: any, b: any) => a + "" + b) !== "321") return 13;
  // initialValue: undefined is PRESENT — it seeds the accumulator.
  let seen: any = "unset";
  reduce.call({ 0: 5, length: 1 }, (a: any, b: any) => { seen = a; return b; }, undefined);
  if (seen !== undefined) return 14;
  if (reduce.call({ length: 0 }, add, undefined) !== undefined) return 15;
  // Empty array-like, no initialValue → TypeError.
  let threw = false;
  try { reduce.call({ length: 0 }, add); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) return 16;
  threw = false;
  try { reduceRight.call({ length: 0 }, add); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) return 17;
  // §23.1.3 step 1: null/undefined receiver → TypeError.
  threw = false;
  try { reduce.call(undefined, add, 1); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) return 18;
  // Missing callback → IsCallable TypeError.
  threw = false;
  try { reduce.call(al); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) return 19;
  if (reduce.length !== 1 || reduceRight.length !== 1) return 20;
  // Transferred onto an ordinary object.
  const o: any = { 0: 2, 1: 4, length: 2, red: Array.prototype.reduce };
  if (o.red((a: any, b: any) => a * b) !== 8) return 21;
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

describe("#6709 — reduce / reduceRight as callable values", () => {
  it("--target standalone (no imports)", async () => {
    expect(await run({ target: "standalone" }, false)).toBe(1);
  });
  it("native-first regime", async () => {
    expect(await run({ semanticProviders: "native-first" }, true)).toBe(1);
  });
});
