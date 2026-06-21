// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2160 (slice) — `String.raw` produced an INVALID standalone / WASI binary.
//
// `compileTaggedTemplateExpression` (src/codegen/string-ops.ts) built the
// `externref`-element template-strings vec (via `array.new_fixed`) BEFORE it
// dispatched the `String.raw` builtin short-circuit. In native-strings mode
// (standalone / WASI) string literals lower to `ref $AnyString`, not externref,
// so that (unused-for-String.raw) vec failed validation:
//   `array.new_fixed expected type externref, found struct.new of type (ref 6)`.
// Even the substitution path then mis-fed an f64 into `any.convert_extern`.
//
// Fix: (1) dispatch `isStringRawTag` at the TOP of the function, before any
// template-vec scaffolding is emitted; (2) give `compileStringRaw` a
// native-strings branch that coerces every operand to `ref $AnyString` via the
// existing `compileNativeConcatOperand` helper and concatenates with the native
// `__str_concat`. JS-host mode is unchanged (wasm:js-string concat).
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
  expect(WebAssembly.validate(result.binary), "binary should validate").toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2160 — String.raw in standalone / WASI", () => {
  for (const { label, opts } of MODES) {
    describe(`[${label}]`, () => {
      it("no-substitution String.raw === 'abc'", async () => {
        expect(await run('export function test(): boolean { return String.raw`abc` === "abc"; }', opts)).toBe(1);
      });

      it("single substitution String.raw`a${1}b` === 'a1b'", async () => {
        expect(await run('export function test(): boolean { return String.raw`a${1}b` === "a1b"; }', opts)).toBe(1);
      });

      it("multiple substitutions String.raw`x${1}y${2}z` === 'x1y2z'", async () => {
        expect(await run('export function test(): boolean { return String.raw`x${1}y${2}z` === "x1y2z"; }', opts)).toBe(
          1,
        );
      });

      it("raw escape is uncooked: String.raw`a\\nb`.length === 4", async () => {
        expect(await run("export function test(): number { return String.raw`a\\nb`.length; }", opts)).toBe(4);
      });

      it("boolean substitution String.raw`v=${true}` === 'v=true'", async () => {
        expect(await run('export function test(): boolean { return String.raw`v=${true}` === "v=true"; }', opts)).toBe(
          1,
        );
      });

      it("string substitution String.raw`<${\"x\"}>` === '<x>'", async () => {
        expect(
          await run('export function test(): boolean { const m = "x"; return String.raw`<${m}>` === "<x>"; }', opts),
        ).toBe(1);
      });
    });
  }

  it("standalone String.raw with substitution validates (regression guard)", async () => {
    const result = await compile("export function test(): number { return String.raw`a${1}b${2}c`.length; }", {
      fileName: "test.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });
});
