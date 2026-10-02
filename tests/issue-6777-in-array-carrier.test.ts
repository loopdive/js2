// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #6777 — `key in arr` on an array carrier.
 *
 * The old arm in `binary-ops-in.ts` chose the carrier struct from the receiver's
 * TypeScript type (an INVALID module once `any[]` was specialised to the f64
 * vec), answered `index < length` (wrong after `delete arr[i]` or an elision),
 * routed its hole case to the host `__extern_has_idx` (no vec arm: every index
 * absent on the js-host lane), and folded every non-constant key to `false`.
 * `in-array-carrier.ts` now owns the whole question.
 *
 * Each source below returns a bitmask (or, js-host only, a JSON string) so one
 * compile checks several answers. Expected values are what node computes for
 * the same source. Every binary is checked with `WebAssembly.validate` first —
 * row 1 used to compile "successfully" into a module the engine rejects.
 *
 * Deliberately NOT asserted (pre-existing, outside the `in` site — see the
 * issue's Resolution): an f64 grow-gap index (`a[4]` after `a[5] = 9` on a
 * length-3 array) in a module with no hole source; standalone holes in a
 * `string[]` literal and `delete` on an array of objects (the store keeps the
 * element, so the read and `Object.keys` are wrong too); standalone non-
 * canonical numeric STRING keys (`"01" in arr`); js-host `Array.prototype[i]`
 * inheritance and named expandos through a constant key.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileChecked(source: string, standalone: boolean) {
  const result = await compile(
    source,
    standalone
      ? ({ fileName: "issue-6777.ts", target: "standalone", hostBridge: "off" } as never)
      : { fileName: "issue-6777.ts" },
  );
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  let invalid = "";
  if (!WebAssembly.validate(result.binary)) {
    try {
      new WebAssembly.Module(result.binary);
    } catch (e) {
      invalid = (e as Error).message;
    }
  }
  expect(invalid, "engine-invalid module").toBe("");
  return result;
}

async function runHost(source: string): Promise<unknown> {
  const result = await compileChecked(source, false);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  return (instance.exports as { run: () => unknown }).run();
}

async function runStandalone(source: string): Promise<unknown> {
  const module = new WebAssembly.Module((await compileChecked(source, true)).binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { run: () => unknown }).run();
}

const LANES = [
  ["js-host", runHost],
  ["standalone", runStandalone],
] as const;

