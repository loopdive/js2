import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
const sources = [
  "export function sum(n: number): number { let r = 0; for (let i = 0; i < n; i++) r += i; return r; }",
  'export function text(s: string): string { return s.slice(1).concat("!"); }',
  "export function object(n: number): number { const o = { value: n }; const f = (x: number) => o.value + x; return f(3); }",
];
for (const [i, source] of sources.entries())
  it(`default legacy identity ${i}`, async () => {
    const result = await compile(source, { emitWat: true });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.binary?.length).toBeGreaterThan(0);
    expect(result.wat.length).toBeGreaterThan(0);
    const snapshot = { binary: Buffer.from(result.binary!).toString("base64"), wat: result.wat };
    const path = `.tmp/legacy-identity-${i}.json`;
    if (process.env.REALM_CLOSE_BASELINE === "1") writeFileSync(path, JSON.stringify(snapshot));
    else expect(snapshot).toEqual(JSON.parse(readFileSync(path, "utf8")));
    console.log(
      JSON.stringify({
        i,
        bytes: result.binary!.length,
        sha256: createHash("sha256").update(result.binary!).digest("hex"),
      }),
    );
  }, 120000);
