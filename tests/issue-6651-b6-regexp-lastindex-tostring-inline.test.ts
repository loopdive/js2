// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B6) Inline programs for the runtime `lastIndex`
 * carrier (`regexp-lastindex-carrier.ts`). The test262 rows live in
 * `issue-6651-b6-regexp-lastindex-tostring.test.ts` — split so one vitest fork
 * never holds both (B5 hit the 512 MB fork heap with them combined).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile standalone, assert no host import leaked, and run the `test` export. */
async function runStandalone(source: string, fileName: string): Promise<number> {
  const result = await compile(source, { fileName, target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#6651 B6 — inline: the runtime lastIndex carrier", () => {
  it("a runtime-keyed lastIndex read/write agrees with the static spelling", async () => {
    const source = `
export function test(): number {
  const re: RegExp = /./g;
  const d: any = re;
  const k = "lastIndex";
  re.lastIndex = 3;
  if (d[k] !== 3) return -1;
  d[k] = 5;
  if (re.lastIndex !== 5) return -2;
  let calls = 0;
  const o: any = { valueOf: function (): number { calls++; return 2; } };
  d[k] = o;
  if ((re as any).lastIndex !== o) return -3;
  if (d[k] !== o) return -4;
  if (calls !== 0) return -5;
  d[k] = 7;
  if (re.lastIndex !== 7) return -6;
  return 1;
}
`;
    expect(await runStandalone(source, "b6-lastindex-dyn.ts")).toBe(1);
  }, 200_000);

  it("defineProperty records [[Writable]] and validates a redefinition", async () => {
    const source = `
export function test(): number {
  const re: any = /x/;
  Object.defineProperty(re, "lastIndex", { value: 45, writable: false });
  const k = "lastIndex";
  if (re[k] !== 45) return -1;
  // Module code is strict: a write to a non-writable property throws.
  let threw = 0;
  try { re[k] = 3; } catch (e) { threw = 1; }
  if (threw !== 1) return -8;
  if (re[k] !== 45) return -2;
  threw = 0;
  try { Object.defineProperty(re, "lastIndex", { value: 46 }); } catch (e) { threw = 1; }
  if (threw !== 1) return -3;
  threw = 0;
  try { Object.defineProperty(re, "lastIndex", { value: 45 }); } catch (e) { threw = 1; }
  if (threw !== 0) return -4;
  const re2: any = /y/g;
  Object.defineProperty(re2, "lastIndex", { value: 7 });
  if (re2[k] !== 7) return -6;
  re2[k] = 2;
  if (re2[k] !== 2) return -7;
  return 1;
}
`;
    expect(await runStandalone(source, "b6-lastindex-define.ts")).toBe(1);
  }, 200_000);

  it("control — String(symbol) still answers SymbolDescriptiveString", async () => {
    const source = `
export function test(): number {
  const s = Symbol("x");
  if (String(s) !== "Symbol(x)") return -1;
  return 1;
}
`;
    expect(await runStandalone(source, "b6-string-symbol-control.ts")).toBe(1);
  }, 200_000);
});