/** Sources that answer identically on both lanes (bitmask results). */
const BOTH_LANES: Array<[string, string, number]> = [
  [
    // Row 1: `any[]` specialised to the f64 vec, then a sparse literal-index
    // write. Was an engine-invalid module on both lanes. Index 4 (the grow gap)
    // is deliberately not asked — see the header.
    "any[] after a sparse write: valid module, indices 2/5/6",
    "export function run(): number { const arr: any[] = [1, 2, 3]; arr[5] = 9; return (2 in arr ? 1 : 0) + (5 in arr ? 2 : 0) + (6 in arr ? 4 : 0); }",
    0b011,
  ],
  [
    "number[] after delete arr[0]: 0 absent, 1 and 2 present, 3 out of range",
    "export function run(): number { const arr: number[] = [1, 2, 3]; delete arr[0]; return (0 in arr ? 1 : 0) + (1 in arr ? 2 : 0) + (2 in arr ? 4 : 0) + (3 in arr ? 8 : 0); }",
    0b0110,
  ],
  [
    "any[] after delete arr[0]",
    "export function run(): number { const arr: any[] = [1, 'x', 3]; delete arr[0]; return (0 in arr ? 1 : 0) + (1 in arr ? 2 : 0) + (2 in arr ? 4 : 0) + (3 in arr ? 8 : 0); }",
    0b0110,
  ],
  [
    "string[] after delete arr[1]",
    "export function run(): number { const arr: string[] = ['a', 'b', 'c']; delete arr[1]; return (0 in arr ? 1 : 0) + (1 in arr ? 2 : 0) + (2 in arr ? 4 : 0) + (3 in arr ? 8 : 0); }",
    0b0101,
  ],
  [
    "elisions in number[] and any[] literals",
    "export function run(): number { const a = [1, , 3]; const b: any[] = [1, , 'x']; return (0 in a ? 1 : 0) + (1 in a ? 2 : 0) + (2 in a ? 4 : 0) + (0 in b ? 8 : 0) + (1 in b ? 16 : 0) + (2 in b ? 32 : 0); }",
    0b101101,
  ],
  [
    "length shrink then grow leaves the dropped indices absent",
    "export function run(): number { const arr: number[] = [1, 2, 3]; arr.length = 1; arr.length = 3; return (0 in arr ? 1 : 0) + (1 in arr ? 2 : 0) + (2 in arr ? 4 : 0); }",
    0b001,
  ],
  [
    "string keys: length / '0' / 'foo' / '3' / 'push'",
    "export function run(): number { const arr: number[] = [1, 2, 3]; return ('length' in arr ? 1 : 0) + ('0' in arr ? 2 : 0) + ('foo' in arr ? 4 : 0) + ('3' in arr ? 8 : 0) + ('push' in arr ? 16 : 0); }",
    0b10011,
  ],
  [
    "string key after delete",
    "export function run(): number { const arr: number[] = [1, 2, 3]; delete arr[0]; return ('0' in arr ? 1 : 0) + ('1' in arr ? 2 : 0); }",
    0b10,
  ],
  [
    "negative, out-of-range, fractional, -0 and 2^32-1 numeric keys",
    "export function run(): number { const arr: number[] = [1, 2, 3]; return (-1 in arr ? 1 : 0) + (3 in arr ? 2 : 0) + (1.5 in arr ? 4 : 0) + (2 in arr ? 8 : 0) + (-0 in arr ? 16 : 0) + (4294967295 in arr ? 32 : 0) + (1e21 in arr ? 64 : 0); }",
    0b11000,
  ],
  [
    "literal-typed keys",
    "export function run(): number { const arr: number[] = [1, 2, 3]; const a = 'push'; const b = 'length'; const c = 1; const d = '2'; const e = 'nope'; const f = 3; return (a in arr ? 1 : 0) + (b in arr ? 2 : 0) + (c in arr ? 4 : 0) + (d in arr ? 8 : 0) + (e in arr ? 16 : 0) + (f in arr ? 32 : 0); }",
    0b001111,
  ],
  [
    "dynamic number key over a deleted index (used to fold to false)",
    "export function run(): number { const arr: number[] = [1, 2, 3]; delete arr[1]; let n = 0; for (let i = 0; i < 4; i++) { if (i in arr) n += 1 << i; } return n; }",
    0b0101,
  ],
  [
    "dynamic non-index number keys",
    "export function run(): number { const arr: number[] = [1, 2, 3]; let n = 0; const ks: number[] = [0, 1.5, -1, NaN, 2, 3, -0]; for (let i = 0; i < ks.length; i++) { if (ks[i] in arr) n += 1 << i; } return n; }",
    0b1010001,
  ],
  [
    "dynamic string keys",
    "export function run(): number { const arr: number[] = [1, 2, 3]; delete arr[0]; let n = 0; const ks: string[] = ['0', '1', 'length', 'x', '5']; for (let i = 0; i < ks.length; i++) { if (ks[i] in arr) n += 1 << i; } return n; }",
    0b00110,
  ],
  [
    "any[] parameter, boolean[] carrier, class-field receiver",
    "class C { arr: number[] = [1, 2]; has(i: number): boolean { return i in this.arr; } } function f(a: any[], i: number): number { return i in a ? 1 : 0; } export function run(): number { const arr: any[] = [1, 2, 3]; delete arr[1]; const bs: boolean[] = [true, false]; const c = new C(); return f(arr, 0) + 2 * f(arr, 1) + 4 * f(arr, 2) + (1 in bs ? 8 : 0) + (2 in bs ? 16 : 0) + (c.has(1) ? 32 : 0) + (c.has(2) ? 64 : 0); }",
    0b0101101,
  ],
  [
    "comma key keeps its side effect; call receiver",
    "function mk(): number[] { const a = [1, 2, 3]; delete a[1]; return a; } export function run(): number { let n = 0; const arr: number[] = [1, 2, 3]; const x = (n = 5, 1) in arr; return n + (x ? 10 : 0) + (1 in mk() ? 100 : 0) + (2 in mk() ? 1000 : 0); }",
    1015,
  ],
  [
    "the result is a real boolean",
    "export function run(): number { const arr: number[] = [1, 2, 3]; delete arr[2]; const r: any = 1 in arr; const s: any = 2 in arr; const t: any = 7 in arr; return (r === true ? 1 : 0) + (s === false ? 2 : 0) + (t === false ? 4 : 0) + (typeof r === 'boolean' ? 8 : 0); }",
    0b1111,
  ],
];

describe("#6777 — `in` on array carriers", () => {
  for (const [lane, run] of LANES) {
    describe(lane, () => {
      for (const [name, source, expected] of BOTH_LANES) {
        it(name, async () => {
          expect(await run(source)).toBe(expected);
        });
      }
    });
  }

  describe("js-host only", () => {
    it("row 1: `[2 in arr]` on a sparse any[] is [true]", async () => {
      expect(
        await runHost(
          "export function run(): string { const arr: any[] = [1, 2, 3]; arr[5] = 9; return JSON.stringify([2 in arr]); }",
        ),
      ).toBe("[true]");
    });

    it("rows 2-4: delete on number[] / any[] and the dense boolean shape", async () => {
      expect(
        await runHost(
          "export function run(): string { const a: number[] = [1, 2, 3]; delete a[0]; const b: any[] = [1, 2, 3]; delete b[0]; const c: number[] = [1, 2, 3]; return JSON.stringify([1 in a, 0 in b, 2 in c, 3 in c]); }",
        ),
      ).toBe("[true,false,true,false]");
    });

    it("delete on an array of objects reaches the host tombstone, not a mirror", async () => {
      expect(
        await runHost(
          "export function run(): number { const arr = [{ a: 1 }, { a: 2 }, { a: 3 }]; delete arr[2]; let n = 0; for (let i = 0; i < 3; i++) if (i in arr) n += 1 << i; return n + (2 in arr ? 8 : 0) + (0 in arr ? 16 : 0); }",
        ),
      ).toBe(0b10011);
    });

    it("§13.10.1 evaluates the key before the receiver", async () => {
      expect(
        await runHost(
          "export function run(): string { let log = ''; const arr: number[] = [1, 2, 3]; function k(): number { log += 'k'; return 1; } function r(): number[] { log += 'r'; return arr; } const x = k() in r(); return log + ':' + String(x); }",
        ),
      ).toBe("kr:true");
    });
  });
});
