// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1058) Narrowing a struct whose field has the struct's own type.
 *
 * Passing a `Wide` where a `Narrow` is expected copies the shared fields into a
 * new `Narrow`. When a field is itself `Wide | undefined` → `Narrow |
 * undefined`, the copy needs the same conversion again. It used to inline that
 * conversion into itself until the compiler's stack overflowed (TypeScript's
 * checker hit this on `MappedType.target`). It now calls an outlined helper
 * for the repeated pair, which recurses at runtime instead.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
interface Wide { kind: number; target: Wide | undefined; extra: number }
interface Narrow { kind: number; target: Narrow | undefined }
function depth(n: Narrow): number { return n.kind + (n.target ? depth(n.target) : 0); }
export function run(): number {
  const a: Wide = { kind: 1, target: { kind: 20, target: { kind: 300, target: undefined, extra: 0 }, extra: 0 }, extra: 5 };
  return depth(a);
}
`;

async function run(target: "gc" | "standalone"): Promise<unknown> {
  const result = await compile(SOURCE, { fileName: "t.ts", target });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).run!();
}

describe("#1058 recursive struct narrowing", () => {
  it("copies every level on the JS host", async () => {
    expect(await run("gc")).toBe(321);
  });

  it("copies every level in standalone", async () => {
    expect(await run("standalone")).toBe(321);
  });
});
