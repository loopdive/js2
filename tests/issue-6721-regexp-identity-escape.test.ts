// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6721 — Annex B IdentityEscape for non-Unicode `\\p` / `\\P`.
 *
 * Keep non-u/v forms on the existing code-unit path while retaining the
 * property-escape parser and its invalid-bare-escape guards in u/v mode.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { parseFlags, RegexUnsupportedError } from "../src/codegen/regex/bytecode.js";
import { compilePattern } from "../src/codegen/regex/compile.js";
import { search } from "../src/codegen/regex/vm.js";

function matchedText(pattern: string, flags: string, input: string): string | null {
  const compiled = compilePattern(pattern, parseFlags(flags));
  const match = search(compiled.prog, compiled.classTable, compiled.nGroups, input, 0, false);
  return match === null ? null : input.slice(match[0]!, match[1]!);
}

const NON_UNICODE_CASES: Array<{ pattern: string; input: string; expected: string }> = [
  { pattern: "\\p", input: "p", expected: "p" },
  { pattern: "\\P", input: "P", expected: "P" },
  { pattern: "O\\PQ", input: "MNOPQRS", expected: "OPQ" },
  { pattern: "\\p{L}", input: "p{L}", expected: "p{L}" },
  { pattern: "\\P{L}", input: "P{L}", expected: "P{L}" },
  { pattern: "[\\p]", input: "p", expected: "p" },
  { pattern: "[\\P]", input: "P", expected: "P" },
  { pattern: "[\\p{L}]", input: "{", expected: "{" },
];

describe("#6721 non-Unicode p/P identity escapes", () => {
  for (const { pattern, input, expected } of NON_UNICODE_CASES) {
    it(`${JSON.stringify(pattern)} matches its Annex B identity spelling`, () => {
      expect(matchedText(pattern, "", input)).toBe(expected);
    });
  }

  it("keeps Unicode property syntax and bare-escape errors in u/v mode", () => {
    for (const flags of ["u", "v"]) {
      expect(matchedText("\\p{L}", flags, "A")).toBe("A");
      expect(matchedText("\\P{L}", flags, "1")).toBe("1");
      expect(matchedText("[\\p{L}]", flags, "A")).toBe("A");
      for (const pattern of ["\\p", "\\P", "[\\p]", "[\\P]"]) {
        expect(() => compilePattern(pattern, parseFlags(flags))).toThrow(RegexUnsupportedError);
      }
    }
  });

  it("emits the original literal and class forms without a RegExp host import", async () => {
    const source = String.raw`
      export function original(): number {
        const match = /O\PQ/.exec("MNOPQRS");
        return match !== null && match[0] === "OPQ" ? 1 : 0;
      }
      export function classes(): number {
        return /[\p{L}]/.test("{") && /[\P]/.test("P") ? 1 : 0;
      }
    `;
    const result = await compile(source, { fileName: "issue-6721.ts", target: "standalone" });
    expect(result.success, result.success ? "" : JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module).filter(({ name }) => /RegExp/.test(name))).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as {
      original(): number;
      classes(): number;
    };
    expect(exports.original()).toBe(1);
    expect(exports.classes()).toBe(1);
  });

  it("retains the non-constant dynamic parser route without a RegExp host import", async () => {
    const source = String.raw`
      export function dynamic(selector: number): number {
        const pattern = selector === 0 ? "\\p{L}" : "\\P{L}";
        const input = selector === 0 ? "p{L}" : "P{L}";
        const expected = selector === 0 ? "p{L}" : "P{L}";
        const match = new RegExp(pattern).exec(input);
        return match !== null && match[0] === expected ? 1 : 0;
      }
    `;
    const result = await compile(source, { fileName: "issue-6721-dynamic.ts", target: "standalone" });
    expect(result.success, result.success ? "" : JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module).filter(({ name }) => /RegExp/.test(name))).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    const dynamic = (instance.exports as { dynamic(selector: number): number }).dynamic;
    expect(dynamic(0)).toBe(1);
    expect(dynamic(1)).toBe(1);
  });
});
