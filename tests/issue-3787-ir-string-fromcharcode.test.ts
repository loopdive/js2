import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const HOST_SOURCE = `
export function empty(): string {
  return String.fromCharCode();
}

export function single(code: number): string {
  return String.fromCharCode(code);
}

export function pair(a: number, b: number): string {
  return String.fromCharCode(a, b);
}
`;

describe("#3787 IR ambient String.fromCharCode", () => {
  it.each(["gc", "standalone"] as const)("emits exact ambient calls through IR on %s", async (target) => {
    const result = await compile(HOST_SOURCE, {
      fileName: "ir-from-char-code.ts",
      target,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining(["empty", "single", "pair"]),
    );
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("preserves zero, one, and variadic results in the host lane", async () => {
    const result = await compile(HOST_SOURCE, {
      fileName: "ir-from-char-code-host.ts",
      target: "gc",
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    const exports = instance.exports as {
      empty: () => string;
      single: (code: number) => string;
      pair: (a: number, b: number) => string;
    };
    expect(exports.empty()).toBe("");
    expect(exports.single(65)).toBe("A");
    expect(exports.pair(65, 90)).toBe("AZ");
    expect(exports.pair(0x10041, 0x10042)).toBe("AB");
  });

  it("applies exact ToUint16 before the native helper", async () => {
    const result = await compile(
      `
      export function code(value: number): number {
        return String.fromCharCode(value).charCodeAt(0);
      }
      `,
      {
        fileName: "ir-from-char-code-standalone.ts",
        target: "standalone",
        trackIrOutcomes: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toContain("code");
    expect(result.imports ?? []).toEqual([]);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const code = (instance.exports as { code: (value: number) => number }).code;
    expect(code(65.9)).toBe(65);
    expect(code(4_294_967_361)).toBe(65);
    expect(code(-65_535.75)).toBe(1);
    expect(code(Number.POSITIVE_INFINITY)).toBe(0);
    expect(code(Number.NaN)).toBe(0);
  });

  it("uses the propagated numeric ABI for Acorn's unannotated helper shape", async () => {
    const result = await compile(
      `
      function codePointToString(code) {
        if (code <= 0xFFFF) { return String.fromCharCode(code); }
        code -= 0x10000;
        return String.fromCharCode((code >> 10) + 0xD800, (code & 1023) + 0xDC00);
      }
      /** @param {number} value @returns {string} */
      export function codePoint(value) {
        return codePointToString(value);
      }
      `,
      {
        allowJs: true,
        skipSemanticDiagnostics: true,
        fileName: "ir-from-char-code-acorn.mjs",
        target: "gc",
        trackIrOutcomes: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toContain("codePointToString");

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    const codePoint = (instance.exports as { codePoint: (value: number) => string }).codePoint;
    expect(codePoint(0x41)).toBe("A");
    expect(codePoint(0x1f600)).toBe("😀");
  });

  it("does not claim a shadowed String binding as the ambient builtin", async () => {
    const result = await compile(
      `
      export function shadowed(value: number): string {
        const String = { fromCharCode(code: number): string { return code === 65 ? "local" : "other"; } };
        return String.fromCharCode(value);
      }
      `,
      {
        fileName: "ir-from-char-code-shadowed.ts",
        target: "gc",
        trackIrOutcomes: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("shadowed");
  });
});
