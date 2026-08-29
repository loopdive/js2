// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5180 — reading an unmodelled property off a builtin CARRIER struct must not
// grow that carrier's field metadata.
//
// `ctx.structFields.get("__Date")` and `ctx.mod.types[<__Date>].fields` are two
// SEPARATE arrays (`ensureDateStruct` writes both from distinct literals). The
// dynamic field auto-registration in `finalizeStructAndDynamicMemberGet`
// appends to the first only, so the metadata claimed two fields while the
// emitted struct kept one — and `findAlternateStructsForField` then emitted
// `struct.get $__Date 1` on a one-field struct. That is not a validation
// failure: the binary emitter's #2043 index check refuses it, so `compile()`
// returns ONE hard error and an EMPTY binary, i.e. the whole module is lost.
//
// Reachable since #5204 (8f161cbf15) added the carrier-name fallback in
// `resolveStructNameForExpr`, which resolves a receiver the checker cannot name
// to whatever WasmGC struct it lowers to — so `new Date(0).valueOf` arrives at
// the auto-registration site with `typeName === "__Date"`.
//
// This is the reduction of the `JSBI___toPrimitive` blocker that stopped the
// linked @js-temporal/polyfill bundle from producing a binary at all; JSBI's
// `static __toPrimitive(i)` reads `i.valueOf` off exactly such a receiver.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

const TS_SOURCE = `
export function test(): number {
  const d = new Date(0);
  const t = d.valueOf;
  return typeof t === "function" ? 1 : 0;
}
`;

// The published-JS shape the polyfill bundle actually hits: no annotations,
// compiled with allowJs exactly as tests/test262-runner.ts does.
const JS_SOURCE = `
const d = new Date(0);
const t = d.valueOf;
console.log(typeof t);
`;

describe("#5180 — builtin carrier field metadata must not diverge from the emitted struct", () => {
  it("emits a binary for a Date-carrier property read (host target)", async () => {
    const result = await compile(TS_SOURCE, { fileName: "issue-5180-host.ts", skipSemanticDiagnostics: true });
    const errors = result.errors.filter((e) => e.severity !== "warning");
    expect(errors.map((e) => e.message).join("\n")).toBe("");
    expect(result.success).toBe(true);
    // The pre-fix failure mode is an EMPTY binary, so assert the bytes exist
    // before asking the engine anything.
    expect(result.binary.length).toBeGreaterThan(0);
    await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  });

  it("emits a binary for the published-JS shape (allowJs, as the polyfill bundle is compiled)", async () => {
    const result = await compile(JS_SOURCE, {
      fileName: "issue-5180-bundle-shape.js",
      allowJs: true,
      sourceMap: true,
      skipSemanticDiagnostics: true,
    });
    const errors = result.errors.filter((e) => e.severity !== "warning");
    expect(errors.map((e) => e.message).join("\n")).toBe("");
    expect(result.binary.length).toBeGreaterThan(0);
    await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  });

  it("keeps the read's semantics: the carrier property is still a function, host-free", async () => {
    const result = await compile(TS_SOURCE, {
      fileName: "issue-5180-standalone.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(1);
  });
});
