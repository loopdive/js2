// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7389 — `s += c ? 'a' : 1` passed the conditional's `$AnyValue` join straight to `__str_concat` and the module
// failed validation. The RHS now goes through the runtime ToString. The `any`-returning `dummy` export is what puts
// the conditional in `$AnyValue` form, as in the issue's repro. Each program carries node's answer.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ANY = " export function dummy(): any { return 0; }";
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

const node = (source: string): unknown =>
  new Function(`${source.replace(/export /g, "").replace(/: (any|number)/g, "")}; return main();`)();

describe("#7389 string += of a mixed string/number conditional", () => {
  it.each([
    [
      "the issue's module-scope form",
      "var out = ''; var c = 1; out += c ? 'a' : 1; export function main(): number { return out === 'a' ? 1 : 0; }",
    ],
    [
      "the number branch",
      "var out = ''; var c: any = 0; out += c ? 'a' : 1; export function main(): number { return out === '1' ? 1 : 0; }",
    ],
    [
      "inside a function",
      "export function main(): number { var out = 'x'; var c: any = 1; out += c ? 'a' : 1; return out === 'xa' ? 1 : 0; }",
    ],
    [
      "a boolean branch",
      "export function main(): number { var out = 'x'; var c: any = 0; out += c ? 'a' : true; return out === 'xtrue' ? 1 : 0; }",
    ],
    [
      "the string-builder loop",
      "export function main(): number { let s = ''; for (let i = 0; i < 3; i++) s += i % 2 ? 'a' : i; return s === '0a2' ? 1 : 0; }",
    ],
  ])("%s", async (_, program) => {
    const source = program + ANY;
    expect(node(source)).toBe(1);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(1);
    // The check is live: a wrong expected string makes main() return 0.
    expect(await run(source.replace(/=== '([^']*)'/, "=== '$1?'"), "standalone")).toBe(0);
  });
});
