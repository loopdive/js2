// #6989 — `temporalKindForExpression` followed variable initializers without a
// cycle guard, so mutually referencing declarations (`var a = b, b = a;`, as in
// Emscripten output such as Octane zlib's eval'd module) overflowed the
// compiler's stack on the first member access.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, target: "gc" | "standalone"): Promise<unknown> {
  const result = await compile(source, {
    fileName: "cycle.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.errors.filter((e) => /call stack/i.test(String(e.message)))).toEqual([]);
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { run: () => unknown }).run();
}

describe("#6989 mutually referencing initializers do not recurse forever", () => {
  it("local `var a = b, b = a` with a member access compiles and runs", async () => {
    const src = `function f(){ var a = b, b = a; return a && a.length; }
export function run(){ return f() === undefined ? 1 : 0; }`;
    expect(await run(src, "standalone")).toBe(1);
  });

  it("script-level cycle followed by a guarded member read", async () => {
    const src = `var p = q, q = p;
export function run(){ return p === undefined && q === undefined ? 1 : 0; }`;
    expect(await run(src, "standalone")).toBe(1);
  });
});
