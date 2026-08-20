// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { compile } from "../src/index.js";

const EXNREF_RUNNER = String.raw`
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const module = new WebAssembly.Module(Buffer.concat(chunks));
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) throw new Error("expected no imports, received " + JSON.stringify(imports));
  const instance = await WebAssembly.instantiate(module, {});
  process.stdout.write(String(instance.exports.probe()));
`;

async function compileStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", nativeStrings: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const child = spawnSync(
    process.execPath,
    ["--experimental-wasm-exnref", "--input-type=module", "--eval", EXNREF_RUNNER],
    { input: result.binary, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  expect(child.status, child.stderr || child.stdout).toBe(0);
  return Number(child.stdout);
}

describe("#4378 — Deno primordials Array.prototype iterator capture", () => {
  it("captures the genuine shared array-iterator prototype from the pristine Array.prototype", async () => {
    const value = await compileStandalone(`
      export function probe(): number {
        const captured: any = Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]());
        const control: any = Object.getPrototypeOf([][Symbol.iterator]());
        const wrong: any = Object.getPrototypeOf([]);
        return captured === control && captured !== wrong ? 42 : 0;
      }
    `);

    expect(value).toBe(42);
  });

  it("does not reinterpret a user binding that shadows Array", async () => {
    const value = await compileStandalone(`
      export function probe(): number {
        const Array = { prototype: [7] };
        let result = 0;
        for (const value of Array.prototype[Symbol.iterator]()) result = value;
        return result;
      }
    `);

    expect(value).toBe(7);
  });
});
