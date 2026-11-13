// #6842 — three's `yieldToMain` falls back to `requestAnimationFrame(resolve)`
// inside a Promise executor; on `--target standalone` that once materialized
// an `env.requestAnimationFrame` host import. A standalone module has no
// frame clock: `typeof requestAnimationFrame` is "undefined" and a call throws
// ReferenceError (the #6675 timer precedent; the name joined that table in
// #6841). This pins three's exact source shape.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

async function compileMain(source: string, target: "standalone" | "gc") {
  const dir = mkdtempSync(join(tmpdir(), "issue-6842-"));
  writeFileSync(join(dir, "main.js"), source);
  const result = await compileProject(join(dir, "main.js"), { allowJs: true, skipSemanticDiagnostics: true, target });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  return { module, imports: WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`) };
}

// three.core.js `yieldToMain`, verbatim apart from the export.
const THREE_YIELD = `
function yieldToMain() {
  if ( typeof self !== 'undefined' && typeof self.scheduler !== 'undefined' && typeof self.scheduler.yield !== 'undefined' ) {
    return self.scheduler.yield();
  }
  return new Promise( resolve => {
    requestAnimationFrame( resolve );
  } );
}
export const yieldHelper = yieldToMain;
export function frameFallback() {
  try { new Promise( resolve => { requestAnimationFrame( resolve ); } ); return 1; } catch (e) { return 2; }
}
export function kind() {
  return (typeof requestAnimationFrame === "undefined" ? 1 : 0) + (typeof cancelAnimationFrame === "undefined" ? 10 : 0);
}
export function direct() {
  try { requestAnimationFrame(() => {}); return 0; } catch (e) { return e instanceof ReferenceError ? 1 : 2; }
}
`;

describe("#6842 — requestAnimationFrame on --target standalone", () => {
  it("three's yieldToMain compiles with zero imports; typeof is undefined and a call throws ReferenceError", async () => {
    const { module, imports } = await compileMain(THREE_YIELD, "standalone");
    expect(imports.filter((name) => !name.startsWith("string_constants."))).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    (instance.exports.__module_init as (() => void) | undefined)?.();
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.kind()).toBe(11);
    expect(ex.direct()).toBe(1);
    // three's fallback branch: the executor's ReferenceError rejects the promise
    // instead of escaping the constructor.
    expect(ex.frameFallback()).toBe(1);
  });

  it("the JS-host target still imports the host requestAnimationFrame (anti-vacuity control)", async () => {
    const { imports } = await compileMain(THREE_YIELD, "gc");
    expect(imports).toContain("env.requestAnimationFrame");
  });
});
