/**
 * #1329-b3 — RegExp @@replace replacer return-value coercion.
 *
 * Mirrors `built-ins/RegExp/prototype/Symbol.replace/fn-coerce-replacement.js`
 * from test262. When the replacer function returns a WasmGC struct with a
 * `toString` field (compiled object literal), V8's @@replace performs
 * `ToString(replValue)` per §22.2.5.8 step 14.k.vi. Without the host-proxy
 * wrap inside `__regex_symbol_call`'s `wrapCallable` bridge, the engine sees
 * an opaque WebAssembly object and throws "Cannot convert object to
 * primitive value".
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

describe("#1329-b3 — @@replace replacer return-value coercion", { timeout: 30000 }, () => {
  it("replacer returns an object with toString (host ToString reaches the closure)", async () => {
    const out = await run(`
      export function test(): string {
        const replacer = function(): any {
          return { toString: function(): string { return "toString value"; } };
        };
        return /x/[Symbol.replace]('[x]', replacer) as string;
      }
    `);
    expect(out).toBe("[toString value]");
  });

  it("replacer that returns a number coerces via ToString", async () => {
    const out = await run(`
      export function test(): string {
        const replacer = function(): any { return 42; };
        return /x/[Symbol.replace]('[x]', replacer) as string;
      }
    `);
    expect(out).toBe("[42]");
  });

  it("replacer that returns a string passes through", async () => {
    const out = await run(`
      export function test(): string {
        const replacer = function(): string { return "Y"; };
        return /x/g[Symbol.replace]('axbxc', replacer) as string;
      }
    `);
    expect(out).toBe("aYbYc");
  });
});
