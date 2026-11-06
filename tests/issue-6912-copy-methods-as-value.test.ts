// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6912 (S3-m of #5385) — `Array.prototype.{toReversed,with,toSpliced,copyWithin}`
 * as callable VALUES on the native regime.
 *
 * Before: every case below threw `Array.prototype.<m> is not yet callable as a
 * value in --target standalone` under both `--target standalone` and the
 * native-first regime. `toSpliced` is the presence-sensitive one: no start →
 * nothing skipped; start only → skip to the end; an explicit `undefined`
 * skipCount is PRESENT (ToIntegerOrInfinity → 0).
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
  const toReversed: any = Array.prototype.toReversed;
  const withM: any = Array.prototype.with;
  const toSpliced: any = Array.prototype.toSpliced;
  const copyWithin: any = Array.prototype.copyWithin;
  const al: any = { 0: "a", 1: "b", 2: "c", length: 3 };
  if (str(toReversed.call(al)) !== "c,b,a") return 10;
  if (al[0] !== "a") return 11; // by copy: receiver untouched
  if (!Array.isArray(toReversed.call({ length: 0 }))) return 12;
  if (str(withM.call(al, 1, "X")) !== "a,X,c") return 20;
  if (str(withM.call(al, -1, "Z")) !== "a,b,Z") return 21;
  let threw = false;
  try { withM.call(al, 3, "Q"); } catch (e) { threw = e instanceof RangeError; }
  if (!threw) return 22;
  const two: any = { valueOf() { return 2; } };
  if (str(withM.call(al, two, "V")) !== "a,b,V") return 23;
  if (str(toSpliced.call(al)) !== "a,b,c") return 30;
  if (str(toSpliced.call(al, 1)) !== "a") return 31;
  if (str(toSpliced.call(al, 1, undefined)) !== "a,b,c") return 32;
  if (str(toSpliced.call(al, 1, 1, "x", "y")) !== "a,x,y,c") return 33;
  if (str(toSpliced.call(al, -1, 5)) !== "a,b") return 34;
  if (str(toSpliced.call(al, undefined, 1)) !== "b,c") return 35;
  const o: any = { 0: 1, 1: 2, 2: 3, 3: 4, length: 4 };
  if (copyWithin.call(o, 0, 2) !== o || str(o) !== "3,4,3,4") return 40;
  threw = false;
  try { toReversed.call(undefined); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) return 50;
  if (toReversed.length !== 0 || withM.length !== 2 || toSpliced.length !== 2 || copyWithin.length !== 2) return 60;
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

describe("#6912 — toReversed / with / toSpliced / copyWithin as callable values", () => {
  it("--target standalone (no imports)", async () => {
    expect(await run({ target: "standalone" }, false)).toBe(1);
  });
  it("native-first regime", async () => {
    expect(await run({ semanticProviders: "native-first" }, true)).toBe(1);
  });
});
