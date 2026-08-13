// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4388 — the standalone realm global object must own the ES5 immutable value
// properties. This is deliberately tested as a sloppy Script-goal module init:
// wrapping the probe in an exported function makes `this` a different receiver
// and recreates the stale pre-#3365 test blind spot.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#4388 standalone global value-property descriptors", () => {
  it("seeds NaN, Infinity, and undefined on sloppy top-level this", async () => {
    const source = `
      function fail() { Object.getOwnPropertyDescriptor(null, "x"); }
      var nanDesc = Object.getOwnPropertyDescriptor(this, "NaN");
      var infinityDesc = Object.getOwnPropertyDescriptor(this, "Infinity");
      var undefinedDesc = Object.getOwnPropertyDescriptor(this, "undefined");

      if (nanDesc.value === nanDesc.value) fail();
      if (infinityDesc.value !== Infinity) fail();
      if (undefinedDesc.value !== undefined) fail();
      if (nanDesc.writable !== false || nanDesc.enumerable !== false || nanDesc.configurable !== false) fail();
      if (infinityDesc.writable !== false || infinityDesc.enumerable !== false || infinityDesc.configurable !== false) fail();
      if (undefinedDesc.writable !== false || undefinedDesc.enumerable !== false || undefinedDesc.configurable !== false) fail();
    `;
    const result = await compile(source, {
      allowJs: true,
      fileName: "issue-4388-sloppy-script.js",
      target: "standalone",
      deferTopLevelInit: true,
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect(() => (instance.exports as { __module_init(): void }).__module_init()).not.toThrow();
  });

  it("exposes the same seeded carrier to an IR-emitted dynamic read", async () => {
    const result = await compile(
      `
        export function getGlobal(): any { return globalThis; }
        export function isGlobalNaN(value: any): boolean { return value.NaN !== value.NaN; }
      `,
      {
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toEqual([]);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "isGlobalNaN")).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
      legacyBodyEmitted: true,
    });

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as {
      getGlobal(): unknown;
      isGlobalNaN(value: unknown): number;
    };
    expect(exports.isGlobalNaN(exports.getGlobal())).toBe(1);
  });
});
