import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2160 — Number.prototype.toLocaleString() (no arguments) for standalone / WASI.
//
// In JS-host (gc) mode the call routes to the `__extern_toLocaleString` host
// import, which delegates to Node's Intl-backed formatter (locale grouping,
// e.g. `(1234).toLocaleString() === "1,234"`). Standalone / WASI have no host,
// so that import has no native fallback and the call hit the dynamic-shape
// `__get_builtin`-style refusal (`'__extern_toLocaleString' (dynamic-shape …)`),
// a hard compile_error.
//
// §21.1.3.4: with no ECMA-402 (Intl) implementation, the result equals
// `ToString(value)` base 10. The fix routes the 0-arg call to the native
// `number_toString` helper in standalone/WASI only — host mode is untouched so
// its real-Intl grouping is preserved.

async function compileStandalone(src: string) {
  return compile(src, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
}

async function runStandalone(src: string): Promise<number> {
  const r = await compileStandalone(src);
  if (!r.success) throw new Error("compile failed: " + (r.errors[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#2160 Number.prototype.toLocaleString() standalone", () => {
  it("compiles in standalone (no __extern_toLocaleString refusal)", async () => {
    const r = await compileStandalone(`export function test(): number { return (1234).toLocaleString().length; }`);
    expect(r.success).toBe(true);
  });

  it("does not leak the __extern_toLocaleString host import", async () => {
    const r = await compileStandalone(`export function test(): number { return (1234).toLocaleString().length; }`);
    expect(r.success).toBe(true);
    const names = r.imports.map((i) => i.name);
    expect(names).not.toContain("__extern_toLocaleString");
  });

  it("integer formats as base-10 ToString (no locale grouping standalone)", async () => {
    // "1234".charCodeAt(0..3) === 49,50,51,52 and length 4
    const ret = await runStandalone(`
      export function test(): number {
        const s = (1234).toLocaleString();
        if (s.length !== 4) return -1;
        return (s.charCodeAt(0) === 49 && s.charCodeAt(1) === 50 &&
                s.charCodeAt(2) === 51 && s.charCodeAt(3) === 52) ? 1 : 0;
      }`);
    expect(ret).toBe(1);
  });

  it('negative integer → "-5"', async () => {
    const ret = await runStandalone(`
      export function test(): number {
        const s = (-5).toLocaleString();
        return (s.length === 2 && s.charCodeAt(0) === 45 && s.charCodeAt(1) === 53) ? 1 : 0;
      }`);
    expect(ret).toBe(1);
  });

  it('fractional → "3.14"', async () => {
    const ret = await runStandalone(`
      export function test(): number {
        const s = (3.14).toLocaleString();
        return (s.length === 4 && s.charCodeAt(0) === 51 && s.charCodeAt(1) === 46 &&
                s.charCodeAt(2) === 49 && s.charCodeAt(3) === 52) ? 1 : 0;
      }`);
    expect(ret).toBe(1);
  });

  it('zero → "0"', async () => {
    const ret = await runStandalone(`
      export function test(): number {
        const s = (0).toLocaleString();
        return (s.length === 1 && s.charCodeAt(0) === 48) ? 1 : 0;
      }`);
    expect(ret).toBe(1);
  });

  it("variable-typed number receiver", async () => {
    const ret = await runStandalone(`
      export function test(): number {
        let n = 42;
        return n.toLocaleString().length;
      }`);
    expect(ret).toBe(2);
  });

  it("host (gc) mode keeps the __extern_toLocaleString import (Intl grouping preserved)", async () => {
    // The fix is standalone/WASI-only; host must NOT be rerouted to number_toString,
    // otherwise it loses real locale grouping.
    const r = await compile(`export function test(): number { return (1234).toLocaleString().length; }`, {
      fileName: "test.ts",
      skipSemanticDiagnostics: true,
    });
    expect(r.success).toBe(true);
    const names = r.imports.map((i) => i.name);
    expect(names).toContain("__extern_toLocaleString");
  });
});
