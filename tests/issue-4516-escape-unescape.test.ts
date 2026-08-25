// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4516 — standalone ES5 Annex B `escape` / `unescape`.
 *
 * These probes stay in allowJs top-level code so the arguments exercise the
 * same dynamic path as the assembled Test262 harness. The global-object probe
 * pins the callable own properties and ES5 descriptor flags required by both
 * `prop-desc.js` rows.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4516-escape-unescape.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports.map((entry) => `${entry.module}::${entry.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { probe: () => number }).probe();
}

describe("#4516 — standalone Annex B escape/unescape", () => {
  it("ToString-coerces undefined and omitted arguments", async () => {
    const result = await runStandalone(`
      var checks =
        escape(undefined) === "undefined" &&
        escape() === "undefined" &&
        unescape(undefined) === "undefined" &&
        unescape() === "undefined" &&
        escape(null) === "null" &&
        unescape(null) === "null";
      export function probe() { return checks ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("seeds callable own properties with ES5 descriptors", async () => {
    const result = await runStandalone(`
      export function probe() {
        var e = Object.getOwnPropertyDescriptor(globalThis, "escape");
        var u = Object.getOwnPropertyDescriptor(globalThis, "unescape");
        return typeof globalThis.escape === "function" &&
          typeof globalThis.unescape === "function" &&
          e.writable === true && e.enumerable === false && e.configurable === true &&
          u.writable === true && u.enumerable === false && u.configurable === true ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});
