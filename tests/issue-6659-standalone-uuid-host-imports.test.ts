// #6659 — uuid's standalone lanes retained three env imports:
// `__crypto_get_random_values` (rng.js), `__crypto_random_uuid` (v4.js) and
// `__unwrap_for_wasm` (v35.js `bytes.set(...)` on an externref carrier).
// A standalone module may not import anything, so a module that merely
// CONTAINED those calls was un-instantiable host-free.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

async function compileStandaloneProject(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "issue-6659-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const result = await compileProject(join(dir, "main.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  return { module, imports };
}

async function run(module: WebAssembly.Module) {
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

const V35_LIKE = `
export function build(value, hash) {
  const valueBytes = typeof value === "string" ? new Uint8Array(value.length) : value;
  let bytes = new Uint8Array(4 + valueBytes.length);
  bytes.set([1, 2, 3, 4]);
  bytes.set(valueBytes, 4);
  bytes = hash(bytes);
  return bytes;
}
`;

const CRYPTO_LIKE = `
const rnds8 = new Uint8Array(16);
export function rng() {
  return crypto.getRandomValues(rnds8);
}
export function v4() {
  return crypto.randomUUID();
}
`;

describe("#6659 — uuid-shaped modules stay host-free under --target standalone", () => {
  it("TypedArray.set on a reassigned (externref) receiver needs no host unwrap", async () => {
    const { module, imports } = await compileStandaloneProject({
      "bytes.js": V35_LIKE,
      "main.js": `
import { build } from "./bytes.js";
export function test() {
  const out = build(new Uint8Array([9, 8]), (b) => b);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum = sum * 10 + out[i];
  return sum;
}
`,
    });
    expect(imports).toEqual([]);
    expect((await run(module)).test()).toBe(123498);
  });

  it("crypto.getRandomValues / randomUUID compile without host imports and throw when reached", async () => {
    const { module, imports } = await compileStandaloneProject({
      "rng.js": CRYPTO_LIKE,
      "main.js": `
import { rng, v4 } from "./rng.js";
export function pure(x) { return x + 1; }
export function callRng() { try { rng(); return 0; } catch (e) { return e instanceof ReferenceError ? 1 : 2; } }
export function callV4() { try { v4(); return 0; } catch (e) { return e instanceof ReferenceError ? 1 : 2; } }
`,
    });
    expect(imports).toEqual([]);
    const exports = await run(module);
    // Never a pseudorandom substitute (#4569): no secure provider => the call throws.
    expect(exports.pure(41)).toBe(42);
    expect(exports.callRng()).toBe(1);
    expect(exports.callV4()).toBe(1);
  });
});
