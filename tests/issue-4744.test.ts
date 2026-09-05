// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4744 — ES2015 %ArrayIteratorPrototype% owns a non-enumerable,
// non-writable, configurable Symbol.toStringTag. Standalone reifies the
// prototype as a native $Object singleton, so the descriptor must be seeded on
// that exact identity and the direct toString fold must use the iterator tag.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const EXACT_FILES = [
  "built-ins/ArrayIteratorPrototype/Symbol.toStringTag/property-descriptor.js",
  "built-ins/ArrayIteratorPrototype/Symbol.toStringTag/value-direct.js",
  "built-ins/ArrayIteratorPrototype/Symbol.toStringTag/value-from-to-string.js",
] as const;

async function run(source: string, lane: Lane): Promise<number> {
  const options = lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {};
  const result = await compile(source, { fileName: "issue-4744.ts", ...options });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return 0;

  const imports =
    lane === "host"
      ? (buildImports(result.imports, undefined, result.stringPool) as unknown as WebAssembly.Imports)
      : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const lifecycle = imports as WebAssembly.Imports & {
    setInstance?: (value: WebAssembly.Instance) => void;
  };
  lifecycle.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

describe("#4744 — ArrayIteratorPrototype Symbol.toStringTag", () => {
  it.each(EXACT_FILES)("passes the exact host Test262 row %s", async (file) => {
    const result = await runTest262File(join("test262/test", file), "issue-4744", 120_000);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(EXACT_FILES)("passes the exact standalone Test262 row %s", async (file) => {
    const result = await runTest262File(join("test262/test", file), "issue-4744", 120_000, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it("keeps standalone iterator prototypes identity-stable and distinct from Array.prototype", async () => {
    const result = await run(
      `export function test(): number {
        const arrayIteratorProto: any = Object.getPrototypeOf([][Symbol.iterator]());
        const valuesProto: any = Object.getPrototypeOf([1].values());
        const entriesProto: any = Object.getPrototypeOf([].entries());
        const arrayProto: any = Object.getPrototypeOf([]);
        return arrayIteratorProto === valuesProto && valuesProto === entriesProto && arrayIteratorProto !== arrayProto ? 1 : 0;
      }`,
      "standalone",
    );
    expect(result).toBe(1);
  });
});
