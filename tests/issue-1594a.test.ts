import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
  // Build host imports the same way test262 does: build → instantiate →
  // setExports. The lazy `r.importObject` path used by #1667 doesn't wire
  // setExports, so closure-aware host helpers (e.g. __typeof via #1594A)
  // can't see __is_closure unless we use this manual flow.
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  if (typeof imports.setExports === "function") {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  const fn = (instance.exports as Record<string, unknown>).test as (() => unknown) | undefined;
  if (typeof fn !== "function") throw new Error("no test export");
  return fn();
}

describe("#1594A — typeof of block-hoisted function declaration", () => {
  it('typeof of a function reference widened to any returns "function"', async () => {
    // Function reference passed through an externref (any) — exercises the
    // dynamic __typeof host path where the closure struct surfaces. Without
    // the closure-aware probe in src/runtime.ts (#1594A), this returns "object".
    const src = `
      function f() { return 'decl'; }
      export function test(): string {
        const x: any = f;
        return typeof x;
      }
    `;
    expect(await run(src)).toBe("function");
  });

  it('typeof of a normal function expression returns "function" (regression guard)', async () => {
    const src = `
      export function test(): string {
        const g = function () { return 1; };
        return typeof g;
      }
    `;
    expect(await run(src)).toBe("function");
  });

  it('typeof of a plain object stays "object" (regression guard)', async () => {
    const src = `
      export function test(): string {
        const o: any = { a: 1 };
        return typeof o;
      }
    `;
    expect(await run(src)).toBe("object");
  });
});
