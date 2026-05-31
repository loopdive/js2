/**
 * Issue #836 — Tagged templates with non-PropertyAccess tag expressions
 * Tests that tagged templates work with Identifier and CallExpression tags.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(source: string): Promise<any> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compilation failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return result;
}

describe("Issue #836: Tagged templates with Identifier and CallExpression tags", () => {
  it("should compile tagged template with identifier tag", async () => {
    const source = `
      function tag(strings: TemplateStringsArray, ...values: any[]): string {
        return strings[0] + (values[0] ?? "") + (strings[1] ?? "");
      }
      const result = tag\`hello\`;
      export function test(): number {
        return 1;
      }
    `;
    const result = await compileAndRun(source);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should compile tagged template with identifier tag and substitutions", async () => {
    const source = `
      function tag(strings: TemplateStringsArray, ...values: any[]): string {
        return strings[0] + String(values[0]) + strings[1];
      }
      const x = 42;
      const result = tag\`hello \${x} world\`;
      export function test(): number {
        return 1;
      }
    `;
    const result = await compileAndRun(source);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should compile tagged template with call expression tag", async () => {
    const source = `
      function getTag(): (strings: TemplateStringsArray) => string {
        return function(strings: TemplateStringsArray): string {
          return strings[0];
        };
      }
      const result = getTag()\`hello\`;
      export function test(): number {
        return 1;
      }
    `;
    const result = await compileAndRun(source);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should compile tagged template with IIFE tag", async () => {
    const source = `
      const result = (function(strings: TemplateStringsArray): string {
        return strings[0];
      })\`hello\`;
      export function test(): number {
        return 1;
      }
    `;
    const result = await compileAndRun(source);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should not produce 'unsupported tag expression kind' errors", async () => {
    const source = `
      function myTag(strings: TemplateStringsArray): string {
        return strings[0];
      }
      const fn = myTag;
      const r = fn\`test\`;
      export function test(): number {
        return 1;
      }
    `;
    const result = await compile(source, { fileName: "test.ts" });
    const tagErrors = result.errors.filter((e) => e.message.includes("unsupported tag expression kind"));
    expect(tagErrors).toHaveLength(0);
  });
});
