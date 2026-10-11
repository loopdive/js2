import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #6714 — under standalone/WASI `Uint8Array` lowers to the packed-`i8`
// `$__vec_i8_byte` carrier, but the native `__textencoder_encode` returned (and
// `__textdecoder_decode_u8` consumed) the pre-#3150 `$__vec_f64`. Any encode
// result flowing through a slot typed `Uint8Array` — axios `lib/adapters/fetch.js`'s
// `((encoder) => (str) => encoder.encode(str))(new TextEncoder())` — produced an
// invalid module: `type error in fallthru[0] (expected (ref null $__vec_i8_byte),
// got (ref null $__vec_f64))`.

async function run(src: string, fileName: string, target: "standalone" | "wasi" = "standalone"): Promise<unknown> {
  const r = await compile(src, {
    fileName,
    target,
    ...(target === "standalone" ? { runtimeEvalProvider: false } : {}),
  });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = new WebAssembly.Module(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
  expect(imports.filter((n) => n.includes("TextEncoder") || n.includes("TextDecoder"))).toEqual([]);
  if (target === "wasi") return undefined;
  expect(imports).toEqual([]);
  const inst = new WebAssembly.Instance(mod, {});
  return (inst.exports as { test: () => unknown }).test();
}

describe("#6714 standalone TextEncoder/TextDecoder use the Uint8Array carrier", () => {
  it("axios fetch.js curried encoder closure validates and encodes", async () => {
    const src = `const encodeText = ((encoder) => (str) => encoder.encode(str))(new TextEncoder());
      export function test() { return encodeText("aé😀").length; }`;
    expect(await run(src, "issue-6714-axios.js")).toBe(7);
  });

  it("typed arrow returning encoder.encode validates (repro from the issue)", async () => {
    const src = `const enc = new TextEncoder();
      const encodeText = (str: string): Uint8Array => enc.encode(str);
      export function test(): number { return encodeText("abc").length; }`;
    expect(await run(src, "issue-6714-arrow.ts")).toBe(3);
  });

  it("encode result is byte-exact and passes through a Uint8Array parameter to decode", async () => {
    const src = `function dec(u: Uint8Array): string { return new TextDecoder().decode(u); }
      function enc(s: string): Uint8Array { return new TextEncoder().encode(s); }
      export function test(): number {
        const s = "ASCII é 你 😀";
        const u = enc(s);
        const exact = new TextEncoder().encode("aé").buffer.byteLength;
        return (dec(u) === s ? 1 : 0) + u.length * 10 + u[6] * 1000 + exact * 1000000;
      }`;
    // "ASCII é 你 😀" = 5 + 1 + 2 + 1 + 3 + 1 + 4 = 17 bytes; u[6] = 0xc3. The
    // encoded backing store is trimmed to the byte length ("aé" = 3 bytes).
    expect(await run(src, "issue-6714-param.ts")).toBe(1 + 17 * 10 + 0xc3 * 1000 + 3 * 1000000);
  });

  it("decodes a new Uint8Array and encodes a lone surrogate as U+FFFD", async () => {
    const src = `export function test(): number {
        const b = new Uint8Array([0x41, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]);
        const lone = new TextEncoder().encode("\\ud800");
        return (new TextDecoder().decode(b) === "Aé😀" ? 1 : 0) + lone.length * 10 + lone[0] * 100;
      }`;
    expect(await run(src, "issue-6714-decode.ts")).toBe(1 + 30 + 0xef * 100);
  });

  it("WASI: the curried encoder closure is a valid module", async () => {
    const src = `const encodeText = ((encoder) => (str) => encoder.encode(str))(new TextEncoder());
      export function test() { return encodeText("x").length; }`;
    await run(src, "issue-6714-wasi.js", "wasi");
  });
});
