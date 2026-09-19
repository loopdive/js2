// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1058 string literal factory optional flags", () => {
  it.each(["gc", "standalone"] as const)("preserves an undefined middle argument in %s", async (target) => {
    const result = await compile(
      `
      interface Literal { text: string; singleQuote?: boolean; extended?: boolean; }
      interface Factory { createStringLiteral(text: string, singleQuote?: boolean, extended?: boolean): Literal; }
      function createFactory(): Factory {
        return { createStringLiteral };
        function createStringLiteral(text: string, singleQuote?: boolean, extended?: boolean): Literal {
          return { text, singleQuote, extended };
        }
      }
      const { createStringLiteral: factoryCreateStringLiteral } = createFactory();
      function tokenValue(): string { return "__module".substring(2); }
      function hasExtendedEscape(): boolean { return true; }
      export function probe(): number {
        const node = factoryCreateStringLiteral(tokenValue(), undefined, hasExtendedEscape());
        if (node.singleQuote !== undefined) return -1;
        return node.text.length * 10 + (node.extended ? 1 : 0);
      }
      export function probeFalse(): number {
        const node = factoryCreateStringLiteral(tokenValue(), false, false);
        return node.singleQuote === false && node.extended === false ? 1 : -1;
      }
      export function probeOmitted(): number {
        const node = factoryCreateStringLiteral(tokenValue());
        return node.singleQuote === undefined && node.extended === undefined ? 1 : -1;
      }
    `,
      { target, skipSemanticDiagnostics: true, experimentalIR: false },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
    const imports = result.importObject ?? {};
    const instance = await WebAssembly.instantiate(module, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(61);
    expect((instance.exports.probeFalse as () => number)()).toBe(1);
    expect((instance.exports.probeOmitted as () => number)()).toBe(1);
  });
});
