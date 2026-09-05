// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4748 — standalone %GeneratorPrototype% owns the ES2015 Symbol.toStringTag
// data property. The exact Test262 row is retained in both lanes; the direct
// control checks the descriptor and proves the native path stays host-free.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const EXACT_FILE = "built-ins/GeneratorPrototype/Symbol.toStringTag.js";

describe("#4748 — standalone GeneratorPrototype Symbol.toStringTag", () => {
  it("passes the exact Test262 row in the host lane", async () => {
    const result = await runTest262File(join("test262/test", EXACT_FILE), "issue-4748", 120_000);
    expect(result.status, `${result.file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
  });

  it("passes the exact Test262 row in standalone", async () => {
    const result = await runTest262File(join("test262/test", EXACT_FILE), "issue-4748", 120_000, "standalone");
    expect(result.status, `${result.file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
  });

  it("preserves the tag descriptor and emits no standalone host imports", async () => {
    const result = await compile(
      `export function test(): number {
        const generatorPrototype: any = Object.getPrototypeOf(Object.getPrototypeOf(function*() {}()));
        const descriptor: any = Object.getOwnPropertyDescriptor(generatorPrototype, Symbol.toStringTag);
        return generatorPrototype[Symbol.toStringTag] === "Generator" &&
          descriptor.value === "Generator" &&
          descriptor.writable === false &&
          descriptor.enumerable === false &&
          descriptor.configurable === true ? 1 : 0;
      }`,
      { fileName: "issue-4748.ts", target: "standalone" },
    );
    expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) return;
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module), "GeneratorPrototype tag stays host-free").toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports as { test: () => number }).test()).toBe(1);
  });
});
