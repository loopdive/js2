// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2160 (slice) — `String.raw` WITH a substitution emitted an INVALID standalone
// binary. The no-substitution case was fixed upstream by the generic
// tagged-template `pushStringElem` externref-array bridge, but
// `compileStringRaw`'s substitution-concat path (src/codegen/string-ops.ts) still
// mixed representations in native-strings mode: a numeric substitution
// (`String.raw`a${1}b``) drove an f64 straight into `any.convert_extern`
// ("expected externref, found f64.const") → invalid module under
// `--target standalone`.
//
// Fix: in `noJsHost` / native-strings mode, `compileStringRaw` coerces every
// operand to `ref $AnyString` via the existing `compileNativeConcatOperand`
// helper (number_toString + ref-from-extern, bool→literal, string passthrough,
// any→ToString) and concatenates with the native `__str_concat`. JS-host mode
// keeps the wasm:js-string concat path unchanged.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Mode = { label: string; opts: Record<string, unknown> };
const MODES: Mode[] = [
  { label: "host", opts: {} },
  { label: "standalone", opts: { target: "standalone" } },
];

async function run(src: string, opts: Record<string, unknown>): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, ...opts });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "binary should validate").toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2160 — String.raw with substitution (standalone)", () => {
  for (const { label, opts } of MODES) {
    describe(`[${label}]`, () => {
      it("no-substitution String.raw === 'abc'", async () => {
        expect(await run('export function test(): boolean { return String.raw`abc` === "abc"; }', opts)).toBe(1);
      });

      it("single numeric substitution String.raw`a${1}b` === 'a1b'", async () => {
        expect(await run('export function test(): boolean { return String.raw`a${1}b` === "a1b"; }', opts)).toBe(1);
      });

      it("multiple numeric substitutions String.raw`x${1}y${2}z` === 'x1y2z'", async () => {
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

      it("string substitution String.raw`<${m}>` === '<x>'", async () => {
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
