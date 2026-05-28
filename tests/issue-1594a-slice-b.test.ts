import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileAndRun(src: string): Promise<unknown> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors[0]?.message ?? "unknown"}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  const test = (instance.exports as { test?: () => unknown }).test;
  if (!test) throw new Error("No `test` export");
  return test();
}

describe("#1594A Slice B — AnnexB §B.3.3.1 legacy var-binding write", () => {
  it("function-init: block-hoisted function visible to outer call after block executes", async () => {
    const src = `
      export function test(): number {
        let after: any = null;
        {
          function f() { return 42; }
        }
        // After the block: f's legacy var-binding should hold the closure.
        after = f;
        const v: any = after();
        return v;
      }
    `;
    expect(await compileAndRun(src)).toBe(42);
  });

  it("function-update: re-binding on second pass through the declaration", async () => {
    const src = `
      export function test(): number {
        let total: number = 0;
        for (let i: number = 0; i < 3; i = i + 1) {
          function f() { return 7; }
          const v: any = f();
          total = total + (v as number);
        }
        return total;
      }
    `;
    expect(await compileAndRun(src)).toBe(21);
  });

  it("if-then no-brace: function-decl in then branch hoists to function scope", async () => {
    const src = `
      export function test(cond: boolean): number {
        let captured: any = null;
        if (cond) function h() { return 11; }
        if (cond) {
          captured = h;
        }
        const v: any = captured();
        return v;
      }
    `;
    // The cond=true path executes both `if` statements. After the first runs,
    // the §B.3.3.1 write populates the outer h binding; the second reads it.
    const src2 = `
      export function test(): number {
        let captured: any = null;
        if (true) function h() { return 11; }
        captured = h;
        const v: any = captured();
        return v;
      }
    `;
    expect(await compileAndRun(src2)).toBe(11);
  });
});
