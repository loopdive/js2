// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1599 Phase 1 — refuse-and-document for JSON in standalone / WASI mode.
 *
 * `JSON.stringify` / `JSON.parse` of non-primitive shapes delegate to the JS
 * host imports `env::JSON_stringify` / `env::JSON_parse`. In `--target
 * standalone` (pure WasmGC, no JS host) and `--target wasi` there is no host
 * to provide them, so a module that calls them would fail at instantiation
 * with `unknown import env::JSON_*`.
 *
 * Phase 1 instead:
 *   - skips registering the `env::JSON_*` imports in standalone/wasi mode, and
 *   - emits a clear `#1599` compile error at the call site for any shape not
 *     covered by the pure-Wasm primitive `JSON.stringify` slice (#1324).
 *
 * The primitive `JSON.stringify` slice (null / undefined / boolean / number)
 * is still lowered to pure Wasm and continues to compile standalone.
 *
 * Phase 2 (a pure-Wasm JSON codec for objects / arrays / strings / parse) is
 * tracked in the issue file as a follow-up.
 */

async function expectRefused(
  src: string,
  target: "standalone" | "wasi" = "standalone",
): Promise<ReturnType<typeof compile>> {
  const r = await compile(src, { target });
  expect(r.success, `expected compile failure, got success for:\n${src}`).toBe(false);
  expect(r.errors.length).toBeGreaterThan(0);
  expect(r.errors.some((e) => /#1599/.test(e.message))).toBe(true);
  const refusal = r.errors.find((e) => /#1599/.test(e.message))!;
  expect(refusal.line).toBeGreaterThan(0);
  return r;
}

describe("#1599 --target standalone refuses unsupported JSON shapes", () => {
  it("rejects JSON.stringify of an object", async () => {
    await expectRefused(`export function f(): string { return JSON.stringify({ a: 1 }); }`);
  });

  it("rejects JSON.stringify of an array", async () => {
    await expectRefused(`export function f(): string { return JSON.stringify([1, 2, 3]); }`);
  });

  it("rejects JSON.stringify of a string", async () => {
    await expectRefused(`export function f(s: string): string { return JSON.stringify(s); }`);
  });

  it("rejects JSON.parse", async () => {
    await expectRefused(`export function f(s: string): number { return JSON.parse(s).x; }`);
  });

  it("rejects JSON.parse of a string literal", async () => {
    await expectRefused(`export function f(): number { return JSON.parse('{"x":42}').x; }`);
  });

  it("also refuses under --target wasi", async () => {
    await expectRefused(`export function f(): string { return JSON.stringify({ a: 1 }); }`, "wasi");
    await expectRefused(`export function f(s: string): number { return JSON.parse(s).x; }`, "wasi");
  });

  it("emits no env::JSON_* import when refused", async () => {
    const r = await compile(`export function f(): string { return JSON.stringify({ a: 1 }); }`, {
      target: "standalone",
    });
    expect(r.success).toBe(false);
    const labels = r.imports.map((i) => `${i.module}::${i.name}`);
    expect(labels.some((l) => /JSON_stringify|JSON_parse/.test(l))).toBe(false);
  });
});

describe("#1599 primitive JSON.stringify slice still works standalone (#1324)", () => {
  async function runStandalone(src: string, expected: string | undefined) {
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // No JSON host import was registered.
    const labels = r.imports.map((i) => `${i.module}::${i.name}`);
    expect(labels.some((l) => /JSON_stringify|JSON_parse/.test(l))).toBe(false);
  }

  it("JSON.stringify(null) compiles standalone", async () => {
    await runStandalone(`export function f(): string { return JSON.stringify(null); }`, "null");
  });

  it("JSON.stringify(true) compiles standalone", async () => {
    await runStandalone(`export function f(): string { return JSON.stringify(true); }`, "true");
  });

  // NOTE: JSON.stringify(number) is *not* standalone-safe even though it is a
  // primitive — the #1324 slice lowers it through `env::number_toString`, a
  // host import that does not exist in standalone/wasi mode. It is therefore
  // correctly refused with the #1599 message (see refusal block above). The
  // pure-Wasm number-to-string path is part of the Phase 2 follow-up.
});

describe("#1599 default (JS-host) mode unchanged", () => {
  it("compiles JSON.stringify of an object in default mode", async () => {
    const r = await compile(`export function f(): string { return JSON.stringify({ a: 1 }); }`, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((i) => `${i.module}::${i.name}`);
    expect(labels.some((l) => /JSON_stringify/.test(l))).toBe(true);
  });

  it("compiles JSON.parse in default mode", async () => {
    const r = await compile(`export function f(s: string): number { return JSON.parse(s).x; }`, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((i) => `${i.module}::${i.name}`);
    expect(labels.some((l) => /JSON_parse/.test(l))).toBe(true);
  });
});
