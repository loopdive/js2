import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

import { eraseTypesPreservingOffsets } from "../website/playground/ts-erase-types.js";
import { setupAcorn } from "./dogfood/setup-acorn.mjs";

// The playground's AST explorer parses with acorn (JavaScript only) while the
// editor holds TypeScript. Rather than transpiling — which moves code and
// breaks the panel's hover-to-highlight — the TS-only syntax is blanked with
// spaces, so every surviving character keeps its original offset.
//
// Two properties matter and are checked here: the output is still parseable
// JavaScript, and a node's range still points at the same text in the ORIGINAL
// TypeScript.

const PARSE_OPTIONS = { ecmaVersion: 2022, sourceType: "module" as const };

const acorn = await import(setupAcorn().entryModulePath);

function erase(source: string) {
  const result = eraseTypesPreservingOffsets(ts, source, "input.ts");
  if (!result) throw new Error("eraser returned null");
  return result;
}

function eraseAndParse(source: string) {
  const result = erase(source);
  expect(result.unsupported, `bailed: ${result.unsupported}`).toBeUndefined();
  // Blanking must never change the length, or every offset after the edit slides.
  expect(result.code.length).toBe(source.length);
  return { code: result.code, ast: acorn.parse(result.code, PARSE_OPTIONS) };
}

describe("playground TS type eraser", () => {
  it("keeps offsets so a node's range still points at the original source", () => {
    const source = `function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);
  return e;
}
`;
    const { ast } = eraseAndParse(source);
    const fn = ast.body[0];
    expect(fn.type).toBe("FunctionDeclaration");
    // The range is meaningful against the TypeScript the user typed, annotations included.
    expect(source.slice(fn.start, fn.start + 11)).toBe("function el");
    expect(source.slice(fn.id.start, fn.id.end)).toBe("el");
    const param = fn.params[0];
    expect(source.slice(param.start, param.end)).toBe("tag");
  });

  it.each([
    ["type annotation", "const x: number = 1;\n"],
    ["interface", "interface P { x: number }\nconst p = { x: 1 };\n"],
    ["type alias", "type P = { x: number };\nconst p = { x: 1 };\n"],
    ["as expression", 'const v = ("x" as string).length;\n'],
    ["satisfies", "const v = { a: 1 } satisfies Record<string, number>;\n"],
    ["non-null assertion", "const v = document.body!.tagName;\n"],
    ["generic function", "function id<T>(v: T): T { return v; }\nid<number>(1);\n"],
    ["type-only import", 'import type { A } from "./a.js";\nexport const x = 1;\n'],
    ["inline type specifiers", 'import { a, type B, type C } from "./a.js";\nexport const x = a;\n'],
    ["leading inline type specifier", 'import { type B, a } from "./a.js";\nexport const x = a;\n'],
    ["definite assignment", "let v!: number;\nv = 1;\n"],
    ["optional parameter", "function f(a?: number) { return a; }\n"],
    ["this parameter", "function f(this: unknown, x: number) { return x; }\n"],
    ["class members", "class C {\n  private readonly n: number = 0;\n  get v(): number { return this.n; }\n}\n"],
    ["implements clause", "interface I { x: number }\nclass C implements I { x = 1; }\n"],
    [
      "overload signatures",
      "function f(a: string): string;\nfunction f(a: number): number;\nfunction f(a: any) { return a; }\n",
    ],
  ])("erases %s into parseable JavaScript", (_name, source) => {
    expect(() => eraseAndParse(source)).not.toThrow();
  });

  it.each([
    ["enum", "enum E { A, B }\n"],
    ["namespace", "namespace N { export const x = 1; }\n"],
    ["parameter property", "class C { constructor(private readonly n: number) {} }\n"],
  ])("bails on %s rather than blanking code that must be generated", (_name, source) => {
    expect(erase(source).unsupported).toBeTruthy();
  });

  it("erases every playground example into parseable JavaScript", () => {
    const dir = "website/playground/examples";
    const files = (function walk(d: string): string[] {
      return readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    })(dir);
    expect(files.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      try {
        const result = erase(source);
        if (result.unsupported) {
          failures.push(`${file}: bailed on ${result.unsupported}`);
          continue;
        }
        acorn.parse(result.code, PARSE_OPTIONS);
      } catch (error) {
        failures.push(`${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
    // Every shipped example is content the panel renders on load, so a
    // regression here is visible to every visitor.
    expect(failures).toEqual([]);
  });
});
