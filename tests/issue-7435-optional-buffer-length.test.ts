// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7435 — `?.byteLength` / `?.maxByteLength` on an ArrayBuffer or TypedArray read NaN on every lane: the optional
// arm fell to the dynamic member read, which cannot see these computed accessors. It now asks the same buffer/view
// attribute reads the plain read does. On wasi, `u8?.length` / `u8?.[i]` read 0: the #1886 analysis lowered the
// buffer to a `(ptr, len)` pair, which the optional arm cannot read as a value; an optional use now keeps the buffer
// on the GC path. Each program's expected answer is node's.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const TARGETS = ["gc", "standalone", "wasi"] as const;

async function run(source: string, target: (typeof TARGETS)[number]): Promise<unknown> {
  const result = await compile(source, { target, fileName: "t.ts" });
  expect(result.errors.filter((error) => error.severity === "error").map((error) => error.message)).toEqual([]);
  const imports =
    target === "gc"
      ? buildImports(result.imports, undefined, result.stringPool)
      : target === "wasi"
        ? { wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }) }
        : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.main as () => unknown)();
}

const node = (source: string): unknown =>
  new Function(
    `${ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replace(/export /g, "")}; return main();`,
  )();

describe("#7435 optional-chain length reads on ArrayBuffer / TypedArray", () => {
  it.each([
    [
      "ArrayBuffer ?.byteLength",
      "export function main(): number { const b: ArrayBuffer | undefined = new ArrayBuffer(8); return b?.byteLength ?? -1; }",
      8,
    ],
    [
      "ArrayBuffer ?.maxByteLength",
      "export function main(): number { const b: ArrayBuffer | undefined = new ArrayBuffer(8); return b?.maxByteLength ?? -1; }",
      8,
    ],
    [
      "Float64Array ?.byteLength",
      "export function main(): number { const a: Float64Array | undefined = new Float64Array(2); return a?.byteLength ?? -1; }",
      16,
    ],
    [
      "Int32Array ?.byteLength / ?.byteOffset / ?.BYTES_PER_ELEMENT",
      "export function main(): number { const a: Int32Array | undefined = new Int32Array(3); " +
        "return (a?.byteLength ?? -1) * 100 + (a?.byteOffset ?? -1) * 10 + (a?.BYTES_PER_ELEMENT ?? -1); }",
      1204,
    ],
    [
      "a short-circuited parameter",
      "function f(b?: ArrayBuffer): number { return b?.byteLength ?? -1; } " +
        "export function main(): number { return f(new ArrayBuffer(5)) * 10 + f(); }",
      49,
    ],
    [
      "Uint8Array ?.length",
      "export function main(): number { const a: Uint8Array | undefined = new Uint8Array(3); return a?.length ?? -1; }",
      3,
    ],
    [
      "Uint8Array ?.[i]",
      "export function main(): number { const a: Uint8Array | undefined = new Uint8Array([4, 5, 6]); return a?.[1] ?? -1; }",
      5,
    ],
  ])("%s", async (_, source, expected) => {
    expect(node(source)).toBe(expected);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(expected);
  });
});
