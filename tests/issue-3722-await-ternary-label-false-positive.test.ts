import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #3722 — the await-as-label early-error check (src/compiler/early-errors/
// node-checks.ts) flagged ANY AwaitExpression immediately followed by `:` as
// an invalid label, without excluding the case where that `:` is a ternary's
// separator (`cond ? await expr : else`) rather than a label colon. The
// sibling yield-as-label check already carried this exact exclusion; await's
// check was missing it. Found compiling marked@18.0.2's bundled
// marked.esm.js, which uses this pattern for its async/sync dual code path
// (e.g. `i.hooks ? await i.hooks.preprocess(n) : n`).

async function instantiate(src: string): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const result = await compile(src);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  if (imports.setExports) imports.setExports(exports as Record<string, Function>);
  return exports;
}

describe("#3722 — await in a ternary's consequent branch is not a label", () => {
  it("`cond ? await x() : y` compiles and runs (true branch)", async () => {
    const exports = await instantiate(`
      async function fetchIt(): Promise<number> { return 7; }
      export async function pick(useAsync: boolean): Promise<number> {
        return useAsync ? await fetchIt() : 3;
      }
    `);
    expect(exports.pick(1)).toBe(7);
  });

  it("`cond ? await x() : y` compiles and runs (false branch)", async () => {
    const exports = await instantiate(`
      async function fetchIt(): Promise<number> { return 7; }
      export async function pick(useAsync: boolean): Promise<number> {
        return useAsync ? await fetchIt() : 3;
      }
    `);
    expect(exports.pick(0)).toBe(3);
  });

  it("a member/call expression after await inside a ternary compiles", async () => {
    const result = await compile(`
      async function fetchIt(n: number): Promise<number> { return n + 1; }
      const hooks = { preprocess: fetchIt };
      export async function run(useHooks: boolean, n: number): Promise<number> {
        return useHooks ? await hooks.preprocess(n) : n;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);
  });

  it("a genuine await-as-label (no ternary) is still a real error", async () => {
    const result = await compile(`
      export async function foo(): Promise<number> {
        await: for (let i = 0; i < 1; i++) {}
        return 1;
      }
    `);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => /await.*not allowed/i.test(e.message))).toBe(true);
  });
});
