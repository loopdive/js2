// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1599 — standalone / WASI JSON host-import guard.
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
 *     covered by pure-Wasm/static JSON slices.
 *
 * The primitive/static slices (null / undefined / boolean / number and static
 * JSON-compatible literals) are lowered without a JSON host import.
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

async function expectAccepted(src: string, target: "standalone" | "wasi" = "standalone") {
  const r = await compile(src, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /JSON_stringify|JSON_parse/.test(l))).toBe(false);
  return r;
}

describe("#1599 --target standalone refuses dynamic unsupported JSON shapes", () => {
  it("compiles JSON.stringify of a dynamic object (#2166 PR-A — pure-Wasm __json_stringify_value)", async () => {
    // PR-A serialises a runtime `$Object` graph with the recursive native
    // codec instead of refusing (or silently folding the declaration literal).
    await expectAccepted(`export function f(o: { a: number }): string { return JSON.stringify(o); }`);
  });

  it("still rejects JSON.stringify of a dynamic array (closed typed-vec — PR-A2 sub-slice)", async () => {
    // Arrays use the closed `__vec_*` structs, not `$ObjVec`, so they stay on
    // the refusal path until the array sub-slice (PR-A2) lands.
    await expectRefused(`export function f(a: number[]): string { return JSON.stringify(a); }`);
  });

  it("compiles JSON.stringify of a dynamic string (#1599 Phase 2 — pure-Wasm __json_quote_string)", async () => {
    await expectAccepted(`export function f(s: string): string { return JSON.stringify(s); }`);
  });

  it("compiles JSON.stringify of a dynamic number", async () => {
    await expectAccepted(`export function f(n: number): string { return JSON.stringify(n); }`);
  });

  it("compiles dynamic JSON.parse text (PR-C codec, no longer refused)", async () => {
    // #2166 PR-C: a runtime-string `JSON.parse` now routes to the pure-Wasm
    // recursive-descent `__json_parse_text` codec (host-import-free), so a
    // dynamic-text parse + property read compiles instead of refusing.
    await expectAccepted(`export function f(s: string): number { return JSON.parse(s).x; }`);
  });

  it("compiles JSON.parse of a static string literal property read", async () => {
    await expectAccepted(`export function f(): number { return JSON.parse('{"x":42}').x; }`);
  });

  it("still refuses a dynamic array (closed typed-vec) stringify under --target wasi", async () => {
    // A dynamic array (closed typed-vec) still refuses (PR-A2 follow-up). A
    // dynamic JSON.parse text now compiles under wasi too (PR-C, host-import-
    // free — covered by the #2166 PR-C wasi test).
    await expectRefused(`export function f(a: number[]): string { return JSON.stringify(a); }`, "wasi");
    await expectAccepted(`export function f(s: string): number { return JSON.parse(s).x; }`, "wasi");
  });

  it("emits no env::JSON_* import when refused", async () => {
    const r = await compile(`export function f(a: number[]): string { return JSON.stringify(a); }`, {
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

  it("JSON.stringify of a static object compiles standalone", async () => {
    await runStandalone(
      `export function f(): string { return JSON.stringify({ a: 1, b: [2, 3] }); }`,
      '{"a":1,"b":[2,3]}',
    );
  });
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
