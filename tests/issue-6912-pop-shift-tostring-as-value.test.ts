// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6912 (S3-m of #5385) — `Array.prototype.pop` / `shift` / `toString` as
 * callable VALUES on the native regime.
 *
 * Before: every case below threw `Array.prototype.<m> is not yet callable as a
 * value in --target standalone` under both `--target standalone` and the
 * native-first regime. The generic receiver is an array-LIKE: the body reads
 * `length`, moves/deletes indexed properties and writes `length` back through
 * Set(O, P, V, true). `toString` calls the receiver's own `join`, falling back
 * to `Object.prototype.toString` when `join` is not callable.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
export function test(): number {
  const pop: any = Array.prototype.pop;
  const shift: any = Array.prototype.shift;
  const a: any = { 0: "x", 1: "y", 2: "z", length: 3 };
  if (pop.call(a) !== "z") return 10;
  if (a.length !== 2 || a[2] !== undefined || (2 in a)) return 11;
  if (shift.call(a) !== "x") return 12;
  if (a.length !== 1 || a[0] !== "y" || (1 in a)) return 13;
  // Empty receiver: length is (re)written as 0, result undefined.
  const e: any = { length: 0 };
  if (pop.call(e) !== undefined || e.length !== 0) return 20;
  const n: any = {};
  if (shift.call(n) !== undefined || n.length !== 0) return 21;
  // shift preserves holes: a missing source index deletes the destination.
  const h: any = { 0: 1, 2: 3, length: 3 };
  if (shift.call(h) !== 1) return 30;
  if ((0 in h) || h[1] !== 3 || h.length !== 2) return 31;
  // Transferred onto an ordinary object.
  const o: any = { 0: 5, 1: 6, length: 2, pop: Array.prototype.pop, shift: Array.prototype.shift };
  if (o.pop() !== 6 || o.shift() !== 5 || o.length !== 0) return 40;
  // §23.1.3 step 1: null/undefined receiver → TypeError.
  let threw = false;
  try { pop.call(undefined); } catch (err) { threw = err instanceof TypeError; }
  if (!threw) return 50;
  threw = false;
  try { shift.call(null); } catch (err) { threw = err instanceof TypeError; }
  if (!threw) return 51;
  if (pop.length !== 0 || shift.length !== 0) return 60;
  const toStr: any = Array.prototype.toString;
  if (toStr.call({ join() { return "J"; } }) !== "J") return 70;
  if (toStr.call({ 0: 1, 1: 2, length: 2, join: Array.prototype.join }) !== "1,2") return 71;
  if (toStr.call({ join: 1 }) !== "[object Object]") return 72;
  if (toStr.call([1, 2]) !== "1,2") return 73;
  threw = false;
  try { toStr.call(undefined); } catch (err) { threw = err instanceof TypeError; }
  if (!threw) return 74;
  if (toStr.length !== 0) return 75;
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

describe("#6912 — pop / shift / toString as callable values", () => {
  it("--target standalone (no imports)", async () => {
    expect(await run({ target: "standalone" }, false)).toBe(1);
  });
  it("native-first regime", async () => {
    expect(await run({ semanticProviders: "native-first" }, true)).toBe(1);
  });
});
