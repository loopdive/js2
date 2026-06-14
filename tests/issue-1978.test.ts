// #1978 — a user function named `main` had the module-init body SPLICED into
// it: module-global initializers re-ran on every call (top-level state reset),
// and under the `main()`-calls-itself WASI convention `main`'s body began with
// a call to its own index (unbounded self-recursion). `main` is just an ordinary
// export now; module init lives in a standalone `__module_init` that runs once.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(src: string, opts: Record<string, unknown> = {}) {
  const result = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, ...opts });
  if (!result.success) {
    throw new Error(result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n"));
  }
  const importObj = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(result.binary, importObj as never);
  if (typeof importObj.setExports === "function") {
    (importObj.setExports as (e: unknown) => void)(instance.exports);
  }
  return { instance, wat: result.wat };
}

describe("#1978 user main() does not get the module-init body spliced in", () => {
  it("A: top-level state persists across calls to a user main() (was 1,1,1)", async () => {
    const src = `
      let counter = 0;
      export function main(): number { counter = counter + 1; return counter; }
    `;
    const { instance } = await instantiate(src);
    const main = (instance.exports as { main(): number }).main;
    expect([main(), main(), main()]).toEqual([1, 2, 3]); // node: 1,2,3
  });

  it("A': a top-level initializer runs exactly once, not per main() call", async () => {
    const src = `
      let counter = 10;
      counter = counter + 5; // top-level init: counter = 15, once
      export function main(): number { counter = counter + 1; return counter; }
    `;
    const { instance } = await instantiate(src);
    const main = (instance.exports as { main(): number }).main;
    // If init re-ran per call it would reset to 15 each time → 16,16,16.
    expect([main(), main(), main()]).toEqual([16, 17, 18]);
  });

  it("the init body is NOT spliced into main — a standalone start function carries it", async () => {
    const src = `
      let counter = 0;
      counter = 5;
      export function main(): number { return counter; }
    `;
    const { wat } = await instantiate(src);
    expect(wat).toContain("(start "); // module init runs via the start section
    expect(wat).toContain("__module_init"); // a dedicated init function exists
    expect(wat).not.toContain("__init_done"); // no per-call guard
  });

  it("B: the conventional main()-calls-itself shape compiles without self-recursion (WASI)", async () => {
    // WASI modules need WASI host imports to instantiate, so this is a
    // compile-only check: the module must build (no `$main`-calls-its-own-index
    // splice) and expose the conventional `_start` entry wrapping `__module_init`.
    const src = `function main(): void { console.log(42); } main();`;
    const result = await compile(src, { fileName: "test.ts", target: "wasi", skipSemanticDiagnostics: true });
    expect(result.success, result.success ? "" : result.errors?.[0]?.message).toBe(true);
    expect(result.wat).toMatch(/\(export "_start"/);
    expect(result.wat).toContain("__module_init");
  });

  it("a module WITHOUT a main is unregressed (init via start section)", async () => {
    const src = `
      let x = 0;
      x = 7;
      export function get(): number { return x; }
    `;
    const { instance, wat } = await instantiate(src);
    expect(wat).toContain("(start ");
    expect((instance.exports as { get(): number }).get()).toBe(7);
  });
});
