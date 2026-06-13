// #2008 — the tagged-template object (a WasmGC vec struct { length, data, raw })
// was unreadable: the tag function's `strings: TemplateStringsArray` parameter
// resolved to a plain `externref`, so `strings[0]` / `.raw[i]` read the wrong
// representation (undefined / illegal cast) and `String.raw` traps in the host
// bridge ("Cannot convert undefined or null to object").
//
// Fix: (1) resolveWasmType maps `TemplateStringsArray` to the template vec
// struct type so indexed/`.length`/`.raw` reads hit the right fields; (2)
// `String.raw` lowers in-module from the (compile-time-known) raw parts instead
// of routing the opaque struct through the `__tagged_template` host bridge.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => `L${e.line}: ${e.message}`).join("; ")}`);
  }
  const importObj = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(result.binary, importObj as never);
  if (typeof importObj.setExports === "function") {
    (importObj.setExports as (e: unknown) => void)(instance.exports);
  }
  return (instance.exports as { test(): unknown }).test();
}

describe("#2008 tagged-template object reads", () => {
  it("indexes the cooked strings array", async () => {
    const got = await run(`
      function tag(strings: TemplateStringsArray, ...vals: any[]): string {
        return "s0=" + strings[0] + ",s1=" + strings[1];
      }
      export function test(): string { return tag\`a\${1}b\`; }`);
    expect(got).toBe("s0=a,s1=b"); // node: "s0=a,s1=b" (was "s0=undefined,s1=undefined")
  });

  it("reports the correct strings.length", async () => {
    const got = await run(`
      function tag(strings: TemplateStringsArray, ...vals: any[]): number { return strings.length; }
      export function test(): number { return tag\`a\${1}b\${2}c\`; }`);
    expect(got).toBe(3); // node: 3
  });

  it("reads the raw strings via strings.raw[i]", async () => {
    const got = await run(`
      function tag(strings: TemplateStringsArray, ...vals: any[]): string {
        return strings.raw[0] + "|" + strings.raw[1];
      }
      export function test(): string { return tag\`a\${1}b\`; }`);
    expect(got).toBe("a|b"); // node: "a|b" (was illegal cast)
  });

  it("still passes substitution values to the tag function", async () => {
    const got = await run(`
      function tag(strings: TemplateStringsArray, ...vals: any[]): number { return vals[0] + vals[1]; }
      export function test(): number { return tag\`x\${10}y\${32}z\`; }`);
    expect(got).toBe(42); // node: 42
  });

  it("String.raw interleaves raw parts with substitutions", async () => {
    const got = await run(`export function test(): string { return String.raw\`a\${1}b\${2}c\`; }`);
    expect(got).toBe("a1b2c"); // node: "a1b2c" (was host-bridge TypeError)
  });

  it("String.raw with no substitution returns the raw head", async () => {
    const got = await run(`export function test(): string { return String.raw\`hello\`; }`);
    expect(got).toBe("hello"); // node: "hello"
  });

  it("String.raw preserves backslash escapes literally", async () => {
    // The cooked text would collapse \\n to a newline; raw keeps "\\n".
    const got = await run(`export function test(): string { return String.raw\`x\${2}\\ny\`; }`);
    expect(got).toBe("x2\\ny"); // node: String.raw`x${2}\ny` === "x2\\ny"
  });
});
