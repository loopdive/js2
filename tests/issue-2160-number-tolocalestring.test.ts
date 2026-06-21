// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2160 (slice) — `Number.prototype.toLocaleString()` (§21.1.3.4) on a number
// receiver CE'd in standalone / WASI with `'__extern_toLocaleString'
// (dynamic-shape object)`: the generic `toLocaleString` fallback in calls.ts
// routes the receiver to the host `__extern_toLocaleString` import, but a bare
// number is not an extern object so the standalone codegen refuses it.
//
// Fix: in no-JS-host targets (standalone / WASI, where there is no Intl), a
// number receiver's `toLocaleString` delegates to the base-10
// `Number.prototype.toString` (`number_toString`). Per spec the no-Intl default
// is implementation-defined; the decimal form is conformant and matches the
// existing `toLocaleString → toString` delegation. Locale / options arguments
// are ignored. JS-host mode is untouched — it keeps the real Intl-backed
// `__extern_toLocaleString` (locale grouping like "1,234").
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Mode = { label: string; opts: Record<string, unknown> };
const MODES: Mode[] = [
  { label: "host", opts: {} },
  { label: "standalone", opts: { target: "standalone" } },
];

async function run(src: string, opts: Record<string, unknown>): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", ...opts });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2160 — Number.prototype.toLocaleString", () => {
  for (const { label, opts } of MODES) {
    describe(`[${label}]`, () => {
      it("integer toLocaleString length (decimal form)", async () => {
        // "1234".length === 4 in standalone; host Intl ("1,234") has length 5.
        // Assert via a comparison the receiver supports in both modes: the first
        // char is '1' and the last char is '4' regardless of grouping.
        expect(
          await run(
            `export function test(): boolean {
               const s = (1234).toLocaleString();
               return s.charCodeAt(0) === 49 && s.charCodeAt(s.length - 1) === 52;
             }`,
            opts,
          ),
        ).toBe(1);
      });

      it("single-digit toLocaleString === '5'", async () => {
        expect(
          await run(`export function test(): boolean { const s = (5).toLocaleString(); return s === "5"; }`, opts),
        ).toBe(1);
      });

      it("fractional toLocaleString === '3.5'", async () => {
        expect(
          await run(`export function test(): boolean { const n = 3.5; return n.toLocaleString() === "3.5"; }`, opts),
        ).toBe(1);
      });

      it("negative toLocaleString === '-7'", async () => {
        expect(await run(`export function test(): boolean { return (-7).toLocaleString() === "-7"; }`, opts)).toBe(1);
      });

      it("toLocaleString result is concatenable as a string", async () => {
        expect(
          await run(
            `export function test(): boolean { return ("n=" + (42).toLocaleString()).charCodeAt(0) === 110; }`,
            opts,
          ),
        ).toBe(1);
      });
    });
  }

  it("standalone emits no __extern_toLocaleString host import for a number receiver", async () => {
    const result = await compile(`export function test(): number { return (1234).toLocaleString().length; }`, {
      fileName: "test.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const leaked = (result.imports ?? []).some((i) => i.name === "__extern_toLocaleString");
    expect(leaked).toBe(false);
  });
});
