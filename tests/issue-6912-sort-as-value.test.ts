// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6912 (S3-m of #5385) — `Array.prototype.sort` / `toSorted` as callable
 * VALUES on the native regime.
 *
 * Before: every case below threw `Array.prototype.<m> is not yet callable as a
 * value in --target standalone` under both `--target standalone` and the
 * native-first regime. The receiver is an array-like; `sort` skips and then
 * deletes holes, `toSorted` reads through them; undefined sorts last without
 * reaching the comparator; a non-callable comparator is a TypeError before the
 * receiver is touched.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
function str(a: any): string {
  let s = "";
  for (let i = 0; i < a.length; i++) s += (i ? "," : "") + a[i];
  return s;
}
export function test(): number {
  const sort: any = Array.prototype.sort;
  const toSorted: any = Array.prototype.toSorted;
  const al: any = { 0: 10, 1: 9, 2: 1, length: 3 };
  if (sort.call(al) !== al || str(al) !== "1,10,9") return 10; // default: by ToString
  sort.call(al, (a: any, b: any) => a - b);
  if (str(al) !== "1,9,10") return 11;
  const h: any = { 0: "b", 2: "a", 3: undefined, length: 5 };
  sort.call(h);
  if (h[0] !== "a" || h[1] !== "b" || h[2] !== undefined || !(2 in h) || (3 in h) || (4 in h)) return 12;
  const src: any = { 0: 3, 1: 1, 3: 2, length: 4 };
  const out: any = toSorted.call(src);
  if (!Array.isArray(out) || str(out) !== "1,2,3,undefined") return 20;
  if (src[0] !== 3) return 21; // by copy
  if (str(toSorted.call(src, undefined)) !== "1,2,3,undefined") return 22;
  let calls = 0;
  sort.call({ 0: undefined, 1: 2, 2: 1, length: 3 }, (a: any, b: any) => { calls++; if (a === undefined || b === undefined) calls += 100; return a - b; });
  if (calls >= 100) return 30;
  // Stable.
  const st: any = { 0: { k: 1, t: "a" }, 1: { k: 0, t: "b" }, 2: { k: 1, t: "c" }, length: 3 };
  sort.call(st, (a: any, b: any) => a.k - b.k);
  if (st[0].t + st[1].t + st[2].t !== "bac") return 31;
  let threw = false;
  try { sort.call(al, 5); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) return 40;
  threw = false;
  try { toSorted.call(undefined); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) return 41;
  // null is not undefined: a TypeError comparator, and an element that sorts as "null".
  threw = false;
  try { sort.call({ get length(): number { throw new RangeError("ToObject first?"); } }, null); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) return 42;
  const nl: any = { 0: "o", 1: null, 2: "a", length: 3 };
  sort.call(nl);
  if (str(nl) !== "a,null,o") return 43;
  if (sort.length !== 1 || toSorted.length !== 1) return 50;
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

describe("#6912 — sort / toSorted as callable values", () => {
  it("--target standalone (no imports)", async () => {
    expect(await run({ target: "standalone" }, false)).toBe(1);
  });
  it("native-first regime", async () => {
    expect(await run({ semanticProviders: "native-first" }, true)).toBe(1);
  });
});
