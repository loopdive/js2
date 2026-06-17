// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2160 (slice) — `Number.parseInt` / `Number.parseFloat` (§21.1.2.12-13) are
// the same functions as the global `parseInt` / `parseFloat`. The bare-identifier
// forms worked standalone (the import-collector in src/codegen/declarations.ts
// registered a native WasmGC scanner under `parseInt`/`parseFloat`), but the
// `Number.`-namespaced property-access form was never detected by the collector,
// so the native scanner was never registered and standalone compilation failed
// with a `__get_builtin` codegen error.
//
// Fix: detect the `Number.parseInt` / `Number.parseFloat` call shape in the
// collector and add the same parse helper to `parseNeeded`. The call-site
// routing (calls.ts) already reads `ctx.funcMap.get("parseInt"/"parseFloat")`,
// so once the native scanner is registered the namespaced form lowers like the
// bare form. Verified in both host and standalone modes.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Mode = { label: string; opts: Record<string, unknown> };
const MODES: Mode[] = [
  { label: "host", opts: {} },
  { label: "standalone", opts: { target: "standalone" } },
];

async function runBool(src: string, opts: Record<string, unknown>): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", ...opts });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2160 — Number.parseInt / Number.parseFloat (namespaced aliases)", () => {
  for (const { label, opts } of MODES) {
    describe(`[${label}]`, () => {
      it("Number.parseFloat parses a decimal", async () => {
        expect(
          await runBool(`export function test(): boolean { return Number.parseFloat("1.5") === 1.5; }`, opts),
        ).toBe(1);
      });

      it("Number.parseInt with explicit radix", async () => {
        expect(
          await runBool(`export function test(): boolean { return Number.parseInt("42", 10) === 42; }`, opts),
        ).toBe(1);
      });

      it("Number.parseInt without radix (decimal default)", async () => {
        expect(await runBool(`export function test(): boolean { return Number.parseInt("42") === 42; }`, opts)).toBe(1);
      });

      it("Number.parseInt with hex radix", async () => {
        expect(
          await runBool(`export function test(): boolean { return Number.parseInt("ff", 16) === 255; }`, opts),
        ).toBe(1);
      });

      it("Number.parseInt stops at first non-digit", async () => {
        expect(
          await runBool(`export function test(): boolean { return Number.parseInt("42px", 10) === 42; }`, opts),
        ).toBe(1);
      });

      it("Number.parseFloat of a non-number is NaN", async () => {
        expect(
          await runBool(
            `export function test(): boolean { const r = Number.parseFloat("abc"); return r !== r; }`,
            opts,
          ),
        ).toBe(1);
      });

      it("namespaced and bare forms agree", async () => {
        expect(
          await runBool(
            `export function test(): boolean { return Number.parseInt("10", 10) === parseInt("10", 10); }`,
            opts,
          ),
        ).toBe(1);
      });

      it("bare parseInt / parseFloat still work (regression guard)", async () => {
        expect(
          await runBool(
            `export function test(): boolean { return parseInt("7", 10) === 7 && parseFloat("2.5") === 2.5; }`,
            opts,
          ),
        ).toBe(1);
      });
    });
  }
});
