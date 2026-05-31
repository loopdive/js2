import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

/**
 * #1598 — Pure-Wasm String.fromCharCode / String.fromCodePoint in standalone mode.
 *
 * In `--target standalone` (and `--target wasi`), nativeStrings is forced on and
 * there is no JS host, so `env.String_fromCharCode` / `env.String_fromCodePoint`
 * host imports must NOT be emitted. Codegen instead routes through the pure-Wasm
 * `__str_fromCharCode` / `__str_fromCodePoint` helpers.
 *
 * Runtime behaviour is exercised via fast mode (which also enables nativeStrings
 * and the same helper path) returning numeric observables (charCodeAt / length).
 */

async function runFast(source: string, exportName = "test"): Promise<any> {
  const result = await compile(source, { fast: true });
  if (!result.success) {
    throw new Error(result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n"));
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports[exportName] as Function)();
}

describe("#1598 String.fromCharCode / fromCodePoint standalone (no JS host)", () => {
  // ── No host imports in standalone mode ───────────────────────────
  it("fromCharCode emits no env.String_fromCharCode in standalone mode", async () => {
    const r = await compile(`export function test(): string { return String.fromCharCode(65); }`, {
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.wat).not.toContain("String_fromCharCode");
    expect(r.wat).not.toContain("wasm:js-string");
  });

  it("fromCodePoint emits no env.String_fromCodePoint in standalone mode", async () => {
    const r = await compile(`export function test(): string { return String.fromCodePoint(0x1f600); }`, {
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.wat).not.toContain("String_fromCodePoint");
    expect(r.wat).not.toContain("wasm:js-string");
  });

  it("fromCharCode emits no host imports at all in standalone mode", async () => {
    const r = await compile(`export function test(): string { return String.fromCharCode(72, 105); }`, {
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const mod = new WebAssembly.Module(r.binary);
    const imps = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
    expect(imps).toEqual([]);
  });

  // ── Runtime correctness (fast mode == nativeStrings helper path) ──
  it("fromCharCode(65) === 'A' (charCodeAt)", async () => {
    expect(await runFast(`export function test(): number { return String.fromCharCode(65).charCodeAt(0); }`)).toBe(65);
  });

  it("fromCharCode(65) has length 1", async () => {
    expect(await runFast(`export function test(): number { return String.fromCharCode(65).length; }`)).toBe(1);
  });

  it("fromCharCode multi-arg concatenates", async () => {
    expect(await runFast(`export function test(): number { return String.fromCharCode(72, 105).length; }`)).toBe(2);
    expect(await runFast(`export function test(): number { return String.fromCharCode(72, 105).charCodeAt(1); }`)).toBe(
      105,
    );
  });

  it("fromCharCode applies ToUint16 (truncates high bits)", async () => {
    // 0x10041 & 0xFFFF === 0x41 === 'A'
    expect(await runFast(`export function test(): number { return String.fromCharCode(0x10041).charCodeAt(0); }`)).toBe(
      65,
    );
  });

  it("fromCodePoint BMP === fromCharCode", async () => {
    expect(await runFast(`export function test(): number { return String.fromCodePoint(0x41).charCodeAt(0); }`)).toBe(
      65,
    );
  });

  it("fromCodePoint supplementary emits surrogate pair", async () => {
    // U+1F600 -> high D83D, low DE00, length 2
    expect(await runFast(`export function test(): number { return String.fromCodePoint(0x1f600).length; }`)).toBe(2);
    expect(
      await runFast(`export function test(): number { return String.fromCodePoint(0x1f600).charCodeAt(0); }`),
    ).toBe(0xd83d);
    expect(
      await runFast(`export function test(): number { return String.fromCodePoint(0x1f600).charCodeAt(1); }`),
    ).toBe(0xde00);
  });
});
