/**
 * #1439 — RegExp.prototype Symbol.* protocol methods (replace/match/search/split/matchAll).
 *
 * Direct invocation of `regex[Symbol.replace](string, replaceValue)` etc.
 * previously deref'd a null pointer at runtime. Validate each Symbol-keyed
 * protocol method works end-to-end through the JS host bridge.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  if (typeof imports.setExports === "function") {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports as any)[fn]();
}

describe("#1439 — RegExp.prototype Symbol.* protocol methods", { timeout: 30000 }, () => {
  it("@@replace with literal pattern + literal replacement", async () => {
    const out = await run(`
      export function test(): string {
        return /b/[Symbol.replace]('abc', 'x') as string;
      }
    `);
    expect(out).toBe("axc");
  });

  it("@@replace coerces first arg via ToString (object with toString)", async () => {
    const out = await run(`
      export function test(): string {
        const o: any = { toString: () => 'hello' };
        return /l/g[Symbol.replace](o, 'X') as string;
      }
    `);
    expect(out).toBe("heXXo");
  });

  it("@@match returns Array of matches with /g flag", async () => {
    const out = await run(`
      export function test(): number {
        const m: any = /a/g[Symbol.match]('banana');
        if (m === null) return -1;
        return (m as any).length as number;
      }
    `);
    expect(out).toBe(3);
  });

  it("@@match returns null when no match", async () => {
    const out = await run(`
      export function test(): number {
        const m: any = /z/[Symbol.match]('banana');
        return m === null ? 1 : 0;
      }
    `);
    expect(out).toBe(1);
  });

  it("@@search returns first-match index", async () => {
    const out = await run(`
      export function test(): number {
        return /n/[Symbol.search]('banana') as number;
      }
    `);
    expect(out).toBe(2);
  });

  it("@@search returns -1 when no match", async () => {
    const out = await run(`
      export function test(): number {
        return /z/[Symbol.search]('banana') as number;
      }
    `);
    expect(out).toBe(-1);
  });

  it("@@split splits on regex separator", async () => {
    const out = await run(`
      export function test(): number {
        const parts: any = /,/[Symbol.split]('a,b,c,d');
        return (parts as any).length as number;
      }
    `);
    expect(out).toBe(4);
  });

  it("@@split respects limit argument", async () => {
    const out = await run(`
      export function test(): number {
        const parts: any = /,/[Symbol.split]('a,b,c,d', 2);
        return (parts as any).length as number;
      }
    `);
    expect(out).toBe(2);
  });

  it("@@matchAll yields all matches", async () => {
    const out = await run(`
      export function test(): number {
        const iter: any = /a/g[Symbol.matchAll]('banana');
        let count: number = 0;
        for (const _m of iter as Iterable<any>) {
          count = count + 1;
        }
        return count;
      }
    `);
    expect(out).toBe(3);
  });

  it("@@replace with function replacement", async () => {
    const out = await run(`
      export function test(): string {
        return /a/g[Symbol.replace]('banana', (m: string) => m.toUpperCase()) as string;
      }
    `);
    expect(out).toBe("bAnAnA");
  });
});
