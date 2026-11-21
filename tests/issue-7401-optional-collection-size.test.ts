// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7401 — `m?.size` on a typed Map/Set (and RegExp / Error members): the optional-chain arm asked for the host `Map_get_size` / `Set_get_size`
// getter import, which the native lanes do not have, emitted nothing, and left the receiver as the "property". The
// read now falls to the dynamic member read, whose native `$Map` arm answers `size`. Each program carries node's answer.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone", "wasi"] as const;

async function run(source: string, target: (typeof TARGETS)[number]): Promise<unknown> {
  const result = await compile(source, { target, fileName: "t.ts" });
  expect(result.errors.filter((error) => error.severity === "error").map((error) => error.message)).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
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

// Strip the TS annotations this file uses so node can run the same program.
const node = (source: string): unknown =>
  new Function(
    `${source
      .replace(/export /g, "")
      .replace(/\?: Set<number>/g, "")
      .replace(/: (Map<string, number>|Set<number>|RegExp|Error)( \| undefined)?/g, "")
      .replace(/\): number/g, ")")
      .replace(/!\./g, ".")
      .replace(/\)!/g, ")")
      .replace(/<string, number>/g, "")}; return main();`,
  )();

describe("#7401 optional-chain .size on a typed Map / Set", () => {
  it.each([
    [
      "Map",
      "export function main(): number { const m: Map<string, number> | undefined = new Map([['a', 1]]); return m?.size ?? -1; }",
      1,
    ],
    [
      "Set",
      "export function main(): number { const s: Set<number> | undefined = new Set([1, 2]); return s?.size ?? -1; }",
      2,
    ],
    [
      "Set grown after construction",
      "export function main(): number { const s: Set<number> | undefined = new Set([1]); s!.add(5); s!.add(5); return s?.size ?? -1; }",
      2,
    ],
    [
      "a short-circuited parameter",
      "function f(s?: Set<number>): number { return s?.size ?? -1; } export function main(): number { return f(new Set([1, 2, 3])) * 10 + f(); }",
      29,
    ],
    [
      "compared to undefined",
      "function f(s?: Set<number>): number { return s?.size === undefined ? 1 : 0; } export function main(): number { return f() * 10 + f(new Set([1])); }",
      10,
    ],
    // S7's invalid-module shapes (the receiver stood in for the property and failed validation).
    [
      "a parameter (was invalid Wasm)",
      'function h(r: Map<string, number> | undefined) { return r?.size; } export function main(): number { return h(new Map([["k", 7]]))!; }',
      1,
    ],
    [
      "a module global (was invalid Wasm)",
      "let r: Set<number> | undefined = new Set([5]); export function main(): number { const v = r?.size; return v === 1 ? 1 : 0; }",
      1,
    ],
    [
      "an undefined class field (was invalid Wasm)",
      "class W { r: Map<string, number> | undefined = undefined; } export function main(): number { const w = new W(); const v = w.r?.size; return v === undefined ? 2 : 0; }",
      2,
    ],
    // Other extern classes without a host getter import take the same arm.
    [
      "RegExp ?.source / ?.flags",
      'export function main(): number { const r: RegExp | undefined = /ab/g; return (r?.source ?? "").length + (r?.flags === "g" ? 10 : 0); }',
      12,
    ],
    [
      "Error ?.message / ?.name",
      'export function main(): number { const e: Error | undefined = new RangeError("boom"); return (e?.message === "boom" ? 1 : 0) + (e?.name === "RangeError" ? 10 : 0); }',
      11,
    ],
  ])("%s", async (_, source, expected) => {
    expect(node(source)).toBe(expected);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(expected);
  });
});
