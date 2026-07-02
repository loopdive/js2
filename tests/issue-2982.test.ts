import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

/**
 * #2982 — regression: a tag function whose first parameter is annotated
 * `string[]` (or `readonly string[]`) must compile.
 *
 * A tagged template implicitly passes a `TemplateStringsArray`
 * (ECMA-262 §13.2.8.4 — a frozen `ReadonlyArray<string> & { raw }`) as the
 * tag's first argument. TypeScript rejects assigning that to a mutable
 * `string[]` parameter (TS2345), but at runtime the tag simply receives an
 * array of strings, so `string[]` is a runtime-accurate, idiomatic annotation.
 * The Apr-17 "fail on incompatible TypeScript annotations" gate (d8cfbb7a7)
 * promoted TS2345 to a fatal error, which broke this idiomatic pattern (used
 * across tests/issue-141 and the equivalence suite). The compiler now downgrades
 * exactly this false positive.
 */
describe("Issue #2982: tagged-template `string[]` first-param must compile", () => {
  it("compiles a tag fn with `strings: string[]` and two substitutions", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[], a: number, b: number): number {
        return strings.length + a + b;
      }
      export function test(): number {
        return tag\`hello \${10} world \${20}\`;
      }
    `);
    // 3 string parts + 10 + 20
    expect(e.test()).toBe(33);
  });

  it("compiles a tag fn with `strings: readonly string[]`", async () => {
    const e = await compileToWasm(`
      function tag(strings: readonly string[], a: number): number {
        return strings.length + a;
      }
      export function test(): number {
        return tag\`a \${5} b\`;
      }
    `);
    // 2 string parts + 5
    expect(e.test()).toBe(7);
  });

  it("still lowers `.raw` access on a `string[]`-annotated tag fn", async () => {
    const e = await compileToWasm(`
      function tag(strings: string[]): string {
        return strings.raw[0];
      }
      export function test(): string {
        return tag\`hello world\`;
      }
    `);
    expect(e.test()).toBe("hello world");
  });

  // ── Negatives: the downgrade must stay tightly scoped ──────────────────────

  it("KEEPS a hard error for a `number[]` first param (wrong element type)", async () => {
    const r = await compile(
      `
      function tag(strings: number[]): number {
        return strings.length;
      }
      export function test(): number {
        return tag\`x\`;
      }
    `,
      { fileName: "t.ts" },
    );
    expect(r.success).toBe(false);
    expect(r.errors?.some((e) => e.code === 2345)).toBe(true);
  });

  it("KEEPS a hard error for a genuine substitution-argument type mismatch", async () => {
    // First param correctly typed, so the arg0 shadow error is gone and the
    // real `string`→`number` substitution mismatch must surface fatally.
    const r = await compile(
      `
      function tag(strings: TemplateStringsArray, n: number): number {
        return n;
      }
      const s = "x";
      export function test(): number {
        return tag\`a \${s} b\`;
      }
    `,
      { fileName: "t.ts" },
    );
    expect(r.success).toBe(false);
    expect(r.errors?.some((e) => e.code === 2345)).toBe(true);
  });
});
