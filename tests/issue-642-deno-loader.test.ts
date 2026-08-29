// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { clearModuleCache, loadWasmModule } from "../examples/deno-loader/js2wasm-loader.js";
import * as compilerModule from "../src/index.js";
import * as runtimeModule from "../src/runtime.js";

/**
 * #642 — Deno loader: transparent compile-on-import of a .ts module to Wasm.
 *
 * The example loader (`examples/deno-loader/js2wasm-loader.ts`) is
 * runtime-agnostic; under Deno it pulls the compiler from `npm:@loopdive/js2`
 * via the import map, and here we inject the in-repo compiler/runtime so the
 * loader's read → compile → instantiate → wrapExports pipeline is validated in
 * CI without a Deno install.
 */

const inject = { compiler: compilerModule, runtime: runtimeModule };
const greetUrl = new URL("../examples/deno-loader/modules/greet.ts", import.meta.url);

beforeEach(() => clearModuleCache());

describe("#642 — deno-loader compile-on-import", () => {
  it("loads the example module and calls number/string exports", async () => {
    const mod = await loadWasmModule(greetUrl, inject);
    expect(mod.add(2, 3)).toBe(5);
    expect(mod.fib(10)).toBe(55);
    expect(mod.greet("Deno")).toBe("Hello, Deno!");
  });

  it("accepts a plain path string as well as a URL", async () => {
    const mod = await loadWasmModule(fileURLToPath(greetUrl), inject);
    expect(mod.add(40, 2)).toBe(42);
  });

  it("caches by specifier: repeat load returns the same instance", async () => {
    const a = await loadWasmModule(greetUrl, inject);
    const b = await loadWasmModule(greetUrl, inject);
    expect(b).toBe(a);
    const c = await loadWasmModule(greetUrl, { ...inject, cache: false });
    expect(c).not.toBe(a);
  });

  it("rejects with the compiler diagnostics on a compile failure", async () => {
    // js2wasm is tolerant (success stays true, problems become diagnostics),
    // so the strict loader keys on error-severity diagnostics. `with` draws
    // one; the source is written at runtime because it cannot pass the repo's
    // own lint as a committed fixture.
    const dir = await mkdtemp(join(tmpdir(), "issue-642-"));
    const badPath = join(dir, "does-not-compile.ts");
    await writeFile(badPath, "export function broken(o: any): number { with (o) { return x; } }\n");
    await expect(loadWasmModule(badPath, inject)).rejects.toThrow(/failed to compile/);
    // A rejected load must not poison the cache.
    await expect(loadWasmModule(badPath, inject)).rejects.toThrow(/failed to compile/);
  });
});
